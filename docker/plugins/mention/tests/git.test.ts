import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGit, GitError } from "../poller/git.ts";
import type { Exec } from "../poller/exec.ts";

for (const fork of [false, true]) test(`detached worktree preparation (${fork ? "fork" : "same repo"}) uses HTTPS argument arrays`, async () => {
  const root = await mkdtemp("/tmp/opencode/mention-test-");
  const checkout = join(root, "repo");
  const worktree = join(checkout, ".slim/worktrees/mention-pr-12");
  await mkdir(join(checkout, ".git/info"), { recursive: true });
  const calls: string[][] = [];
  const run: Exec = async (args) => {
    calls.push(args);
    let stdout = "";
    if (args.includes("--show-toplevel")) stdout = checkout;
    else if (args.includes("get-url")) stdout = "https://github.com/org/repo.git";
    else if (args.includes("--git-common-dir")) stdout = ".git";
    else if (args.includes("rev-parse")) stdout = args.at(-1) === "refs/remotes/origin/main" ? "b".repeat(40) : "a".repeat(40);
    return { code: 0, stdout, stderr: "", timedOut: false };
  };
  try {
    expect(await createGit(run).prepare(root, "org/repo", 12, "feature/test", "main", !fork)).toEqual({ worktree, headSha: "a".repeat(40), baseSha: "b".repeat(40) });
    const fetch = calls.find((args) => args.includes("fetch"))!;
    expect(fetch).toContain("credential.helper=");
    expect(fetch).toContain("credential.helper=!gh auth git-credential");
    expect(fetch).toContain("https://github.com/org/repo.git");
    expect(fetch).toContain(fork ? "+refs/pull/12/head:refs/mention/pull/12" : "+refs/heads/feature/test:refs/remotes/origin/feature/test");
    expect(fetch).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(fetch).toContain("core.hooksPath=/dev/null");
    expect(fetch).toContain("core.fsmonitor=false");
    const add = calls.find((args) => args.includes("add"))!;
    expect(add.slice(-5)).toEqual(["worktree", "add", "--detach", worktree, fork ? "refs/mention/pull/12" : "refs/remotes/origin/feature/test"]);
    expect(await readFile(join(checkout, ".git/info/exclude"), "utf8")).toBe("/.slim/worktrees/\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing dirty worktree is never checked out or reset", async () => {
  const root = await mkdtemp("/tmp/opencode/mention-test-");
  const checkout = join(root, "repo");
  const worktree = join(checkout, ".slim/worktrees/mention-pr-12");
  await mkdir(worktree, { recursive: true });
  const calls: string[][] = [];
  const run: Exec = async (args) => {
    calls.push(args);
    let stdout = "";
    if (args.includes("--show-toplevel")) stdout = checkout;
    else if (args.includes("get-url")) stdout = "https://github.com/org/repo.git";
    else if (args.includes("--git-common-dir")) stdout = ".git";
    else if (args.includes("list")) stdout = `worktree ${checkout}\0\0worktree ${worktree}\0detached\0\0`;
    else if (args.includes("status")) stdout = " M important.ts";
    return { code: 0, stdout, stderr: "", timedOut: false };
  };
  try {
    await expect(createGit(run).prepare(root, "org/repo", 12, "feature", "main", true)).rejects.toThrow("worktree has uncommitted changes");
    expect(calls.some((args) => args.includes("checkout") || args.includes("reset"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const baseRef of ["", "-main", "main..other", "main;touch", "a/../b"]) test(`invalid baseRef ${JSON.stringify(baseRef)} is rejected before exec`, async () => {
  const calls: string[][] = [];
  const run: Exec = async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  await expect(createGit(run).prepare("/unused", "org/repo", 12, "feature", baseRef, true)).rejects.toThrow("invalid base ref");
  expect(calls).toEqual([]);
});

export async function cleanupFixture(options: { dirty?: boolean; ancestor?: number; registered?: boolean; removeCode?: number; localRef?: boolean; fetchFailures?: number } = {}) {
  const root = await mkdtemp("/tmp/opencode/mention-cleanup-");
  const checkout = join(root, "repo");
  const path = join(checkout, ".slim/worktrees/mention-pr-12");
  await mkdir(path, { recursive: true });
  const calls: string[][] = [];
  let fetches = 0;
  const waits: number[] = [];
  const run: Exec = async (args) => {
    calls.push(args);
    let stdout = "", code = 0;
    if (args.includes("--show-toplevel")) stdout = checkout;
    else if (args.includes("get-url")) stdout = "https://github.com/org/repo.git";
    else if (args.includes("list")) stdout = `worktree ${options.registered === false ? path + "-other" : path}\0detached\0\0`;
    else if (args.includes("status")) stdout = options.dirty ? "?? untracked.txt" : "";
    else if (args.includes("show-ref")) code = options.localRef === false ? 1 : 0;
    else if (args.includes("merge-base")) code = options.ancestor ?? 0;
    else if (args.includes("remove")) code = options.removeCode ?? 0;
    else if (args.includes("for-each-ref")) stdout = "refs/mention/saved/pr-12/aaa\nrefs/mention/saved/pr-12/bbb\n";
    else if (args.includes("fetch")) code = ++fetches <= (options.fetchFailures ?? 0) ? 1 : 0;
    return { code, stdout, stderr: "", timedOut: false };
  };
  return { root, checkout, path, calls, waits, git: createGit(run, async (ms) => { waits.push(ms); }), dispose: () => rm(root, { recursive: true, force: true }) };
}

for (const failures of [1, 2]) test(`cleanup fetch retries once (${failures} failures)`, async () => {
  const f = await cleanupFixture({ fetchFailures: failures });
  try {
    const pending = f.git.cleanup(f.root, "org/repo", 12, closed);
    if (failures === 1) expect((await pending).decision).toEqual({ action: "remove" });
    else await expect(pending).rejects.toBeInstanceOf(GitError);
    expect(f.calls.filter((args) => args.includes("fetch"))).toHaveLength(2);
    expect(f.waits).toEqual([2_000]);
    if (failures === 2) expect(f.calls.some((args) => args.includes("remove"))).toBe(false);
  } finally { await f.dispose(); }
});

for (const failures of [1, 2]) test(`prepare fetch retries once (${failures} failures)`, async () => {
  const root = await mkdtemp("/tmp/opencode/mention-retry-");
  const checkout = join(root, "app");
  await mkdir(join(checkout, ".git/info"), { recursive: true });
  let fetches = 0;
  const waits: number[] = [];
  const run: Exec = async (args) => {
    let stdout = "", code = 0;
    if (args.includes("--show-toplevel")) stdout = checkout;
    else if (args.includes("get-url")) stdout = "https://github.com/octo-org/app.git";
    else if (args.includes("--git-common-dir")) stdout = ".git";
    else if (args.includes("fetch")) code = ++fetches <= failures ? 1 : 0;
    else if (args.includes("rev-parse")) stdout = "a".repeat(40);
    return { code, stdout, stderr: "", timedOut: false };
  };
  try {
    const pending = createGit(run, async (ms) => { waits.push(ms); }).prepare(root, "octo-org/app", 12, "feature", "main", true);
    if (failures === 1) expect((await pending).headSha).toBe("a".repeat(40));
    else await expect(pending).rejects.toBeInstanceOf(GitError);
    expect(fetches).toBe(2); expect(waits).toEqual([2_000]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shutdown interrupts fetch retry delay without another fetch", async () => {
  const root = await mkdtemp("/tmp/opencode/mention-abort-");
  const checkout = join(root, "app");
  await mkdir(join(checkout, ".git/info"), { recursive: true });
  const controller = new AbortController();
  let fetches = 0;
  const run: Exec = async (args) => {
    let stdout = "", code = 0;
    if (args.includes("--show-toplevel")) stdout = checkout;
    else if (args.includes("get-url")) stdout = "https://github.com/octo-org/app.git";
    else if (args.includes("--git-common-dir")) stdout = ".git";
    else if (args.includes("fetch")) {
      fetches++; code = 1; setTimeout(() => controller.abort(), 10);
    }
    return { code, stdout, stderr: "", timedOut: false };
  };
  try {
    await expect(createGit(run).prepare(root, "octo-org/app", 12, "feature", "main", true, controller.signal)).rejects.toThrow("poller stopped");
    expect(fetches).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const closed = { prState: "closed", merged: false, liveJob: false, dryRun: false };
for (const [name, options, reason] of [
  ["not registered", { registered: false }, "not registered"],
  ["dirty", { dirty: true }, "uncommitted changes"],
  ["ancestor exit 1", { ancestor: 1 }, "unpushed commits"],
  ["remove failure", { removeCode: 1 }, "worktree remove failed"],
] as const) test(`cleanup skips ${name}`, async () => {
  const f = await cleanupFixture(options);
  try {
    expect((await f.git.cleanup(f.root, "org/repo", 12, closed)).decision).toEqual({ action: "skip", reason });
    if (name !== "remove failure") expect(f.calls.some((args) => args.includes("remove"))).toBe(false);
    if (name === "dirty" || name === "not registered") expect(f.calls.some((args) => args.includes("fetch"))).toBe(false);
    expect(f.calls.some((args) => args.includes("--force") || args.includes("update-ref"))).toBe(false);
  } finally { await f.dispose(); }
});

test("cleanup removes without force, deletes only the PR ref, and counts retained saved refs", async () => {
  const f = await cleanupFixture();
  try {
    expect(await f.git.cleanup(f.root, "org/repo", 12, closed)).toEqual({ decision: { action: "remove" }, saved: 2 });
    const fetch = f.calls.find((args) => args.includes("fetch"))!;
    expect(fetch).toContain("https://github.com/org/repo.git");
    expect(fetch).toContain("+refs/pull/12/head:refs/mention/pull/12");
    expect(fetch).toContain("credential.helper=!gh auth git-credential");
    const remove = f.calls.find((args) => args.includes("remove"))!;
    expect(remove.slice(-3)).toEqual(["worktree", "remove", f.path]);
    expect(f.calls.some((args) => args.includes("--force"))).toBe(false);
    expect(f.calls.filter((args) => args.includes("update-ref")).map((args) => args.slice(-3))).toEqual([["update-ref", "-d", "refs/mention/pull/12"]]);
    expect(f.calls.find((args) => args.includes("for-each-ref"))!.at(-1)).toBe("refs/mention/saved/pr-12/");
  } finally { await f.dispose(); }
});

for (const localRef of [true, false]) test(`dry-run cleanup uses local ref only (present=${localRef})`, async () => {
  const f = await cleanupFixture({ localRef });
  try {
    const result = await f.git.cleanup(f.root, "org/repo", 12, { ...closed, dryRun: true });
    expect(result.decision).toEqual(localRef ? { action: "remove" } : { action: "skip", reason: "unknown" });
    expect(f.calls.some((args) => args.includes("fetch") || args.includes("remove") || args.includes("update-ref"))).toBe(false);
  } finally { await f.dispose(); }
});

test("unexpected ancestor exit is an error and never removes", async () => {
  const f = await cleanupFixture({ ancestor: 128 });
  try {
    await expect(f.git.cleanup(f.root, "org/repo", 12, closed)).rejects.toThrow("git merge-base failed (exit 128)");
    expect(f.calls.some((args) => args.includes("remove"))).toBe(false);
  } finally { await f.dispose(); }
});

test("cleanup discovery ignores files, symlinks and non-PR directories", async () => {
  const f = await cleanupFixture();
  try {
    const parent = join(f.checkout, ".slim/worktrees");
    await mkdir(join(parent, "mention-pr-0"));
    await mkdir(join(parent, "mention-pr-01"));
    await mkdir(join(parent, "pr-12"));
    await mkdir(join(parent, "other"));
    await writeFile(join(parent, "mention-pr-13"), "file");
    await symlink(f.path, join(parent, "mention-pr-14"));
    expect(await f.git.cleanupEntries(f.root, "org/repo")).toEqual([{ pr: 12, path: f.path }]);
    await rm(join(f.checkout, ".slim"), { recursive: true });
    await symlink(f.root, join(f.checkout, ".slim"));
    expect(await f.git.cleanupEntries(f.root, "org/repo")).toEqual([]);
  } finally { await f.dispose(); }
});
