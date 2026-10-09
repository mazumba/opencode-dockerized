#!/usr/bin/env bun
// Kanban poller: watches the Linear team board and runs opencode commands
// (/investigate-ticket, /review-ticket, /work-ticket) unattended.
// It does the deterministic GitHub and git work itself, so agents start only when needed:
//   - pre-flight before work: project config (repo + path), checkout exists, origin matches
//   - Agent review gate: waits for CI, sends CI failures and merge conflicts back to the worker
//     (limited rounds), escalates missing/closed PRs, and starts the reviewer only when CI is green
//   - cleanup: removes the worktree and local branch of merged or canceled tickets, only when
//     nothing would be lost (clean tree, branch head equals the PR head)
// Agents get their facts as `<ID> ctx:<json>`. At most one agent run per pass.
// Never logs keys, tokens, comment bodies, or ticket text.
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { GitError, createGit, dirExists, type Git } from "./git.ts";
import { GitHubError, createGh, ensureInstallationId, type Gh } from "./github.ts";
import { LinearClient, LinearError, type Ids } from "./linear.ts";
import { log } from "./log.ts";
import { abortCurrentRun, describeRun, runAgent, type RunResult } from "./runner.ts";
import {
  INVESTIGATE_WINDOW_MS,
  LABEL,
  REACTION,
  STATE,
  autoLabelTargets,
  investigateBlocker,
  investigationOutcome,
  investigateRequests,
  MAX_REVIEW_ROUNDS,
  changesRequestedRounds,
  cleanupCandidate,
  fixCandidates,
  issueTarget,
  latestFixRequest,
  originMatchesRepo,
  readyCandidates,
  refinementLabel,
  removeLane,
  reviewCandidates,
  reviewGate,
  reviewerMessage,
  staleClaims,
  workerMessage,
  worktreePath,
  type Comment,
  type GateDecision,
  type Issue,
  type PrInfo,
  type Target,
} from "./select.ts";

const DEFAULT_OPENCODE_BIN = "/home/opencode/.opencode/bin/opencode";
const CLEANUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_LOG_REPLY_LINES = 150;

const AGENT = {
  work: { agent: "ticket-worker", command: "work-ticket" },
  review: { agent: "ticket-reviewer", command: "review-ticket" },
  investigate: { agent: "ticket-investigator", command: "investigate-ticket" },
} as const;

interface Context {
  config: Config;
  linear: LinearClient;
  ids: Ids;
  viewerId: string;
  opencodeBin: string;
  gh: Gh;
  git: Git;
}

let stopping = false;

const nowIso = () => new Date().toISOString();
const minutes = (ms: number) => Math.round(ms / 60_000);

// ── Writes (all Linear mutations go through here so --dry-run is airtight) ──

async function comment(
  ctx: Context,
  issue: Issue,
  body: string,
  parentId?: string,
): Promise<string | undefined> {
  if (ctx.config.dryRun) {
    log("dry-run.comment", { ticket: issue.identifier });
    return undefined;
  }
  return ctx.linear.addComment(issue.id, body, parentId);
}

async function move(ctx: Context, issue: Issue, state: string): Promise<void> {
  if (ctx.config.dryRun) return log("dry-run.move", { ticket: issue.identifier, to: state });
  await ctx.linear.updateIssue(issue.id, { stateId: ctx.ids.states.get(state) });
}

async function relabel(
  ctx: Context,
  issue: Issue,
  change: { add?: string[]; remove?: string[] },
): Promise<void> {
  if (ctx.config.dryRun) {
    return log("dry-run.relabel", {
      ticket: issue.identifier,
      add: (change.add ?? []).join(",") || "-",
      remove: (change.remove ?? []).join(",") || "-",
    });
  }
  await ctx.linear.updateIssue(issue.id, {
    addLabelIds: change.add?.map((n) => ctx.ids.labels.get(n)!),
    removeLabelIds: change.remove?.map((n) => ctx.ids.labels.get(n)!),
  });
}

async function needsHuman(ctx: Context, issue: Issue, reason: string): Promise<void> {
  await move(ctx, issue, STATE.needsHuman);
  await comment(ctx, issue, `Agent: needs human — poller: ${reason}`);
  log("needs-human", { ticket: issue.identifier, reason });
}

