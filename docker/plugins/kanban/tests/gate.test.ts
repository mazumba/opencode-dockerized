import { describe, expect, test } from "bun:test";
import { GitHubError, createGh, ensureInstallationId, parseChecks, parsePrList, tailLines } from "../poller/github.ts";
import type { Exec, ExecResult } from "../poller/exec.ts";
import {
  changesRequestedRounds,
  cleanupCandidate,
  fixCandidates,
  issueTarget,
  latestFixRequest,
  originMatchesRepo,
  parseProjectConfig,
  removeLane,
  reviewGate,
  reviewerMessage,
  workerMessage,
  worktreePath,
  type Check,
  type Issue,
  type PrInfo,
} from "../poller/select.ts";

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  mergeable: "MERGEABLE",
  baseRefName: "main",
  headRefOid: "abc",
  ...over,
});
const check = (name: string, bucket: Check["bucket"]): Check => ({ name, bucket });

describe("reviewGate", () => {
  const cases: [string, PrInfo | null, Check[], number, unknown][] = [
    ["no PR", null, [], 0, { kind: "needsHuman", reason: "no PR found" }],
    ["merged", pr({ state: "MERGED" }), [check("a", "pass")], 0, { kind: "needsHuman", reason: "PR is MERGED" }],
    ["closed", pr({ state: "CLOSED" }), [check("a", "pass")], 0, { kind: "needsHuman", reason: "PR is CLOSED" }],
    ["zero checks", pr(), [], 0, { kind: "needsHuman", reason: "no CI checks configured" }],
    ["failure", pr(), [check("a", "fail"), check("b", "pass")], 0, { kind: "fix", cause: "ci", failed: ["a"] }],
    ["cancel counts as failure", pr(), [check("a", "cancel")], 0, { kind: "fix", cause: "ci", failed: ["a"] }],
    ["fail wins over pending", pr(), [check("a", "fail"), check("b", "pending")], 0, { kind: "fix", cause: "ci", failed: ["a"] }],
    ["fail wins over conflict", pr({ mergeable: "CONFLICTING" }), [check("a", "fail")], 0, { kind: "fix", cause: "ci", failed: ["a"] }],
    ["conflict", pr({ mergeable: "CONFLICTING" }), [check("a", "pass")], 0, { kind: "fix", cause: "conflict", failed: [] }],
    ["conflict wins over pending", pr({ mergeable: "CONFLICTING" }), [check("a", "pending")], 0, { kind: "fix", cause: "conflict", failed: [] }],
    ["pending", pr(), [check("a", "pass"), check("b", "pending")], 0, { kind: "wait" }],
    ["mergeable unknown", pr({ mergeable: "UNKNOWN" }), [check("a", "pass")], 0, { kind: "wait" }],
    ["green", pr(), [check("a", "pass"), check("b", "skipping")], 0, { kind: "review" }],
    ["all skipping is still review", pr(), [check("a", "skipping")], 0, { kind: "review" }],
    ["ci fix at the limit", pr(), [check("a", "fail")], 2, { kind: "needsHuman", reason: "review limit reached (ci)" }],
    ["conflict fix at the limit", pr({ mergeable: "CONFLICTING" }), [check("a", "pass")], 2, { kind: "needsHuman", reason: "review limit reached (conflict)" }],
    ["limit does not block review", pr(), [check("a", "pass")], 5, { kind: "review" }],
    ["limit does not block wait", pr(), [check("a", "pending")], 5, { kind: "wait" }],
    ["fix below the limit", pr(), [check("a", "fail")], 1, { kind: "fix", cause: "ci", failed: ["a"] }],
  ];
  test.each(cases)("%s", (_name, prInfo, checks, rounds, expected) => {
    expect(reviewGate(prInfo, checks, rounds)).toEqual(expected as never);
  });
});

describe("changesRequestedRounds", () => {
  test("counts only comments starting with the marker", () => {
    expect(
      changesRequestedRounds([
        { body: "Agent review: changes requested (round 1/2) — url\nCI failed: a" },
        { body: "see Agent review: changes requested" },
        { body: "Agent review: approved" },
        { body: "Agent review: changes requested" },
      ]),
    ).toBe(2);
  });
});

