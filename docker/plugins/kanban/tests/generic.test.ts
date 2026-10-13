import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXCLUDE_PATTERNS,
  MAX_SLOT,
  checkoutPlan,
  excludeAppend,
  isBindSafe,
  isWithin,
  lanesDirSafe,
  orphanDirs,
  orphanPass,
  orphanStackProjects,
  partitionProjects,
  sharedProjectBlocker,
  worktreeBlocker,
  parseComposeProjects,
  repoFromOrigin,
  slotPorts,
  type CheckoutFacts,
} from "../poller/select.ts";
import { parseWorktreeList } from "../poller/git.ts";

describe("repoFromOrigin", () => {
  test.each([
    ["https://github.com/o/r.git", "o/r"],
    ["https://x-access-token:abc@github.com/o/r", "o/r"],
    ["git@github.com:o/r.git", "o/r"],
    ["ssh://git@github.com/o/r.git", "o/r"],
    ["https://gitlab.com/o/r.git", null],
    ["not a url", null],
    ["", null],
  ])("%s", (url, expected) => {
    expect(repoFromOrigin(url)).toBe(expected);
  });
});

describe("checkoutPlan", () => {
  const facts = (over: Partial<CheckoutFacts>): CheckoutFacts => ({
    kind: "dir",
    empty: false,
    isRepoRoot: true,
    originRepo: "o/web",
    ...over,
  });
  const plan = (over: Partial<CheckoutFacts>) => checkoutPlan("/root/web", "o/web", facts(over));

  test("the right repository is used as is (case-insensitive)", () => {
    expect(plan({})).toEqual({ kind: "ready" });
    expect(plan({ originRepo: "O/Web" })).toEqual({ kind: "ready" });
  });
  test("a missing path is cloned", () => {
    expect(plan({ kind: "missing", empty: true, isRepoRoot: false, originRepo: null })).toEqual({ kind: "clone" });
  });
  test("an empty directory is cloned into", () => {
    expect(plan({ empty: true, isRepoRoot: false, originRepo: null })).toEqual({ kind: "clone" });
  });
  test("another repository with the same directory name is a path collision", () => {
    expect(plan({ originRepo: "b/web" })).toEqual({ kind: "problem", reason: "path collision: /root/web holds b/web" });
  });
  test("a repository without a GitHub origin is a collision too", () => {
    expect(plan({ originRepo: null })).toEqual({
      kind: "problem",
      reason: "path collision: /root/web holds a repository without a GitHub origin",
    });
  });
  test("a non-empty directory that is not a repository is never cloned into", () => {
    expect(plan({ isRepoRoot: false, originRepo: null, empty: false })).toEqual({
      kind: "problem",
      reason: "path /root/web exists, is not empty, and is not a git repository",
    });
  });
  test("a file at the path is a problem", () => {
    expect(plan({ kind: "other", isRepoRoot: false, originRepo: null })).toEqual({
      kind: "problem",
      reason: "path /root/web exists and is not a directory",
    });
  });
});

describe("excludeAppend", () => {
  test("creates the content when there is none", () => {
    expect(excludeAppend(null)).toBe(`${EXCLUDE_PATTERNS.join("\n")}\n`);
  });
  test("appends after existing lines, adding a missing final newline", () => {
    expect(excludeAppend("# comment\n*.log")).toBe(`# comment\n*.log\n${EXCLUDE_PATTERNS.join("\n")}\n`);
    expect(excludeAppend("*.log\n")).toBe(`*.log\n${EXCLUDE_PATTERNS.join("\n")}\n`);
  });
  test("is idempotent: nothing to do when every pattern is there", () => {
    const content = `*.log\n${EXCLUDE_PATTERNS.join("\n")}\n`;
    expect(excludeAppend(content)).toBeNull();
    expect(excludeAppend(excludeAppend("x") as string)).toBeNull();
  });
  test("adds only the missing patterns and tolerates CRLF and padding", () => {
    expect(excludeAppend("  /.slim/worktrees/  \r\n")).toBe(`  /.slim/worktrees/  \r\n/.slim/worktrees.json\n`);
  });
  test("the patterns are anchored to the repo root", () => {
    expect(EXCLUDE_PATTERNS).toEqual(["/.slim/worktrees/", "/.slim/worktrees.json"]);
  });
});

