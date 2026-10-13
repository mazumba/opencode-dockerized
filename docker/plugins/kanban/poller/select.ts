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
  /** Linear user id of the author; the poller's own comments carry its API user id. */
  authorId?: string | null;
}

const authoredBy = (comments: TimedComment[], authorId: string): TimedComment[] =>
  comments.filter((c) => c.authorId != null && c.authorId === authorId);

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
  error: string | null;
  timedOut: boolean;
  aborted: boolean;
  minutes: number;
}

export type InvestigationOutcome =
  | { emoji: typeof REACTION.done; report: string }
  | { emoji: typeof REACTION.failed; reason: string };

/**
 * Final reaction (and failure reason, or the report to post) for an investigation that was claimed and run.
 * Success = the run ended without error, the result marker says `done`, and the report file is not empty.
 */
export function investigationOutcome(
  run: InvestigationRun,
  output: string,
  report: string | null,
): InvestigationOutcome {
  if (run.aborted) return { emoji: REACTION.failed, reason: "poller stopped" };
  if (run.timedOut) return { emoji: REACTION.failed, reason: `timeout after ${run.minutes} min` };
  if (run.error !== null) return { emoji: REACTION.failed, reason: `agent error: ${run.error}` };
  const parsed = parseResult("investigate", output);
  if (!parsed.ok) return { emoji: REACTION.failed, reason: `no valid result marker (${parsed.reason})` };
  if (parsed.result.outcome === "needs-human") {
    return { emoji: REACTION.failed, reason: `${oneLine(parsed.result.step)}: ${oneLine(parsed.result.reason)}` };
  }
  const text = (report ?? "").trim();
  if (text === "") return { emoji: REACTION.failed, reason: "no investigation report written" };
  return { emoji: REACTION.done, report: text };
}

export const MAX_INVESTIGATION_COMMENT_CHARS = 60_000;

/**
 * Comment body for an investigation report; a leading `Agent investigation:` in the report is not doubled.
 * Reports beyond the cap are cut with a note.
 */
export function investigationComment(report: string): string {
  const body = report.trim();
  const rest = body.startsWith(INVESTIGATE_PREFIX) ? body.slice(INVESTIGATE_PREFIX.length).trim() : body;
  const full = `${INVESTIGATE_PREFIX}\n\n${rest}`;
  if (full.length <= MAX_INVESTIGATION_COMMENT_CHARS) return full;
  const note = `\n\n(report truncated: ${full.length - MAX_INVESTIGATION_COMMENT_CHARS} characters omitted)`;
  return full.slice(0, MAX_INVESTIGATION_COMMENT_CHARS - note.length) + note;
}

// ── Agent result marker: the last line of an agent's reply, `KANBAN-RESULT: <json>` ──

export const RESULT_MARKER = "KANBAN-RESULT:";
export const MAX_RESULT_TEXT_CHARS = 300;

export type NeedsHumanResult = { outcome: "needs-human"; step: string; reason: string };
export type WorkResult = { outcome: "review"; pr: number } | NeedsHumanResult;
export type ReviewResult = { outcome: "approve" } | { outcome: "changes"; summary: string } | NeedsHumanResult;
export type InvestigateResult = { outcome: "done" } | NeedsHumanResult;

export interface ResultByKind {
  work: WorkResult;
  review: ReviewResult;
  investigate: InvestigateResult;
}

export type ParsedResult<K extends keyof ResultByKind> =
  | { ok: true; result: ResultByKind[K] }
  | { ok: false; reason: string };

export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_RESULT_TEXT_CHARS;

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

function validateResult(kind: keyof ResultByKind, value: unknown): ResultByKind[typeof kind] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.outcome === "needs-human") {
    if (!exactKeys(obj, ["outcome", "step", "reason"]) || !isText(obj.step) || !isText(obj.reason)) return null;
    return { outcome: "needs-human", step: obj.step, reason: obj.reason };
  }
  if (kind === "work" && obj.outcome === "review") {
    const pr = obj.pr;
    if (!exactKeys(obj, ["outcome", "pr"]) || typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return null;
    return { outcome: "review", pr };
  }
  if (kind === "review" && obj.outcome === "approve") {
    return exactKeys(obj, ["outcome"]) ? { outcome: "approve" } : null;
  }
  if (kind === "review" && obj.outcome === "changes") {
    if (!exactKeys(obj, ["outcome", "summary"]) || !isText(obj.summary)) return null;
    return { outcome: "changes", summary: obj.summary };
  }
  if (kind === "investigate" && obj.outcome === "done") {
    return exactKeys(obj, ["outcome"]) ? { outcome: "done" } : null;
  }
  return null;
}

/** Strips the decoration a renderer may put around the line (backticks, bold, list or quote markers). */
const MARKER_LINE = /^[\s>*_`-]*KANBAN-RESULT:\s*(.*?)[\s*_`]*$/;

/**
 * Result of an agent run from its output: the LAST `KANBAN-RESULT: <json>` line, validated for `kind`.
 * Unknown fields, unknown outcomes, and invalid values are rejected; earlier marker lines are ignored.
 */
