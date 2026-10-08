// Pure selection logic for the kanban poller. No I/O, no clock access: every
// function takes plain data and `now` (epoch milliseconds).

export const STATE = {
  backlog: "Backlog",
  ready: "Ready for agent",
  inProgress: "In Progress",
  agentReview: "Agent review",
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

export type Backoff = Map<string, number>;

export function setBackoff(backoff: Backoff, issueId: string, now: number, ms: number): void {
  backoff.set(issueId, now + ms);
}

export function isBackedOff(backoff: Backoff, issueId: string, now: number): boolean {
  const until = backoff.get(issueId);
  if (until === undefined) return false;
  if (now >= until) {
    backoff.delete(issueId);
    return false;
  }
  return true;
}

export function pickReview(issues: Issue[], backoff: Backoff, now: number): Issue | null {
  return (
    byCreatedAt(issues.filter((i) => i.state === STATE.agentReview)).find(
      (i) => !isBackedOff(backoff, i.id, now),
    ) ?? null
  );
}

export function pickFix(issues: Issue[]): Issue | null {
  return (
    byCreatedAt(
      issues.filter(
        (i) => i.state === STATE.inProgress && i.labels.includes(LABEL.changesRequested),
      ),
    )[0] ?? null
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

/**
 * Extracts the single `path: /absolute/path` line from a project description.
 * Returns null if absent, relative, or ambiguous (several distinct values).
 */
export function parseProjectPath(text: string): string | null {
  const paths = new Set<string>();
  for (const match of text.matchAll(/^\s*path:\s*(.+?)\s*$/gim)) {
    const value = match[1].replace(/^`+|`+$/g, "").trim();
    if (value.startsWith("/")) paths.add(value);
  }
  return paths.size === 1 ? [...paths][0] : null;
}