describe("cleanupCandidate", () => {
  const cases: [string, "OPEN" | "CLOSED" | "MERGED" | null, boolean][] = [
    ["Ready for merge", "MERGED", true],
    ["Ready for merge", "CLOSED", false],
    ["Ready for merge", "OPEN", false],
    ["Done", "MERGED", true],
    ["Done", "CLOSED", false],
    ["Canceled", "MERGED", true],
    ["Canceled", "CLOSED", true],
    ["Canceled", "OPEN", false],
    ["Done", null, false],
    ["In Progress", "MERGED", false],
  ];
  test.each(cases)("%s + %s -> %p", (state, prState, expected) => {
    expect(cleanupCandidate(state, prState)).toBe(expected);
  });
});

describe("parseProjectConfig", () => {
  test("reads repo and path, stripping backticks", () => {
    expect(parseProjectConfig("repo: `o/r.x`\npath: `/home/x/r`")).toEqual({ repo: "o/r.x", path: "/home/x/r" });
  });
  test("tolerates repeated identical values", () => {
    expect(parseProjectConfig("repo: o/r\nrepo: o/r\npath: /a")).toEqual({ repo: "o/r", path: "/a" });
  });
  test.each([
    ["", "repo"],
    ["path: /a", "repo"],
    ["repo: o/r", "path"],
    ["repo: o/r\npath: relative", "path"],
    ["repo: o/r\npath: /a\npath: /b", "path"],
    ["repo: o/r\nrepo: p/q\npath: /a", "repo"],
    ["repo: not-a-repo\npath: /a", "repo"],
    ["repo: o/r/extra\npath: /a", "repo"],
    ["repo: o/r;rm\npath: /a", "repo"],
  ])("rejects %j", (text, field) => {
    const result = parseProjectConfig(text);
    expect("error" in result && result.error.includes(field)).toBe(true);
  });
});

describe("worktreePath", () => {
  test("lowercases the identifier", () => expect(worktreePath("/r", "DEY-12")).toBe("/r/.slim/worktrees/dey-12"));
  test.each(["dey-1", "DEY-", "../DEY-1", "DEY-1/x", "DEY-1 ", ""])("rejects %j", (id) => {
    expect(() => worktreePath("/r", id)).toThrow();
  });
});

describe("originMatchesRepo", () => {
  test.each([
    "https://github.com/Owner/Repo.git",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo/",
    "https://x-access-token@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "git@github.com:owner/repo",
    "ssh://git@github.com/owner/repo.git",
  ])("matches %s", (url) => expect(originMatchesRepo(url, "owner/repo")).toBe(true));
  test.each([
    "https://github.com/owner/other.git",
    "https://github.com/other/repo.git",
    "https://github.com/owner/repo-extra.git",
    "https://gitlab.com/owner/repo.git",
    "https://evil.com/github.com/owner/repo",
    "git@github.com:owner/repo/more.git",
    "",
  ])("rejects %s", (url) => expect(originMatchesRepo(url, "owner/repo")).toBe(false));
});

describe("issueTarget and messages", () => {
  const issue: Issue = {
    id: "i",
    identifier: "DEY-9",
    createdAt: "2026-10-01T00:00:00Z",
    state: "Ready for agent",
    labels: [],
    projectPath: "/repo",
    projectConfig: { repo: "o/r", path: "/repo" },
    branchName: "max/dey-9-thing",
  };
  const target = issueTarget(issue);
  if ("error" in target) throw new Error("unexpected");

  test("rejects bad config, identifier and branch", () => {
    expect(issueTarget({ ...issue, projectConfig: { error: "nope" } })).toEqual({ error: "nope" });
    expect("error" in issueTarget({ ...issue, identifier: "dey-9" })).toBe(true);
    expect("error" in issueTarget({ ...issue, branchName: "--upload-pack=x" })).toBe(true);
    expect("error" in issueTarget({ ...issue, branchName: "" })).toBe(true);
  });

  test("worker message is a single line with the documented shape", () => {
    const message = workerMessage(target, {
      defaultBranch: "main",
      pr: { number: 7, url: "u" },
      round: 1,
      fix: { cause: "ci", summary: "CI failed: a\nb" },
    });
    expect(message.includes("\n")).toBe(false);
    expect(message.startsWith("DEY-9 ctx:")).toBe(true);
    expect(JSON.parse(message.slice("DEY-9 ctx:".length))).toEqual({
      repo: "o/r",
      path: "/repo",
      branch: "max/dey-9-thing",
      defaultBranch: "main",
      worktree: "/repo/.slim/worktrees/dey-9",
      pr: { number: 7, url: "u" },
      round: 1,
      fix: { cause: "ci", summary: "CI failed: a\nb" },
    });
  });
  test("worker message omits pr and fix for new work", () => {
    const parsed = JSON.parse(workerMessage(target, { defaultBranch: "main", round: 0 }).slice(10));
    expect(parsed.pr).toBeUndefined();
    expect(parsed.fix).toBeUndefined();
  });
  test("reviewer message shape", () => {
    const message = reviewerMessage(target, { base: "main", pr: { number: 7, url: "u" }, round: 2 });
    expect(JSON.parse(message.slice(10))).toEqual({
      repo: "o/r",
      path: "/repo",
      branch: "max/dey-9-thing",
      base: "main",
      pr: { number: 7, url: "u" },
      round: 2,
      ci: "green",
    });
  });
  test("rejects an invalid base branch", () => {
    expect(() => reviewerMessage(target, { base: "-x", pr: { number: 1, url: "u" }, round: 0 })).toThrow();
  });
});

