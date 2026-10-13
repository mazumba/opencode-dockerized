import { describe, expect, test } from "bun:test";
import { claimIssue, releaseClaim, type ClaimApi } from "../poller/claims.ts";
import { createKeyedMutex } from "../poller/serial.ts";
import { staleClaims, type Issue } from "../poller/select.ts";

const VIEWER = "viewer";
const issue = (reactions: Issue["reactions"], over: Partial<Issue> = {}): Issue => ({
  id: "id-1",
  identifier: "DEY-1",
  createdAt: "2026-10-01T00:00:00Z",
  state: "In Progress",
  labels: [],
  projectPath: "/repo",
  projectConfig: { repo: "o/r", path: "/repo" },
  branchName: "b",
  reactions,
  ...over,
});
const reaction = (id: string, over: object = {}) => ({ id, emoji: "eyes", userId: VIEWER, createdAt: "2026-10-08T09:00:00Z", ...over });

function fakeApi(current: Issue, failOn?: "react") {
  const calls: string[] = [];
  const api: ClaimApi = {
    async reactToIssue(issueId, emoji) {
      calls.push(`react:${issueId}:${emoji}`);
      if (failOn === "react") throw new Error("linear down");
    },
    async deleteReaction(id) {
      calls.push(`delete:${id}`);
    },
    async issue() {
      return current;
    },
  };
  return { api, calls };
}

describe("claimIssue", () => {
  test("adds the new claim before deleting older ones", async () => {
    const { api, calls } = fakeApi(issue([]));
    await claimIssue(api, issue([reaction("r1"), reaction("r2")]), VIEWER);
    expect(calls).toEqual(["react:id-1:eyes", "delete:r1", "delete:r2"]);
  });
  test("a failed add leaves the older claims untouched", async () => {
    const { api, calls } = fakeApi(issue([]), "react");
    await expect(claimIssue(api, issue([reaction("r1")]), VIEWER)).rejects.toThrow("linear down");
    expect(calls).toEqual(["react:id-1:eyes"]);
  });
  test("only the poller's claim reactions are replaced", async () => {
    const { api, calls } = fakeApi(issue([]));
    await claimIssue(api, issue([reaction("mine"), reaction("other", { userId: "someone" }), reaction("x", { emoji: "x" })]), VIEWER);
    expect(calls).toEqual(["react:id-1:eyes", "delete:mine"]);
  });
});

describe("stale reaction ids", () => {
  const failingDelete = (message: string) => {
    const calls: string[] = [];
    const api: ClaimApi = {
      async reactToIssue() {
        calls.push("react");
      },
      async deleteReaction(id) {
        calls.push(`delete:${id}`);
        if (id === "gone") throw new Error(message);
      },
      async issue() {
        return issue([reaction("gone"), reaction("b")]);
      },
    };
    return { api, calls };
  };
  test("claimIssue ignores a reaction that no longer exists and still removes the rest", async () => {
    const { api, calls } = failingDelete("GraphQL error (HTTP 200): Entity not found: Reaction");
    await claimIssue(api, issue([reaction("gone"), reaction("b")]), VIEWER);
    expect(calls).toEqual(["react", "delete:gone", "delete:b"]);
  });
  test("releaseClaim ignores it too", async () => {
    const { api, calls } = failingDelete("Entity not found");
    await releaseClaim(api, "DEY-1", VIEWER);
    expect(calls).toEqual(["delete:gone", "delete:b"]);
  });
  test("other delete errors still surface", async () => {
    const { api } = failingDelete("HTTP 500");
    await expect(claimIssue(api, issue([reaction("gone")]), VIEWER)).rejects.toThrow("HTTP 500");
  });
});

describe("releaseClaim", () => {
  test("removes every poller claim, read fresh", async () => {
    const { api, calls } = fakeApi(issue([reaction("a"), reaction("b", { userId: "someone" }), reaction("c")]));
    await releaseClaim(api, "DEY-1", VIEWER);
    expect(calls).toEqual(["delete:a", "delete:c"]);
  });
  test("does nothing without a claim", async () => {
    const { api, calls } = fakeApi(issue([]));
    await releaseClaim(api, "DEY-1", VIEWER);
    expect(calls).toEqual([]);
  });
});

describe("stale claims after a finished run", () => {
  const NOW = Date.parse("2026-10-08T12:00:00Z");
  const old = [reaction("r", { createdAt: "2026-10-08T08:00:00Z" })];
  test("an In Progress ticket with an old claim is stale", () => {
    expect(staleClaims([issue(old)], VIEWER, NOW, 60 * 60_000, new Set())).toHaveLength(1);
  });
  test("a ticket waiting for its fix round (agent:changes-requested) is never stale", () => {
    const waiting = issue(old, { labels: ["agent:changes-requested"] });
    expect(staleClaims([waiting], VIEWER, NOW, 60 * 60_000, new Set())).toEqual([]);
  });
  test("a ticket without its claim (released after the run) is not stale", () => {
    expect(staleClaims([issue([])], VIEWER, NOW, 60 * 60_000, new Set())).toEqual([]);
  });
});

describe("createKeyedMutex", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  test("runs calls for one key one at a time, in order", async () => {
    const run = createKeyedMutex();
    const events: string[] = [];
    const task = (name: string, ms: number) =>
      run("/repo", async () => {
        events.push(`${name}:start`);
        await wait(ms);
        events.push(`${name}:end`);
      });
    await Promise.all([task("a", 30), task("b", 1), task("c", 1)]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });
  test("different keys run in parallel", async () => {
    const run = createKeyedMutex();
    const events: string[] = [];
    await Promise.all([
      run("a", async () => { events.push("a:start"); await wait(30); events.push("a:end"); }),
      run("b", async () => { events.push("b:start"); await wait(1); events.push("b:end"); }),
    ]);
    expect(events).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });
  test("a failing call does not block the next and passes its error on", async () => {
    const run = createKeyedMutex();
    await expect(run("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await run("k", async () => "next")).toBe("next");
  });
});