// ── Agent runs ──

async function run(
  ctx: Context,
  kind: keyof typeof AGENT,
  issue: Issue,
  message: string,
  timeoutMs: number,
): Promise<RunResult | null> {
  const { agent, command } = AGENT[kind];
  if (ctx.config.dryRun) {
    log("dry-run.run", { ticket: issue.identifier, agent, command, hasPath: issue.projectPath !== null });
    return null;
  }
  log("run.start", { ticket: issue.identifier, agent, command });
  const result = await runAgent({
    opencodeBin: ctx.opencodeBin,
    url: ctx.config.opencodeUrl,
    agent,
    command,
    message,
    dir: issue.projectPath,
    timeoutMs,
  });
  log("run.end", {
    ticket: issue.identifier,
    agent,
    exitCode: result.exitCode ?? -1,
    timedOut: result.timedOut,
    aborted: result.aborted,
    seconds: Math.round(result.durationMs / 1000),
  });
  return result;
}

/**
 * After a work or review run the ticket must have left its starting lane.
 * Otherwise (or on timeout, abort, or failed exit) it goes to Needs human.
 */
async function settle(
  ctx: Context,
  issue: Issue,
  result: RunResult,
  after: Issue,
  isAcceptable: (state: string) => boolean,
): Promise<void> {
  if (!result.aborted && !result.timedOut && isAcceptable(after.state)) return;
  if (after.state === STATE.needsHuman) return;
  const reason =
    result.aborted || result.timedOut || result.exitCode !== 0
      ? describeRun(result)
      : `ended in state ${after.state}`;
  await needsHuman(ctx, issue, reason);
}

// ── Pass steps. Each returns true if it consumed the pass's single agent run. ──

/** Adds a reaction. Returns false (and logs) on failure instead of throwing. */
async function react(ctx: Context, request: Comment, emoji: string): Promise<boolean> {
  if (ctx.config.dryRun) {
    log("dry-run.react", { ticket: request.issueIdentifier, emoji });
    return true;
  }
  try {
    await ctx.linear.react(request.id, emoji);
    return true;
  } catch (error) {
    log("react.error", { ticket: request.issueIdentifier, emoji, message: (error as Error).message });
    return false;
  }
}