export function parseResult<K extends keyof ResultByKind>(kind: K, output: string): ParsedResult<K> {
  let payload: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = MARKER_LINE.exec(line);
    if (match) payload = match[1];
  }
  if (payload === null) return { ok: false, reason: "marker missing" };
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return { ok: false, reason: "marker is not JSON" };
  }
  const result = validateResult(kind, json);
  return result ? { ok: true, result: result as ResultByKind[K] } : { ok: false, reason: "marker invalid" };
}

// ── Results to actions: what the poller writes to Linear after a run ──

export type Action =
  | { kind: "move"; state: string }
  | { kind: "label"; add: string }
  | { kind: "comment"; body: string };

const NEEDS_HUMAN_AGENT = (step: string, reason: string) => `${oneLine(step)}: ${oneLine(reason)}`;

/** Work run: only a PR that exists on the branch with the reported number moves the ticket to Agent review. */
export function workResultActions(result: WorkResult, pr: PrInfo | null): Action[] {
  if (result.outcome === "needs-human") {
    return [
      { kind: "move", state: STATE.needsHuman },
      { kind: "comment", body: `Agent: needs human — ${NEEDS_HUMAN_AGENT(result.step, result.reason)}` },
    ];
  }
  if (!pr || pr.state !== "OPEN" || pr.number !== result.pr) {
    return [
      { kind: "move", state: STATE.needsHuman },
      { kind: "comment", body: `Agent: needs human — poller: reported PR #${result.pr} is not the open PR of the branch` },
    ];
  }
  return [{ kind: "move", state: STATE.agentReview }];
}

/** Worker reported a PR but GitHub could not be read: a human checks it (never a wrong "no PR" message). */
export function workVerificationFailedActions(): Action[] {
  return [
    { kind: "move", state: STATE.needsHuman },
    {
      kind: "comment",
      body: "Agent: needs human — poller: could not verify the reported PR because GitHub could not be read; check the PR and move the ticket back",
    },
  ];
}

export interface ReviewRun {
  round: number;
  prUrl: string;
  maxRounds?: number;
}

const FIX_LINE_PREFIXES = ["CI failed", "merge conflicts"];

/** One-line review summary that cannot be mistaken for the poller's own `CI failed` / `merge conflicts` lines. */
export function reviewSummaryLine(summary: string): string {
  const line = oneLine(summary).slice(0, MAX_RESULT_TEXT_CHARS);
  return FIX_LINE_PREFIXES.some((p) => line.startsWith(p)) ? `Review: ${line}` : line;
}

/** Review run: comment first, then label, then move, so a failed write never leaves an uncounted round. */
export function reviewResultActions(result: ReviewResult, run: ReviewRun): Action[] {
  if (result.outcome === "approve") return [{ kind: "move", state: STATE.readyForMerge }];
  if (result.outcome === "needs-human") {
    return [
      { kind: "move", state: STATE.needsHuman },
      { kind: "comment", body: `Agent review: needs human — ${NEEDS_HUMAN_AGENT(result.step, result.reason)}` },
    ];
  }
  if (run.round >= (run.maxRounds ?? MAX_REVIEW_ROUNDS)) {
    return [
      { kind: "move", state: STATE.needsHuman },
      { kind: "comment", body: `Agent review: needs human — review limit reached — ${run.prUrl}` },
    ];
  }
  return [
    {
      kind: "comment",
      body: `${CHANGES_REQUESTED_PREFIX} (round ${run.round + 1}/${MAX_REVIEW_ROUNDS}) — ${run.prUrl}\n${reviewSummaryLine(result.summary)}`,
    },
    { kind: "label", add: LABEL.changesRequested },
    { kind: "move", state: STATE.inProgress },
  ];
}

// ── Ticket snapshot: everything the agent may know about the ticket, written by the poller ──

export interface TicketComment {
  id: string;
  parentId: string | null;
  authorName: string | null;
  authorUserId: string | null;
  createdAt: string;
  body: string;
}

export interface TicketData {
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  labels: string[];
  projectName: string | null;
  url: string;
  attachments: { title: string; url: string }[];
  comments: TicketComment[];
  stateHistory: { createdAt: string; from: string | null; to: string }[];
}

export interface TicketSnapshot extends Omit<TicketData, "comments"> {
  comments: {
    id: string;
    parentId: string | null;
    author: string | null;
    isPoller: boolean;
    createdAt: string;
    body: string;
  }[];
}

/** Snapshot with comments oldest to newest and `isPoller` set for the poller's own API user. */
export function buildTicketSnapshot(data: TicketData, viewerId: string): TicketSnapshot {
  return {
    ...data,
    stateHistory: byCreatedAt(data.stateHistory),
    comments: byCreatedAt(data.comments).map((c) => ({
      id: c.id,
      parentId: c.parentId,
      author: c.authorName,
      isPoller: c.authorUserId !== null && c.authorUserId === viewerId,
      createdAt: c.createdAt,
      body: c.body,
    })),
  };
}

const TICKETS_DIR = ".slim/worktrees/.tickets";

const RUN_ID_PATTERN = /^[A-Za-z0-9-]+$/;

function ticketFileBase(path: string, identifier: string, runId?: string): string {
  if (!isIdentifier(identifier)) throw new Error(`invalid ticket identifier "${identifier}"`);
  if (runId !== undefined && !RUN_ID_PATTERN.test(runId)) throw new Error("invalid run id");
  return `${path}/${TICKETS_DIR}/${identifier}${runId === undefined ? "" : `.${runId}`}`;
}

