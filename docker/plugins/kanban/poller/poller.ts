#!/usr/bin/env bun
// Kanban poller: watches the Linear team board and runs opencode commands
// (/investigate-ticket, /review-ticket, /work-ticket) unattended.
// It does the deterministic GitHub, git and status work itself, so agents start only when needed:
//   - pre-flight before work: project config (repo + path), checkout exists, origin matches,
//     `.slim/worktrees` is git-ignored
//   - worktree setup before work and fix runs: fetch, create or reuse `.slim/worktrees/<id>`,
//     register the lane in `.slim/worktrees.json`
//   - follow-up: a Ready for agent ticket whose branch has an open PR gets that PR in the worker ctx
//     (merged/closed PR: Needs human); review rounds count only since the ticket last entered
//     Ready for agent, so each human request gets a fresh limit
//   - claims: an eyes reaction by the poller on the ticket (replaces the claim comment); a claim
//     reaction older than the work timeout marks an In Progress ticket as stale
//   - /investigate comments run on any ticket (state and labels are not touched); the poller
//     checks the project config first and reacts eyes (claim), then check or x on the request
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
  investigationOutcome,
  investigateRequests,
  investigatorMessage,
  issueProject,
  MAX_REVIEW_ROUNDS,
  changesRequestedRounds,
  cleanupCandidate,
  existingPrDecision,
  fixCandidates,
  issueTarget,
  latestFixRequest,
  originMatchesRepo,
  addLane,
  readyCandidates,
  refinementLabel,
  removeLane,
  reviewCandidates,
  reviewGate,
  reviewerMessage,
  staleClaims,
  viewerClaimReactionIds,
  workerMessage,
  worktreePath,
  worktreePlan,
  worktreeRelPath,
  type Comment,
  type GateDecision,
  type Issue,
  type PrInfo,
  type Project,
  type Target,
  type TimedComment,
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

