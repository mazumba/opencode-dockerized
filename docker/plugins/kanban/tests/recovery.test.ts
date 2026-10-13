import { describe, expect, test } from "bun:test";
import {
  MAIN_RETRY_MS,
  autoMergeDecision,
  keepMainPending,
  latestChangesRequestedAt,
  MAX_CONSECUTIVE_FETCH_FAILURES,
  fetchFailureDecision,
  isDue,
  retriesTotal,
  retryComment,
  fixWritesPending,
  workVerificationFailedActions,
  CLEANUP_RECHECK_MS,
  retriesUsed,
  retryDecision,
  type RetryFacts,
} from "../poller/select.ts";

describe("autoMergeDecision", () => {
  test.each([
    ["clean and at the PR head", { dirty: false, head: "a", prHead: "a" }, { kind: "merge" }],
    ["dirty", { dirty: true, head: "a", prHead: "a" }, { kind: "skip", reason: "worktree has uncommitted changes" }],
    ["HEAD moved", { dirty: false, head: "b", prHead: "a" }, { kind: "skip", reason: "worktree HEAD differs from PR head" }],
    ["no HEAD", { dirty: false, head: null, prHead: "a" }, { kind: "skip", reason: "worktree HEAD differs from PR head" }],
    ["dirty wins over moved", { dirty: true, head: "b", prHead: "a" }, { kind: "skip", reason: "worktree has uncommitted changes" }],
  ])("%s", (_name, facts, expected) => {
    expect(autoMergeDecision(facts)).toEqual(expected as never);
  });
});

describe("retry budget", () => {
  const POSTER = "poller";
  const note = (body: string, createdAt: string, authorId: string | null = POSTER) => ({ body, createdAt, authorId });
  const comments = [
    note("Agent: retrying (work) — timeout after 60 min", "2026-10-08T10:00:00Z"),
    note("Agent review: changes requested (round 1/2) — u\nCI failed: a", "2026-10-08T11:00:00Z"),
    note("Agent: retrying (fix) — agent error: x", "2026-10-08T12:00:00Z"),
    note("Agent: retrying (review) — agent error: y", "2026-10-08T12:10:00Z"),
    note("Agent: needs human — poller: x", "2026-10-08T12:30:00Z"),
  ];
  test("retryComment names the lane and flattens the reason", () => {
    expect(retryComment("fix", "agent error:\n boom")).toBe("Agent: retrying (fix) — agent error: boom");
  });
  test("retriesUsed counts the poller's retry comments of that lane at or after the anchor", () => {
    expect(retriesUsed(comments, null, "work", POSTER)).toBe(1);
    expect(retriesUsed(comments, "2026-10-08T10:00:00Z", "work", POSTER)).toBe(1);
    expect(retriesUsed(comments, "2026-10-08T10:00:01Z", "work", POSTER)).toBe(0);
    expect(retriesUsed(comments, "2026-10-08T11:00:00Z", "fix", POSTER)).toBe(1);
    expect(retriesUsed(comments, "2026-10-08T12:00:01Z", "fix", POSTER)).toBe(0);
    expect(retriesUsed(comments, null, "review", POSTER)).toBe(1);
    expect(retriesUsed([], null, "work", POSTER)).toBe(0);
  });
  test("a retry comment with the same timestamp as the lane entry still counts (no unlimited retries)", () => {
    const entry = "2026-10-08T10:00:00.000Z";
    const sameInstant = [note("Agent: retrying (work) — timeout", entry)];
    expect(retriesUsed(sameInstant, entry, "work", POSTER)).toBe(1);
    expect(
      retryDecision({ kind: "work", failure: "timeout", pushed: false, retriesUsed: 1, retriesTotal: 1 }),
    ).toBe(false);
  });
  test("retry comments by anyone else are ignored, so they can neither grant nor use the budget", () => {
    const forged = [note("Agent: retrying (work) — x", "2026-10-08T10:00:00Z", "human"), note("Agent: retrying (work) — y", "2026-10-08T10:00:00Z", null)];
    expect(retriesUsed(forged, null, "work", POSTER)).toBe(0);
    expect(retriesTotal(forged, "work", POSTER)).toBe(0);
  });
  test("retriesTotal counts the whole ticket for the lane", () => {
    const many = [1, 2, 3].map((n) => note("Agent: retrying (work) — x", `2026-10-0${n}T00:00:00Z`));
    expect(retriesTotal(many, "work", POSTER)).toBe(3);
    expect(retriesTotal(many, "fix", POSTER)).toBe(0);
  });
  test("latestChangesRequestedAt is the newest poller comment of that kind", () => {
    expect(latestChangesRequestedAt(comments, POSTER)).toBe("2026-10-08T11:00:00Z");
    expect(latestChangesRequestedAt([note("x", "2026-10-08T11:00:00Z")], POSTER)).toBeNull();
    const two = [...comments, note("Agent review: changes requested (round 2/2) — u", "2026-10-08T13:00:00Z")];
    expect(latestChangesRequestedAt(two, POSTER)).toBe("2026-10-08T13:00:00Z");
    const foreign = [...comments, note("Agent review: changes requested (round 2/2) — u", "2026-10-08T14:00:00Z", "human")];
    expect(latestChangesRequestedAt(foreign, POSTER)).toBe("2026-10-08T11:00:00Z");
  });
});

