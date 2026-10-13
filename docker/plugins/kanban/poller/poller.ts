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
// Agents get their facts as `<ID> ctx:<json>` and the whole ticket as a JSON snapshot file
// (`ctx.ticketFile`). They never write to Linear: they end their reply with `KANBAN-RESULT: <json>`
// and the poller applies the result (state, label, comment).
// Runs are opencode sessions started over HTTP. Passes never wait for them: each run is a job in a
// table, settled asynchronously; at most `maxAutomated` work/fix/review jobs run at once, and
// investigations run alongside.
// Never logs keys, tokens, comment bodies, or ticket text.
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { claimIssue, releaseClaim } from "./claims.ts";
import { FetchError, GitError, createGit, dirExists, type Git } from "./git.ts";
import { GitHubError, createGh, ensureInstallationId, type Gh } from "./github.ts";
import { createDocker, type Docker } from "./docker.ts";
import { LinearClient, LinearError, type Ids } from "./linear.ts";
import { log } from "./log.ts";
import { describeRun, runAgent, type RunResult } from "./runner.ts";
import { createKeyedMutex } from "./serial.ts";
import {
  INVESTIGATE_WINDOW_MS,
  LABEL,
  REACTION,
  STATE,
  autoLabelTargets,
  buildTicketSnapshot,
  investigationComment,
  investigationFilePath,
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
  oneLine,
  parseResult,
  EXCLUDE_PATTERNS,
  MAX_SLOT,
  checkoutPlan,
  excludeAppend,
  isWithin,
  orphanDirs,
  orphanPass,
  lanesDirSafe,
  orphanStackProjects,
  partitionProjects,
  sharedProjectBlocker,
  worktreeBlocker,
  repoFromOrigin,
  type CheckoutFacts,
  type WorkerContext,
  pendingSince,
  CLEANUP_RECHECK_MS,
  MAIN_RETRY_MS,
  abandonedLanes,
  fixWritesPending,
  fetchFailureDecision,
  isDue,
  retriesTotal,
  retryComment,
  workVerificationFailedActions,
  type RunLane,
  addLane,
  autoMergeDecision,
  keepMainPending,
  latestChangesRequestedAt,
  retriesUsed,
  retryDecision,
  type MainOutcome,
  type RunFailure,
  cleanupIdentifiers,
  isCleanupState,
  mainUpdateDecision,
  type ProjectConfig,
  automatedIdentifiers,
  canStartAutomated,
  hasCapacity,
  readyCandidates,
  refinementLabel,
  removeLane,
  reviewCandidates,
  reviewGate,
  reviewerMessage,
  reviewResultActions,
  staleClaims,
  ticketFilePath,
  ticketsDir,
  viewerClaimReactionIds,
  workerMessage,
  workResultActions,
  worktreePath,
  worktreePlan,
  worktreeRelPath,
  type Action,
  type LiveJob,
  type Comment,
  type GateDecision,
  type Issue,
  type PrInfo,
  type Project,
  type ResultByKind,
  type Target,
  type TimedComment,
} from "./select.ts";

// Shorter than the container stop_grace_period (60 s) so the last Linear writes still happen.
const SHUTDOWN_GRACE_MS = 50_000;
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
  gh: Gh;
  git: Git;
  docker: Docker;
  jobs: Map<string, Job>;
  /** Done tickets updated after this time still need their project's main checkout checked. */
  mainCheckedAt: string;
  /** Projects whose main checkout still needs an update; seeded with all projects on the first pass. */
  mainPending: Map<string, { project: ProjectConfig; lastTryMs: number | null; lastReason: string | null }>;
  mainSeeded: boolean;
  /** One git fetch per project path at a time. */
  fetchLocked: ReturnType<typeof createKeyedMutex>;
  /** Consecutive failed fetches per project path; reset by a successful fetch. */
  fetchFailures: Map<string, number>;
  /** When each worktree directory was last looked up for cleanup (epoch ms), keyed by path. */
  cleanupChecked: Map<string, number>;
  /** Orphan candidates seen in the previous pass, per project path (the two-pass rule). */
  orphanSeen: Map<string, Set<string>>;
}

type JobKind = "work" | "fix" | "review" | "investigate";

