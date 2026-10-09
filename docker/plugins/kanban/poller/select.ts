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
export const CLAIM_PREFIX = "Agent: claimed by poller (";
const WORKER_DONE_PREFIXES = ["Agent: PR ready", "Agent: fixes pushed", "Agent: needs human"];

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
}

export interface Reaction {
  emoji: string;
  userId: string | null;
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

/** Final reaction (and failure reason) for an investigation that was claimed and run. */
export function investigationOutcome(run: InvestigationRun, labelsSwapped: boolean): InvestigationOutcome {
  if (run.aborted) return { emoji: REACTION.failed, reason: "poller stopped" };
  if (run.timedOut) return { emoji: REACTION.failed, reason: `timeout after ${run.minutes} min` };
  if (run.exitCode !== 0) return { emoji: REACTION.failed, reason: `exit code ${run.exitCode}` };
  if (!labelsSwapped) return { emoji: REACTION.failed, reason: "label not changed" };
  return { emoji: REACTION.done };
}

/** Why an issue cannot be investigated, or null if it can. */
export function investigateBlocker(issue: Issue): string | null {
  if (issue.state !== STATE.backlog) return `ticket is in ${issue.state}, not ${STATE.backlog}`;
  if (!issue.labels.includes(LABEL.investigate)) return `ticket has no ${LABEL.investigate} label`;
  return null;
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

/**
 * In Progress issues whose latest poller claim is older than `timeoutMs` and
 * has no later worker comment (PR ready, fixes pushed, needs human).
 */
export function staleClaims(
  inProgress: { issue: Issue; comments: TimedComment[] }[],
  now: number,
  timeoutMs: number,
): Issue[] {
  return inProgress
    .filter(({ issue, comments }) => {
      if (issue.state !== STATE.inProgress) return false;
      const sorted = byCreatedAt(comments);
      const claimIndex = sorted.map((c) => c.body.startsWith(CLAIM_PREFIX)).lastIndexOf(true);
      if (claimIndex === -1) return false;
      const claim = sorted[claimIndex];
      if (now - Date.parse(claim.createdAt) <= timeoutMs) return false;
      const workerReplied = sorted
        .slice(claimIndex + 1)
        .some((c) => WORKER_DONE_PREFIXES.some((p) => c.body.startsWith(p)));
      return !workerReplied;
    })
    .map(({ issue }) => issue);
}

function singleField(text: string, key: string, accept: (value: string) => boolean): string | null {
  const values = new Set<string>();
  for (const match of text.matchAll(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "gim"))) {
    const value = match[1].replace(/^`+|`+$/g, "").trim();
    if (accept(value)) values.add(value);
  }
  return values.size === 1 ? [...values][0] : null;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
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
  if (!isIdentifier(identifier)) throw new Error(`invalid ticket identifier "${identifier}"`);
  return `${path}/.slim/worktrees/${identifier.toLowerCase()}`;
}

export interface Target extends ProjectConfig {
  identifier: string;
  branch: string;
}

/** Validated repo, path, and branch of a ticket, or the reason it cannot be worked on. */
export function issueTarget(issue: Issue): Target | { error: string } {
  if (!isIdentifier(issue.identifier)) return { error: "invalid ticket identifier" };
  if ("error" in issue.projectConfig) return { error: issue.projectConfig.error };
  if (!BRANCH_PATTERN.test(issue.branchName ?? "")) return { error: "ticket has no usable branch name" };
  return { ...issue.projectConfig, identifier: issue.identifier, branch: issue.branchName };
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

export function changesRequestedRounds(comments: { body: string }[]): number {
  return comments.filter((c) => c.body.startsWith(CHANGES_REQUESTED_PREFIX)).length;
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
  lanes: { slug?: unknown; path?: unknown }[];
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
