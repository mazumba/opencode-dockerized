import { describe, expect, test } from "bun:test";
import ticket from "./fixtures/ticket.json";
import {
  buildTicketSnapshot,
  investigationFilePath,
  parseResult,
  reviewResultActions,
  reviewSummaryLine,
  ticketFilePath,
  workResultActions,
  type PrInfo,
} from "../poller/select.ts";

const marker = (json: string) => `KANBAN-RESULT: ${json}`;
const needsHuman = { outcome: "needs-human", step: "tests", reason: "red" };

describe("parseResult", () => {
  const valid: [string, "work" | "review" | "investigate", string, unknown][] = [
    ["worker review", "work", marker('{"outcome":"review","pr":7}'), { outcome: "review", pr: 7 }],
    ["worker needs-human", "work", marker(JSON.stringify(needsHuman)), needsHuman],
    ["reviewer approve", "review", marker('{"outcome":"approve"}'), { outcome: "approve" }],
    ["reviewer changes", "review", marker('{"outcome":"changes","summary":"Use a map"}'), { outcome: "changes", summary: "Use a map" }],
    ["reviewer needs-human", "review", marker(JSON.stringify(needsHuman)), needsHuman],
    ["investigator done", "investigate", marker('{"outcome":"done"}'), { outcome: "done" }],
    ["investigator needs-human", "investigate", marker(JSON.stringify(needsHuman)), needsHuman],
    ["surrounding text and CRLF", "review", `done.\r\n${marker('{"outcome":"approve"}')}\r\n`, { outcome: "approve" }],
    ["decorated line", "review", "`KANBAN-RESULT: {\"outcome\":\"approve\"}`", { outcome: "approve" }],
    ["the last marker wins", "work", `${marker('{"outcome":"review","pr":1}')}\n${marker('{"outcome":"review","pr":2}')}`, { outcome: "review", pr: 2 }],
  ];
  test.each(valid)("%s", (_name, kind, output, expected) => {
    expect(parseResult(kind, output)).toEqual({ ok: true, result: expected as never });
  });

  const invalid: [string, "work" | "review" | "investigate", string][] = [
    ["empty output", "work", ""],
    ["no marker", "work", "all done"],
    ["marker mid-line", "work", 'see KANBAN-RESULT: {"outcome":"review","pr":1}'],
    ["not JSON", "work", marker("review 7")],
    ["JSON array", "work", marker("[]")],
    ["null", "work", marker("null")],
    ["unknown field", "work", marker('{"outcome":"review","pr":7,"extra":1}')],
    ["missing field", "work", marker('{"outcome":"review"}')],
    ["pr as string", "work", marker('{"outcome":"review","pr":"7"}')],
    ["pr zero", "work", marker('{"outcome":"review","pr":0}')],
    ["pr fractional", "work", marker('{"outcome":"review","pr":1.5}')],
    ["unknown outcome", "work", marker('{"outcome":"merged"}')],
    ["reviewer outcome for the worker", "work", marker('{"outcome":"approve"}')],
    ["worker outcome for the reviewer", "review", marker('{"outcome":"review","pr":7}')],
    ["done for the reviewer", "review", marker('{"outcome":"done"}')],
    ["approve with extra field", "review", marker('{"outcome":"approve","summary":"x"}')],
    ["changes without summary", "review", marker('{"outcome":"changes"}')],
    ["changes with blank summary", "review", marker('{"outcome":"changes","summary":"  "}')],
    ["summary too long", "review", marker(JSON.stringify({ outcome: "changes", summary: "x".repeat(301) }))],
    ["done with report field", "investigate", marker('{"outcome":"done","report":"x"}')],
    ["needs-human without reason", "work", marker('{"outcome":"needs-human","step":"s"}')],
    ["needs-human with blank step", "work", marker('{"outcome":"needs-human","step":"","reason":"r"}')],
    ["last marker invalid, earlier valid", "work", `${marker('{"outcome":"review","pr":1}')}\n${marker("oops")}`],
  ];
  test.each(invalid)("rejects %s", (_name, kind, output) => {
    expect(parseResult(kind, output).ok).toBe(false);
  });
});

describe("workResultActions", () => {
  const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
    number: 7, url: "u", state: "OPEN", mergeable: "MERGEABLE", baseRefName: "main", headRefOid: "x", updatedAt: null, ...over,
  });
  const review = { outcome: "review", pr: 7 } as const;
  const mismatch = [
    { kind: "move", state: "Needs human" },
    { kind: "comment", body: "Agent: needs human — poller: reported PR #7 is not the open PR of the branch" },
  ];
  test("matching open PR moves to Agent review", () => {
    expect(workResultActions(review, pr())).toEqual([{ kind: "move", state: "Agent review" }]);
  });
  test("missing, different, or closed PR needs a human", () => {
    expect(workResultActions(review, null)).toEqual(mismatch);
    expect(workResultActions(review, pr({ number: 8 }))).toEqual(mismatch);
    expect(workResultActions(review, pr({ state: "MERGED" }))).toEqual(mismatch);
  });
  test("needs-human flattens step and reason to one line", () => {
    expect(workResultActions({ outcome: "needs-human", step: "verify\nrun", reason: "tests  red" }, null)).toEqual([
      { kind: "move", state: "Needs human" },
      { kind: "comment", body: "Agent: needs human — verify run: tests red" },
    ]);
  });
});

