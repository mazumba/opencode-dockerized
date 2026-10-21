import { describe, expect, test } from "bun:test";
import { cleanupDecision, excludeAppend, isCandidate, jobKey, mentions, parseResult, planStarts, pushPolicy, roleAllowed, validRef, type Candidate, type Comment, type CleanupFacts, type CleanupDecision } from "../poller/select.ts";
import { loadConfig } from "../poller/config.ts";
import { worktreeDirIdentifier } from "../../kanban/poller/select.ts";

test("mention worktrees are not recognized as kanban worktrees", () => {
  expect(worktreeDirIdentifier("mention-pr-1583")).toBeNull();
  expect(worktreeDirIdentifier("dey-12")).not.toBeNull();
});

const now = Date.parse("2026-10-20T12:00:00Z");
describe("cleanupDecision", () => {
  const base: CleanupFacts = { prState: "closed", merged: false, liveJob: false, registered: true, dirty: false, ancestor: true, dryRun: false };
  const cases: [string, Partial<CleanupFacts>, CleanupDecision][] = [
    ["closed and pushed", {}, { action: "remove" }],
    ["merged", { prState: "open", merged: true }, { action: "remove" }],
    ["open before other checks", { prState: "open", registered: false, dirty: true }, { action: "keep" }],
    ["live before other checks", { liveJob: true, registered: false }, { action: "keep" }],
    ["unregistered before dirty", { registered: false, dirty: true }, { action: "skip", reason: "not registered" }],
    ["dirty before ancestry", { dirty: true, ancestor: false }, { action: "skip", reason: "uncommitted changes" }],
    ["unpushed", { ancestor: false }, { action: "skip", reason: "unpushed commits" }],
    ["unknown ancestry", { ancestor: "unknown" }, { action: "skip", reason: "unknown" }],
    ["dry-run removable prediction", { dryRun: true }, { action: "remove" }],
    ["dry-run unknown ref", { dryRun: true, ancestor: "unknown" }, { action: "skip", reason: "unknown" }],
    ["unknown PR state", { prState: "unknown" }, { action: "skip", reason: "unknown PR state" }],
  ];
  for (const [name, facts, expected] of cases) test(name, () => expect(cleanupDecision({ ...base, ...facts })).toEqual(expected));
});
const config = { handle: "@example-bot", botLogin: "example-bot[bot]", allowedUsers: ["Alice"], lookbackMs: 3_600_000 };
const comment = (over: Partial<Comment> = {}): Comment => ({
  id: 1, html_url: "https://github.com/org/repo/pull/12#issuecomment-1", issue_url: "https://api.github.com/repos/org/repo/issues/12",
  body: `${config.handle} please help`, created_at: new Date(now).toISOString(), user: { login: "alice", type: "User" }, ...over,
});
describe("mention matching", () => {
  const handle = config.handle;
  for (const [label, body, expected] of [
    ["start", `${handle} help`, true], ["middle", `please ${handle} help`, true], ["end", `please ${handle}`, true],
    ["punctuation", `(${handle}), please!`, true], ["case", handle.toUpperCase(), true],
    ["suffix word", `${handle}2`, false], ["suffix underscore", `${handle}_x`, false], ["suffix hyphen", `${handle}-x`, false],
    ["email-like", `x${handle}`, false], ["email dot", `x.${handle}`, false], ["unicode prefix", `é${handle}`, false],
  ] as const) test(label, () => expect(mentions(body, handle)).toBe(expected));
});
describe("candidate filtering", () => {
  for (const [label, value, expected] of [
    ["allowlist case insensitive", comment(), true],
    ["not allowed", comment({ user: { login: "mallory", type: "User" } }), false],
    ["self bot", comment({ user: { login: config.botLogin.toUpperCase(), type: "User" } }), false],
    ["Bot type", comment({ user: { login: "alice", type: "Bot" } }), false],
    ["issue", comment({ html_url: "https://github.com/org/repo/issues/12#issuecomment-1" }), false],
    ["invalid PR number", comment({ issue_url: "https://api.github.com/repos/org/repo/issues/0" }), false],
    ["lookback boundary", comment({ created_at: new Date(now - config.lookbackMs).toISOString() }), true],
    ["too old", comment({ created_at: new Date(now - config.lookbackMs - 1).toISOString() }), false],
    ["future", comment({ created_at: new Date(now + 1).toISOString() }), false],
    ["invalid time", comment({ created_at: "nope" }), false],
  ] as const) test(label, () => expect(isCandidate(value, config, now)).toBe(expected));
});
describe("roles", () => {
  for (const [role, expected] of [["admin", true], ["maintain", true], ["write", false], ["read", false], ["none", false], ["ADMIN", true]] as const) {
    test(role, () => expect(roleAllowed(role, ["admin", "maintain"])).toBe(expected));
  }
});
const candidate = (id: number, pr = id, repo = "org/repo"): Candidate => ({
  repo, pr, comment: comment({ id, created_at: new Date(now - (10 - id) * 1_000).toISOString() }),
});
describe("planStarts", () => {
  test("oldest first, with capacity", () => expect(planStarts([candidate(3), candidate(1), candidate(2)], new Set(), 2).map((c) => c.comment.id)).toEqual([1, 2]));
  test("one per PR, including already live", () => {
    expect(planStarts([candidate(1), candidate(2, 1), candidate(3)], new Set(), 3).map((c) => c.comment.id)).toEqual([1, 3]);
    expect(planStarts([candidate(1), candidate(2)], new Set([jobKey(candidate(1))]), 2).map((c) => c.comment.id)).toEqual([2]);
  });
  test("full and over-capacity", () => {
    expect(planStarts([candidate(1)], new Set(["org/other#1"]), 1)).toEqual([]);
    expect(planStarts([candidate(1)], new Set(["a#1", "b#1"]), 1)).toEqual([]);
  });
  test("same number in different repos is distinct", () => expect(planStarts([candidate(1), candidate(2, 1, "org/other")], new Set(), 2)).toHaveLength(2));
  test("does not mutate input", () => {
    const input = [candidate(2), candidate(1)]; const live = new Set<string>();
    planStarts(input, live, 2); expect(input[0].comment.id).toBe(2); expect(live.size).toBe(0);
  });
});
describe("result markers", () => {
  for (const line of [
    'MENTION-RESULT: {"outcome":"replied"}',
    '`MENTION-RESULT: {"outcome":"replied"}`',
    '**MENTION-RESULT: {"outcome":"replied"}**',
    '**MENTION-RESULT:** {"outcome":"replied"}',
    '> - MENTION-RESULT: {"outcome":"replied"}',
  ]) test(line, () => expect(parseResult(line)).toEqual({ ok: true, result: { outcome: "replied" } }));
  test("last marker wins", () => expect(parseResult('MENTION-RESULT: {"outcome":"replied"}\nMENTION-RESULT: {"outcome":"failed","reason":"blocked"}')).toEqual({ ok: true, result: { outcome: "failed", reason: "blocked" } }));
  for (const [output, reason] of [
    ["none", "marker missing"], ["MENTION-RESULT: nope", "marker is not JSON"],
    ['MENTION-RESULT: {"outcome":"failed"}', "marker invalid"],
    ['MENTION-RESULT: {"outcome":"replied","extra":1}', "marker invalid"],
    ['MENTION-RESULT: {"outcome":"unknown"}', "marker invalid"],
  ]) test(reason + output, () => expect(parseResult(output)).toEqual({ ok: false, reason }));
});
describe("refs and push policy", () => {
  for (const ref of ["main", "feature/a-b_2", "release/1.2"]) test(ref, () => expect(validRef(ref)).toBe(true));
  for (const ref of ["", "-x", "a..b", "a//b", "a/", "a.lock", "a/.hidden", "a b", "a@{b", "a~1", "a;touch", "a\nb"]) test(JSON.stringify(ref), () => expect(validRef(ref)).toBe(false));
  test("fork is never pushable", () => expect(pushPolicy("org/repo", "alice/repo")).toEqual({ pushable: false, pushReason: "PR from fork" }));
  test("deleted fork is not pushable", () => expect(pushPolicy("org/repo", null).pushable).toBe(false));
  test("same repo is pushable", () => expect(pushPolicy("org/repo", "ORG/REPO").pushable).toBe(true));
});
test("exclude append is idempotent and preserves missing newline", () => {
  expect(excludeAppend(null)).toBe("/.slim/worktrees/\n");
  expect(excludeAppend("# local")).toBe("# local\n/.slim/worktrees/\n");
  expect(excludeAppend("# local\n/.slim/worktrees/\n")).toBeNull();
});
test("required config and numeric validation", () => {
  const env = { MENTION_HANDLE: config.handle, MENTION_BOT_LOGIN: config.botLogin, MENTION_ALLOWED_USERS: " Alice, BOB ", MENTION_PROJECTS_ROOT: "/projects", OPENCODE_SERVER_PASSWORD: "test" };
  expect(loadConfig(env, ["--dry-run", "--once"])).toMatchObject({ allowedUsers: ["alice", "bob"], maxConcurrent: 2, dryRun: true, once: true });
  for (const key of ["MENTION_ALLOWED_USERS", "MENTION_PROJECTS_ROOT", "OPENCODE_SERVER_PASSWORD"]) expect(() => loadConfig({ ...env, [key]: "" }, [])).toThrow();
  expect(loadConfig({ ...env, MENTION_HANDLE: "", MENTION_BOT_LOGIN: "" }, [])).toMatchObject({ handle: undefined, botLogin: undefined });
  expect(() => loadConfig({ ...env, MENTION_HANDLE: "invalid" }, [])).toThrow();
  expect(() => loadConfig({ ...env, MENTION_BOT_LOGIN: "invalid" }, [])).toThrow();
  expect(() => loadConfig({ ...env, MENTION_ALLOWED_USERS: " , " }, [])).toThrow();
  expect(() => loadConfig({ ...env, MENTION_PROJECTS_ROOT: "relative" }, [])).toThrow();
  expect(() => loadConfig({ ...env, MENTION_MAX_CONCURRENT: "1.5" }, [])).toThrow();
  expect(() => loadConfig({ ...env, MENTION_TIMEOUT: "-1" }, [])).toThrow();
  expect(() => loadConfig(env, ["--unknown"])).toThrow();
});