describe("latestFixRequest", () => {
  const at = (n: number) => `2026-10-0${n}T00:00:00Z`;
  test("uses the latest comment's second line to derive the cause", () => {
    const comments = [
      { body: "Agent review: changes requested (round 1/2) — u\nCI failed: build", createdAt: at(1) },
      { body: "Agent review: changes requested (round 2/2) — u\nmerge conflicts with main", createdAt: at(3) },
      { body: "unrelated", createdAt: at(4) },
    ];
    expect(latestFixRequest(comments)).toEqual({ cause: "conflict", summary: "merge conflicts with main" });
    expect(latestFixRequest(comments.slice(0, 1))).toEqual({ cause: "ci", summary: "CI failed: build" });
  });
  test("falls back to review", () => {
    expect(latestFixRequest([{ body: "Agent review: changes requested\nUse a map", createdAt: at(1) }])).toEqual({
      cause: "review",
      summary: "Use a map",
    });
    expect(latestFixRequest([])).toEqual({ cause: "review", summary: "" });
  });
});

describe("removeLane", () => {
  const registry = {
    version: 1,
    updatedAt: "old",
    lanes: [
      { slug: "dey-1", branch: "b1", path: "/r/.slim/worktrees/dey-1" },
      { slug: "dey-2", branch: "b2", path: "/r/.slim/worktrees/dey-2" },
    ],
  };
  test("removes the matching lane and keeps the rest", () => {
    const updated = removeLane(registry, "/r/.slim/worktrees/dey-1", "dey-1", "now");
    expect(updated).toEqual({ version: 1, updatedAt: "now", lanes: [registry.lanes[1]] });
  });
  test("returns null without a match or on malformed input", () => {
    expect(removeLane(registry, "/x", "dey-9", "now")).toBeNull();
    expect(removeLane({ lanes: "no" }, "/x", "dey-1", "now")).toBeNull();
    expect(removeLane(null, "/x", "dey-1", "now")).toBeNull();
  });
});

describe("fixCandidates", () => {
  test("is empty without matching issues", () => expect(fixCandidates([])).toEqual([]));
});

describe("github parsing", () => {
  const raw = (over: object) => ({
    number: 1, url: "u", state: "OPEN", mergeable: "MERGEABLE", baseRefName: "main", headRefOid: "x", ...over,
  });
  test("prefers the newest OPEN PR, else the newest overall", () => {
    expect(parsePrList([raw({ number: 1 }), raw({ number: 3, state: "MERGED" }), raw({ number: 2 })])?.number).toBe(2);
    expect(parsePrList([raw({ number: 1, state: "CLOSED" }), raw({ number: 3, state: "MERGED" })])?.number).toBe(3);
    expect(parsePrList([])).toBeNull();
  });
  test("normalises unknown mergeable values", () => {
    expect(parsePrList([raw({ mergeable: "WEIRD" })])?.mergeable).toBe("UNKNOWN");
  });
  test("unknown check buckets are not green", () => {
    expect(parseChecks([{ name: "a", bucket: "???" }])).toEqual([{ name: "a", bucket: "pending" }]);
  });
  test("tailLines keeps the last lines", () => expect(tailLines("1\n2\n3\n", 2)).toBe("2\n3"));
});

