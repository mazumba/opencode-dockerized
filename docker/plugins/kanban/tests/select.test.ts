import { describe, expect, test } from "bun:test";
import issues from "./fixtures/issues.json";
import comments from "./fixtures/comments.json";
import { loadConfig, ConfigError } from "../poller/config.ts";
import { buildArgs } from "../poller/runner.ts";
import {
  autoLabelTargets,
  addLane,
  investigateRequests,
  investigationOutcome,
  investigatorMessage,
  parseInvestigate,
  parseProjectPath,
  fixCandidates,
  readyCandidates,
  refinementLabel,
  reviewCandidates,
  staleClaims,
  viewerClaimReactionIds,
  worktreePlan,
  type Comment,
  type Issue,
  type IssueReaction,
} from "../poller/select.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const WORK_TIMEOUT_MS = 60 * 60_000;
const allIssues = issues as Issue[];
const allComments = comments as Comment[];
const ids = (list: { id: string }[]) => list.map((i) => i.id);

describe("parseInvestigate", () => {
  test("bare command", () => expect(parseInvestigate("/investigate")).toEqual({ question: "" }));
  test("question on first line and following lines", () => {
    expect(parseInvestigate("/investigate Why?\nMore")).toEqual({ question: "Why?\nMore" });
  });
  test("question only on later lines", () => {
    expect(parseInvestigate("/investigate\nWhy?")).toEqual({ question: "Why?" });
  });
  test("no match for suffixes, prefixes, and mid-text", () => {
    expect(parseInvestigate("/investigateX")).toBeNull();
    expect(parseInvestigate("please /investigate")).toBeNull();
    expect(parseInvestigate("")).toBeNull();
  });
});

describe("investigateRequests", () => {
  const requests = investigateRequests(allComments, "viewer", NOW);

  test("keeps only authentic, recent, unanswered requests, oldest first", () => {
    expect(requests.map((r) => r.comment.id)).toEqual(["c-eyes-other", "c-question", "c-ok"]);
  });
  test("rejects other users, missing user, external, bot, and synced comments", () => {
    const rejected = ["c-other-user", "c-no-user", "c-external", "c-bot", "c-synced"];
    expect(requests.map((r) => r.comment.id).some((id) => rejected.includes(id))).toBe(false);
  });
  test("skips answered, suffixed, mid-text, and older than 7 days", () => {
    const rejected = ["c-answered", "c-suffix", "c-mid", "c-old"];
    expect(requests.map((r) => r.comment.id).some((id) => rejected.includes(id))).toBe(false);
  });
  test("carries the question", () => {
    const byId = (id: string) => requests.find((r) => r.comment.id === id)!;
    expect(byId("c-question").question).toBe("Why is the cache slow?\nSee also the loader.");
    expect(byId("c-ok").question).toBe("");
  });
  test("the viewer's eyes reaction marks a comment as handled", () => {
    expect(requests.map((r) => r.comment.id)).not.toContain("c-eyes-viewer");
  });
  test("someone else's eyes reaction does not", () => {
    expect(requests.map((r) => r.comment.id)).toContain("c-eyes-other");
  });
  test("a legacy `Agent investigation:` reply without a reaction still marks it handled", () => {
    const legacy = allComments.find((c) => c.id === "c-answered")!;
    expect(legacy.reactions).toEqual([]);
    expect(requests.map((r) => r.comment.id)).not.toContain("c-answered");
  });
});

describe("investigationOutcome", () => {
  const ok = { exitCode: 0, timedOut: false, aborted: false, minutes: 3 };
  const START = Date.parse("2026-10-08T12:00:00Z");
  const note = (body: string, createdAt = "2026-10-08T12:05:00Z") => ({ body, createdAt });
  test("success needs exit 0 and a fresh `Agent investigation:` comment", () => {
    expect(investigationOutcome(ok, [note("Agent investigation: found it")], START)).toEqual({ emoji: "white_check_mark" });
    expect(investigationOutcome(ok, [note("Agent investigation: x", "2026-10-08T12:00:00Z")], START)).toEqual({ emoji: "white_check_mark" });
  });
  test("failures map to x with a reason, most specific first", () => {
    const comments = [note("Agent investigation: found it")];
    expect(investigationOutcome({ ...ok, aborted: true }, comments, START)).toEqual({ emoji: "x", reason: "poller stopped" });
    expect(investigationOutcome({ ...ok, timedOut: true, exitCode: null }, comments, START)).toEqual({ emoji: "x", reason: "timeout after 3 min" });
    expect(investigationOutcome({ ...ok, exitCode: 2 }, comments, START)).toEqual({ emoji: "x", reason: "exit code 2" });
  });
  const noComment = { emoji: "x", reason: "no investigation comment posted" };
  test("no comment, an older comment, a `failed` comment, or an unrelated comment is a failure", () => {
    expect(investigationOutcome(ok, [], START)).toEqual(noComment);
    expect(investigationOutcome(ok, [note("Agent investigation: old", "2026-10-08T11:59:59Z")], START)).toEqual(noComment);
    expect(investigationOutcome(ok, [note("Agent investigation: failed — timeout")], START)).toEqual(noComment);
    expect(investigationOutcome(ok, [note("Looks fine to me")], START)).toEqual(noComment);
  });
});