/** Replaces the poller's claim reactions on the ticket with a fresh one (the claim marker). */
async function claim(ctx: Context, issue: Issue): Promise<void> {
  if (ctx.config.dryRun) return log("dry-run.claim", { ticket: issue.identifier });
  for (const id of viewerClaimReactionIds(issue, ctx.viewerId)) await ctx.linear.deleteReaction(id);
  await ctx.linear.reactToIssue(issue.id, REACTION.claimed);
  log("claimed", { ticket: issue.identifier });
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
    const project = issueProject(issue);
    const blocker = "error" in project ? project.error : await checkoutProblem(ctx, project);
    if ("error" in project || blocker) {
      log("investigate.skip", { ticket: issue.identifier, reason: blocker });
      await comment(ctx, issue, `Agent investigation: failed — ${blocker}`, request.id);
      await react(ctx, request, REACTION.failed);
      continue;
    }
    // The eyes reaction is the claim. Without it the request would run again every pass.
    if (!(await react(ctx, request, REACTION.claimed))) return false;

    const startedAt = Date.now();
    const result = await run(
      ctx,
      "investigate",
      issue,
      investigatorMessage(project, question),
      ctx.config.timeoutInvestigateMs,
    );
    if (!result) return true;

    const outcome = investigationOutcome(
      { ...result, minutes: minutes(result.durationMs) },
      await ctx.linear.issueComments(issue.identifier),
      startedAt,
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

/** Why the project checkout is unusable (missing, not a git repo, wrong origin), or null. */
async function checkoutProblem(ctx: Context, project: Project): Promise<string | null> {
  if (!(await dirExists(project.path))) return `project path ${project.path} does not exist`;
  try {
    if (!(await ctx.git.isRepo(project.path))) return `project path ${project.path} is not a git repository`;
    const origin = await ctx.git.originUrl(project.path);
    if (!originMatchesRepo(origin, project.repo)) return `origin of ${project.path} does not match ${project.repo}`;
  } catch (error) {
    return `git check failed: ${(error as Error).message}`;
  }
  return null;
}

/** Why the ticket cannot be worked on (config, checkout, origin, ignore rules), as a Target when it can. */
async function preflight(ctx: Context, issue: Issue): Promise<Target | string> {
  const target = issueTarget(issue);
  if ("error" in target) return target.error;
  const problem = await checkoutProblem(ctx, target);
  if (problem) return problem;
  try {
    // Probe a path inside the worktree so directory-only ignore patterns match too.
    if (!(await ctx.git.isIgnored(target.path, `${worktreeRelPath(target.identifier)}/.probe`))) {
      return `.slim/worktrees is not git-ignored in ${target.path}`;
    }
  } catch (error) {
    return `git check failed: ${(error as Error).message}`;
  }
  return target;
}

async function writeRegistry(file: string, registry: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(temp, file);
}

async function addLaneEntry(target: Target, defaultBranch: string): Promise<void> {
  const file = `${target.path}/.slim/worktrees.json`;
  let registry: unknown = null;
  try {
    registry = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new GitError("worktree registry unreadable");
  }
  const updated = addLane(
    registry,
    {
      slug: target.identifier.toLowerCase(),
      branch: target.branch,
      base: defaultBranch,
      purpose: `ticket ${target.identifier}`,
    },
    nowIso(),
  );
  if (!updated) throw new GitError("worktree registry malformed");
  if (updated === registry) return;
  try {
    await writeRegistry(file, updated);
  } catch {
    throw new GitError("worktree registry not writable");
  }
}

/** Fetches, creates or reuses the ticket's worktree, and registers its lane. Throws GitError. */
async function prepareWorktree(ctx: Context, target: Target, defaultBranch: string): Promise<void> {
  if (ctx.config.dryRun) return log("dry-run.worktree", { ticket: target.identifier });
  const worktree = worktreePath(target.path, target.identifier);
  await ctx.git.fetch(target.path, target.repo);
  const plan = worktreePlan({
    worktreeExists: (await dirExists(worktree)) && (await isRegisteredWorktree(ctx, target.path, worktree)),
    localBranch: (await ctx.git.revParse(target.path, `refs/heads/${target.branch}`)) !== null,
    remoteBranch: (await ctx.git.revParse(target.path, `refs/remotes/origin/${target.branch}`)) !== null,
    defaultBranch,
    branch: target.branch,
  });
  if (plan.kind !== "reuse") await ctx.git.worktreeAdd(target.path, worktree, plan);
  await addLaneEntry(target, defaultBranch);
  log("worktree.ready", { ticket: target.identifier, plan: plan.kind });
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

/** Review rounds used since the ticket last entered Ready for agent (each human request starts fresh). */
async function roundsUsed(ctx: Context, issue: Issue, known?: TimedComment[]): Promise<number> {
  const comments = known ?? (await ctx.linear.issueComments(issue.identifier));
  return changesRequestedRounds(comments, await ctx.linear.lastEnteredStateAt(issue.identifier, STATE.ready));
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
      rounds = await roundsUsed(ctx, issue);
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

/** Prepares the worktree; on GitError the ticket goes to Needs human and false is returned. */
async function setupWorktree(ctx: Context, issue: Issue, target: Target, defaultBranch: string): Promise<boolean> {
  try {
    await prepareWorktree(ctx, target, defaultBranch);
    return true;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    await needsHuman(ctx, issue, `worktree setup failed: ${oneLine(error.message)}`);
    return false;
  }
}

async function stepFix(ctx: Context): Promise<boolean> {
  for (const issue of fixCandidates(await ctx.linear.issuesInState(STATE.inProgress))) {
    const target = await preflight(ctx, issue);
    if (typeof target === "string") {
      await needsHuman(ctx, issue, target);
      continue;
    }
    let message: string;
    let defaultBranch: string;
    try {
      const comments = await ctx.linear.issueComments(issue.identifier);
      const rounds = await roundsUsed(ctx, issue, comments);
      const pr = await ctx.gh.findPr(target.repo, target.branch);
      defaultBranch = await ctx.gh.defaultBranch(target.repo);
      message = workerMessage(target, {
        defaultBranch,
        pr: pr ? { number: pr.number, url: pr.url } : undefined,
        round: rounds,
        fix: latestFixRequest(comments),
      });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log("fix.github-error", { ticket: issue.identifier, message: error.message });
      continue;
    }
    if (!(await setupWorktree(ctx, issue, target, defaultBranch))) continue;
    await relabel(ctx, issue, { remove: [LABEL.changesRequested] });
    await claim(ctx, issue);
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
    let defaultBranch: string;
    try {
      const existing = existingPrDecision(await ctx.gh.findPr(target.repo, target.branch));
      if (existing.kind === "needsHuman") {
        await needsHuman(ctx, issue, existing.reason);
        continue;
      }
      defaultBranch = await ctx.gh.defaultBranch(target.repo);
      message = workerMessage(target, {
        defaultBranch,
        pr: existing.kind === "follow-up" ? existing.pr : undefined,
        round: await roundsUsed(ctx, issue),
      });
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log("work.github-error", { ticket: issue.identifier, message: error.message });
      continue;
    }
    if (!(await setupWorktree(ctx, issue, target, defaultBranch))) continue;
    await move(ctx, issue, STATE.inProgress);
    await claim(ctx, issue);
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
  await writeRegistry(file, updated);
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
  for (const issue of staleClaims(inProgress, ctx.viewerId, Date.now(), ctx.config.timeoutWorkMs)) {
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