/**
 * Snapshot file the agent reads; inside the git-ignored `.slim/worktrees/`.
 * Investigations pass a `runId` (their request comment id) so they never share files with an automated job.
 */
export function ticketFilePath(path: string, identifier: string, runId?: string): string {
  return `${ticketFileBase(path, identifier, runId)}.json`;
}

/** Report file the investigator writes and the poller posts. */
export function investigationFilePath(path: string, identifier: string, runId?: string): string {
  return `${ticketFileBase(path, identifier, runId)}.investigation.md`;
}

export function ticketsDir(path: string): string {
  return `${path}/${TICKETS_DIR}`;
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
 * Without a viewer claim reaction, or while its identifier has a live job in `active`, an issue is not stale.
 */
export function staleClaims(
  issues: Issue[],
  viewerId: string,
  now: number,
  timeoutMs: number,
  active: Set<string>,
): Issue[] {
  return issues.filter((issue) => {
    if (active.has(issue.identifier)) return false;
    if (issue.state !== STATE.inProgress) return false;
    // A fix round waiting to be picked up keeps its old claim until the poller replaces it.
    if (issue.labels.includes(LABEL.changesRequested)) return false;
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
export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_PATH_PATTERN = /^\/[^\0-\x1f]*$/;

export interface ProjectConfig {
  repo: string;
  path: string;
}

export type ProjectConfigResult = ProjectConfig | { error: string };

/** Directory name for a repo's checkout: the name part of `owner/name`. */
export function repoDirName(repo: string): string {
  return repo.split("/")[1];
}

/**
 * Default checkout of a repo: `<projectsRoot>/<name>`. Null without a root, or for a name that is not a plain
 * directory name (`.`, `..`).
 */
export function defaultCheckoutPath(projectsRoot: string | null, repo: string): string | null {
  if (projectsRoot === null || !SAFE_PATH_PATTERN.test(projectsRoot)) return null;
  const name = repoDirName(repo);
  if (name === "." || name === "..") return null;
  return `${projectsRoot.replace(/\/+$/, "")}/${name}`;
}

/**
 * Reads `repo: owner/name` (exactly once) and the optional `path: /abs/dir` from a project description.
 * Without `path:` the checkout is `<projectsRoot>/<name>`; an explicit `path:` always wins.
 */
export function parseProjectConfig(text: string, projectsRoot: string | null = null): ProjectConfigResult {
  const repo = singleField(text, "repo", (value) => REPO_PATTERN.test(value));
  if (!repo) return { error: "project needs exactly one `repo: owner/name` line" };
  if (/^\s*path:/im.test(text)) {
    const path = singleField(text, "path", (value) => SAFE_PATH_PATTERN.test(value));
    return path ? { repo, path } : { error: "project has a `path:` line that is not exactly one absolute path" };
  }
  const path = defaultCheckoutPath(projectsRoot, repo);
  if (!path) return { error: "project has no `path:` line and KANBAN_PROJECTS_ROOT is not set" };
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

/** `owner/name` of a GitHub remote URL (https, scp-style or ssh), or null for anything else. */
export function repoFromOrigin(url: string): string | null {
  const match = url
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return match ? match[1] : null;
}

/** True if a git remote URL points at `owner/name` on github.com. */
export function originMatchesRepo(url: string, repo: string): boolean {
  return repoFromOrigin(url)?.toLowerCase() === repo.toLowerCase();
}

export interface CheckoutFacts {
  kind: "missing" | "dir" | "other";
  /** For a directory: it has no entries. */
  empty: boolean;
  /** For a directory: it is the top level of a git repository. */
  isRepoRoot: boolean;
  /** For a repository: `owner/name` of its origin, or null (no origin, or not a GitHub URL). */
  originRepo: string | null;
}

export type CheckoutPlan = { kind: "ready" } | { kind: "clone" } | { kind: "problem"; reason: string };

/**
 * What to do with the project's checkout path: use it, clone into it, or stop. A repository whose origin is another
 * repo is a path collision (`a/web` vs `b/web`); a non-empty directory that is not a repository is never cloned into.
 */
export function checkoutPlan(path: string, repo: string, facts: CheckoutFacts): CheckoutPlan {
  if (facts.kind === "missing") return { kind: "clone" };
  if (facts.kind === "other") return { kind: "problem", reason: `path ${path} exists and is not a directory` };
  if (facts.isRepoRoot) {
    if (facts.originRepo !== null && facts.originRepo.toLowerCase() === repo.toLowerCase()) return { kind: "ready" };
    return { kind: "problem", reason: `path collision: ${path} holds ${facts.originRepo ?? "a repository without a GitHub origin"}` };
  }
  if (facts.empty) return { kind: "clone" };
  return { kind: "problem", reason: `path ${path} exists, is not empty, and is not a git repository` };
}

/** Patterns that keep the poller's files out of `git status` without touching the repo (`.git/info/exclude`). */
export const EXCLUDE_PATTERNS = ["/.slim/worktrees/", "/.slim/worktrees.json"];

/** New content of `.git/info/exclude` with the patterns added, or null when all are already there. */
export function excludeAppend(content: string | null, patterns: readonly string[] = EXCLUDE_PATTERNS): string | null {
  const existing = content ?? "";
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = patterns.filter((p) => !lines.has(p));
  if (missing.length === 0) return null;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  return `${existing}${separator}${missing.join("\n")}\n`;
}

/** True if `path` is `dir` or lies below it (a path boundary, so `dey-4` does not contain `dey-42`). */
export function isWithin(path: string, dir: string): boolean {
  const base = dir.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
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
  updatedAt: string | null;
}

export interface Check {
  name: string;
  bucket: CheckBucket;
  startedAt: string | null;
}

export const DEFAULT_CI_PENDING_TIMEOUT_MS = 30 * 60_000;

/**
 * Epoch ms since when CI has been pending: the earliest start of a pending check, else the PR's `updatedAt`
 * (queued checks have no start; `updatedAt` only moves later, so the fallback never escalates early).
 * Null when neither is known.
 */
export function pendingSince(pr: PrInfo, checks: Check[]): number | null {
  const starts = checks
    .filter((c) => c.bucket === "pending" && c.startedAt !== null)
    .map((c) => Date.parse(c.startedAt as string))
    .filter((t) => Number.isFinite(t));
  if (starts.length > 0) return Math.min(...starts);
  const updated = pr.updatedAt === null ? NaN : Date.parse(pr.updatedAt);
  return Number.isFinite(updated) ? updated : null;
}

export const CHANGES_REQUESTED_PREFIX = "Agent review: changes requested";
export const MAX_REVIEW_ROUNDS = 2;

export type GateDecision =
  | { kind: "wait" }
  | { kind: "review"; ci: "green" | "none" }
  | { kind: "fix"; cause: "ci" | "conflict"; failed: string[] }
  | { kind: "needsHuman"; reason: string };

/**
 * Review rounds used: `Agent review: changes requested` comments written by the poller (`posterId`) at or after
 * `sinceIso` (when the ticket last entered Ready for agent); all of them when `sinceIso` is null. Comments by
 * anyone else never count, so a pasted copy cannot change the budget.
 */
export function changesRequestedRounds(comments: TimedComment[], sinceIso: string | null, posterId: string): number {
  const since = sinceIso === null ? -Infinity : Date.parse(sinceIso);
  return authoredBy(comments, posterId).filter(
    (c) => c.body.startsWith(CHANGES_REQUESTED_PREFIX) && Date.parse(c.createdAt) >= since,
  ).length;
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
  now: number,
  pendingSinceMs: number | null,
  pendingTimeoutMs: number = DEFAULT_CI_PENDING_TIMEOUT_MS,
  maxRounds: number = MAX_REVIEW_ROUNDS,
): GateDecision {
  if (!pr) return { kind: "needsHuman", reason: "no PR found" };
  if (pr.state !== "OPEN") return { kind: "needsHuman", reason: `PR is ${pr.state}` };

  const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map((c) => c.name);
  let decision: GateDecision;
  if (failed.length > 0) decision = { kind: "fix", cause: "ci", failed };
  else if (pr.mergeable === "CONFLICTING") decision = { kind: "fix", cause: "conflict", failed: [] };
  else if (checks.some((c) => c.bucket === "pending") || pr.mergeable === "UNKNOWN") {
    if (pendingSinceMs !== null && now - pendingSinceMs > pendingTimeoutMs) {
      return { kind: "needsHuman", reason: `CI pending for more than ${Math.round(pendingTimeoutMs / 60_000)} min` };
    }
    decision = { kind: "wait" };
  } else decision = { kind: "review", ci: checks.length === 0 ? "none" : "green" };

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
export function latestFixRequest(comments: TimedComment[], posterId: string): FixRequest {
  const latest = byCreatedAt(authoredBy(comments, posterId).filter((c) => c.body.startsWith(CHANGES_REQUESTED_PREFIX))).at(-1);
  const summary = (latest?.body.split(/\r?\n/)[1] ?? "").trim().slice(0, MAX_SUMMARY_CHARS);
  const cause = summary.startsWith("CI failed") ? "ci" : summary.startsWith("merge conflicts") ? "conflict" : "review";
  return { cause, summary };
}

export interface WorkerContext {
  defaultBranch: string;
  pr?: { number: number; url: string };
  round: number;
  fix?: FixRequest;
  /** Lane slot (>= 1): the lane's own ports and stack names derive from it. */
  slot: number;
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
    slot: extra.slot,
    ports: slotPorts(extra.slot),
    ticketFile: ticketFilePath(path, target.identifier),
  })}`;
}

/** `<ID> ctx:{"repo","path"}`, plus the question on the following lines when there is one. */
export function investigatorMessage(project: Project, question: string, runId: string): string {
  const first = `${project.identifier} ctx:${JSON.stringify({
    repo: project.repo,
    path: project.path,
    ticketFile: ticketFilePath(project.path, project.identifier, runId),
    reportFile: investigationFilePath(project.path, project.identifier, runId),
  })}`;
  return question ? `${first}\n${question}` : first;
}

export interface ReviewerContext {
  base: string;
  pr: { number: number; url: string };
  round: number;
  /** `green` = all checks passed; `none` = the repo has no CI checks at all. */
  ci: "green" | "none";
}

/** Single-line `<ID> ctx:<json>` message for the reviewer. */
export function reviewerMessage(target: Target, extra: ReviewerContext): string {
  if (!BRANCH_PATTERN.test(extra.base)) throw new Error("invalid base branch");
  const { repo, path, branch } = target;
  const ticketFile = ticketFilePath(path, target.identifier);
  return `${target.identifier} ctx:${JSON.stringify({ repo, path, branch, ...extra, ticketFile })}`;
}

// ── Worktree lane registry (`<repo>/.slim/worktrees.json`) ──

export interface LaneRegistry {
  version?: unknown;
  updatedAt?: unknown;
  lanes: { slug?: unknown; path?: unknown; [key: string]: unknown }[];
  [key: string]: unknown;
}

/**
 * Registry without the lane for this worktree, other lanes untouched and `updatedAt` refreshed. The lane is matched
 * on its path (`.slim/worktrees/<slug>`, or the absolute `worktree`), never on the slug alone: a lane with the same
 * slug elsewhere is someone else's. Null if the registry is malformed or has no such lane.
 */
export function removeLane(registry: unknown, worktree: string, slug: string, nowIso: string): LaneRegistry | null {
  if (typeof registry !== "object" || registry === null || !Array.isArray((registry as LaneRegistry).lanes)) {
    return null;
  }
  const current = registry as LaneRegistry;
  const relative = `.slim/worktrees/${slug}`;
  const lanes = current.lanes.filter((l) => l?.path !== worktree && l?.path !== relative);
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

export const PORTS_PER_SLOT = 100;
const PORT_BASE = 10_000;
/** Highest slot whose port block still fits below 65536. */
export const MAX_SLOT = Math.floor((65_535 - PORT_BASE - (PORTS_PER_SLOT - 1)) / PORTS_PER_SLOT);

/** The block of host ports a lane may use: `base` to `base + count - 1`. */
export function slotPorts(slot: number): { base: number; count: number } {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) throw new Error(`slot ${slot} is outside 1..${MAX_SLOT}`);
  return { base: PORT_BASE + slot * PORTS_PER_SLOT, count: PORTS_PER_SLOT };
}

const isSlot = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/** Lowest integer >= 1 not used as `slot` by any lane (any owner: interactive lanes record slots too). */
export function lowestFreeSlot(lanes: { slot?: unknown }[]): number {
  const used = new Set(lanes.map((l) => l?.slot).filter(isSlot));
  let slot = 1;
  while (used.has(slot)) slot++;
  return slot;
}

/**
 * Registry with the lane added (`updatedAt` refreshed) and the lane's slot, per the worktrees skill.
 * A new lane, or an existing one without a slot, gets the lowest free slot; an existing slot is kept.
 * Lanes in `abandoned` (the poller's own lanes whose worktree directory is gone) are dropped first, so their slots
 * are free again. A null registry starts a new one. `registry` is the same object when nothing changed,
 * and the result is null if the registry is malformed.
 */
export function addLane(
  registry: unknown,
  lane: LaneInput,
  nowIso: string,
  abandoned: ReadonlySet<string> = new Set(),
): { registry: LaneRegistry; slot: number } | null {
  if (registry === null) {
    registry = { version: "1.0.0", updatedAt: nowIso, lanes: [] };
  }
  if (typeof registry !== "object" || registry === null || !Array.isArray((registry as LaneRegistry).lanes)) {
    return null;
  }
  const original = registry as LaneRegistry;
  const kept = original.lanes.filter((l) => !abandoned.has(String(l?.slug)));
  const current: LaneRegistry = kept.length === original.lanes.length ? original : { ...original, updatedAt: nowIso, lanes: kept };
  const existing = current.lanes.find((l) => l?.slug === lane.slug);
  if (existing && isSlot(existing.slot)) return { registry: current, slot: existing.slot };
  const slot = lowestFreeSlot(current.lanes);
  if (existing) {
    return {
      registry: {
        ...current,
        updatedAt: nowIso,
        lanes: current.lanes.map((l) => (l === existing ? { ...l, slot } : l)),
      },
      slot,
    };
  }
  return {
    registry: {
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
          slot,
        },
      ],
    },
    slot,
  };
}

/** Slugs of the poller's own lanes whose directory is not among `existingDirs` (names under `.slim/worktrees/`). */
export function abandonedLanes(registry: unknown, existingDirs: ReadonlySet<string>): Set<string> {
  if (typeof registry !== "object" || registry === null || !Array.isArray((registry as LaneRegistry).lanes)) {
    return new Set();
  }
  const slugs = (registry as LaneRegistry).lanes
    .filter((l) => l?.owner === WORKTREE_OWNER && typeof l.slug === "string" && !existingDirs.has(l.slug))
    .map((l) => l.slug as string);
  return new Set(slugs);
}

// ── Disk-driven cleanup ──

const WORKTREE_SLUG_PATTERN = /^[a-z]+-[0-9]+$/;

/** Ticket identifier for a directory under `.slim/worktrees/`, or null (`.tickets`, other names). */
export function worktreeDirIdentifier(name: string): string | null {
  return WORKTREE_SLUG_PATTERN.test(name) ? name.toUpperCase() : null;
}

export type LaneOwnership = "poller" | "foreign" | "none";

/**
 * Who owns the lane for `slug`: the poller, someone else (another owner, or an unreadable registry,
 * to stay safe), or nobody (no registry, or no entry for the slug).
 */
export function laneOwnership(registry: unknown, slug: string): LaneOwnership {
  if (registry === null) return "none";
  if (typeof registry !== "object" || !Array.isArray((registry as LaneRegistry).lanes)) return "foreign";
  const lane = (registry as LaneRegistry).lanes.find((l) => l?.slug === slug);
  if (!lane) return "none";
  return lane.owner === WORKTREE_OWNER ? "poller" : "foreign";
}

/** Identifiers of worktree directories the poller may clean up: its own lanes, and unregistered ticket-named ones. */
export function cleanupIdentifiers(dirNames: string[], registry: unknown): string[] {
  return dirNames.flatMap((name) => {
    const identifier = worktreeDirIdentifier(name);
    return identifier !== null && laneOwnership(registry, name) !== "foreign" ? [identifier] : [];
  });
}

/** Ticket states whose worktrees may be cleaned up (the PR decides the rest). */
export function isCleanupState(state: string): boolean {
  return state === STATE.readyForMerge || state === STATE.done || state === STATE.canceled;
}

// ── Main checkout update after merges ──

export interface WorktreeBlockerFacts {
  registered: boolean;
  locked: boolean;
  dirty: boolean;
  branchHead: string | null;
  worktreeHead: string | null;
  prHead: string;
}

/** Why a ticket's worktree must stay (never forced), or null if removing it loses nothing. */
export function worktreeBlocker(facts: WorktreeBlockerFacts): string | null {
  if (!facts.registered) return "not a registered worktree";
  if (facts.locked) return "locked";
  if (facts.dirty) return "uncommitted changes";
  if (facts.branchHead === null) return "no local branch";
  if (facts.branchHead !== facts.prHead) return "local branch differs from PR head";
  if (facts.worktreeHead !== facts.prHead) return "worktree HEAD differs from PR head";
  return null;
}

export interface MainFacts {
  defaultBranch: string;
  /** The checkout (main checkout or a linked worktree) that has the default branch checked out, if any. */
  holder: { path: string; dirty: boolean; operation: boolean } | null;
  local: string | null;
  remote: string | null;
  /** Whether `local` is an ancestor of `remote`; only read when both exist and differ. */
  fastForward: boolean;
}

export type MainDecision =
  | { kind: "uptodate" }
  | { kind: "merge"; at: string }
  | { kind: "update-ref" }
  | { kind: "skip"; reason: string };

/**
 * How to bring the local default branch up to `origin/<default>`:
 * - checked out somewhere (main checkout or any worktree, also one in the middle of a rebase or bisect of it): a
 *   fast-forward merge there, if its tree is clean and no operation is in progress;
 * - checked out nowhere: move the ref (it is an ancestor of the remote one, so nothing is lost).
 * Local commits that are not on origin (not a fast-forward) are never touched.
 */
export function mainUpdateDecision(facts: MainFacts): MainDecision {
  if (facts.remote === null) return { kind: "skip", reason: `no origin/${facts.defaultBranch}` };
  if (facts.local === null) return { kind: "skip", reason: `no local ${facts.defaultBranch}` };
  if (facts.local === facts.remote) return { kind: "uptodate" };
  if (!facts.fastForward) return { kind: "skip", reason: "not a fast-forward" };
  if (facts.holder === null) return { kind: "update-ref" };
  if (facts.holder.operation) return { kind: "skip", reason: `operation in progress in ${facts.holder.path}` };
  if (facts.holder.dirty) return { kind: "skip", reason: `uncommitted changes in ${facts.holder.path}` };
  return { kind: "merge", at: facts.holder.path };
}

// ── Scheduling: the job table decides what may start ──

export interface LiveJob {
  identifier: string;
  /** Work, fix, and review jobs count against the pool; investigations do not. */
  automated: boolean;
}

/** Identifiers with a live automated job. */
export function automatedIdentifiers(live: LiveJob[]): Set<string> {
  return new Set(live.filter((j) => j.automated).map((j) => j.identifier));
}

export function hasCapacity(live: LiveJob[], maxAutomated: number): boolean {
  return live.filter((j) => j.automated).length < maxAutomated;
}

/** An automated job may start if the pool has a free slot and the ticket has no automated job. */
export function canStartAutomated(identifier: string, live: LiveJob[], maxAutomated: number): boolean {
  return hasCapacity(live, maxAutomated) && !automatedIdentifiers(live).has(identifier);
}

// ── Clean auto-merge of the base branch (poller work, no agent round) ──

export interface AutoMergeFacts {
  dirty: boolean;
  head: string | null;
  prHead: string;
}

export type AutoMergeDecision = { kind: "merge" } | { kind: "skip"; reason: string };

/** Whether the ticket worktree may be used to merge the base: clean, and exactly at the PR head. */
export function autoMergeDecision(facts: AutoMergeFacts): AutoMergeDecision {
  if (facts.dirty) return { kind: "skip", reason: "worktree has uncommitted changes" };
  if (facts.head !== facts.prHead) return { kind: "skip", reason: "worktree HEAD differs from PR head" };
  return { kind: "merge" };
}

// ── Retry after a failed run, and requeue after a poller stop ──

export const RETRY_PREFIX = "Agent: retrying";
export const MAX_RETRIES = 1;
/** Retries per lane over the whole ticket, whatever the timestamps say: a hard stop against loops. */
export const MAX_RETRIES_TOTAL = 3;

export type RunLane = "work" | "fix" | "review";

/** Body of the persisted retry marker comment; the lane is part of it so budgets stay per lane. */
export const retryComment = (lane: RunLane, reason: string): string => `${RETRY_PREFIX} (${lane}) — ${oneLine(reason)}`;

const RETRY_LANE = /^Agent: retrying \((work|fix|review)\)/;

const retryComments = (comments: TimedComment[], lane: RunLane, posterId: string): TimedComment[] =>
  authoredBy(comments, posterId).filter((c) => RETRY_LANE.exec(c.body)?.[1] === lane);

/**
 * Retry comments of the poller for `lane` created at or after `sinceIso` (all when null): the budget used.
 * Inclusive on purpose: a retry comment with the same timestamp as the lane entry still counts, so equal
 * timestamps can only cost a retry, never grant another one.
 */
export function retriesUsed(comments: TimedComment[], sinceIso: string | null, lane: RunLane, posterId: string): number {
  const since = sinceIso === null ? -Infinity : Date.parse(sinceIso);
  return retryComments(comments, lane, posterId).filter((c) => Date.parse(c.createdAt) >= since).length;
}

/** All retry comments of the poller for `lane` on the ticket, regardless of age. */
export function retriesTotal(comments: TimedComment[], lane: RunLane, posterId: string): number {
  return retryComments(comments, lane, posterId).length;
}

/** Creation time of the newest poller `Agent review: changes requested` comment, or null. */
export function latestChangesRequestedAt(comments: TimedComment[], posterId: string): string | null {
  return (
    byCreatedAt(authoredBy(comments, posterId).filter((c) => c.body.startsWith(CHANGES_REQUESTED_PREFIX))).at(-1)
      ?.createdAt ?? null
  );
}

/**
 * Whether the poller already wrote this ticket's `changes requested` comment but the label/move did not follow
 * (the ticket is still in Agent review with the comment newer than its entry into Agent review).
 */
export function fixWritesPending(comments: TimedComment[], posterId: string, reviewEnteredIso: string | null): boolean {
  const latest = latestChangesRequestedAt(comments, posterId);
  return latest !== null && reviewEnteredIso !== null && Date.parse(latest) > Date.parse(reviewEnteredIso);
}

export type RunFailure = "error" | "timeout" | "marker";

export interface RetryFacts {
  kind: "work" | "fix" | "review";
  failure: RunFailure;
  /** Whether the run pushed to the ticket branch (or this could not be ruled out). Reviews never push. */
  pushed: boolean;
  retriesUsed: number;
  /** Retry comments for this lane on the whole ticket. */
  retriesTotal: number;
  maxRetries?: number;
}

/**
 * Whether a failed run is tried once more instead of going to Needs human.
 * Work and fix runs retry any failure if nothing was pushed; review runs only retry a transport or server error.
 */
export function retryDecision(facts: RetryFacts): boolean {
  if (facts.retriesUsed >= (facts.maxRetries ?? MAX_RETRIES)) return false;
  if (facts.retriesTotal >= MAX_RETRIES_TOTAL) return false;
  if (facts.kind === "review") return facts.failure === "error";
  return !facts.pushed;
}

// ── Main checkout retry ──

export const MAIN_RETRY_MS = 10 * 60_000;

export type MainOutcome = "updated" | "uptodate" | "skip" | "error";

/** A project stays pending until its main checkout is up to date or updated. */
export function keepMainPending(outcome: MainOutcome): boolean {
  return outcome === "skip" || outcome === "error";
}

/** A check is due when it never ran, or its last run is at least `intervalMs` old. */
export function isDue(lastRunMs: number | null, now: number, intervalMs: number): boolean {
  return lastRunMs === null || now - lastRunMs >= intervalMs;
}

/** How often a worktree directory is looked up in Linear and GitHub for cleanup. */
export const CLEANUP_RECHECK_MS = 10 * 60_000;

// ── Repeated git fetch failures ──

export const MAX_CONSECUTIVE_FETCH_FAILURES = 5;

/** A fetch failure is skipped (retried next pass) until it has failed `limit` times in a row, then it is permanent. */
export function fetchFailureDecision(
  consecutiveFailures: number,
  limit: number = MAX_CONSECUTIVE_FETCH_FAILURES,
): "skip" | "escalate" {
  return consecutiveFailures >= limit ? "escalate" : "skip";
}

// ── Docker stacks and orphaned lane directories ──

export interface ComposeProject {
  project: string;
  workingDir: string;
}

/** Compose project names are lowercase letters, digits, `-` and `_`; anything else is never passed to docker. */
export const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Lane directory names the poller will ever consider (ticket slugs and interactive lane names). */
export const LANE_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Parses `docker ps -a --format '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}'`.
 * Containers without those labels, and projects with an unusable name, are dropped; entries are unique.
 */
export function parseComposeProjects(stdout: string): ComposeProject[] {
  const seen = new Set<string>();
  const projects: ComposeProject[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [project, workingDir] = line.split("\t").map((part) => part.trim());
    if (!project || !workingDir || !workingDir.startsWith("/") || !COMPOSE_PROJECT_PATTERN.test(project)) continue;
    const key = `${project}\t${workingDir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({ project, workingDir });
  }
  return projects;
}

/** Why a lane directory must stay when compose projects it shares with other directories were left running, or null. */
export function sharedProjectBlocker(shared: readonly string[]): string | null {
  return shared.length === 0 ? null : `shared compose project ${shared.join(",")}`;
}

export interface OrphanDirInput {
  /** Real path of `<checkout>/.slim/worktrees`. */
  worktreesReal: string;
  /** Directory entries: lstat says directory (a symlink or file is not), `.git` present, and the real path (null if unresolvable). */
  entries: { name: string; real: string | null; isDirectory: boolean; hasGit: boolean }[];
  /** Real paths of the worktrees git knows about. */
  registered: ReadonlySet<string>;
  /** Lowercase identifiers of tickets with a live automated job. */
  liveSlugs: ReadonlySet<string>;
}

/**
 * Lane directories that are not git worktrees and belong to no running job. A directory counts only if it is a
 * real directory (not a symlink or file), its real path is directly under the worktrees directory, its name is a
 * plain lane name (not `.tickets`), and it is not registered. A directory containing `.git` (a worktree or a
 * clone, whatever git thinks of it) is never an orphan: it is reported in `withGit` instead.
 */
export function orphanDirs(input: OrphanDirInput): { orphans: string[]; withGit: string[] } {
  const candidates = input.entries.filter(
    (e) =>
      e.isDirectory &&
      LANE_SLUG_PATTERN.test(e.name) &&
      e.real === `${input.worktreesReal.replace(/\/+$/, "")}/${e.name}` &&
      !input.registered.has(e.real) &&
      !input.liveSlugs.has(e.name),
  );
  return {
    orphans: candidates.filter((e) => !e.hasGit).map((e) => e.name),
    withGit: candidates.filter((e) => e.hasGit).map((e) => e.name),
  };
}

export interface LanesDirFacts {
  /** lstat of `<checkout>/.slim/worktrees` says symbolic link. */
  isSymlink: boolean;
  lanesReal: string;
  projectReal: string;
}

/** The orphan scan only runs in a worktrees directory that really is `<checkout>/.slim/worktrees`, not a link elsewhere. */
export function lanesDirSafe(facts: LanesDirFacts): boolean {
  return !facts.isSymlink && facts.lanesReal === `${facts.projectReal.replace(/\/+$/, "")}/.slim/worktrees`;
}

/**
 * Splits the compose projects that have containers inside `inside` from the ones that are also used elsewhere.
 * A project is lane-exclusive only if EVERY working directory of its containers is inside; a project that also runs
 * from another directory (for example the main checkout) is shared, and `compose down` on it would take that
 * stack down too.
 */
export function partitionProjects(
  stacks: ComposeProject[],
  inside: (workingDir: string) => boolean,
): { exclusive: string[]; shared: string[] } {
  const exclusive: string[] = [];
  const shared: string[] = [];
  for (const project of new Set(stacks.map((s) => s.project))) {
    const dirs = stacks.filter((s) => s.project === project).map((s) => s.workingDir);
    if (!dirs.some(inside)) continue;
    (dirs.every(inside) ? exclusive : shared).push(project);
  }
  return { exclusive, shared };
}

/**
 * Compose projects to take down because their lane directory is gone: every working directory of the project lies
 * below one of `worktreesDirs`, in a first segment that is missing (not in `existingDirs`) or an orphan lane
 * directory (`orphanNames`). A project that also runs from anywhere else is never returned.
 */
export function orphanStackProjects(
  stacks: ComposeProject[],
  worktreesDirs: string[],
  existingDirs: ReadonlySet<string>,
  orphanNames: ReadonlySet<string>,
): string[] {
  const goneSegment = (workingDir: string): boolean =>
    worktreesDirs.some((dir) => {
      const base = dir.replace(/\/+$/, "");
      if (!workingDir.startsWith(`${base}/`)) return false;
      const segment = workingDir.slice(base.length + 1).split("/")[0];
      return segment !== "" && (!existingDirs.has(segment) || orphanNames.has(segment));
    });
  return [...new Set(stacks.map((s) => s.project))].filter((project) =>
    stacks.filter((s) => s.project === project).every((s) => goneSegment(s.workingDir)),
  );
}

/**
 * The two-pass rule: a candidate is acted on only if it was also a candidate in the previous pass.
 * `seen` is what the next pass compares against (only current candidates stay).
 */
export function orphanPass(seenBefore: ReadonlySet<string>, candidates: readonly string[]): { due: string[]; seen: Set<string> } {
  return { due: candidates.filter((c) => seenBefore.has(c)), seen: new Set(candidates) };
}

/** A path that can be used in a `docker run -v` bind without being split or reinterpreted. */
export function isBindSafe(path: string): boolean {
  return path.startsWith("/") && !/[:,\0-\x1f]/.test(path);
}