describe("isWithin", () => {
  test.each([
    ["/r/.slim/worktrees/dey-4", "/r/.slim/worktrees/dey-4", true],
    ["/r/.slim/worktrees/dey-4/app", "/r/.slim/worktrees/dey-4", true],
    ["/r/.slim/worktrees/dey-42", "/r/.slim/worktrees/dey-4", false],
    ["/r/.slim/worktrees/dey-42/app", "/r/.slim/worktrees/dey-4", false],
    ["/r/.slim/worktrees/dey-4x", "/r/.slim/worktrees/dey-4", false],
    ["/r/.slim", "/r/.slim/worktrees", false],
    ["/r/.slim/worktrees/dey-4", "/r/.slim/worktrees/", true],
  ])("%s in %s", (path, dir, expected) => {
    expect(isWithin(path, dir)).toBe(expected);
  });
});

describe("slotPorts", () => {
  test("a block of 100 ports per slot, starting at 10100", () => {
    expect(slotPorts(1)).toEqual({ base: 10_100, count: 100 });
    expect(slotPorts(2)).toEqual({ base: 10_200, count: 100 });
    expect(slotPorts(7)).toEqual({ base: 10_700, count: 100 });
  });
  test("blocks never overlap and stay below 65536", () => {
    const first = slotPorts(MAX_SLOT);
    expect(first.base + first.count - 1).toBeLessThanOrEqual(65_535);
    expect(slotPorts(1).base + 100).toBe(slotPorts(2).base);
  });
  test("slots outside 1..MAX_SLOT are rejected", () => {
    for (const slot of [0, -1, 1.5, MAX_SLOT + 1]) expect(() => slotPorts(slot)).toThrow();
  });
});

describe("parseComposeProjects", () => {
  test("parses project and working dir, drops unlabeled containers, bad names, and duplicates", () => {
    const out = [
      "picshow-dey-7\t/r/.slim/worktrees/dey-7",
      "picshow-dey-7\t/r/.slim/worktrees/dey-7",
      "picshow-dey-7-e2e\t/r/.slim/worktrees/dey-7",
      "\t",
      "web\t",
      "\t/x",
      "Bad Name\t/x",
      "up;rm\t/x",
      "rel\trelative/dir",
      "",
    ].join("\n");
    expect(parseComposeProjects(out)).toEqual([
      { project: "picshow-dey-7", workingDir: "/r/.slim/worktrees/dey-7" },
      { project: "picshow-dey-7-e2e", workingDir: "/r/.slim/worktrees/dey-7" },
    ]);
  });
});

describe("partitionProjects", () => {
  const lane = "/r/.slim/worktrees/dey-4";
  const inside = (wd: string) => wd === lane || wd.startsWith(`${lane}/`);
  const stack = (project: string, workingDir: string) => ({ project, workingDir });

  test("a project with all containers in the lane is exclusive", () => {
    expect(partitionProjects([stack("a", lane), stack("a", `${lane}/app`)], inside)).toEqual({ exclusive: ["a"], shared: [] });
  });
  test("a project shared between the main checkout and the lane is never exclusive", () => {
    const stacks = [stack("web", "/r"), stack("web", lane)];
    expect(partitionProjects(stacks, inside)).toEqual({ exclusive: [], shared: ["web"] });
  });
  test("a project that lives elsewhere entirely is not mentioned", () => {
    expect(partitionProjects([stack("x", "/other")], inside)).toEqual({ exclusive: [], shared: [] });
  });
  test("path boundary: dey-42 is not dey-4", () => {
    expect(partitionProjects([stack("b", "/r/.slim/worktrees/dey-42")], inside)).toEqual({ exclusive: [], shared: [] });
  });
  test("mixed: only fully-inside projects are exclusive", () => {
    const stacks = [stack("own", lane), stack("shared", lane), stack("shared", "/r"), stack("elsewhere", "/o")];
    expect(partitionProjects(stacks, inside)).toEqual({ exclusive: ["own"], shared: ["shared"] });
  });
  test("a project with a duplicate working dir is counted once", () => {
    expect(partitionProjects([stack("a", lane), stack("a", lane)], inside).exclusive).toEqual(["a"]);
  });
});

