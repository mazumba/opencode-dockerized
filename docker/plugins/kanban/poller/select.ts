// Pure selection logic for the kanban poller. No I/O, no clock access: every
// function takes plain data and `now` (epoch milliseconds).

export const STATE = {
  backlog: "Backlog",
  ready: "Ready for agent",
  inProgress: "In Progress",
  agentReview: "Agent review",
  readyForMerge: "Ready for merge",
  done: "Done",
  canceled: "Canceled",
  needsHuman: "Needs human",
} as const;

export const LABEL = {
  needsGrilling: "needs grilling",
  investigate: "investigate",
  refined: "refined",
  changesRequested: "agent:changes-requested",
} as const;

export const INVESTIGATE_PREFIX = "Agent investigation:";
export const INVESTIGATE_FAILED_PREFIX = "Agent investigation: failed";

export const INVESTIGATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface Issue {
  id: string;
  identifier: string;
  createdAt: string;
  state: string;
  labels: string[];
  projectPath: string | null;
  projectConfig: ProjectConfigResult;
  /** Linear's suggested git branch name for the ticket. */
  branchName: string;
  /** Reactions on the issue itself (not on its comments). */
  reactions: IssueReaction[];
}

export interface Reaction {
  emoji: string;
  userId: string | null;
}

export interface IssueReaction extends Reaction {
  id: string;
  createdAt: string;
}

export const REACTION = {
  claimed: "eyes",
  done: "white_check_mark",
  failed: "x",
} as const;

export interface Comment {
  id: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  userId: string | null;
  externalUserId: string | null;
  botActorId: string | null;
  synced: boolean;
  issueId: string;
  issueIdentifier: string;
  reactions: Reaction[];
}

export interface InvestigateRequest {
  comment: Comment;
  question: string;
}

export interface TimedComment {
  body: string;
  createdAt: string;
}