describe("investigatorMessage", () => {
  const project = { identifier: "DEY-9", repo: "o/r", path: "/repo" };
  test("single ctx line without a question", () => {
    expect(investigatorMessage(project, "")).toBe('DEY-9 ctx:{"repo":"o/r","path":"/repo"}');
  });
  test("question follows on the next line, verbatim", () => {
    expect(investigatorMessage(project, "Why?\nMore")).toBe('DEY-9 ctx:{"repo":"o/r","path":"/repo"}\nWhy?\nMore');
  });
});

describe("candidate selection", () => {
  test("review returns all Agent review tickets, oldest first", () => {
    expect(ids(reviewCandidates(allIssues))).toEqual(["id-1", "id-2"]);
  });
  test("fix picks In Progress with the changes-requested label only", () => {
    expect(ids(fixCandidates(allIssues))).toEqual(["id-3"]);
    expect(fixCandidates(allIssues.filter((i) => i.id !== "id-3"))).toEqual([]);
  });
  test("ready candidates are oldest first and labelled ones are detectable", () => {
    const ready = readyCandidates(allIssues);
    expect(ids(ready)).toEqual(["id-5", "id-6", "id-7"]);
    expect(ready.map(refinementLabel)).toEqual(["needs grilling", null, "investigate"]);
  });
});

describe("autoLabelTargets", () => {
  test("labels only unlabelled Backlog tickets; refined and refinement labels are skipped", () => {
    expect(ids(autoLabelTargets(allIssues))).toEqual(["id-8", "id-12"]);
  });
});

describe("staleClaims", () => {
  const VIEWER = "viewer";
  const reaction = (over: Partial<IssueReaction> = {}): IssueReaction => ({
    id: "r",
    emoji: "eyes",
    userId: VIEWER,
    createdAt: "2026-10-08T09:00:00Z",
    ...over,
  });
  const issue = (id: string, reactions: IssueReaction[], state = "In Progress"): Issue => ({
    id,
    identifier: "DEY-1",
    createdAt: "2026-10-01T00:00:00Z",
    state,
    labels: [],
    projectPath: "/repo",
    projectConfig: { repo: "o/r", path: "/repo" },
    branchName: "b",
    reactions,
  });
  const stale = (...issues: Issue[]) => ids(staleClaims(issues, VIEWER, NOW, WORK_TIMEOUT_MS));

  const cases: [string, Issue, boolean][] = [
    ["old viewer claim", issue("old", [reaction()]), true],
    ["fresh viewer claim", issue("fresh", [reaction({ createdAt: "2026-10-08T11:30:00Z" })]), false],
    ["exactly at the timeout", issue("edge", [reaction({ createdAt: "2026-10-08T11:00:00Z" })]), false],
    ["no reactions", issue("none", []), false],
    ["only someone else's claim", issue("other", [reaction({ userId: "someone" })]), false],
    ["only other emoji", issue("emoji", [reaction({ emoji: "x" })]), false],
    ["latest claim is fresh", issue("renewed", [reaction({ id: "a" }), reaction({ id: "b", createdAt: "2026-10-08T11:50:00Z" })]), false],
    ["latest claim is old", issue("both-old", [reaction({ id: "a", createdAt: "2026-10-08T08:00:00Z" }), reaction({ id: "b" })]), true],
    ["not In Progress", issue("review", [reaction()], "Agent review"), false],
  ];
  test.each(cases)("%s", (_name, candidate, expected) => {
    expect(stale(candidate)).toEqual(expected ? [candidate.id] : []);
  });

  test("viewerClaimReactionIds returns only the viewer's claim reactions", () => {
    const target = issue("x", [
      reaction({ id: "a" }),
      reaction({ id: "b", userId: "someone" }),
      reaction({ id: "c", emoji: "x" }),
      reaction({ id: "d" }),
    ]);
    expect(viewerClaimReactionIds(target, VIEWER)).toEqual(["a", "d"]);
  });
});

