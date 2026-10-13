import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGroup } from "../poller/exec.ts";
import {
  cleanupIdentifiers,
  isCleanupState,
  laneOwnership,
  mainUpdateDecision,
  worktreeDirIdentifier,
  type MainFacts,
} from "../poller/select.ts";

describe("cleanup candidates from disk", () => {
  test("worktreeDirIdentifier only accepts ticket slugs", () => {
    expect(worktreeDirIdentifier("dey-9")).toBe("DEY-9");
    for (const name of [".tickets", "DEY-9", "dey-", "dey-9x", "feature", "a/b", "dey-9.bak", ""]) {
      expect(worktreeDirIdentifier(name)).toBeNull();
    }
  });
  const registry = {
    lanes: [
      { slug: "dey-1", owner: "kanban-poller" },
      { slug: "dey-2", owner: "orchestrator" },
      { slug: "dey-3" },
    ],
  };
  test.each([
    ["missing registry", null, "dey-1", "none"],
    ["poller-owned", registry, "dey-1", "poller"],
    ["foreign owner", registry, "dey-2", "foreign"],
    ["no owner field", registry, "dey-3", "foreign"],
    ["no entry", registry, "dey-4", "none"],
    ["malformed registry is treated as foreign", { lanes: "x" }, "dey-1", "foreign"],
    ["non-object registry", "x", "dey-1", "foreign"],
  ])("laneOwnership: %s", (_name, input, slug, expected) => {
    expect(laneOwnership(input, slug)).toBe(expected);
  });
  test("cleanupIdentifiers keeps poller-owned and unregistered ticket dirs only", () => {
    const names = [".tickets", "dey-1", "dey-2", "dey-3", "dey-4", "notes", "Dey-5"];
    expect(cleanupIdentifiers(names, registry)).toEqual(["DEY-1", "DEY-4"]);
    expect(cleanupIdentifiers(names, null)).toEqual(["DEY-1", "DEY-2", "DEY-3", "DEY-4"]);
    expect(cleanupIdentifiers(names, { lanes: "x" })).toEqual([]);
  });
  test("isCleanupState", () => {
    for (const state of ["Ready for merge", "Done", "Canceled"]) expect(isCleanupState(state)).toBe(true);
    for (const state of ["In Progress", "Agent review", "Needs human", "Backlog"]) expect(isCleanupState(state)).toBe(false);
  });
});

describe("mainUpdateDecision", () => {
  const holder = (over: Partial<{ path: string; dirty: boolean; operation: boolean }> = {}) => ({ path: "/repo", dirty: false, operation: false, ...over });
  const facts = (over: Partial<MainFacts> = {}): MainFacts => ({
    defaultBranch: "main",
    holder: holder(),
    local: "a",
    remote: "b",
    fastForward: true,
    ...over,
  });
  const cases: [string, Partial<MainFacts>, unknown][] = [
    ["checked out in the main checkout, clean: merge there", {}, { kind: "merge", at: "/repo" }],
    ["checked out in a linked worktree, clean: merge there", { holder: holder({ path: "/repo/.slim/worktrees/dey-1" }) }, { kind: "merge", at: "/repo/.slim/worktrees/dey-1" }],
    ["checked out nowhere: move the ref", { holder: null }, { kind: "update-ref" }],
    ["checked out nowhere, main checkout on a feature branch: still move the ref", { holder: null }, { kind: "update-ref" }],
    ["up to date", { remote: "a" }, { kind: "uptodate" }],
    ["up to date even when dirty", { remote: "a", holder: holder({ dirty: true }) }, { kind: "uptodate" }],
    ["up to date with no holder", { remote: "a", holder: null }, { kind: "uptodate" }],
    ["a rebase or bisect of the default branch is in progress in the holder", { holder: holder({ operation: true, path: "/repo/.slim/worktrees/dey-1" }) }, { kind: "skip", reason: "operation in progress in /repo/.slim/worktrees/dey-1" }],
    ["operation in progress wins over dirty", { holder: holder({ operation: true, dirty: true }) }, { kind: "skip", reason: "operation in progress in /repo" }],
    ["up to date even with an operation in progress", { remote: "a", holder: holder({ operation: true }) }, { kind: "uptodate" }],
    ["dirty holder", { holder: holder({ dirty: true }) }, { kind: "skip", reason: "uncommitted changes in /repo" }],
    ["local commits not on origin (not a fast-forward), checked out", { fastForward: false }, { kind: "skip", reason: "not a fast-forward" }],
    ["local commits not on origin, checked out nowhere", { fastForward: false, holder: null }, { kind: "skip", reason: "not a fast-forward" }],
    ["no remote ref", { remote: null }, { kind: "skip", reason: "no origin/main" }],
    ["no local ref", { local: null }, { kind: "skip", reason: "no local main" }],
  ];
  test.each(cases)("%s", (_name, over, expected) => {
    expect(mainUpdateDecision(facts(over))).toEqual(expected as never);
  });
});

describe("execGroup", () => {
  const sh = (script: string, timeoutMs: number) => execGroup(["bash", "-c", script], { timeoutMs });

  test("returns the exit code and the tail of stderr; stdout is discarded", async () => {
    const result = await sh("echo out; echo first >&2; echo last >&2; exit 3", 10_000);
    expect(result).toMatchObject({ code: 3, stdout: "", timedOut: false });
    expect(result.stderr.trim().split("\n").at(-1)).toBe("last");
  });

  test("a script that backgrounds a child holding its stderr is killed at the timeout and returns", async () => {
    const started = Date.now();
    const result = await sh("sleep 30 &\nwait\n", 300);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("a background child left behind after a normal exit does not delay the result", async () => {
    const started = Date.now();
    const result = await sh("(sleep 30 >&2 &)\nexit 0\n", 20_000);
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("only the tail of a huge stderr is kept", async () => {
    const result = await sh("head -c 2000000 /dev/zero | tr '\\0' 'x' >&2\necho >&2\necho final line >&2\nexit 4\n", 20_000);
    expect(result.code).toBe(4);
    expect(result.stderr.length).toBeLessThanOrEqual(4 * 1024);
    expect(result.stderr.trim().split("\n").at(-1)).toBe("final line");
  });

  test("after a timeout the whole group is killed, even a child that ignores SIGTERM and outlives the leader", async () => {
    const marker = join(tmpdir(), `kanban-child-${process.pid}-${Date.now()}.pid`);
    const result = await sh(`(trap '' TERM; echo $BASHPID > '${marker}'; sleep 30) &\nsleep 30\n`, 300);
    expect(result.timedOut).toBe(true);
    const pid = Number((await readFile(marker, "utf8")).trim());
    await rm(marker, { force: true });
    // A killed child may linger as a zombie until PID 1 reaps it; a zombie is dead.
    const isAlive = async () => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      return !/^\d+ \(.*\) Z/.test(stat);
    };
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      alive = await isAlive();
      if (alive) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(alive).toBe(false);
  });

  test("runs in the given cwd with exactly the given env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanban-exec-"));
    try {
      await mkdir(join(dir, "w"), { recursive: true });
      const out = join(dir, "out.txt");
      const result = await execGroup(["bash", "-c", `printf '%s|%s' "$(basename "$PWD")" "\${SECRET:-unset}" > '${out}'`], {
        cwd: join(dir, "w"),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMs: 10_000,
      });
      expect(result.code).toBe(0);
      expect(await readFile(out, "utf8")).toBe("w|unset");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
