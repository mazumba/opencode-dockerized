import { describe, expect, test } from "bun:test";
import issues from "./fixtures/issues.json";
import comments from "./fixtures/comments.json";
import claims from "./fixtures/claims.json";
import { loadConfig, ConfigError } from "../poller/config.ts";
import { buildArgs } from "../poller/runner.ts";
import {
  autoLabelTargets,
  investigateBlocker,
  investigateRequests,
  investigationOutcome,
  parseInvestigate,
  parseProjectPath,
  fixCandidates,
  readyCandidates,
  refinementLabel,
  reviewCandidates,
  staleClaims,
  type Comment,
  type Issue,
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
  test("success needs exit 0 and swapped labels", () => {
    expect(investigationOutcome(ok, true)).toEqual({ emoji: "white_check_mark" });
  });
  test("failures map to x with a reason, most specific first", () => {
    expect(investigationOutcome({ ...ok, aborted: true }, true)).toEqual({ emoji: "x", reason: "poller stopped" });
    expect(investigationOutcome({ ...ok, timedOut: true, exitCode: null }, false)).toEqual({ emoji: "x", reason: "timeout after 3 min" });
    expect(investigationOutcome({ ...ok, exitCode: 2 }, true)).toEqual({ emoji: "x", reason: "exit code 2" });
    expect(investigationOutcome(ok, false)).toEqual({ emoji: "x", reason: "label not changed" });
  });
});

describe("investigateBlocker", () => {
  const byId = (id: string) => allIssues.find((i) => i.id === id)!;
  test("Backlog with investigate label is allowed", () => {
    expect(investigateBlocker(byId("id-11"))).toBeNull();
  });
  test("wrong state and missing label are blocked", () => {
    expect(investigateBlocker(byId("id-1"))).toContain("Agent review");
    expect(investigateBlocker(byId("id-10"))).toContain("investigate");
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
  const entries = Object.values(claims) as { issue: Issue; comments: { body: string; createdAt: string }[] }[];
  test("only old claims without a later worker comment are stale", () => {
    expect(ids(staleClaims(entries, NOW, WORK_TIMEOUT_MS))).toEqual(["id-21", "id-24"]);
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