describe("worktreePlan", () => {
  const facts = { worktreeExists: false, localBranch: false, remoteBranch: false, defaultBranch: "main", branch: "max/dey-9" };
  const cases: [string, Partial<typeof facts>, unknown][] = [
    ["worktree exists", { worktreeExists: true, localBranch: true, remoteBranch: true }, { kind: "reuse" }],
    ["local branch", { localBranch: true }, { kind: "existing-local", branch: "max/dey-9" }],
    ["local and remote branch prefers local", { localBranch: true, remoteBranch: true }, { kind: "existing-local", branch: "max/dey-9" }],
    ["remote branch only", { remoteBranch: true }, { kind: "track", branch: "max/dey-9" }],
    ["neither", {}, { kind: "new", branch: "max/dey-9", base: "origin/main" }],
    ["neither, other default", { defaultBranch: "develop" }, { kind: "new", branch: "max/dey-9", base: "origin/develop" }],
  ];
  test.each(cases)("%s", (_name, over, expected) => expect(worktreePlan({ ...facts, ...over })).toEqual(expected));
});

describe("addLane", () => {
  const NOW_ISO = "2026-10-09T10:00:00.000Z";
  const lane = { slug: "dey-9", branch: "max/dey-9", base: "main", purpose: "ticket DEY-9" };
  const expectedLane = {
    slug: "dey-9",
    branch: "max/dey-9",
    path: ".slim/worktrees/dey-9",
    base: "main",
    purpose: "ticket DEY-9",
    owner: "kanban-poller",
    status: "active",
    areas: [],
    createdAt: NOW_ISO,
  };
  test("creates a registry when none exists", () => {
    expect(addLane(null, lane, NOW_ISO)).toEqual({ version: "1.0.0", updatedAt: NOW_ISO, lanes: [expectedLane] });
  });
  test("appends and keeps other lanes and unknown fields", () => {
    const registry = { version: "1.0.0", updatedAt: "old", extra: 1, lanes: [{ slug: "other", path: ".slim/worktrees/other" }] };
    expect(addLane(registry, lane, NOW_ISO)).toEqual({
      ...registry,
      updatedAt: NOW_ISO,
      lanes: [registry.lanes[0], expectedLane],
    });
    expect(registry.lanes).toHaveLength(1);
  });
  test("is idempotent when the lane exists", () => {
    const registry = { version: "1.0.0", updatedAt: "old", lanes: [{ slug: "dey-9" }] };
    expect(addLane(registry, lane, NOW_ISO)).toBe(registry);
  });
  test("returns null for a malformed registry", () => {
    expect(addLane({ lanes: "x" }, lane, NOW_ISO)).toBeNull();
    expect(addLane("x", lane, NOW_ISO)).toBeNull();
  });
});

describe("parseProjectPath", () => {
  test("extracts the path line", () => {
    expect(parseProjectPath("repo: a/b\npath: /home/x/repo\n")).toBe("/home/x/repo");
  });
  test("strips backticks", () => expect(parseProjectPath("path: `/x`")).toBe("/x"));
  test("rejects missing, relative, and ambiguous paths", () => {
    expect(parseProjectPath("repo: a/b")).toBeNull();
    expect(parseProjectPath("path: relative/dir")).toBeNull();
    expect(parseProjectPath("path: /a\npath: /b")).toBeNull();
  });
});

describe("loadConfig", () => {
  const env = { LINEAR_API_KEY: "k", OPENCODE_SERVER_PASSWORD: "p" };
  test("applies defaults", () => {
    const config = loadConfig(env, []);
    expect(config.team).toBe("DEY");
    expect(config.pollIntervalMs).toBe(60_000);
    expect(config.timeoutWorkMs).toBe(60 * 60_000);
    expect(config.opencodeUrl).toBe("http://opencode:4096");
    expect(config.once).toBe(false);
  });
  test("parses flags and overrides", () => {
    const config = loadConfig({ ...env, KANBAN_TEAM: "ABC" }, ["--once", "--dry-run"]);
    expect(config).toMatchObject({ team: "ABC", once: true, dryRun: true });
  });
  test("fails fast on missing env, bad numbers, and unknown flags", () => {
    expect(() => loadConfig({ OPENCODE_SERVER_PASSWORD: "p" }, [])).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, KANBAN_POLL_INTERVAL: "abc" }, [])).toThrow(ConfigError);
    expect(() => loadConfig(env, ["--nope"])).toThrow(ConfigError);
  });
});

describe("buildArgs", () => {
  test("passes the message as the last single argument and --dir when known", () => {
    const args = buildArgs({
      opencodeBin: "opencode", url: "http://o:4096", agent: "ticket-investigator",
      command: "investigate-ticket", message: "DEY-1 why; rm -rf /", dir: "/repo", timeoutMs: 1,
    });
    expect(args).toEqual([
      "run", "--attach", "http://o:4096", "--agent", "ticket-investigator",
      "--command", "investigate-ticket", "--dir", "/repo", "DEY-1 why; rm -rf /",
    ]);
  });
  test("omits --dir without a path", () => {
    const args = buildArgs({
      opencodeBin: "o", url: "u", agent: "a", command: "c", message: "DEY-1", dir: null, timeoutMs: 1,
    });
    expect(args).not.toContain("--dir");
  });
});
