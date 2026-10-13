import { describe, expect, test } from "bun:test";
import issues from "./fixtures/issues.json";
import comments from "./fixtures/comments.json";
import { loadConfig, ConfigError } from "../poller/config.ts";
import {
  autoLabelTargets,
  addLane,
  abandonedLanes,
  lowestFreeSlot,
  investigateRequests,
  investigationComment,
  investigationOutcome,
  investigatorMessage,
  parseInvestigate,
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
  const ok = { error: null, timedOut: false, aborted: false, minutes: 3 };
  const done = 'text\nKANBAN-RESULT: {"outcome":"done"}';
  test("success needs exit 0, a done marker, and a non-empty report", () => {
    expect(investigationOutcome(ok, done, "  # Findings\n")).toEqual({ emoji: "white_check_mark", report: "# Findings" });
  });
  test("failures map to x with a reason, most specific first", () => {
    expect(investigationOutcome({ ...ok, aborted: true }, done, "r")).toEqual({ emoji: "x", reason: "poller stopped" });
    expect(investigationOutcome({ ...ok, timedOut: true }, done, "r")).toEqual({ emoji: "x", reason: "timeout after 3 min" });
    expect(investigationOutcome({ ...ok, error: "APIError: boom" }, done, "r")).toEqual({ emoji: "x", reason: "agent error: APIError: boom" });
  });
  test("missing marker, needs-human, and a missing or blank report are failures", () => {
    expect(investigationOutcome(ok, "no marker", "r")).toEqual({ emoji: "x", reason: "no valid result marker (marker missing)" });
    expect(
      investigationOutcome(ok, 'KANBAN-RESULT: {"outcome":"needs-human","step":"read","reason":"no access"}', "r"),
    ).toEqual({ emoji: "x", reason: "read: no access" });
    expect(investigationOutcome(ok, done, null)).toEqual({ emoji: "x", reason: "no investigation report written" });
    expect(investigationOutcome(ok, done, " \n")).toEqual({ emoji: "x", reason: "no investigation report written" });
  });
});

describe("investigationComment", () => {
  test("prefixes the report", () => {
    expect(investigationComment("Findings")).toBe("Agent investigation:\n\nFindings");
  });
  test("caps long reports with a truncation note", () => {
    const body = investigationComment("x".repeat(70_000));
    expect(body.length).toBe(60_000);
    expect(body.startsWith("Agent investigation:\n\nxxx")).toBe(true);
    expect(body.endsWith("characters omitted)")).toBe(true);
  });
  test("a report at the cap is kept whole", () => {
    const report = "x".repeat(60_000 - "Agent investigation:\n\n".length);
    expect(investigationComment(report).length).toBe(60_000);
    expect(investigationComment(report)).not.toContain("truncated");
  });
  test("does not double a leading prefix", () => {
    expect(investigationComment("Agent investigation:\n\nFindings\n")).toBe("Agent investigation:\n\nFindings");
  });
});