describe("createGh", () => {
  const result = (over: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over });
  const gh = (...results: ExecResult[]) => {
    const calls: string[][] = [];
    const run: Exec = async (command) => {
      calls.push(command);
      return results.shift() ?? result({});
    };
    return { gh: createGh(run), calls };
  };

  test("checks parses JSON even when gh exits non-zero", async () => {
    const { gh: client, calls } = gh(result({ code: 8, stdout: '[{"name":"a","bucket":"pending"}]' }));
    expect(await client.checks("o/r", 5)).toEqual([{ name: "a", bucket: "pending" }]);
    expect(calls[0]).toEqual(["gh", "pr", "checks", "5", "--repo", "o/r", "--json", "name,bucket"]);
  });
  test("checks maps 'no checks reported' to an empty list", async () => {
    const { gh: client } = gh(result({ code: 1, stderr: "no checks reported on the 'x' branch" }));
    expect(await client.checks("o/r", 5)).toEqual([]);
  });
  test("checks throws GitHubError on other failures and timeouts", async () => {
    await expect(gh(result({ code: 1, stderr: "boom" })).gh.checks("o/r", 5)).rejects.toBeInstanceOf(GitHubError);
    await expect(gh(result({ code: null, timedOut: true })).gh.checks("o/r", 5)).rejects.toBeInstanceOf(GitHubError);
  });
  test("findPr passes the branch as a single argument", async () => {
    const { gh: client, calls } = gh(result({ stdout: "[]" }));
    expect(await client.findPr("o/r", "a;b")).toBeNull();
    expect(calls[0].slice(0, 6)).toEqual(["gh", "pr", "list", "--repo", "o/r", "--head"]);
    expect(calls[0][6]).toBe("a;b");
  });
  test("defaultBranch reads defaultBranchRef", async () => {
    expect(await gh(result({ stdout: '{"defaultBranchRef":{"name":"trunk"}}' })).gh.defaultBranch("o/r")).toBe("trunk");
    await expect(gh(result({ stdout: '{"defaultBranchRef":null}' })).gh.defaultBranch("o/r")).rejects.toBeInstanceOf(GitHubError);
  });
  test("failedLogTail keeps the last lines of failed runs and swallows errors", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    const { gh: client } = gh(
      result({ stdout: '[{"databaseId":1,"conclusion":"failure"},{"databaseId":2,"conclusion":"success"}]' }),
      result({ stdout: lines }),
    );
    expect(await client.failedLogTail("o/r", pr(), 3)).toBe("l7\nl8\nl9");
    expect(await gh(result({ code: 1, stderr: "x" })).gh.failedLogTail("o/r", pr())).toBe("");
  });
});

describe("ensureInstallationId", () => {
  const deps = (over: Partial<Parameters<typeof ensureInstallationId>[0]> & { env?: Record<string, string> }) => ({
    env: {} as Record<string, string | undefined>,
    run: (async () => ({ code: 0, stdout: "jwt\n", stderr: "", timedOut: false })) as Exec,
    fetchInstallations: async () => [{ id: 42 }] as unknown,
    cacheExists: async () => false,
    ...over,
  });

  test("does nothing when the id is set or cached", async () => {
    const env = { GH_APP_INSTALLATION_ID: "1" };
    await ensureInstallationId(deps({ env, fetchInstallations: async () => { throw new Error("no"); } }));
    await ensureInstallationId(deps({ cacheExists: async () => true, fetchInstallations: async () => { throw new Error("no"); } }));
  });
  test("sets the id when exactly one installation exists", async () => {
    const env: Record<string, string | undefined> = {};
    await ensureInstallationId(deps({ env }));
    expect(env.GH_APP_INSTALLATION_ID).toBe("42");
  });
  test("fails clearly for zero or several installations", async () => {
    for (const list of [[], [{ id: 1 }, { id: 2 }]]) {
      await expect(ensureInstallationId(deps({ fetchInstallations: async () => list }))).rejects.toThrow(
        "set KANBAN_GH_APP_INSTALLATION_ID",
      );
    }
  });
  test("fails when the JWT cannot be minted, without leaking output", async () => {
    const run: Exec = async () => ({ code: 1, stdout: "secret-jwt", stderr: "bad key", timedOut: false });
    const error = await ensureInstallationId(deps({ run })).catch((e: Error) => e);
    expect((error as Error).message).toContain("bad key");
    expect((error as Error).message).not.toContain("secret-jwt");
  });
});
