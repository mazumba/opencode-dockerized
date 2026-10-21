// Pure selection, scheduling, validation and result parsing.
export interface Comment {
  id: number;
  html_url: string;
  issue_url: string;
  body: string;
  created_at: string;
  user: { login: string; type: string };
}
export interface Candidate {
  repo: string;
  pr: number;
  comment: Comment;
}
export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export function validRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
    && !ref.includes("..") && !ref.includes("//")
    && ref.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}
export function mentions(body: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_@.+-])${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(body);
}
export function prNumber(comment: Comment): number | null {
  if (!comment.html_url.includes("/pull/")) return null;
  const match = /\/issues\/([1-9]\d*)$/.exec(comment.issue_url);
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}
export function isCandidate(comment: Comment, config: {
  handle: string; botLogin: string; allowedUsers: readonly string[]; lookbackMs: number;
}, now: number): boolean {
  const created = Date.parse(comment.created_at);
  const login = comment.user.login.toLowerCase();
  return prNumber(comment) !== null && mentions(comment.body, config.handle)
    && login !== config.botLogin.toLowerCase() && comment.user.type.toLowerCase() !== "bot"
    && config.allowedUsers.some((user) => user.toLowerCase() === login)
    && Number.isFinite(created) && created >= now - config.lookbackMs && created <= now;
}
export function roleAllowed(role: string, allowed: readonly string[]): boolean {
  return allowed.some((value) => value.toLowerCase() === role.toLowerCase());
}
export const jobKey = (candidate: Pick<Candidate, "repo" | "pr">): string => `${candidate.repo.toLowerCase()}#${candidate.pr}`;
export interface CleanupFacts {
  prState: string;
  merged: boolean;
  liveJob: boolean;
  registered: boolean;
  dirty: boolean;
  ancestor: boolean | "unknown";
  dryRun: boolean;
}
export type CleanupDecision = { action: "keep" } | { action: "remove" } | { action: "skip"; reason: string };

// A dry-run may return "remove" as a prediction; only the git caller performs mutations.
export function cleanupDecision(facts: CleanupFacts): CleanupDecision {
  if (facts.liveJob || (facts.prState === "open" && !facts.merged)) return { action: "keep" };
  if (facts.prState !== "closed" && !facts.merged) return { action: "skip", reason: "unknown PR state" };
  if (!facts.registered) return { action: "skip", reason: "not registered" };
  if (facts.dirty) return { action: "skip", reason: "uncommitted changes" };
  if (facts.ancestor === "unknown") return { action: "skip", reason: "unknown" };
  if (!facts.ancestor) return { action: "skip", reason: "unpushed commits" };
  return { action: "remove" };
}
export function planStarts(candidates: readonly Candidate[], live: ReadonlySet<string>, capacity: number): Candidate[] {
  const occupied = new Set(live);
  const starts: Candidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => Date.parse(a.comment.created_at) - Date.parse(b.comment.created_at) || a.comment.id - b.comment.id)) {
    if (occupied.size >= capacity) break;
    const key = jobKey(candidate);
    if (occupied.has(key)) continue;
    occupied.add(key);
    starts.push(candidate);
  }
  return starts;
}
export function pushPolicy(repo: string, headRepo: string | null): { pushable: boolean; pushReason: string } {
  return headRepo?.toLowerCase() === repo.toLowerCase()
    ? { pushable: true, pushReason: "same-repository PR" }
    : { pushable: false, pushReason: "PR from fork" };
}
export function excludeAppend(content: string | null): string | null {
  const existing = content ?? "";
  if (existing.split(/\r?\n/).some((line) => line.trim() === "/.slim/worktrees/")) return null;
  return `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}/.slim/worktrees/\n`;
}
export type ParsedResult = { ok: true; result: { outcome: "replied" } | { outcome: "failed"; reason: string } } | { ok: false; reason: string };
export function parseResult(output: string): ParsedResult {
  let payload: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /^[\s>*_`-]*MENTION-RESULT:[\s*_`]*(.*?)[\s*_`]*$/.exec(line);
    if (match) payload = match[1];
  }
  if (payload === null) return { ok: false, reason: "marker missing" };
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return { ok: false, reason: "marker is not JSON" }; }
  if (value && typeof value === "object" && "outcome" in value) {
    if (value.outcome === "replied" && Object.keys(value).length === 1) return { ok: true, result: { outcome: "replied" } };
    if (value.outcome === "failed" && "reason" in value && typeof value.reason === "string" && value.reason.trim() && Object.keys(value).length === 2) {
      return { ok: true, result: { outcome: "failed", reason: value.reason.replace(/\s+/g, " ").trim().slice(0, 200) } };
    }
  }
  return { ok: false, reason: "marker invalid" };
}