describe("orphanDirs", () => {
  const worktreesReal = "/r/.slim/worktrees";
  type Entry = { name: string; real: string | null; isDirectory: boolean; hasGit: boolean };
  const entry = (name: string, over: Partial<Entry> = {}): Entry => ({
    name,
    real: `${worktreesReal}/${name}`,
    isDirectory: true,
    hasGit: false,
    ...over,
  });
  const input = (over: Partial<Parameters<typeof orphanDirs>[0]> = {}) => ({
    worktreesReal,
    entries: [] as Entry[],
    registered: new Set<string>(),
    liveSlugs: new Set<string>(),
    ...over,
  });
  const orphans = (over: Partial<Parameters<typeof orphanDirs>[0]> = {}) => orphanDirs(input(over)).orphans;

  test("an unregistered directory with no job is an orphan", () => {
    expect(orphans({ entries: [entry("dey-7"), entry("dey-17")] })).toEqual(["dey-7", "dey-17"]);
  });
  test("a directory containing .git (a file or a directory) is never an orphan, and is reported", () => {
    const result = orphanDirs(input({ entries: [entry("dey-7"), entry("repo", { hasGit: true })] }));
    expect(result).toEqual({ orphans: ["dey-7"], withGit: ["repo"] });
  });
  test("only real directories qualify: files and symlinks do not", () => {
    const entries = [entry("a-file", { isDirectory: false }), entry("a-link", { isDirectory: false, real: "/etc" }), entry("dey-7")];
    expect(orphans({ entries })).toEqual(["dey-7"]);
  });
  test("registered worktrees are never touched", () => {
    expect(orphans({ entries: [entry("dey-7"), entry("dey-8")], registered: new Set([`${worktreesReal}/dey-8`]) })).toEqual(["dey-7"]);
  });
  test("a ticket with a live job is skipped, matching by exact slug (dey-4 vs dey-42)", () => {
    const entries = [entry("dey-4"), entry("dey-42")];
    expect(orphans({ entries, liveSlugs: new Set(["dey-4"]) })).toEqual(["dey-42"]);
    expect(orphans({ entries, liveSlugs: new Set(["dey-42"]) })).toEqual(["dey-4"]);
  });
  test(".tickets and names that are not plain lane names are skipped", () => {
    const names = [".tickets", ".hidden", "-rf", "Upper", "a b", "a/b", "", "ok.name_1-x"];
    expect(orphans({ entries: names.map((n) => entry(n)) })).toEqual(["ok.name_1-x"]);
  });
  test("a real path that is unresolvable, elsewhere, or nested does not count", () => {
    const entries = [entry("link", { real: "/etc" }), entry("dangling", { real: null }), entry("nested", { real: `${worktreesReal}/other/nested` }), entry("good")];
    expect(orphans({ entries })).toEqual(["good"]);
  });
  test("a real path that only starts with the same characters does not count", () => {
    expect(orphans({ entries: [entry("x", { real: "/r/.slim/worktrees-evil/x" })] })).toEqual([]);
  });
  test("a trailing slash on the worktrees real path is tolerated", () => {
    expect(orphans({ worktreesReal: `${worktreesReal}/`, entries: [entry("dey-7")] })).toEqual(["dey-7"]);
  });
});

describe("lanesDirSafe", () => {
  test.each([
    ["the checkout's own directory", { isSymlink: false, lanesReal: "/r/.slim/worktrees", projectReal: "/r" }, true],
    ["a symlink, even to the right place", { isSymlink: true, lanesReal: "/r/.slim/worktrees", projectReal: "/r" }, false],
    ["resolves outside the checkout", { isSymlink: false, lanesReal: "/other/worktrees", projectReal: "/r" }, false],
    ["the project path itself is a symlink: compared by real path", { isSymlink: false, lanesReal: "/real/r/.slim/worktrees", projectReal: "/real/r" }, true],
    ["a sibling that shares the prefix", { isSymlink: false, lanesReal: "/r2/.slim/worktrees", projectReal: "/r" }, false],
    ["a different .slim layout", { isSymlink: false, lanesReal: "/r/.slim/other", projectReal: "/r" }, false],
  ])("%s", (_name, facts, expected) => {
    expect(lanesDirSafe(facts)).toBe(expected);
  });
});