describe("fixWritesPending", () => {
  const POSTER = "poller";
  const request = (createdAt: string, authorId: string | null = POSTER) => ({
    body: "Agent review: changes requested (round 1/2) — u\nCI failed: a",
    createdAt,
    authorId,
  });
  test.each([
    ["comment newer than the entry into Agent review: label/move still to do", [request("2026-10-08T12:00:00Z")], "2026-10-08T11:00:00Z", true],
    ["comment from before the last entry (an earlier round)", [request("2026-10-08T10:00:00Z")], "2026-10-08T11:00:00Z", false],
    ["comment at the same instant as the entry is not pending", [request("2026-10-08T11:00:00Z")], "2026-10-08T11:00:00Z", false],
    ["no comment", [], "2026-10-08T11:00:00Z", false],
    ["comment by someone else", [request("2026-10-08T12:00:00Z", "human")], "2026-10-08T11:00:00Z", false],
    ["entry unknown", [request("2026-10-08T12:00:00Z")], null, false],
  ])("%s", (_name, comments, entered, expected) => {
    expect(fixWritesPending(comments, POSTER, entered)).toBe(expected);
  });
});

describe("workVerificationFailedActions", () => {
  test("a GitHub read failure is a human matter with an accurate message", () => {
    const actions = workVerificationFailedActions();
    expect(actions[0]).toEqual({ kind: "move", state: "Needs human" });
    expect(actions[1]).toMatchObject({ kind: "comment" });
    expect((actions[1] as { body: string }).body).toContain("GitHub could not be read");
    expect((actions[1] as { body: string }).body).not.toContain("no PR");
  });
});

describe("retryDecision", () => {
  const facts = (over: Partial<RetryFacts>): RetryFacts => ({
    kind: "work",
    failure: "error",
    pushed: false,
    retriesUsed: 0,
    retriesTotal: 0,
    ...over,
  });
  const cases: [string, Partial<RetryFacts>, boolean][] = [
    ["work: transport/server error, nothing pushed", { kind: "work", failure: "error" }, true],
    ["work: timeout, nothing pushed", { kind: "work", failure: "timeout" }, true],
    ["work: missing marker, nothing pushed", { kind: "work", failure: "marker" }, true],
    ["fix: timeout, nothing pushed", { kind: "fix", failure: "timeout" }, true],
    ["work: pushed", { kind: "work", failure: "error", pushed: true }, false],
    ["fix: pushed", { kind: "fix", failure: "marker", pushed: true }, false],
    ["work: budget used", { kind: "work", retriesUsed: 1 }, false],
    ["review: transport/server error", { kind: "review", failure: "error" }, true],
    ["review: timeout is not retried", { kind: "review", failure: "timeout" }, false],
    ["review: missing marker is not retried", { kind: "review", failure: "marker" }, false],
    ["review: budget used", { kind: "review", failure: "error", retriesUsed: 1 }, false],
    ["a larger budget allows another", { kind: "work", retriesUsed: 1, maxRetries: 2 }, true],
    ["the hard cap beats a timestamp that hides earlier retries", { kind: "work", retriesUsed: 0, retriesTotal: 3 }, false],
    ["review: the hard cap applies too", { kind: "review", failure: "error", retriesUsed: 0, retriesTotal: 3 }, false],
    ["below the hard cap", { kind: "work", retriesUsed: 0, retriesTotal: 2 }, true],
  ];
  test.each(cases)("%s", (_name, over, expected) => {
    expect(retryDecision(facts(over))).toBe(expected);
  });
});

describe("main checkout retry", () => {
  test("only skipped or failed projects stay pending", () => {
    expect(keepMainPending("skip")).toBe(true);
    expect(keepMainPending("error")).toBe(true);
    expect(keepMainPending("updated")).toBe(false);
    expect(keepMainPending("uptodate")).toBe(false);
  });
  test("a check is due when never run or after the interval", () => {
    const now = 1_000_000_000;
    expect(isDue(null, now, MAIN_RETRY_MS)).toBe(true);
    expect(isDue(now - MAIN_RETRY_MS + 1, now, MAIN_RETRY_MS)).toBe(false);
    expect(isDue(now - MAIN_RETRY_MS, now, MAIN_RETRY_MS)).toBe(true);
    expect(isDue(now - 5_000, now, 1_000)).toBe(true);
  });
  test("cleanup rechecks a directory at most every 10 minutes", () => expect(CLEANUP_RECHECK_MS).toBe(600_000));
  test("the interval is 10 minutes", () => expect(MAIN_RETRY_MS).toBe(600_000));
});

describe("fetchFailureDecision", () => {
  test.each([
    [0, "skip"],
    [1, "skip"],
    [4, "skip"],
    [5, "escalate"],
    [9, "escalate"],
  ])("%i consecutive failures: %s", (count, expected) => {
    expect(fetchFailureDecision(count)).toBe(expected as never);
  });
  test("the default limit is 5 and can be overridden", () => {
    expect(MAX_CONSECUTIVE_FETCH_FAILURES).toBe(5);
    expect(fetchFailureDecision(2, 2)).toBe("escalate");
  });
});