interface Job extends LiveJob {
  key: string;
  kind: JobKind;
  sessionId: string | null;
  startedAt: number;
  abort: AbortController;
  promise: Promise<void>;
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

/** Claims the ticket: the new reaction is added before older ones are removed. Call before moving or relabelling. */
async function claim(ctx: Context, issue: Issue): Promise<void> {
  if (ctx.config.dryRun) return log("dry-run.claim", { ticket: issue.identifier });
  await claimIssue(ctx.linear, issue, ctx.viewerId);
  log("claimed", { ticket: issue.identifier });
}

/** Removes the poller's claim reactions (the ticket is no longer being worked on). */
async function unclaim(ctx: Context, issue: Issue): Promise<void> {
  if (ctx.config.dryRun) return log("dry-run.unclaim", { ticket: issue.identifier });
  await releaseClaim(ctx.linear, issue.identifier, ctx.viewerId);
}

/** `git fetch`, one at a time per project path (concurrent fetches fight over the same ref locks). */
const fetchRepo = (ctx: Context, path: string, repo: string): Promise<void> =>
  ctx.fetchLocked(path, async () => {
    try {
      await ctx.git.fetch(path, repo);
      ctx.fetchFailures.delete(path);
    } catch (error) {
      if (error instanceof FetchError) ctx.fetchFailures.set(path, (ctx.fetchFailures.get(path) ?? 0) + 1);
      throw error;
    }
  });

const fetchFailuresFor = (ctx: Context, path: string) => fetchFailureDecision(ctx.fetchFailures.get(path) ?? 0);

// ── Agent runs and jobs ──

const liveJobs = (ctx: Context): Job[] => [...ctx.jobs.values()];
const hasAutomatedJob = (ctx: Context, identifier: string) => automatedIdentifiers(liveJobs(ctx)).has(identifier);

/**
 * Starts `body` as a job without waiting for it. Errors are logged per job, never thrown;
 * `cleanup` always runs, then the job leaves the table.
 */
function launch(
  ctx: Context,
  spec: { key: string; identifier: string; kind: JobKind },
  body: (job: Job) => Promise<void>,
  cleanup: () => Promise<void>,
): void {
  const job: Job = {
    ...spec,
    automated: spec.kind !== "investigate",
    sessionId: null,
    startedAt: Date.now(),
    abort: new AbortController(),
    promise: Promise.resolve(),
  };
  if (stopping) job.abort.abort();
  ctx.jobs.set(spec.key, job);
  job.promise = (async () => {
    try {
      await body(job);
    } catch (error) {
      const kind = error instanceof LinearError ? "linear" : error instanceof GitHubError ? "github" : "internal";
      log("job.error", { ticket: spec.identifier, kind: spec.kind, errorKind: kind, message: (error as Error).message });
    } finally {
      try {
        await cleanup();
      } catch (error) {
        log("job.cleanup-error", { ticket: spec.identifier, message: (error as Error).message });
      }
      ctx.jobs.delete(spec.key);
    }
  })();
}

interface AgentRun extends RunResult {
  /** Contents of the investigation report file (investigate runs only). */
  report: string | null;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Writes the ticket snapshot the agent reads (atomic) and clears any stale report file. Throws on failure. */
async function writeTicketFile(ctx: Context, project: Project, runId?: string): Promise<void> {
  if (ctx.config.dryRun) return log("dry-run.ticket-file", { ticket: project.identifier });
  const data = await ctx.linear.ticketData(project.identifier);
  await mkdir(ticketsDir(project.path), { recursive: true });
  await rm(investigationFilePath(project.path, project.identifier, runId), { force: true });
  await writeJsonAtomic(ticketFilePath(project.path, project.identifier, runId), buildTicketSnapshot(data, ctx.viewerId));
}

async function removeTicketFiles(ctx: Context, project: Project, runId?: string): Promise<void> {
  if (ctx.config.dryRun) return;
  await rm(ticketFilePath(project.path, project.identifier, runId), { force: true });
  await rm(investigationFilePath(project.path, project.identifier, runId), { force: true });
}

/** Runs `fn`; if it throws, the ticket snapshot written before it is removed. */
async function withSnapshotCleanup(ctx: Context, project: Project, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    await removeTicketFiles(ctx, project);
    throw error;
  }
}

async function run(
  ctx: Context,
  job: Job,
  project: Project,
  message: string,
  timeoutMs: number,
  runId?: string,
): Promise<AgentRun | null> {
  const { agent, command } = AGENT[job.kind === "fix" ? "work" : job.kind];
  const ticket = project.identifier;
  if (ctx.config.dryRun) {
    log("dry-run.run", { ticket, agent, command });
    return null;
  }
  const result = await runAgent({
    url: ctx.config.opencodeUrl,
    username: ctx.config.opencodeUsername,
    password: ctx.config.opencodePassword,
    agent,
    command,
    message,
    dir: project.path,
    title: `kanban ${job.kind} ${ticket}`,
    timeoutMs,
    signal: job.abort.signal,
    onSession: (sessionId) => {
      job.sessionId = sessionId;
      log("run.start", { ticket, agent, command, session: sessionId });
    },
    onEvent: (event, detail) =>
      log(event === "permission-rejected" ? "run.permission-rejected" : "run.poll-error", { ticket, detail }),
  });
  log("run.end", {
    ticket,
    agent,
    failed: result.error !== null,
    timedOut: result.timedOut,
    aborted: result.aborted,
    seconds: Math.round(result.durationMs / 1000),
  });
  const report =
    job.kind === "investigate" ? await readIfPresent(investigationFilePath(project.path, ticket, runId)) : null;
  return { ...result, report };
}

async function applyActions(ctx: Context, issue: Issue, actions: Action[]): Promise<void> {
  for (const action of actions) {
    if (action.kind === "comment") await comment(ctx, issue, action.body);
    else if (action.kind === "label") await relabel(ctx, issue, { add: [action.add] });
    else await move(ctx, issue, action.state);
  }
}

/** Puts the ticket back to the lane its run started from, so the next pass picks it up again. */
async function requeue(ctx: Context, issue: Issue, lane: RunLane): Promise<void> {
  if (lane === "work") await move(ctx, issue, STATE.ready);
  else if (lane === "fix") await relabel(ctx, issue, { add: [LABEL.changesRequested] });
}

/** Retry comments of the poller for the lane: since the ticket entered it, and over the whole ticket. */
async function retriesInLane(ctx: Context, issue: Issue, lane: RunLane): Promise<{ used: number; total: number }> {
  const comments = await ctx.linear.issueComments(issue.identifier);
  const since =
    lane === "fix"
      ? latestChangesRequestedAt(comments, ctx.viewerId)
      : await ctx.linear.lastEnteredStateAt(issue.identifier, lane === "work" ? STATE.ready : STATE.agentReview);
  return {
    used: retriesUsed(comments, since, lane, ctx.viewerId),
    total: retriesTotal(comments, lane, ctx.viewerId),
  };
}

/**
 * Applies an agent's result marker.
 * - Session that could not be aborted: Needs human, never a retry or requeue (a second agent would share its worktree).
 * - Poller stop: the ticket goes back to its start lane, no comment, no retry used (`run.requeued`).
 * - Timeout, agent error, or missing/invalid marker: one automatic retry (see `retryDecision`), persisted as an
 *   `Agent: retrying` comment; the second failure sends the ticket to Needs human.
 */
async function settleRun<K extends "work" | "review">(
  ctx: Context,
  issue: Issue,
  kind: K,
  result: RunResult,
  decide: (parsed: ResultByKind[K]) => Promise<Action[]>,
  retry: { lane: RunLane; pushed: () => Promise<boolean> },
): Promise<void> {
  if (result.stuck) return needsHuman(ctx, issue, describeRun(result));
  if (result.aborted) {
    await requeue(ctx, issue, retry.lane);
    return log("run.requeued", { ticket: issue.identifier, lane: retry.lane });
  }
  let failure: { kind: RunFailure; reason: string };
  if (result.timedOut) {
    failure = { kind: "timeout", reason: describeRun(result) };
  } else if (result.error !== null) {
    failure = { kind: "error", reason: describeRun(result) };
  } else {
    const parsed = parseResult(kind, result.output);
    if (parsed.ok) {
      log("run.result", { ticket: issue.identifier, kind, outcome: parsed.result.outcome });
      return applyActions(ctx, issue, await decide(parsed.result));
    }
    failure = { kind: "marker", reason: `agent result: ${parsed.reason}` };
  }
  const budget = await retriesInLane(ctx, issue, retry.lane);
  const retryable = retryDecision({
    kind: retry.lane,
    failure: failure.kind,
    pushed: retry.lane === "review" ? false : await retry.pushed(),
    retriesUsed: budget.used,
    retriesTotal: budget.total,
  });
  if (!retryable) return needsHuman(ctx, issue, failure.reason);
  // Move first, comment second: the comment must be newer than the lane entry to count against the budget.
  await requeue(ctx, issue, retry.lane);
  await comment(ctx, issue, retryComment(retry.lane, failure.reason));
  log("run.retry", { ticket: issue.identifier, lane: retry.lane, failure: failure.kind });
}

// ── Pass steps. Each returns how many jobs it started. ──

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

const investigationKey = (requestId: string) => `investigate:${requestId}`;

async function failInvestigation(ctx: Context, issue: Issue, request: Comment, reason: string): Promise<void> {
  log("investigate.skip", { ticket: issue.identifier, reason });
  await comment(ctx, issue, `Agent investigation: failed — ${reason}`, request.id);
  await react(ctx, request, REACTION.failed);
}

async function stepInvestigate(ctx: Context): Promise<number> {
  let started = 0;
  const since = new Date(Date.now() - INVESTIGATE_WINDOW_MS).toISOString();
  const comments = await ctx.linear.commentsSince(since);
  for (const { comment: request, question } of investigateRequests(comments, ctx.viewerId, Date.now())) {
    if (stopping) break;
    if (ctx.jobs.has(investigationKey(request.id))) continue;
    const issue = await ctx.linear.issue(request.issueIdentifier);
    const project = issueProject(issue);
    if ("error" in project) {
      await failInvestigation(ctx, issue, request, project.error);
      continue;
    }
    const blocker = (await ensureCheckout(ctx, project)) ?? (await ensureIgnored(ctx, project));
    if (blocker) {
      await failInvestigation(ctx, issue, request, blocker);
      continue;
    }
    try {
      await writeTicketFile(ctx, project, request.id);
    } catch (error) {
      await failInvestigation(ctx, issue, request, `ticket snapshot failed: ${oneLine((error as Error).message)}`);
      continue;
    }
    // The eyes reaction is the claim. Without it the request would run again every pass.
    if (!(await react(ctx, request, REACTION.claimed))) {
      await removeTicketFiles(ctx, project, request.id);
      continue;
    }
    launch(
      ctx,
      { key: investigationKey(request.id), identifier: issue.identifier, kind: "investigate" },
      (job) => investigate(ctx, job, issue, project, request, question),
      () => removeTicketFiles(ctx, project, request.id),
    );
    started++;
  }
  return started;
}

async function investigate(
  ctx: Context,
  job: Job,
  issue: Issue,
  project: Project,
  request: Comment,
  question: string,
): Promise<void> {
  const result = await run(
    ctx,
    job,
    project,
    investigatorMessage(project, question, request.id),
    ctx.config.timeoutInvestigateMs,
    request.id,
  );
  if (!result) return;
  const outcome = investigationOutcome({ ...result, minutes: minutes(result.durationMs) }, result.output, result.report);
  if (outcome.emoji === REACTION.done) {
    await comment(ctx, issue, investigationComment(outcome.report), request.id);
    await react(ctx, request, REACTION.done);
  } else {
    await comment(ctx, issue, `Agent investigation: failed — ${outcome.reason}`, request.id);
    await react(ctx, request, REACTION.failed);
  }
}

const FENCE = "```";

async function checkoutFacts(ctx: Context, project: ProjectConfig): Promise<CheckoutFacts> {
  let info;
  try {
    info = await stat(project.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { kind: "missing", empty: true, isRepoRoot: false, originRepo: null };
  }
  if (!info.isDirectory()) return { kind: "other", empty: false, isRepoRoot: false, originRepo: null };
  const empty = (await readdir(project.path)).length === 0;
  const top = await ctx.git.topLevel(project.path);
  const isRepoRoot = top !== null && (await realpath(top)) === (await realpath(project.path));
  let originRepo: string | null = null;
  if (isRepoRoot) {
    try {
      originRepo = repoFromOrigin(await ctx.git.originUrl(project.path));
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
    }
  }
  return { kind: "dir", empty, isRepoRoot, originRepo };
}

/**
 * Makes sure the project's checkout exists and holds the right repository: clones a missing (or empty) directory
 * over HTTPS, never into a non-empty directory that is not a repository, and refuses a repository whose origin is
 * another repo (path collision). Returns the reason it cannot be used, or null.
 */
async function ensureCheckout(ctx: Context, project: ProjectConfig): Promise<string | null> {
  try {
    const plan = checkoutPlan(project.path, project.repo, await checkoutFacts(ctx, project));
    if (plan.kind === "problem") return plan.reason;
    if (plan.kind === "ready") return null;
    if (ctx.config.dryRun) {
      log("dry-run.clone", { repo: project.repo });
      return null;
    }
    log("clone.start", { repo: project.repo });
    await ctx.fetchLocked(project.path, () => ctx.git.clone(project.repo, project.path));
    const after = checkoutPlan(project.path, project.repo, await checkoutFacts(ctx, project));
    if (after.kind !== "ready") return `git clone of ${project.repo} into ${project.path} did not produce the repository`;
    log("clone.done", { repo: project.repo });
    return null;
  } catch (error) {
    return error instanceof GitError ? error.message : `checkout check failed: ${(error as Error).message}`;
  }
}

/** Adds the poller's directories to the checkout's `.git/info/exclude` (shared by all worktrees; nothing to commit). */
async function addExcludes(ctx: Context, path: string): Promise<void> {
  const file = `${await ctx.git.commonGitDir(path)}/info/exclude`;
  let content: string | null = null;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const updated = excludeAppend(content, EXCLUDE_PATTERNS);
  if (updated === null) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, updated);
}

/**
 * Makes sure `.slim/worktrees/` (snapshots and worktrees live there) is git-ignored: if not, it is added to
 * `.git/info/exclude`, so the repo itself needs no change. Returns the reason it still is not, or null.
 */
async function ensureIgnored(ctx: Context, project: Project): Promise<string | null> {
  if (ctx.config.dryRun && !(await dirExists(project.path))) return null;
  // Probe a path inside the worktree so directory-only ignore patterns match too.
  const probe = `${worktreeRelPath(project.identifier)}/.probe`;
  try {
    if (await ctx.git.isIgnored(project.path, probe)) return null;
    if (ctx.config.dryRun) {
      log("dry-run.exclude", { repo: project.repo });
      return null;
    }
    await addExcludes(ctx, project.path);
    if (await ctx.git.isIgnored(project.path, probe)) {
      log("exclude.added", { repo: project.repo });
      return null;
    }
    return `.slim/worktrees is not git-ignored in ${project.path}, and adding it to .git/info/exclude did not help`;
  } catch (error) {
    return `git check failed: ${(error as Error).message}`;
  }
}

/** Why the ticket cannot be worked on (config, checkout, origin, ignore rules), as a Target when it can. */
async function preflight(ctx: Context, issue: Issue): Promise<Target | string> {
  const target = issueTarget(issue);
  if ("error" in target) return target.error;
  return (await ensureCheckout(ctx, target)) ?? (await ensureIgnored(ctx, target)) ?? target;
}

async function writeJsonAtomic(file: string, registry: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(temp, file);
}

/** Names of the directories under `<path>/.slim/worktrees/`. */
async function worktreeDirNames(path: string): Promise<string[]> {
  try {
    return (await readdir(`${path}/.slim/worktrees`, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Registry writes only happen inside a pass (prepare and cleanup run in the sequential pass loop; job
// continuations never touch the registry), so a plain atomic write is enough.
async function addLaneEntry(target: Target, defaultBranch: string): Promise<number> {
  const file = `${target.path}/.slim/worktrees.json`;
  let registry: unknown = null;
  try {
    registry = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new GitError("worktree registry unreadable");
  }
  // The poller's own lanes whose worktree is gone (a cleanup that failed to update the registry) free their slot.
  const abandoned = abandonedLanes(registry, new Set(await worktreeDirNames(target.path)));
  const added = addLane(
    registry,
    {
      slug: target.identifier.toLowerCase(),
      branch: target.branch,
      base: defaultBranch,
      purpose: `ticket ${target.identifier}`,
    },
    nowIso(),
    abandoned,
  );
  if (!added) throw new GitError("worktree registry malformed");
  if (added.slot > MAX_SLOT) throw new GitError(`no free port slot (slots 1..${MAX_SLOT} are all in use)`);
  if (added.registry !== registry) {
    try {
      await writeJsonAtomic(file, added.registry);
    } catch {
      throw new GitError("worktree registry not writable");
    }
  }
  return added.slot;
}

/** Fetches and creates or reuses the ticket's worktree. Throws FetchError (transient) or GitError. */
async function ensureWorktree(ctx: Context, target: Target, defaultBranch: string): Promise<void> {
  const worktree = worktreePath(target.path, target.identifier);
  await fetchRepo(ctx, target.path, target.repo);
  const plan = worktreePlan({
    worktreeExists: (await dirExists(worktree)) && (await registeredWorktree(ctx, target.path, worktree)) !== null,
    localBranch: (await ctx.git.revParse(target.path, `refs/heads/${target.branch}`)) !== null,
    remoteBranch: (await ctx.git.revParse(target.path, `refs/remotes/origin/${target.branch}`)) !== null,
    defaultBranch,
    branch: target.branch,
  });
  if (plan.kind !== "reuse") await ctx.git.worktreeAdd(target.path, worktree, plan);
  log("worktree.ensured", { ticket: target.identifier, plan: plan.kind });
}

/** The worktree plus its lane with a slot (returned). Throws FetchError or GitError. */
async function prepareWorktree(ctx: Context, target: Target, defaultBranch: string): Promise<number> {
  if (ctx.config.dryRun) {
    log("dry-run.worktree", { ticket: target.identifier });
    return 1;
  }
  await ensureWorktree(ctx, target, defaultBranch);
  const slot = await addLaneEntry(target, defaultBranch);
  log("worktree.ready", { ticket: target.identifier, slot });
  return slot;
}

/**
 * Asks the worker for a fix round: comment first (it carries the round count), then label, then move.
 * `resume` = a previous attempt already wrote the comment but the label or move failed: only those are redone,
 * so a retry never adds a second round.
 */
async function postFixRequest(
  ctx: Context,
  issue: Issue,
  target: Target,
  pr: PrInfo,
  rounds: number,
  cause: "ci" | "conflict",
  failed: string[],
  resume: boolean,
): Promise<void> {
  let parentId: string | undefined;
  if (!resume) {
    const summary = cause === "ci" ? `CI failed: ${oneLine(failed.join(", "))}` : `merge conflicts with ${pr.baseRefName}`;
    parentId = await comment(
      ctx,
      issue,
      `Agent review: changes requested (round ${rounds + 1}/${MAX_REVIEW_ROUNDS}) — ${pr.url}\n${summary}`,
    );
  }
  await relabel(ctx, issue, { add: [LABEL.changesRequested] });
  await move(ctx, issue, STATE.inProgress);
  if (cause === "ci" && parentId) {
    const tail = await ctx.gh.failedLogTail(target.repo, pr, MAX_LOG_REPLY_LINES);
    if (tail) await comment(ctx, issue, `${FENCE}\n${tail.replaceAll(FENCE, "'".repeat(3))}\n${FENCE}`, parentId);
  }
  log(resume ? "review.fix-resumed" : "review.fix", { ticket: issue.identifier, cause, round: resume ? rounds : rounds + 1 });
}

/** Review rounds used since the ticket last entered Ready for agent (each human request starts fresh). */
async function roundsUsed(ctx: Context, issue: Issue, known?: TimedComment[]): Promise<number> {
  const comments = known ?? (await ctx.linear.issueComments(issue.identifier));
  return changesRequestedRounds(comments, await ctx.linear.lastEnteredStateAt(issue.identifier, STATE.ready), ctx.viewerId);
}

type AutoMerge = "merged" | "fallthrough" | "retry";

/**
 * Tries to merge the base branch into a conflicting PR branch without an agent: in the ticket worktree,
 * only when it is clean and at the PR head, then pushes (no force). No lane or setup hook is involved.
 * - "merged": pushed; the ticket stays in Agent review.
 * - "fallthrough": conflicts, a dirty or moved worktree, or a git failure; the worktree is as it was and the agent
 *   gets the fix request.
 * - "retry": a transient fetch error; nothing changed, try again next pass.
 */
async function autoMergeBase(ctx: Context, issue: Issue, target: Target, pr: PrInfo): Promise<AutoMerge> {
  if (ctx.config.dryRun) {
    log("dry-run.auto-merge", { ticket: issue.identifier });
    return "fallthrough";
  }
  const skip = (reason: string): AutoMerge => {
    log("review.auto-merge-skip", { ticket: issue.identifier, reason });
    return "fallthrough";
  };
  try {
    await ensureWorktree(ctx, target, await ctx.gh.defaultBranch(target.repo));
    const worktree = worktreePath(target.path, target.identifier);
    const decision = autoMergeDecision({
      dirty: (await ctx.git.statusPorcelain(worktree)) !== "",
      head: await ctx.git.revParse(worktree, "HEAD"),
      prHead: pr.headRefOid,
    });
    if (decision.kind === "skip") return skip(decision.reason);
    const merged = await ctx.git.mergeBase(worktree, `origin/${pr.baseRefName}`);
    if (merged === "conflict") return skip("merge conflicts");
    if (merged === "uptodate") return skip("base already merged");
    try {
      await ctx.git.push(worktree, target.repo, target.branch);
    } catch (error) {
      await ctx.git.resetHard(worktree, pr.headRefOid);
      throw error;
    }
  } catch (error) {
    if (error instanceof FetchError) {
      log("review.fetch-error", { ticket: issue.identifier, message: error.message });
      return fetchFailuresFor(ctx, target.path) === "skip" ? "retry" : "fallthrough";
    }
    if (!(error instanceof GitError || error instanceof GitHubError)) throw error;
    log("review.auto-merge-error", { ticket: issue.identifier, message: error.message });
    return "fallthrough";
  }
  await comment(ctx, issue, `Agent: merged ${pr.baseRefName} into the branch (no conflicts)`);
  log("review.auto-merged", { ticket: issue.identifier, base: pr.baseRefName });
  return "merged";
}

async function stepReview(ctx: Context): Promise<number> {
  let started = 0;
  for (const issue of reviewCandidates(await ctx.linear.issuesInState(STATE.agentReview))) {
    if (stopping) break;
    if (hasAutomatedJob(ctx, issue.identifier)) continue;
    const target = issueTarget(issue);
    if ("error" in target) {
      await needsHuman(ctx, issue, target.error);
      continue;
    }
    let pr: PrInfo | null;
    let decision: GateDecision;
    let rounds: number;
    let comments: TimedComment[];
    try {
      pr = await ctx.gh.findPr(target.repo, target.branch);
      const checks = pr?.state === "OPEN" ? await ctx.gh.checks(target.repo, pr.number) : [];
      comments = await ctx.linear.issueComments(issue.identifier);
      rounds = await roundsUsed(ctx, issue, comments);
      decision = reviewGate(
        pr,
        checks,
        rounds,
        Date.now(),
        pr ? pendingSince(pr, checks) : null,
        ctx.config.ciPendingTimeoutMs,
      );
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
      const resume = fixWritesPending(
        comments,
        ctx.viewerId,
        await ctx.linear.lastEnteredStateAt(issue.identifier, STATE.agentReview),
      );
      if (!resume && decision.cause === "conflict") {
        const merged = await autoMergeBase(ctx, issue, target, pr!);
        if (merged !== "fallthrough") continue;
      }
      try {
        await postFixRequest(ctx, issue, target, pr!, rounds, decision.cause, decision.failed, resume);
      } catch (error) {
        const kind = error instanceof GitHubError ? "github" : error instanceof LinearError ? "linear" : "internal";
        log("review.fix-error", { ticket: issue.identifier, kind, message: (error as Error).message });
      }
      continue;
    }

    if (!hasCapacity(liveJobs(ctx), ctx.config.maxAutomated)) {
      log("review.queued", { ticket: issue.identifier });
      continue;
    }
    const message = reviewerMessage(target, {
      base: pr!.baseRefName,
      pr: { number: pr!.number, url: pr!.url },
      round: rounds,
      ci: decision.ci,
    });
    try {
      await writeTicketFile(ctx, target);
    } catch (error) {
      await needsHuman(ctx, issue, `ticket snapshot failed: ${oneLine((error as Error).message)}`);
      continue;
    }
    const prUrl = pr!.url;
    launch(
      ctx,
      { key: issue.identifier, identifier: issue.identifier, kind: "review" },
      async (job) => {
        const result = await run(ctx, job, target, message, ctx.config.timeoutReviewMs);
        if (!result) return;
        await settleRun(
          ctx,
          issue,
          "review",
          result,
          async (parsed) => reviewResultActions(parsed, { round: rounds, prUrl }),
          { lane: "review", pushed: async () => false },
        );
      },
      () => removeTicketFiles(ctx, target),
    );
    started++;
  }
  return started;
}

const PR_LOOKUP_ATTEMPTS = 3;
const PR_LOOKUP_DELAY_MS = 5_000;

type BranchPr = { readable: true; pr: PrInfo | null } | { readable: false };

/** The PR on the ticket branch. GitHub errors are retried a few times, then reported as unreadable (not as "no PR"). */
async function branchPr(ctx: Context, target: Target): Promise<BranchPr> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { readable: true, pr: await ctx.gh.findPr(target.repo, target.branch) };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log("work.github-error", { ticket: target.identifier, attempt, message: error.message });
      if (attempt >= PR_LOOKUP_ATTEMPTS || stopping) return { readable: false };
      await new Promise((resolve) => setTimeout(resolve, PR_LOOKUP_DELAY_MS));
    }
  }
}

const remoteBranchHead = (ctx: Context, target: Target) =>
  ctx.git.revParse(target.path, `refs/remotes/origin/${target.branch}`);

function startWork(ctx: Context, issue: Issue, target: Target, kind: "work" | "fix", message: string): void {
  launch(
    ctx,
    { key: issue.identifier, identifier: issue.identifier, kind },
    async (job) => {
      const before = await remoteBranchHead(ctx, target);
      const result = await run(ctx, job, target, message, ctx.config.timeoutWorkMs);
      if (!result) return;
      // Anything that cannot be ruled out counts as pushed: a retry could redo or clash with pushed work.
      const pushed = async () => {
        try {
          await fetchRepo(ctx, target.path, target.repo);
          return (await remoteBranchHead(ctx, target)) !== before;
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          return true;
        }
      };
      await settleRun(
        ctx,
        issue,
        "work",
        result,
        async (parsed) => {
          if (parsed.outcome !== "review") return workResultActions(parsed, null);
          const found = await branchPr(ctx, target);
          return found.readable ? workResultActions(parsed, found.pr) : workVerificationFailedActions();
        },
        { lane: kind, pushed },
      );
    },
    // Whatever the outcome (settled, retried, requeued, failed), the claim of this run ends with the job.
    async () => {
      try {
        await removeTicketFiles(ctx, target);
      } finally {
        await unclaim(ctx, issue);
      }
    },
  );
}

type Prepared = { status: "ready"; slot: number } | { status: "skip" | "failed" };

/**
 * Prepares the worktree (with its lane slot) and the ticket snapshot, before the ticket is claimed or moved.
 * - "ready": go on, with the lane's slot.
 * - "skip": a transient `git fetch` error; nothing changed, the ticket is looked at again next pass.
 * - "failed": the ticket went to Needs human (worktree add, repeated fetch failure, or snapshot failure).
 */
async function prepareRun(
  ctx: Context,
  issue: Issue,
  target: Target,
  defaultBranch: string,
  kind: "work" | "fix",
): Promise<Prepared> {
  let slot: number;
  try {
    slot = await prepareWorktree(ctx, target, defaultBranch);
  } catch (error) {
    if (error instanceof FetchError) {
      log(`${kind}.fetch-error`, { ticket: issue.identifier, message: error.message });
      if (fetchFailuresFor(ctx, target.path) === "skip") return { status: "skip" };
      await needsHuman(ctx, issue, `git fetch failing repeatedly: ${oneLine(error.message).slice(0, 120)}`);
      return { status: "failed" };
    }
    if (!(error instanceof GitError)) throw error;
    await needsHuman(ctx, issue, `worktree setup failed: ${oneLine(error.message)}`);
    return { status: "failed" };
  }
  try {
    await writeTicketFile(ctx, target);
  } catch (error) {
    await needsHuman(ctx, issue, `ticket snapshot failed: ${oneLine((error as Error).message)}`);
    return { status: "failed" };
  }
  return { status: "ready", slot };
}

async function stepFix(ctx: Context): Promise<number> {
  let started = 0;
  for (const issue of fixCandidates(await ctx.linear.issuesInState(STATE.inProgress))) {
    if (stopping) break;
    if (!canStartAutomated(issue.identifier, liveJobs(ctx), ctx.config.maxAutomated)) continue;
    const target = await preflight(ctx, issue);
    if (typeof target === "string") {
      await needsHuman(ctx, issue, target);
      continue;
    }
    let context: Omit<WorkerContext, "slot">;
    try {
      const comments = await ctx.linear.issueComments(issue.identifier);
      const rounds = await roundsUsed(ctx, issue, comments);
      const pr = await ctx.gh.findPr(target.repo, target.branch);
      context = {
        defaultBranch: await ctx.gh.defaultBranch(target.repo),
        pr: pr ? { number: pr.number, url: pr.url } : undefined,
        round: rounds,
        fix: latestFixRequest(comments, ctx.viewerId),
      };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log("fix.github-error", { ticket: issue.identifier, message: error.message });
      continue;
    }
    const prepared = await prepareRun(ctx, issue, target, context.defaultBranch, "fix");
    if (prepared.status !== "ready") continue;
    // Claim first: a failure between the two writes leaves a ticket that is still picked up, never a limbo.
    await withSnapshotCleanup(ctx, target, async () => {
      await claim(ctx, issue);
      await relabel(ctx, issue, { remove: [LABEL.changesRequested] });
    });
    startWork(ctx, issue, target, "fix", workerMessage(target, { ...context, slot: prepared.slot }));
    started++;
  }
  return started;
}

async function stepNewWork(ctx: Context): Promise<number> {
  let started = 0;
  for (const issue of readyCandidates(await ctx.linear.issuesInState(STATE.ready))) {
    if (stopping) break;
    const label = refinementLabel(issue);
    if (label) {
      await move(ctx, issue, STATE.backlog);
      await comment(ctx, issue, `Agent: not refined — remove ${label} first`);
      log("bounced", { ticket: issue.identifier, label });
      continue;
    }
    if (!canStartAutomated(issue.identifier, liveJobs(ctx), ctx.config.maxAutomated)) continue;
    const target = await preflight(ctx, issue);
    if (typeof target === "string") {
      await needsHuman(ctx, issue, target);
      continue;
    }
    let context: Omit<WorkerContext, "slot">;
    try {
      const existing = existingPrDecision(await ctx.gh.findPr(target.repo, target.branch));
      if (existing.kind === "needsHuman") {
        await needsHuman(ctx, issue, existing.reason);
        continue;
      }
      context = {
        defaultBranch: await ctx.gh.defaultBranch(target.repo),
        pr: existing.kind === "follow-up" ? existing.pr : undefined,
        round: await roundsUsed(ctx, issue),
      };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      log("work.github-error", { ticket: issue.identifier, message: error.message });
      continue;
    }
    const prepared = await prepareRun(ctx, issue, target, context.defaultBranch, "work");
    if (prepared.status !== "ready") continue;
    await withSnapshotCleanup(ctx, target, async () => {
      await claim(ctx, issue);
      await move(ctx, issue, STATE.inProgress);
    });
    startWork(ctx, issue, target, "work", workerMessage(target, { ...context, slot: prepared.slot }));
    started++;
  }
  return started;
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
  await writeJsonAtomic(file, updated);
}

/** The git worktree entry for `worktree` (plain or real path), or null if git does not list it. */
async function registeredWorktree(ctx: Context, path: string, worktree: string) {
  const entries = await ctx.git.worktreeBranches(path);
  const resolved = await realpath(worktree).catch(() => worktree);
  return entries.find((e) => e.path === worktree || e.path === resolved) ?? null;
}

/** Why the worktree must stay, or null if removing it loses nothing. */
async function cleanupBlocker(ctx: Context, target: Target, worktree: string, pr: PrInfo): Promise<string | null> {
  const entry = await registeredWorktree(ctx, target.path, worktree);
  return worktreeBlocker({
    registered: entry !== null,
    locked: entry?.locked ?? false,
    dirty: entry !== null && (await ctx.git.statusPorcelain(worktree)) !== "",
    branchHead: entry === null ? null : await ctx.git.revParse(target.path, `refs/heads/${target.branch}`),
    worktreeHead: entry === null ? null : await ctx.git.revParse(worktree, "HEAD"),
    prHead: pr.headRefOid,
  });
}

async function readRegistry(project: ProjectConfig): Promise<unknown> {
  try {
    return JSON.parse(await readFile(`${project.path}/.slim/worktrees.json`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GitError("worktree registry unreadable");
  }
}

const lanesDirOf = (path: string) => `${path}/.slim/worktrees`;

/**
 * Compose projects with containers started from `dir` (plain or real path): the ones used only from there
 * (exclusive: safe to take down) and the ones that also run from elsewhere (shared).
 */
async function stacksAt(ctx: Context, dir: string): Promise<{ exclusive: string[]; shared: string[] }> {
  const stacks = await ctx.docker.composeProjects();
  const realDir = await realpath(dir).catch(() => dir);
  const real = new Map<string, string>();
  for (const stack of stacks) real.set(stack.workingDir, await realpath(stack.workingDir).catch(() => stack.workingDir));
  return partitionProjects(stacks, (wd) => isWithin(wd, dir) || isWithin(real.get(wd) ?? wd, realDir));
}

/**
 * Takes down (with volumes) the compose stacks that were started only from `dir`. A project that also runs from
 * another directory is left alone (`teardown.shared-project`); their names are returned, and the caller must then
 * keep the directory. Throws DockerError.
 */
async function takeDownStacks(ctx: Context, dir: string, ticket: string): Promise<string[]> {
  const { exclusive, shared } = await stacksAt(ctx, dir);
  for (const project of shared) log("teardown.shared-project", { ticket, project });
  for (const project of exclusive) {
    await ctx.docker.composeDown(project);
    log("teardown.down", { ticket, project });
  }
  return shared;
}

/**
 * The lanes directory when `<path>/.slim/worktrees/<slug>` really is a directory directly under the checkout's own
 * worktrees directory (no symlinks anywhere in between); null if the lane directory does not exist.
 * Throws if it resolves anywhere else.
 */
async function checkedLaneDir(path: string, slug: string): Promise<string | null> {
  const lanesDir = lanesDirOf(path);
  const lanesReal = await realpath(lanesDir);
  if (lanesReal !== `${await realpath(path)}/.slim/worktrees`) throw new GitError(`refusing ${lanesDir}: it does not resolve to the checkout's own worktrees directory`);
  const target = `${lanesDir}/${slug}`;
  const real = await realpath(target).catch(() => null);
  if (real === null) return null;
  if (real !== `${lanesReal}/${slug}`) throw new GitError(`refusing ${target}: it does not resolve to itself`);
  return lanesDir;
}

/** Deletes a lane directory as root in a throwaway container (an orphan; stacks leave root-owned files). */
async function removeLaneDirectory(ctx: Context, path: string, slug: string): Promise<void> {
  const lanesDir = await checkedLaneDir(path, slug);
  if (lanesDir !== null) await ctx.docker.removeLaneDir(lanesDir, slug);
}

/** Gives a lane directory (a registered worktree with root-owned leftovers) to the poller's user. */
async function chownLaneDirectory(ctx: Context, path: string, slug: string): Promise<void> {
  const lanesDir = await checkedLaneDir(path, slug);
  if (lanesDir === null) return;
  await ctx.docker.chownLaneDir(lanesDir, slug, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
}

/** Drops a lane from `.slim/worktrees.json` by slug, whoever owns it (its directory is gone). */
async function dropLaneEntry(path: string, slug: string, ticket: string): Promise<void> {
  const file = `${path}/.slim/worktrees.json`;
  let registry: unknown;
  try {
    registry = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return log("cleanup.lanes-skip", { ticket, reason: "registry missing or unreadable" });
  }
  const updated = removeLane(registry, `${lanesDirOf(path)}/${slug}`, slug, nowIso());
  if (!updated) return log("cleanup.lanes-skip", { ticket, reason: "no matching lane" });
  await writeJsonAtomic(file, updated);
}

async function cleanupIssue(ctx: Context, issue: Issue, target: Target): Promise<void> {
  const worktree = worktreePath(target.path, target.identifier);
  const pr = await ctx.gh.findPr(target.repo, target.branch);
  if (!pr || !cleanupCandidate(issue.state, pr.state)) return;

  const blocker = await cleanupBlocker(ctx, target, worktree, pr);
  if (blocker) return log("cleanup.skip", { ticket: issue.identifier, reason: blocker });
  if (ctx.config.dryRun) {
    return log("dry-run.cleanup", { ticket: issue.identifier, stacks: (await stacksAt(ctx, worktree)).exclusive.length });
  }

  let shared: string[];
  try {
    shared = await takeDownStacks(ctx, worktree, issue.identifier);
  } catch (error) {
    return log("cleanup.skip", { ticket: issue.identifier, reason: "teardown failed", message: (error as Error).message });
  }
  const sharedReason = sharedProjectBlocker(shared);
  if (sharedReason) return log("cleanup.skip", { ticket: issue.identifier, reason: sharedReason });
  try {
    await ctx.git.worktreeRemove(target.path, worktree);
  } catch (error) {
    // Typically root-owned leftovers of a compose stack: hand them to the poller's user and try again, never force.
    log("cleanup.remove-fallback", { ticket: issue.identifier, message: (error as Error).message });
    try {
      await chownLaneDirectory(ctx, target.path, target.identifier.toLowerCase());
      await ctx.git.worktreeRemove(target.path, worktree);
    } catch (retry) {
      return log("cleanup.skip", { ticket: issue.identifier, reason: "worktree remove failed", message: (retry as Error).message });
    }
  }
  // Squash merges leave the branch unmerged in git's eyes; the head checks above make -D safe.
  await ctx.git.branchDelete(target.path, target.branch);
  log("cleanup.done", { ticket: issue.identifier, pr: pr.number });
  try {
    await removeLaneEntry(target, worktree);
  } catch (error) {
    // The worktree is gone; the stale lane no longer blocks its slot (see abandonedLanes).
    log("cleanup.lanes-error", { ticket: issue.identifier, message: (error as Error).message });
  }
}

/** Cleans up one worktree directory if its ticket is in a cleanup state and belongs to this project. */
async function cleanupTicket(ctx: Context, project: ProjectConfig, identifier: string): Promise<void> {
  const issue = await ctx.linear.findIssue(identifier);
  if (!issue || !isCleanupState(issue.state)) return;
  const target = issueTarget(issue);
  if ("error" in target || target.path !== project.path) return;
  await cleanupIssue(ctx, issue, target);
}

/** Worktree directories on disk are the candidates; Linear and GitHub then say whether each may go. */
async function cleanupProject(ctx: Context, project: ProjectConfig): Promise<void> {
  const dir = `${project.path}/.slim/worktrees`;
  if (!(await dirExists(dir))) return;
  const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const identifier of cleanupIdentifiers(names, await readRegistry(project))) {
    if (stopping) return;
    if (hasAutomatedJob(ctx, identifier)) continue;
    // Each directory costs a Linear and a GitHub lookup: not on every pass.
    const key = `${project.path}/${identifier}`;
    if (!isDue(ctx.cleanupChecked.get(key) ?? null, Date.now(), CLEANUP_RECHECK_MS)) continue;
    ctx.cleanupChecked.set(key, Date.now());
    try {
      await cleanupTicket(ctx, project, identifier);
    } catch (error) {
      const kind = error instanceof GitError ? "git" : error instanceof GitHubError ? "github" : error instanceof LinearError ? "linear" : "internal";
      log("cleanup.error", { ticket: identifier, kind, message: (error as Error).message });
    }
  }
}

async function stepCleanup(ctx: Context): Promise<void> {
  for (const project of await ctx.linear.projectConfigs()) {
    if (stopping) return;
    try {
      await cleanupProject(ctx, project);
    } catch (error) {
      log("cleanup.error", { kind: "project", message: (error as Error).message });
    }
  }
}

// ── Orphans: lane directories and stacks nobody owns (never consume the pass) ──

/** Lowercase identifiers of tickets with a live automated job. */
const liveSlugs = (ctx: Context): Set<string> =>
  new Set([...automatedIdentifiers(liveJobs(ctx))].map((identifier) => identifier.toLowerCase()));

const hasGitEntry = (dir: string): Promise<boolean> =>
  lstat(`${dir}/.git`).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

async function orphanProject(ctx: Context, project: ProjectConfig): Promise<void> {
  const lanesDir = lanesDirOf(project.path);
  const info = await lstat(lanesDir).catch(() => null);
  if (info === null) return;
  const lanesReal = await realpath(lanesDir);
  if (!lanesDirSafe({ isSymlink: info.isSymbolicLink(), lanesReal, projectReal: await realpath(project.path) })) {
    return log("orphan.skip-project", { repo: project.repo, reason: "worktrees directory is not the checkout's own" });
  }
  const dirents = await readdir(lanesDir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (e) => ({
      name: e.name,
      real: await realpath(`${lanesDir}/${e.name}`).catch(() => null),
      isDirectory: e.isDirectory(),
      hasGit: e.isDirectory() && (await hasGitEntry(`${lanesDir}/${e.name}`)),
    })),
  );
  const registered = new Set(
    await Promise.all((await ctx.git.worktreeBranches(project.path)).map((w) => realpath(w.path).catch(() => w.path))),
  );
  const { orphans, withGit } = orphanDirs({ worktreesReal: lanesReal, entries, registered, liveSlugs: liveSlugs(ctx) });
  for (const name of withGit) log("orphan.skip", { repo: project.repo, name, reason: "contains .git" });
  const stacks = orphanStackProjects(
    await ctx.docker.composeProjects(),
    [lanesDir, lanesReal],
    new Set(dirents.map((e) => e.name)),
    new Set(orphans),
  );

  const candidates = [...orphans.map((name) => `dir:${name}`), ...stacks.map((name) => `stack:${name}`)];
  const before = ctx.orphanSeen.get(project.path) ?? new Set<string>();
  const { due, seen } = orphanPass(before, candidates);
  ctx.orphanSeen.set(project.path, seen);

  for (const candidate of candidates) {
    const [kind, name] = [candidate.slice(0, candidate.indexOf(":")), candidate.slice(candidate.indexOf(":") + 1)];
    if (!due.includes(candidate)) {
      const inside = kind === "dir" ? (await stacksAt(ctx, `${lanesDir}/${name}`)).exclusive.length : 1;
      log("orphan.seen", { repo: project.repo, kind, name, stacks: inside, action: "removed if still orphaned next pass" });
      continue;
    }
    if (ctx.config.dryRun) {
      log("dry-run.orphan-remove", { repo: project.repo, kind, name });
      continue;
    }
    if (stopping) return;
    try {
      if (kind === "stack") {
        await ctx.docker.composeDown(name);
      } else {
        // Re-checked right before deleting: a job may have started, or a repo appeared, since the scan.
        if (liveSlugs(ctx).has(name)) continue;
        if (await hasGitEntry(`${lanesDir}/${name}`)) {
          log("orphan.skip", { repo: project.repo, name, reason: "contains .git" });
          continue;
        }
        const shared = await takeDownStacks(ctx, `${lanesDir}/${name}`, name);
        const sharedReason = sharedProjectBlocker(shared);
        if (sharedReason) {
          log("orphan.skip", { repo: project.repo, name, reason: sharedReason });
          continue;
        }
        await removeLaneDirectory(ctx, project.path, name);
        await dropLaneEntry(project.path, name, name);
      }
      log("orphan.removed", { repo: project.repo, kind, name });
    } catch (error) {
      log("orphan.error", { repo: project.repo, kind, name, message: (error as Error).message });
    }
  }
}

async function stepOrphans(ctx: Context): Promise<void> {
  for (const project of await ctx.linear.projectConfigs()) {
    if (stopping) return;
    try {
      await orphanProject(ctx, project);
    } catch (error) {
      log("orphan.error", { repo: project.repo, message: (error as Error).message });
    }
  }
}

// ── Main checkout: bring the default branch up to origin/<default> after merges (never consumes the pass) ──

interface MainAttempt {
  outcome: MainOutcome;
  reason: string | null;
}

/**
 * The checkout that has the default branch checked out: a worktree on it, or a detached one that is in the middle
 * of a rebase or bisect of it (`operation`), whose tree must not be touched.
 */
async function defaultBranchHolder(ctx: Context, path: string, ref: string) {
  const entries = await ctx.git.worktreeBranches(path);
  for (const entry of entries) {
    if (entry.branch === ref) {
      return { path: entry.path, dirty: (await ctx.git.statusPorcelain(entry.path)) !== "", operation: false };
    }
  }
  for (const entry of entries.filter((e) => e.branch === null)) {
    if ((await ctx.git.operationBranch(entry.path)) === ref) return { path: entry.path, dirty: false, operation: true };
  }
  return null;
}

async function updateMainCheckout(ctx: Context, project: ProjectConfig): Promise<MainAttempt> {
  if (!(await dirExists(project.path))) return { outcome: "uptodate", reason: null };
  const defaultBranch = await ctx.gh.defaultBranch(project.repo);
  if (!ctx.config.dryRun) await fetchRepo(ctx, project.path, project.repo);
  const local = await ctx.git.revParse(project.path, `refs/heads/${defaultBranch}`);
  const remote = await ctx.git.revParse(project.path, `refs/remotes/origin/${defaultBranch}`);
  const holder = await defaultBranchHolder(ctx, project.path, `refs/heads/${defaultBranch}`);
  const decision = mainUpdateDecision({
    defaultBranch,
    holder,
    local,
    remote,
    fastForward: local !== null && remote !== null && (await ctx.git.isAncestor(project.path, local, remote)),
  });
  if (decision.kind === "uptodate") return { outcome: "uptodate", reason: null };
  if (decision.kind === "skip") return { outcome: "skip", reason: decision.reason };
  if (ctx.config.dryRun) {
    log("dry-run.main-update", { repo: project.repo, how: decision.kind });
    return { outcome: "updated", reason: null };
  }
  if (decision.kind === "merge") await ctx.git.mergeFfOnly(decision.at, `origin/${defaultBranch}`);
  else await ctx.git.updateRef(project.path, `refs/heads/${defaultBranch}`, remote!, local!);
  log("main.updated", { repo: project.repo, branch: defaultBranch, how: decision.kind });
  return { outcome: "updated", reason: null };
}

/**
 * Keeps a pending set of projects whose main checkout may be behind: all projects once at startup, and every
 * project with a ticket that reached Done since the last check. A project leaves the set when its checkout is up
 * to date or updated; a skipped or failed one is retried every 10 minutes.
 */
async function stepMainUpdate(ctx: Context): Promise<void> {
  const checkedAt = nowIso();
  const addPending = (project: ProjectConfig) => {
    const known = ctx.mainPending.get(project.path);
    if (known) known.lastTryMs = null;
    else ctx.mainPending.set(project.path, { project, lastTryMs: null, lastReason: null });
  };
  if (!ctx.mainSeeded) {
    for (const project of await ctx.linear.projectConfigs()) addPending(project);
    ctx.mainSeeded = true;
  }
  for (const issue of await ctx.linear.issuesInState(STATE.done, ctx.mainCheckedAt)) {
    const project = issueProject(issue);
    if (!("error" in project)) addPending(project);
  }
  ctx.mainCheckedAt = checkedAt;
  for (const [path, entry] of ctx.mainPending) {
    if (stopping) return;
    if (!isDue(entry.lastTryMs, Date.now(), MAIN_RETRY_MS)) continue;
    entry.lastTryMs = Date.now();
    let attempt: MainAttempt;
    try {
      attempt = await updateMainCheckout(ctx, entry.project);
    } catch (error) {
      attempt = { outcome: "error", reason: oneLine((error as Error).message) };
    }
    if (keepMainPending(attempt.outcome)) {
      if (attempt.reason !== entry.lastReason) {
        log(attempt.outcome === "skip" ? "main.skip" : "main.error", { repo: entry.project.repo, reason: attempt.reason ?? "" });
      }
      entry.lastReason = attempt.reason;
    } else {
      ctx.mainPending.delete(path);
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
  for (const issue of staleClaims(
    inProgress,
    ctx.viewerId,
    Date.now(),
    ctx.config.timeoutWorkMs,
    automatedIdentifiers(liveJobs(ctx)),
  )) {
    await needsHuman(ctx, issue, "stale claim");
  }
}

async function runPass(ctx: Context): Promise<void> {
  await stepAutoLabel(ctx);
  try {
    await recoverStaleClaims(ctx);
  } catch (error) {
    log("recovery.error", { message: (error as Error).message });
  }
  try {
    await stepCleanup(ctx);
  } catch (error) {
    log("cleanup.error", { kind: "pass", message: (error as Error).message });
  }
  try {
    await stepOrphans(ctx);
  } catch (error) {
    log("orphan.error", { kind: "pass", message: (error as Error).message });
  }
  try {
    await stepMainUpdate(ctx);
  } catch (error) {
    log("main.error", { kind: "pass", message: (error as Error).message });
  }
  let started = 0;
  for (const step of [stepInvestigate, stepReview, stepFix, stepNewWork]) {
    if (stopping) return;
    started += await step(ctx);
  }
  if (started === 0 && ctx.jobs.size === 0) log("pass.idle");
}

// ── Startup and main loop ──

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

  const linear = new LinearClient(config.linearApiKey, config.team, config.projectsRoot);
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
    const git = createGit();
    ctx = {
      config,
      linear,
      ids,
      viewerId: await linear.viewerId(),
      gh: createGh(),
      git,
      docker: createDocker(),
      jobs: new Map(),
      mainCheckedAt: nowIso(),
      mainPending: new Map(),
      mainSeeded: false,
      fetchLocked: createKeyedMutex(),
      fetchFailures: new Map(),
      cleanupChecked: new Map(),
      orphanSeen: new Map(),
    };
  } catch (error) {
    console.error(`kanban-poller: startup failed: ${(error as Error).message}`);
    process.exit(1);
  }

  const stop = () => {
    stopping = true;
    for (const job of ctx.jobs.values()) job.abort.abort();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  log("start", { team: config.team, once: config.once, dryRun: config.dryRun, maxAutomated: config.maxAutomated });
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
  await drainJobs(ctx);
  log("stop");
}

/** --once waits for the started jobs; after a stop signal the aborted jobs get a bounded time to settle. */
async function drainJobs(ctx: Context): Promise<void> {
  const settled = Promise.allSettled(liveJobs(ctx).map((job) => job.promise));
  if (!stopping) {
    await settled;
    return;
  }
  for (const job of liveJobs(ctx)) job.abort.abort();
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
}

await main();
