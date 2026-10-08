#!/usr/bin/env bun
// Kanban poller: watches the Linear team board and runs opencode commands
// (/investigate-ticket, /review-ticket, /work-ticket) unattended.
// At most one agent run per pass. Never logs keys, comment bodies, or ticket text.
import { ConfigError, loadConfig, type Config } from "./config.ts";
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
  pickFix,
  pickReview,
  readyCandidates,
  refinementLabel,
  setBackoff,
  staleClaims,
  type Backoff,
  type Comment,
  type Issue,
} from "./select.ts";

const DEFAULT_OPENCODE_BIN = "/home/opencode/.opencode/bin/opencode";
const PENDING_MARKER = "PENDING: CI still running";

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
  backoff: Backoff;
}

let stopping = false;

const nowIso = () => new Date().toISOString();
const minutes = (ms: number) => Math.round(ms / 60_000);

// ── Writes (all Linear mutations go through here so --dry-run is airtight) ──

async function comment(ctx: Context, issue: Issue, body: string, parentId?: string): Promise<void> {
  if (ctx.config.dryRun) return log("dry-run.comment", { ticket: issue.identifier });
  await ctx.linear.addComment(issue.id, body, parentId);
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

async function stepReview(ctx: Context): Promise<boolean> {
  const issue = pickReview(await ctx.linear.issuesInState(STATE.agentReview), ctx.backoff, Date.now());
  if (!issue) return false;
  const result = await run(ctx, "review", issue, issue.identifier, ctx.config.timeoutReviewMs);
  if (!result) return true;

  const after = await ctx.linear.issue(issue.identifier);
  const pending =
    !result.aborted && !result.timedOut && after.state === STATE.agentReview &&
    result.outputTail.includes(PENDING_MARKER);
  if (pending) {
    setBackoff(ctx.backoff, issue.id, Date.now(), ctx.config.reviewRetryMs);
    log("review.pending", { ticket: issue.identifier, retryMinutes: minutes(ctx.config.reviewRetryMs) });
    return true;
  }
  await settle(ctx, issue, result, after, (state) => state !== STATE.agentReview);
  return true;
}

async function stepWork(ctx: Context, issue: Issue): Promise<void> {
  const result = await run(ctx, "work", issue, issue.identifier, ctx.config.timeoutWorkMs);
  if (!result) return;
  const after = await ctx.linear.issue(issue.identifier);
  await settle(ctx, issue, result, after, (s) => s === STATE.agentReview || s === STATE.needsHuman);
}

async function stepFix(ctx: Context): Promise<boolean> {
  const issue = pickFix(await ctx.linear.issuesInState(STATE.inProgress));
  if (!issue) return false;
  await relabel(ctx, issue, { remove: [LABEL.changesRequested] });
  await comment(ctx, issue, `Agent: claimed by poller (${nowIso()})`);
  await stepWork(ctx, issue);
  return true;
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
    await move(ctx, issue, STATE.inProgress);
    await comment(ctx, issue, `Agent: claimed by poller (${nowIso()})`);
    await stepWork(ctx, issue);
    return true;
  }
  return false;
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
    const ids = await linear.resolveIds(
      [STATE.backlog, STATE.ready, STATE.inProgress, STATE.agentReview, STATE.needsHuman],
      Object.values(LABEL),
    );
    ctx = {
      config,
      linear,
      ids,
      viewerId: await linear.viewerId(),
      opencodeBin: await resolveOpencodeBin(),
      backoff: new Map(),
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