async function stepInvestigate(ctx: Context): Promise<boolean> {
  const since = new Date(Date.now() - INVESTIGATE_WINDOW_MS).toISOString();
  const comments = await ctx.linear.commentsSince(since);
  for (const { comment: request, question } of investigateRequests(comments, ctx.viewerId, Date.now())) {
    const issue = await ctx.linear.issue(request.issueIdentifier);
    const blocker = investigateBlocker(issue);
    if (blocker) {
      log("investigate.skip", { ticket: issue.identifier });
      await comment(ctx, issue, `Agent investigation: skipped — ${blocker}`, request.id);
      await react(ctx, request, REACTION.failed);
      continue;
    }
    // The eyes reaction is the claim. Without it the request would run again every pass.
    if (!(await react(ctx, request, REACTION.claimed))) return false;

    const message = question ? `${issue.identifier} ${question}` : issue.identifier;
    const result = await run(ctx, "investigate", issue, message, ctx.config.timeoutInvestigateMs);
    if (!result) return true;

    const after = await ctx.linear.issue(issue.identifier);
    const swapped =
      after.labels.includes(LABEL.needsGrilling) && !after.labels.includes(LABEL.investigate);
    const outcome = investigationOutcome(
      { ...result, minutes: minutes(result.durationMs) },
      swapped,
    );
    if (outcome.emoji === REACTION.done) {
      await react(ctx, request, REACTION.done);
    } else {
      await comment(ctx, issue, `Agent investigation: failed — ${outcome.reason}`, request.id);
      await react(ctx, request, REACTION.failed);
    }
    return true;
  }
  return false;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const FENCE = "```";

/** Why the ticket cannot be worked on (config, checkout, origin), as a Target when it can. */
async function preflight(ctx: Context, issue: Issue): Promise<Target | string> {
  const target = issueTarget(issue);
  if ("error" in target) return target.error;
  if (!(await dirExists(target.path))) return `project path ${target.path} does not exist`;
  try {
    if (!(await ctx.git.isRepo(target.path))) return `project path ${target.path} is not a git repository`;
    const origin = await ctx.git.originUrl(target.path);
    if (!originMatchesRepo(origin, target.repo)) return `origin of ${target.path} does not match ${target.repo}`;
  } catch (error) {
    return `git check failed: ${(error as Error).message}`;
  }
  return target;
}

async function postFixRequest(
  ctx: Context,
  issue: Issue,
  target: Target,
  pr: PrInfo,
  rounds: number,
  cause: "ci" | "conflict",
  failed: string[],
): Promise<void> {
  await relabel(ctx, issue, { add: [LABEL.changesRequested] });
  await move(ctx, issue, STATE.inProgress);
  const summary = cause === "ci" ? `CI failed: ${oneLine(failed.join(", "))}` : `merge conflicts with ${pr.baseRefName}`;
  const parentId = await comment(
    ctx,
    issue,
    `Agent review: changes requested (round ${rounds + 1}/${MAX_REVIEW_ROUNDS}) — ${pr.url}\n${summary}`,
  );
  if (cause === "ci" && parentId) {
    const tail = await ctx.gh.failedLogTail(target.repo, pr, MAX_LOG_REPLY_LINES);
    if (tail) await comment(ctx, issue, `${FENCE}\n${tail.replaceAll(FENCE, "'".repeat(3))}\n${FENCE}`, parentId);
  }
  log("review.fix", { ticket: issue.identifier, cause, round: rounds + 1 });
}

async function stepReview(ctx: Context): Promise<boolean> {
  for (const issue of reviewCandidates(await ctx.linear.issuesInState(STATE.agentReview))) {
    const target = issueTarget(issue);
    if ("error" in target) {
      await needsHuman(ctx, issue, target.error);
      continue;
    }
    let pr: PrInfo | null;
    let decision: GateDecision;
    let rounds: number;
    try {
      pr = await ctx.gh.findPr(target.repo, target.branch);
      const checks = pr?.state === "OPEN" ? await ctx.gh.checks(target.repo, pr.number) : [];
      rounds = changesRequestedRounds(await ctx.linear.issueComments(issue.identifier));
      decision = reviewGate(pr, checks, rounds);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log("review.github-error", { ticket: issue.identifier, message: error.message });
      continue;
    }

    if (decision.kind === "wait") {
      log("review.wait", { ticket: issue.identifier });
      continue;
    }
    if (decision.kind === "needsHuman") {
      await needsHuman(ctx, issue, decision.reason);
      continue;
    }
    if (decision.kind === "fix") {
      try {
        await postFixRequest(ctx, issue, target, pr!, rounds, decision.cause, decision.failed);
      } catch (error) {
        const kind = error instanceof GitHubError ? "github" : error instanceof LinearError ? "linear" : "internal";
        log("review.fix-error", { ticket: issue.identifier, kind, message: (error as Error).message });
      }
      continue;
    }

    const message = reviewerMessage(target, {
      base: pr!.baseRefName,
      pr: { number: pr!.number, url: pr!.url },
      round: rounds,
    });
    const result = await run(ctx, "review", issue, message, ctx.config.timeoutReviewMs);
    if (!result) return true;
    const after = await ctx.linear.issue(issue.identifier);
    await settle(ctx, issue, result, after, (state) => state !== STATE.agentReview);
    return true;
  }
  return false;
}

async function stepWork(ctx: Context, issue: Issue, message: string): Promise<void> {
  const result = await run(ctx, "work", issue, message, ctx.config.timeoutWorkMs);
  if (!result) return;
  const after = await ctx.linear.issue(issue.identifier);
  await settle(ctx, issue, result, after, (s) => s === STATE.agentReview || s === STATE.needsHuman);
}

async function stepFix(ctx: Context): Promise<boolean> {
  for (const issue of fixCandidates(await ctx.linear.issuesInState(STATE.inProgress))) {
    const target = await preflight(ctx, issue);
    if (typeof target === "string") {
      await needsHuman(ctx, issue, target);
      continue;
    }
    let message: string;
    try {
      const comments = await ctx.linear.issueComments(issue.identifier);
      const pr = await ctx.gh.findPr(target.repo, target.branch);
      message = workerMessage(target, {
        defaultBranch: await ctx.gh.defaultBranch(target.repo),
        pr: pr ? { number: pr.number, url: pr.url } : undefined,
        round: changesRequestedRounds(comments),
        fix: latestFixRequest(comments),
      });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log("fix.github-error", { ticket: issue.identifier, message: error.message });
      continue;
    }
    await relabel(ctx, issue, { remove: [LABEL.changesRequested] });
    await comment(ctx, issue, `Agent: claimed by poller (${nowIso()})`);
    await stepWork(ctx, issue, message);
    return true;
  }
  return false;
}

async function stepNewWork(ctx: Context): Promise<boolean> {
  for (const issue of readyCandidates(await ctx.linear.issuesInState(STATE.ready))) {
    const label = refinementLabel(issue);
    if (label) {
      await move(ctx, issue, STATE.backlog);
      await comment(ctx, issue, `Agent: not refined — remove ${label} first`);
      log("bounced", { ticket: issue.identifier, label });
      continue;
    }
    const target = await preflight(ctx, issue);
    if (typeof target === "string") {
      await needsHuman(ctx, issue, target);
      continue;
    }
    let message: string;
    try {
      message = workerMessage(target, { defaultBranch: await ctx.gh.defaultBranch(target.repo), round: 0 });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log("work.github-error", { ticket: issue.identifier, message: error.message });
      continue;
    }
    await move(ctx, issue, STATE.inProgress);
    await comment(ctx, issue, `Agent: claimed by poller (${nowIso()})`);
    await stepWork(ctx, issue, message);
    return true;
  }
  return false;
}

// ── Cleanup of merged/canceled tickets (never consumes the pass) ──

async function removeLaneEntry(target: Target, worktree: string): Promise<void> {
  const file = `${target.path}/.slim/worktrees.json`;
  let registry: unknown;
  try {
    registry = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return log("cleanup.lanes-skip", { ticket: target.identifier, reason: "registry missing or unreadable" });
  }
  const updated = removeLane(registry, worktree, target.identifier.toLowerCase(), nowIso());
  if (!updated) return log("cleanup.lanes-skip", { ticket: target.identifier, reason: "no matching lane" });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`);
  await rename(temp, file);
}

async function isRegisteredWorktree(ctx: Context, path: string, worktree: string): Promise<boolean> {
  const registered = await ctx.git.worktreePaths(path);
  const resolved = await realpath(worktree).catch(() => worktree);
  return registered.includes(worktree) || registered.includes(resolved);
}

/** Why the worktree must stay, or null if removing it loses nothing. */
async function cleanupBlocker(ctx: Context, target: Target, worktree: string, pr: PrInfo): Promise<string | null> {
  if (!(await isRegisteredWorktree(ctx, target.path, worktree))) return "not a registered worktree";
  if ((await ctx.git.statusPorcelain(worktree)) !== "") return "uncommitted changes";
  const branchHead = await ctx.git.revParse(target.path, `refs/heads/${target.branch}`);
  if (branchHead === null) return "no local branch";
  if (branchHead !== pr.headRefOid) return "local branch differs from PR head";
  if ((await ctx.git.revParse(worktree, "HEAD")) !== pr.headRefOid) return "worktree HEAD differs from PR head";
  return null;
}

async function cleanupIssue(ctx: Context, issue: Issue): Promise<void> {
  const target = issueTarget(issue);
  if ("error" in target) return;
  const worktree = worktreePath(target.path, target.identifier);
  if (!(await dirExists(worktree))) return;
  const pr = await ctx.gh.findPr(target.repo, target.branch);
  if (!pr || !cleanupCandidate(issue.state, pr.state)) return;

  const blocker = await cleanupBlocker(ctx, target, worktree, pr);
  if (blocker) return log("cleanup.skip", { ticket: issue.identifier, reason: blocker });
  if (ctx.config.dryRun) return log("dry-run.cleanup", { ticket: issue.identifier });

  await ctx.git.worktreeRemove(target.path, worktree);
  // Squash merges leave the branch unmerged in git's eyes; the head checks above make -D safe.
  await ctx.git.branchDelete(target.path, target.branch);
  await removeLaneEntry(target, worktree);
  log("cleanup.done", { ticket: issue.identifier, pr: pr.number });
}

async function stepCleanup(ctx: Context): Promise<void> {
  const since = new Date(Date.now() - CLEANUP_WINDOW_MS).toISOString();
  const issues = [
    ...(await ctx.linear.issuesInState(STATE.readyForMerge)),
    ...(await ctx.linear.issuesInState(STATE.done, since)),
    ...(await ctx.linear.issuesInState(STATE.canceled, since)),
  ];
  for (const issue of issues) {
    if (stopping) return;
    try {
      await cleanupIssue(ctx, issue);
    } catch (error) {
      const kind = error instanceof GitError ? "git" : error instanceof GitHubError ? "github" : "internal";
      log("cleanup.error", { ticket: issue.identifier, kind, message: (error as Error).message });
    }
  }
}

async function stepAutoLabel(ctx: Context): Promise<void> {
  for (const issue of autoLabelTargets(await ctx.linear.issuesInState(STATE.backlog))) {
    await relabel(ctx, issue, { add: [LABEL.needsGrilling] });
    log("auto-labelled", { ticket: issue.identifier });
  }
}

async function recoverStaleClaims(ctx: Context): Promise<void> {
  const inProgress = await ctx.linear.issuesInState(STATE.inProgress);
  const withComments = [];
  for (const issue of inProgress) {
    withComments.push({ issue, comments: await ctx.linear.issueComments(issue.identifier) });
  }
  for (const issue of staleClaims(withComments, Date.now(), ctx.config.timeoutWorkMs)) {
    await needsHuman(ctx, issue, "stale claim");
  }
}

async function runPass(ctx: Context): Promise<void> {
  await stepAutoLabel(ctx);
  try {
    await stepCleanup(ctx);
  } catch (error) {
    log("cleanup.error", { kind: "pass", message: (error as Error).message });
  }
  for (const step of [stepInvestigate, stepReview, stepFix, stepNewWork]) {
    if (stopping) return;
    if (await step(ctx)) return;
  }
  log("pass.idle");
}

// ── Startup and main loop ──

async function resolveOpencodeBin(): Promise<string> {
  const override = process.env.KANBAN_OPENCODE_BIN;
  if (override) return override;
  return (await Bun.file(DEFAULT_OPENCODE_BIN).exists()) ? DEFAULT_OPENCODE_BIN : "opencode";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (stopping) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 500);
    setTimeout(() => clearInterval(check), ms + 1000);
  });
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env, process.argv.slice(2));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`kanban-poller: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const linear = new LinearClient(config.linearApiKey, config.team);
  let ctx: Context;
  try {
    await ensureInstallationId();
    const ids = await linear.resolveIds(
      [
        STATE.backlog,
        STATE.ready,
        STATE.inProgress,
        STATE.agentReview,
        STATE.readyForMerge,
        STATE.done,
        STATE.canceled,
        STATE.needsHuman,
      ],
      Object.values(LABEL),
    );
    ctx = {
      config,
      linear,
      ids,
      viewerId: await linear.viewerId(),
      opencodeBin: await resolveOpencodeBin(),
      gh: createGh(),
      git: createGit(),
    };
  } catch (error) {
    console.error(`kanban-poller: startup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  const stop = () => {
    stopping = true;
    abortCurrentRun();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  log("start", { team: config.team, once: config.once, dryRun: config.dryRun });
  try {
    await recoverStaleClaims(ctx);
  } catch (error) {
    log("recovery.error", { message: (error as Error).message });
  }

  do {
    try {
      await runPass(ctx);
    } catch (error) {
      const kind = error instanceof LinearError ? "linear" : "internal";
      log("pass.error", { kind, message: (error as Error).message });
    }
    if (config.once || stopping) break;
    await sleep(config.pollIntervalMs);
  } while (!stopping);
  log("stop");
}

await main();