const byCreatedAt = <T extends { createdAt: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

/**
 * Parses a `/investigate [question]` comment. The first line must be exactly
 * `/investigate` or start with `/investigate `. The question is the rest of the
 * first line plus all following lines. Returns null if the comment is not a request.
 */
export function parseInvestigate(body: string): { question: string } | null {
  const [firstLine, ...rest] = body.split(/\r?\n/);
  const command = "/investigate";
  if (firstLine !== command && !firstLine.startsWith(`${command} `)) return null;
  const question = [firstLine.slice(command.length), ...rest].join("\n").trim();
  return { question };
}

/**
 * Investigate requests that are authentic, recent, and not yet handled, oldest first.
 * Handled = the viewer reacted with eyes (the claim), or a reply starting with
 * `Agent investigation:` exists (legacy comments). Reactions by others do not count.
 */
export function investigateRequests(
  comments: Comment[],
  viewerId: string,
  now: number,
): InvestigateRequest[] {
  const answered = new Set(
    comments
      .filter((c) => c.parentId !== null && c.body.startsWith(INVESTIGATE_PREFIX))
      .map((c) => c.parentId),
  );
  const requests: InvestigateRequest[] = [];
  for (const comment of byCreatedAt(comments)) {
    const parsed = parseInvestigate(comment.body);
    if (!parsed) continue;
    if (comment.userId !== viewerId) continue;
    if (comment.externalUserId || comment.botActorId || comment.synced) continue;
    if (now - Date.parse(comment.createdAt) > INVESTIGATE_WINDOW_MS) continue;
    if (answered.has(comment.id)) continue;
    if (comment.reactions.some((r) => r.emoji === REACTION.claimed && r.userId === viewerId)) continue;
    requests.push({ comment, question: parsed.question });
  }
  return requests;
}

export interface InvestigationRun {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  minutes: number;
}

export type InvestigationOutcome =
  | { emoji: typeof REACTION.done }
  | { emoji: typeof REACTION.failed; reason: string };

/**
 * Final reaction (and failure reason) for an investigation that was claimed and run.
 * Success = the run ended normally with exit 0 and the agent left an `Agent investigation:`
 * comment (not the `failed` form) on the ticket at or after `startedAtMs`.
 */
export function investigationOutcome(
  run: InvestigationRun,
  issueComments: TimedComment[],
  startedAtMs: number,
): InvestigationOutcome {
  if (run.aborted) return { emoji: REACTION.failed, reason: "poller stopped" };
  if (run.timedOut) return { emoji: REACTION.failed, reason: `timeout after ${run.minutes} min` };
  if (run.exitCode !== 0) return { emoji: REACTION.failed, reason: `exit code ${run.exitCode}` };
  const reported = issueComments.some(
    (c) =>
      c.body.startsWith(INVESTIGATE_PREFIX) &&
      !c.body.startsWith(INVESTIGATE_FAILED_PREFIX) &&
      Date.parse(c.createdAt) >= startedAtMs,
  );
  if (!reported) return { emoji: REACTION.failed, reason: "no investigation comment posted" };
  return { emoji: REACTION.done };
}

/** Issues in Agent review, oldest first. */
export function reviewCandidates(issues: Issue[]): Issue[] {
  return byCreatedAt(issues.filter((i) => i.state === STATE.agentReview));
}

/** In Progress issues flagged for a fix round, oldest first. */
export function fixCandidates(issues: Issue[]): Issue[] {
  return byCreatedAt(
    issues.filter((i) => i.state === STATE.inProgress && i.labels.includes(LABEL.changesRequested)),
  );
}

/** Issues in Ready for agent, oldest first. */
export function readyCandidates(issues: Issue[]): Issue[] {
  return byCreatedAt(issues.filter((i) => i.state === STATE.ready));
}

/** The refinement label that makes a ticket not ready for an agent, if any. */
export function refinementLabel(issue: Issue): string | null {
  return (
    [LABEL.needsGrilling, LABEL.investigate].find((label) => issue.labels.includes(label)) ?? null
  );
}

/** Backlog issues that carry none of the refinement labels. */
export function autoLabelTargets(issues: Issue[]): Issue[] {
  const refinement: string[] = [LABEL.needsGrilling, LABEL.investigate, LABEL.refined];
  return issues.filter(
    (i) => i.state === STATE.backlog && !i.labels.some((l) => refinement.includes(l)),
  );
}

/** Ids of the viewer's claim reactions on an issue. */
export function viewerClaimReactionIds(issue: Issue, viewerId: string): string[] {
  return issue.reactions
    .filter((r) => r.emoji === REACTION.claimed && r.userId === viewerId)
    .map((r) => r.id);
}

/**
 * In Progress issues whose latest claim reaction by the viewer is older than `timeoutMs`.
 * Without a viewer claim reaction an issue is not stale.
 */
export function staleClaims(issues: Issue[], viewerId: string, now: number, timeoutMs: number): Issue[] {
  return issues.filter((issue) => {
    if (issue.state !== STATE.inProgress) return false;
    const claimTimes = issue.reactions
      .filter((r) => r.emoji === REACTION.claimed && r.userId === viewerId)
      .map((r) => Date.parse(r.createdAt));
    if (claimTimes.length === 0) return false;
    return now - Math.max(...claimTimes) > timeoutMs;
  });
}

function singleField(text: string, key: string, accept: (value: string) => boolean): string | null {
  const values = new Set<string>();
  for (const match of text.matchAll(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "gim"))) {
    const value = match[1].replace(/^`+|`+$/g, "").trim();
    if (accept(value)) values.add(value);
  }
  return values.size === 1 ? [...values][0] : null;
}

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IDENTIFIER_PATTERN = /^[A-Z]+-[0-9]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_PATH_PATTERN = /^\/[^\0-\x1f]*$/;

/**
 * Extracts the single `path: /absolute/path` line from a project description.
 * Returns null if absent, relative, or ambiguous (several distinct values).
 */