describe("investigatorMessage", () => {
  const project = { identifier: "DEY-9", repo: "o/r", path: "/repo" };
  const ctx = JSON.stringify({
    repo: "o/r",
    path: "/repo",
    ticketFile: "/repo/.slim/worktrees/.tickets/DEY-9.r1.json",
    reportFile: "/repo/.slim/worktrees/.tickets/DEY-9.r1.investigation.md",
  });
  test("single ctx line without a question", () => {
    expect(investigatorMessage(project, "", "r1")).toBe(`DEY-9 ctx:${ctx}`);
  });
  test("question follows on the next line, verbatim", () => {
    expect(investigatorMessage(project, "Why?\nMore", "r1")).toBe(`DEY-9 ctx:${ctx}\nWhy?\nMore`);
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
  const stale = (...issues: Issue[]) => ids(staleClaims(issues, VIEWER, NOW, WORK_TIMEOUT_MS, new Set()));

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

  test("issues with a live job are excluded", () => {
    const running = issue("old", [reaction()]);
    expect(ids(staleClaims([running], VIEWER, NOW, WORK_TIMEOUT_MS, new Set([running.identifier])))).toEqual([]);
    expect(ids(staleClaims([running], VIEWER, NOW, WORK_TIMEOUT_MS, new Set(["DEY-2"])))).toEqual(["old"]);
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
  const expectedLane = (slot: number) => ({
    slug: "dey-9",
    branch: "max/dey-9",
    path: ".slim/worktrees/dey-9",
    base: "main",
    purpose: "ticket DEY-9",
    owner: "kanban-poller",
    status: "active",
    areas: [],
    createdAt: NOW_ISO,
    slot,
  });
  test("creates a registry when none exists, with slot 1", () => {
    expect(addLane(null, lane, NOW_ISO)).toEqual({
      registry: { version: "1.0.0", updatedAt: NOW_ISO, lanes: [expectedLane(1)] },
      slot: 1,
    });
  });
  test("appends, keeps other lanes and unknown fields, and takes the lowest free slot of any owner", () => {
    const registry = {
      version: "1.0.0",
      updatedAt: "old",
      extra: 1,
      lanes: [
        { slug: "a", owner: "orchestrator", slot: 1 },
        { slug: "b", owner: "kanban-poller", slot: 3 },
        { slug: "c" },
      ],
    };
    const added = addLane(registry, lane, NOW_ISO);
    expect(added).toEqual({
      registry: { ...registry, updatedAt: NOW_ISO, lanes: [...registry.lanes, expectedLane(2)] },
      slot: 2,
    });
    expect(registry.lanes).toHaveLength(3);
  });
  test("is idempotent and keeps the slot when the lane exists", () => {
    const registry = { version: "1.0.0", updatedAt: "old", lanes: [{ slug: "dey-9", slot: 4 }] };
    const added = addLane(registry, lane, NOW_ISO);
    expect(added?.registry).toBe(registry);
    expect(added?.slot).toBe(4);
  });
  test("gives an existing lane without a slot the lowest free one", () => {
    const registry = { version: "1.0.0", updatedAt: "old", lanes: [{ slug: "x", slot: 1 }, { slug: "dey-9", branch: "b" }] };
    expect(addLane(registry, lane, NOW_ISO)).toEqual({
      registry: { ...registry, updatedAt: NOW_ISO, lanes: [registry.lanes[0], { slug: "dey-9", branch: "b", slot: 2 }] },
      slot: 2,
    });
  });
  test("returns null for a malformed registry", () => {
    expect(addLane({ lanes: "x" }, lane, NOW_ISO)).toBeNull();
    expect(addLane("x", lane, NOW_ISO)).toBeNull();
  });
});

describe("abandoned lanes free their slot", () => {
  const NOW_ISO = "2026-10-09T10:00:00.000Z";
  const lane = { slug: "dey-9", branch: "b", base: "main", purpose: "ticket DEY-9" };
  const registry = {
    version: "1.0.0",
    updatedAt: "old",
    lanes: [
      { slug: "dey-1", owner: "kanban-poller", slot: 1 },
      { slug: "dey-2", owner: "kanban-poller", slot: 2 },
      { slug: "mine", owner: "orchestrator", slot: 3 },
    ],
  };
  test("abandonedLanes: only the poller's lanes without a directory", () => {
    expect(abandonedLanes(registry, new Set(["dey-2"]))).toEqual(new Set(["dey-1"]));
    expect(abandonedLanes(registry, new Set(["dey-1", "dey-2"]))).toEqual(new Set());
    expect(abandonedLanes(registry, new Set())).toEqual(new Set(["dey-1", "dey-2"]));
    expect(abandonedLanes(null, new Set())).toEqual(new Set());
    expect(abandonedLanes({ lanes: "x" }, new Set())).toEqual(new Set());
  });
  test("addLane drops abandoned lanes and reuses their slot", () => {
    const added = addLane(registry, lane, NOW_ISO, new Set(["dey-1"]));
    expect(added?.slot).toBe(1);
    expect(added?.registry.lanes.map((l) => l.slug)).toEqual(["dey-2", "mine", "dey-9"]);
  });
  test("an interactive lane without a directory is never treated as abandoned", () => {
    const added = addLane(registry, lane, NOW_ISO, abandonedLanes(registry, new Set(["dey-1", "dey-2"])));
    expect(added?.slot).toBe(4);
    expect(added?.registry.lanes.map((l) => l.slug)).toContain("mine");
  });
  test("nothing abandoned keeps the registry object when the lane exists", () => {
    const existing = { version: "1.0.0", updatedAt: "old", lanes: [{ slug: "dey-9", slot: 2 }] };
    expect(addLane(existing, lane, NOW_ISO, new Set())?.registry).toBe(existing);
  });
});

describe("lowestFreeSlot", () => {
  const lanes = (...slots: unknown[]) => slots.map((slot) => ({ slot }));
  test.each([
    ["no lanes", [], 1],
    ["slot 1 taken", lanes(1), 2],
    ["gap", lanes(1, 3), 2],
    ["unsorted", lanes(3, 1, 2), 4],
    ["lanes without slots", lanes(undefined, undefined), 1],
    ["ignores invalid slots", lanes(0, -1, 1.5, "2", null), 1],
    ["duplicates", lanes(1, 1, 2), 3],
  ])("%s", (_name, input, expected) => {
    expect(lowestFreeSlot(input)).toBe(expected);
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
    expect(config.opencodeUsername).toBe("opencode");
    expect(config.opencodePassword).toBe("p");
    expect(config.maxAutomated).toBe(3);
  });
  test("projects root: optional, absolute, trailing slashes trimmed", () => {
    expect(loadConfig(env, []).projectsRoot).toBeNull();
    expect(loadConfig({ ...env, KANBAN_PROJECTS_ROOT: "" }, []).projectsRoot).toBeNull();
    expect(loadConfig({ ...env, KANBAN_PROJECTS_ROOT: "/srv/projects/" }, []).projectsRoot).toBe("/srv/projects");
    expect(() => loadConfig({ ...env, KANBAN_PROJECTS_ROOT: "projects" }, [])).toThrow(ConfigError);
  });
  test("reads the server username and the pool size", () => {
    const config = loadConfig({ ...env, OPENCODE_SERVER_USERNAME: "u", KANBAN_MAX_AUTOMATED: "5" }, []);
    expect(config).toMatchObject({ opencodeUsername: "u", maxAutomated: 5 });
  });
  test("the pool size must be a positive integer", () => {
    for (const value of ["0", "1.5", "-1", "x"]) {
      expect(() => loadConfig({ ...env, KANBAN_MAX_AUTOMATED: value }, [])).toThrow(ConfigError);
    }
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