describe("orphan scan against the real filesystem", () => {
  test("a nested repo (.git file or directory), a symlink, and a file are never candidates", async () => {
    const { realpath, lstat } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "kanban-orphans-"));
    try {
      const lanes = join(root, ".slim", "worktrees");
      await mkdir(join(lanes, "plain"), { recursive: true });
      await mkdir(join(lanes, "clone", ".git"), { recursive: true });
      await mkdir(join(lanes, "linked"), { recursive: true });
      await writeFile(join(lanes, "linked", ".git"), "gitdir: /somewhere/else\n");
      await mkdir(join(lanes, ".tickets"), { recursive: true });
      await mkdir(join(root, "outside"), { recursive: true });
      await symlink(join(root, "outside"), join(lanes, "escape"));
      await writeFile(join(lanes, "file.txt"), "x");
      const lanesReal = await realpath(lanes);
      const { readdir } = await import("node:fs/promises");
      const dirents = await readdir(lanes, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map(async (e) => ({
          name: e.name,
          real: await realpath(join(lanes, e.name)).catch(() => null),
          isDirectory: e.isDirectory(),
          hasGit: e.isDirectory() && (await lstat(join(lanes, e.name, ".git")).then(() => true, () => false)),
        })),
      );
      const result = orphanDirs({ worktreesReal: lanesReal, entries, registered: new Set(), liveSlugs: new Set() });
      expect(result.orphans).toEqual(["plain"]);
      expect(result.withGit.sort()).toEqual(["clone", "linked"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlinked worktrees directory is refused as a whole", async () => {
    const { realpath, lstat } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "kanban-orphans-link-"));
    try {
      await mkdir(join(root, "project", ".slim"), { recursive: true });
      await mkdir(join(root, "elsewhere", "dir"), { recursive: true });
      await symlink(join(root, "elsewhere"), join(root, "project", ".slim", "worktrees"));
      const lanes = join(root, "project", ".slim", "worktrees");
      const info = await lstat(lanes);
      expect(
        lanesDirSafe({ isSymlink: info.isSymbolicLink(), lanesReal: await realpath(lanes), projectReal: await realpath(join(root, "project")) }),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("orphanStackProjects", () => {
  const dirs = ["/r/.slim/worktrees", "/real/r/.slim/worktrees"];
  const stack = (project: string, workingDir: string) => ({ project, workingDir });
  const none = new Set<string>();

  test("projects whose lane directory is missing are orphans; others are not", () => {
    const stacks = [
      stack("alive", "/r/.slim/worktrees/dey-1/app"),
      stack("gone", "/r/.slim/worktrees/dey-9"),
      stack("gone-deep", "/r/.slim/worktrees/dey-9/app/sub"),
      stack("gone-real", "/real/r/.slim/worktrees/dey-8"),
      stack("elsewhere", "/home/me/other"),
      stack("lookalike", "/r/.slim/worktrees-old/dey-9"),
      stack("on-the-dir", "/r/.slim/worktrees"),
    ];
    expect(orphanStackProjects(stacks, dirs, new Set(["dey-1"]), none)).toEqual(["gone", "gone-deep", "gone-real"]);
  });
  test("projects in an orphan lane directory count as orphans too", () => {
    const stacks = [stack("in-orphan", "/r/.slim/worktrees/dey-7/app")];
    expect(orphanStackProjects(stacks, dirs, new Set(["dey-7"]), new Set(["dey-7"]))).toEqual(["in-orphan"]);
    expect(orphanStackProjects(stacks, dirs, new Set(["dey-7"]), none)).toEqual([]);
  });
  test("a project that also runs from the main checkout or a live lane is never an orphan", () => {
    const stacks = [stack("shared", "/r/.slim/worktrees/dey-9"), stack("shared", "/r"), stack("mixed", "/r/.slim/worktrees/dey-9"), stack("mixed", "/r/.slim/worktrees/dey-1")];
    expect(orphanStackProjects(stacks, dirs, new Set(["dey-1"]), none)).toEqual([]);
  });
  test("a project with several missing lane directories is an orphan only if all are gone", () => {
    const stacks = [stack("two", "/r/.slim/worktrees/dey-8"), stack("two", "/r/.slim/worktrees/dey-9")];
    expect(orphanStackProjects(stacks, dirs, none, none)).toEqual(["two"]);
    expect(orphanStackProjects(stacks, dirs, new Set(["dey-9"]), none)).toEqual([]);
  });
  test("a prefix-sharing directory name does not count as existing", () => {
    expect(orphanStackProjects([stack("x", "/r/.slim/worktrees/dey-42")], dirs, new Set(["dey-4"]), none)).toEqual(["x"]);
    expect(orphanStackProjects([stack("x", "/r/.slim/worktrees/dey-4")], dirs, new Set(["dey-42"]), none)).toEqual(["x"]);
  });
});

describe("sharedProjectBlocker", () => {
  test("no shared project: nothing blocks", () => expect(sharedProjectBlocker([])).toBeNull());
  test("any shared project keeps the directory and names the projects", () => {
    expect(sharedProjectBlocker(["web"])).toBe("shared compose project web");
    expect(sharedProjectBlocker(["web", "db"])).toBe("shared compose project web,db");
  });
});

describe("worktreeBlocker", () => {
  const facts = (over = {}) => ({
    registered: true,
    locked: false,
    dirty: false,
    branchHead: "a",
    worktreeHead: "a",
    prHead: "a",
    ...over,
  });
  test.each([
    ["clean, at the PR head", {}, null],
    ["not registered", { registered: false }, "not a registered worktree"],
    ["locked wins over everything after it", { locked: true, dirty: true, branchHead: "b" }, "locked"],
    ["dirty", { dirty: true }, "uncommitted changes"],
    ["no local branch", { branchHead: null }, "no local branch"],
    ["branch differs", { branchHead: "b" }, "local branch differs from PR head"],
    ["worktree HEAD differs", { worktreeHead: "b" }, "worktree HEAD differs from PR head"],
  ])("%s", (_name, over, expected) => {
    expect(worktreeBlocker(facts(over))).toBe(expected);
  });
});

describe("orphanPass (two-pass rule)", () => {
  test("first sight is never due", () => {
    expect(orphanPass(new Set(), ["dir:dey-7"])).toEqual({ due: [], seen: new Set(["dir:dey-7"]) });
  });
  test("a candidate seen in the previous pass is due", () => {
    expect(orphanPass(new Set(["dir:dey-7"]), ["dir:dey-7", "dir:dey-8"])).toEqual({
      due: ["dir:dey-7"],
      seen: new Set(["dir:dey-7", "dir:dey-8"]),
    });
  });
  test("a candidate that disappears for one pass starts over", () => {
    const first = orphanPass(new Set(), ["dir:a"]);
    const gap = orphanPass(first.seen, []);
    expect(orphanPass(gap.seen, ["dir:a"]).due).toEqual([]);
  });
  test("dirs and stacks with the same name are different candidates", () => {
    expect(orphanPass(new Set(["dir:x"]), ["stack:x"]).due).toEqual([]);
  });
});

describe("isBindSafe", () => {
  test.each([
    ["/Users/me/projects/web/.slim/worktrees", true],
    ["relative/path", false],
    ["/a:b", false],
    ["/a,b", false],
    ["/a\nb", false],
    ["", false],
  ])("%s", (path, expected) => {
    expect(isBindSafe(path)).toBe(expected);
  });
});

describe("parseWorktreeList", () => {
  test("reads paths and checked-out branches, null when detached", () => {
    const out = [
      "worktree /r",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /r/.slim/worktrees/dey-1",
      "HEAD def",
      "branch refs/heads/max/dey-1",
      "",
      "worktree /r/.slim/worktrees/dey-2",
      "HEAD 123",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/r", branch: "refs/heads/main", locked: false },
      { path: "/r/.slim/worktrees/dey-1", branch: "refs/heads/max/dey-1", locked: false },
      { path: "/r/.slim/worktrees/dey-2", branch: null, locked: false },
    ]);
  });
  test("reads the lock, with or without a reason, only for its own worktree", () => {
    const out = [
      "worktree /r",
      "HEAD a",
      "branch refs/heads/main",
      "",
      "worktree /w1",
      "HEAD b",
      "branch refs/heads/b1",
      "locked",
      "",
      "worktree /w2",
      "HEAD c",
      "branch refs/heads/b2",
      "locked checked out on a USB stick",
      "",
      "worktree /w3",
      "HEAD d",
      "branch refs/heads/b3",
      "",
    ].join("\n");
    expect(parseWorktreeList(out).map((w) => [w.path, w.locked])).toEqual([["/r", false], ["/w1", true], ["/w2", true], ["/w3", false]]);
  });
  test("empty output", () => expect(parseWorktreeList("")).toEqual([]));
});