export function parseProjectPath(text: string): string | null {
  return singleField(text, "path", (value) => value.startsWith("/"));
}

export interface ProjectConfig {
  repo: string;
  path: string;
}

export type ProjectConfigResult = ProjectConfig | { error: string };

/** Reads `repo: owner/name` and `path: /abs/dir` (each exactly once) from a project description. */
export function parseProjectConfig(text: string): ProjectConfigResult {
  const repo = singleField(text, "repo", (value) => REPO_PATTERN.test(value));
  const path = singleField(text, "path", (value) => SAFE_PATH_PATTERN.test(value));
  if (!repo) return { error: "project needs exactly one `repo: owner/name` line" };
  if (!path) return { error: "project needs exactly one absolute `path: /dir` line" };
  return { repo, path };
}

export const isIdentifier = (value: string): boolean => IDENTIFIER_PATTERN.test(value);

/** Worktree directory the worker uses for a ticket. */
export function worktreePath(path: string, identifier: string): string {
  return `${path}/${worktreeRelPath(identifier)}`;
}

/** Worktree directory relative to the project path. */
export function worktreeRelPath(identifier: string): string {
  if (!isIdentifier(identifier)) throw new Error(`invalid ticket identifier "${identifier}"`);
  return `.slim/worktrees/${identifier.toLowerCase()}`;
}

export interface Project extends ProjectConfig {
  identifier: string;
}

/** Validated repo and path of a ticket's project (no branch needed), or the reason it has none. */
export function issueProject(issue: Issue): Project | { error: string } {
  if (!isIdentifier(issue.identifier)) return { error: "invalid ticket identifier" };
  if ("error" in issue.projectConfig) return { error: issue.projectConfig.error };
  return { ...issue.projectConfig, identifier: issue.identifier };
}

export interface Target extends Project {
  branch: string;
}

/** Validated repo, path, and branch of a ticket, or the reason it cannot be worked on. */
export function issueTarget(issue: Issue): Target | { error: string } {
  const project = issueProject(issue);
  if ("error" in project) return project;
  if (!BRANCH_PATTERN.test(issue.branchName ?? "")) return { error: "ticket has no usable branch name" };
  return { ...project, branch: issue.branchName };
}

/** True if a git remote URL (https, scp-style or ssh) points at `owner/name` on github.com. */
export function originMatchesRepo(url: string, repo: string): boolean {
  const match = url
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return match !== null && match[1].toLowerCase() === repo.toLowerCase();
}

// ── Pull request gate ──

export type PrState = "OPEN" | "CLOSED" | "MERGED";
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface PrInfo {
  number: number;
  url: string;
  state: PrState;
  mergeable: Mergeable;
  baseRefName: string;
  headRefOid: string;
}

export interface Check {
  name: string;
  bucket: CheckBucket;
}

export const CHANGES_REQUESTED_PREFIX = "Agent review: changes requested";
export const MAX_REVIEW_ROUNDS = 2;

export type GateDecision =
  | { kind: "wait" }
  | { kind: "review" }
  | { kind: "fix"; cause: "ci" | "conflict"; failed: string[] }
  | { kind: "needsHuman"; reason: string };

/**
 * Review rounds used: `Agent review: changes requested` comments created after `sinceIso`
 * (when the ticket last entered Ready for agent); all of them when `sinceIso` is null.
 */
export function changesRequestedRounds(comments: TimedComment[], sinceIso: string | null): number {
  const since = sinceIso === null ? -Infinity : Date.parse(sinceIso);
  return comments.filter((c) => c.body.startsWith(CHANGES_REQUESTED_PREFIX) && Date.parse(c.createdAt) > since).length;
}

export interface StateEntry {
  createdAt: string;
  toState: string | null;
}