describe("reviewResultActions", () => {
  const run = { round: 0, prUrl: "https://github.com/o/r/pull/7" };
  test("approve moves to Ready for merge", () => {
    expect(reviewResultActions({ outcome: "approve" }, run)).toEqual([{ kind: "move", state: "Ready for merge" }]);
  });
  test("changes: comment first, then label, then move", () => {
    expect(reviewResultActions({ outcome: "changes", summary: "Use a map\nand a set" }, { ...run, round: 1 })).toEqual([
      { kind: "comment", body: "Agent review: changes requested (round 2/2) — https://github.com/o/r/pull/7\nUse a map and a set" },
      { kind: "label", add: "agent:changes-requested" },
      { kind: "move", state: "In Progress" },
    ]);
  });
  test("changes at the round limit needs a human", () => {
    expect(reviewResultActions({ outcome: "changes", summary: "x" }, { ...run, round: 2 })).toEqual([
      { kind: "move", state: "Needs human" },
      { kind: "comment", body: "Agent review: needs human — review limit reached — https://github.com/o/r/pull/7" },
    ]);
  });
  test("needs-human", () => {
    expect(reviewResultActions({ outcome: "needs-human", step: "diff", reason: "too big" }, run)).toEqual([
      { kind: "move", state: "Needs human" },
      { kind: "comment", body: "Agent review: needs human — diff: too big" },
    ]);
  });
  test("approve and needs-human ignore the round", () => {
    expect(reviewResultActions({ outcome: "approve" }, { ...run, round: 9 })).toEqual([{ kind: "move", state: "Ready for merge" }]);
  });
});

describe("reviewSummaryLine", () => {
  test.each([
    ["one line", "a\n  b", "a b"],
    ["CI failed prefix", "CI failed: x", "Review: CI failed: x"],
    ["merge conflicts prefix", "merge conflicts with main", "Review: merge conflicts with main"],
    ["prefix only at the start", "Not CI failed", "Not CI failed"],
    ["truncates", "x".repeat(400), "x".repeat(300)],
  ])("%s", (_name, input, expected) => {
    expect(reviewSummaryLine(input)).toBe(expected);
  });
});

describe("ticket snapshot", () => {
  const snapshot = buildTicketSnapshot(ticket, "viewer");
  test("comments are oldest to newest with isPoller from the API user", () => {
    expect(snapshot.comments.map((c) => [c.id, c.isPoller, c.author, c.parentId])).toEqual([
      ["c1", false, "Max", null],
      ["c2", true, "Poller", "c1"],
      ["c3", false, "GitHub", null],
    ]);
  });
  test("keeps ticket details and orders the state history", () => {
    expect(snapshot.title).toBe("Add the thing");
    expect(snapshot.attachments).toEqual([{ title: "Issue 4", url: "https://github.com/o/r/issues/4" }]);
    expect(snapshot.stateHistory.map((h) => h.to)).toEqual(["Ready for agent", "In Progress"]);
  });
  test("exposes no author ids", () => {
    expect(JSON.stringify(snapshot)).not.toContain("authorUserId");
  });
  test("an unknown author is never the poller", () => {
    const anonymous = buildTicketSnapshot({ ...ticket, comments: [{ ...ticket.comments[2], authorUserId: null }] }, "");
    expect(anonymous.comments[0].isPoller).toBe(false);
  });
  test("file paths live in the ignored .tickets dir and need a valid identifier", () => {
    expect(ticketFilePath("/r", "DEY-9")).toBe("/r/.slim/worktrees/.tickets/DEY-9.json");
    expect(investigationFilePath("/r", "DEY-9")).toBe("/r/.slim/worktrees/.tickets/DEY-9.investigation.md");
    expect(() => ticketFilePath("/r", "../x")).toThrow();
  });
  test("investigation runs get their own files, keyed by a safe run id", () => {
    expect(ticketFilePath("/r", "DEY-9", "ab-12")).toBe("/r/.slim/worktrees/.tickets/DEY-9.ab-12.json");
    expect(investigationFilePath("/r", "DEY-9", "ab-12")).toBe("/r/.slim/worktrees/.tickets/DEY-9.ab-12.investigation.md");
    expect(() => ticketFilePath("/r", "DEY-9", "../x")).toThrow();
    expect(() => ticketFilePath("/r", "DEY-9", "")).toThrow();
  });
});
