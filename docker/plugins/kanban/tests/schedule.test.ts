import { describe, expect, test } from "bun:test";
import { automatedIdentifiers, canStartAutomated, hasCapacity, type LiveJob } from "../poller/select.ts";

const job = (identifier: string, automated = true): LiveJob => ({ identifier, automated });

describe("scheduling", () => {
  const cases: [string, string, LiveJob[], number, boolean][] = [
    ["empty table", "DEY-1", [], 3, true],
    ["free slots", "DEY-1", [job("DEY-2"), job("DEY-3")], 3, true],
    ["pool full", "DEY-1", [job("DEY-2"), job("DEY-3"), job("DEY-4")], 3, false],
    ["same ticket has an automated job", "DEY-2", [job("DEY-2")], 3, false],
    ["investigations do not use a slot", "DEY-1", [job("DEY-2", false), job("DEY-3", false), job("DEY-4", false)], 1, true],
    ["investigation on the same ticket does not block", "DEY-2", [job("DEY-2", false)], 3, true],
    ["pool of one is full with one job", "DEY-1", [job("DEY-2")], 1, false],
  ];
  test.each(cases)("canStartAutomated: %s", (_name, identifier, live, max, expected) => {
    expect(canStartAutomated(identifier, live, max)).toBe(expected);
  });

  test("hasCapacity counts only automated jobs", () => {
    expect(hasCapacity([job("A-1"), job("A-2", false)], 2)).toBe(true);
    expect(hasCapacity([job("A-1"), job("A-2")], 2)).toBe(false);
  });
  test("automatedIdentifiers excludes investigations", () => {
    expect([...automatedIdentifiers([job("DEY-1"), job("DEY-2", false), job("DEY-1")])]).toEqual(["DEY-1"]);
  });
});