/** Latest time the issue moved into `state`, or null if it never did (in the history given). */
export function lastEnteredState(history: StateEntry[], state: string): string | null {
  const times = history.filter((h) => h.toState === state).map((h) => h.createdAt);
  return times.length === 0 ? null : times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export type ExistingPrDecision =
  | { kind: "new" }
  | { kind: "follow-up"; pr: { number: number; url: string } }
  | { kind: "needsHuman"; reason: string };

/** What a `Ready for agent` ticket does given the PR already on its branch: new PR, follow-up on the open one, or stop. */
export function existingPrDecision(pr: PrInfo | null): ExistingPrDecision {
  if (!pr) return { kind: "new" };
  if (pr.state === "OPEN") return { kind: "follow-up", pr: { number: pr.number, url: pr.url } };
  return { kind: "needsHuman", reason: `PR #${pr.number} is ${pr.state.toLowerCase()}; open a new ticket` };
}

/** Decides what the poller does with a ticket in Agent review, before any agent runs. */
export function reviewGate(
  pr: PrInfo | null,
  checks: Check[],
  rounds: number,
  maxRounds: number = MAX_REVIEW_ROUNDS,
): GateDecision {
  if (!pr) return { kind: "needsHuman", reason: "no PR found" };
  if (pr.state !== "OPEN") return { kind: "needsHuman", reason: `PR is ${pr.state}` };
  if (checks.length === 0) return { kind: "needsHuman", reason: "no CI checks configured" };

  const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map((c) => c.name);
  let decision: GateDecision;
  if (failed.length > 0) decision = { kind: "fix", cause: "ci", failed };
  else if (pr.mergeable === "CONFLICTING") decision = { kind: "fix", cause: "conflict", failed: [] };
  else if (checks.some((c) => c.bucket === "pending") || pr.mergeable === "UNKNOWN") decision = { kind: "wait" };
  else decision = { kind: "review" };

  if (decision.kind === "fix" && rounds >= maxRounds) {
    return { kind: "needsHuman", reason: `review limit reached (${decision.cause})` };
  }
  return decision;
}

/** Whether a ticket's worktree and branch may be cleaned up, given its PR state. */
export function cleanupCandidate(issueState: string, prState: PrState | null): boolean {
  if (prState === null || prState === "OPEN") return false;
  if (issueState === STATE.readyForMerge || issueState === STATE.done) return prState === "MERGED";
  if (issueState === STATE.canceled) return true;
  return false;
}

// ── Messages for the agents ──

export interface FixRequest {
  cause: "ci" | "conflict" | "review";
  summary: string;
}

const MAX_SUMMARY_CHARS = 300;

/** Cause and summary of the latest `Agent review: changes requested` comment. */
export function latestFixRequest(comments: TimedComment[]): FixRequest {
  const latest = byCreatedAt(comments.filter((c) => c.body.startsWith(CHANGES_REQUESTED_PREFIX))).at(-1);
  const summary = (latest?.body.split(/\r?\n/)[1] ?? "").trim().slice(0, MAX_SUMMARY_CHARS);
  const cause = summary.startsWith("CI failed") ? "ci" : summary.startsWith("merge conflicts") ? "conflict" : "review";
  return { cause, summary };
}

export interface WorkerContext {
  defaultBranch: string;
  pr?: { number: number; url: string };
  round: number;
  fix?: FixRequest;
}

/** Single-line `<ID> ctx:<json>` message for the worker. */
export function workerMessage(target: Target, extra: WorkerContext): string {
  if (!BRANCH_PATTERN.test(extra.defaultBranch)) throw new Error("invalid default branch");
  const { repo, path, branch } = target;
  const worktree = worktreePath(path, target.identifier);
  return `${target.identifier} ctx:${JSON.stringify({
    repo,
    path,
    branch,
    defaultBranch: extra.defaultBranch,
    worktree,
    pr: extra.pr,
    round: extra.round,
    fix: extra.fix,
  })}`;
}

/** `<ID> ctx:{"repo","path"}`, plus the question on the following lines when there is one. */
export function investigatorMessage(project: Project, question: string): string {
  const first = `${project.identifier} ctx:${JSON.stringify({ repo: project.repo, path: project.path })}`;
  return question ? `${first}\n${question}` : first;
}

export interface ReviewerContext {
  base: string;
  pr: { number: number; url: string };
  round: number;
}

/** Single-line `<ID> ctx:<json>` message for the reviewer. CI is known green here. */
export function reviewerMessage(target: Target, extra: ReviewerContext): string {
  if (!BRANCH_PATTERN.test(extra.base)) throw new Error("invalid base branch");
  const { repo, path, branch } = target;
  return `${target.identifier} ctx:${JSON.stringify({ repo, path, branch, ...extra, ci: "green" })}`;
}

// ── Worktree lane registry (`<repo>/.slim/worktrees.json`) ──

export interface LaneRegistry {
  version?: unknown;
  updatedAt?: unknown;
  lanes: { slug?: unknown; path?: unknown; [key: string]: unknown }[];
  [key: string]: unknown;
}

/**
 * Registry without the lane for this worktree (matched by path or slug), other lanes untouched
 * and `updatedAt` refreshed. Null if the registry is malformed or has no such lane.
 */
export function removeLane(registry: unknown, worktree: string, slug: string, nowIso: string): LaneRegistry | null {
  if (typeof registry !== "object" || registry === null || !Array.isArray((registry as LaneRegistry).lanes)) {
    return null;
  }
  const current = registry as LaneRegistry;
  const lanes = current.lanes.filter((l) => l?.path !== worktree && l?.slug !== slug);
  if (lanes.length === current.lanes.length) return null;
  return { ...current, updatedAt: nowIso, lanes };
}

export interface WorktreeFacts {
  worktreeExists: boolean;
  localBranch: boolean;
  remoteBranch: boolean;
  defaultBranch: string;
  branch: string;
}

export type WorktreePlan =
  | { kind: "reuse" }
  | { kind: "existing-local"; branch: string }
  | { kind: "track"; branch: string }
  | { kind: "new"; branch: string; base: string };

/** How to get the ticket's worktree: reuse it, check out the local or remote branch, or branch off the default. */
export function worktreePlan(facts: WorktreeFacts): WorktreePlan {
  if (facts.worktreeExists) return { kind: "reuse" };
  if (facts.localBranch) return { kind: "existing-local", branch: facts.branch };
  if (facts.remoteBranch) return { kind: "track", branch: facts.branch };
  return { kind: "new", branch: facts.branch, base: `origin/${facts.defaultBranch}` };
}

export const WORKTREE_OWNER = "kanban-poller";

export interface LaneInput {
  slug: string;
  branch: string;
  base: string;
  purpose: string;
}

/**
 * Registry with the lane added (`updatedAt` refreshed), per the worktrees skill.
 * A null registry starts a new one. Returns the same registry object if the lane (by slug) exists,
 * and null if the registry is malformed.
 */
export function addLane(registry: unknown, lane: LaneInput, nowIso: string): LaneRegistry | null {
  if (registry === null) {
    registry = { version: "1.0.0", updatedAt: nowIso, lanes: [] };
  }
  if (typeof registry !== "object" || registry === null || !Array.isArray((registry as LaneRegistry).lanes)) {
    return null;
  }
  const current = registry as LaneRegistry;
  if (current.lanes.some((l) => l?.slug === lane.slug)) return current;
  return {
    ...current,
    updatedAt: nowIso,
    lanes: [
      ...current.lanes,
      {
        slug: lane.slug,
        branch: lane.branch,
        path: `.slim/worktrees/${lane.slug}`,
        base: lane.base,
        purpose: lane.purpose,
        owner: WORKTREE_OWNER,
        status: "active",
        areas: [],
        createdAt: nowIso,
      },
    ],
  };
}
