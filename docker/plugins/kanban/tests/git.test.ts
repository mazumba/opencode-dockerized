import { describe, expect, test } from "bun:test";
import { GitError, createGit } from "../poller/git.ts";
import type { Exec, ExecResult } from "../poller/exec.ts";

const result = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over });

function fake(res: ExecResult = result()) {
  const calls: string[][] = [];
  const run: Exec = async (command) => {
    calls.push(command);
    return res;
  };
  return { git: createGit(run), calls };
}

describe("git wrappers", () => {
  test("fetch uses gh as credential helper, as an argument array", async () => {
    const { git, calls } = fake();
    await git.fetch("/repo", "o/r");
    expect(calls[0]).toEqual([
      "git", "-c", "safe.directory=/repo", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
      "-C", "/repo", "fetch", "--prune", "https://github.com/o/r.git", "+refs/heads/*:refs/remotes/origin/*",
    ]);
  });
  test("fetch rejects repo names that are not owner/name", async () => {
    const { git, calls } = fake();
    for (const repo of ["", "o", "o/r/x", "o/r;rm", "../x/y", "o/r --upload-pack=x"]) {
      await expect(git.fetch("/repo", repo)).rejects.toBeInstanceOf(GitError);
    }
    expect(calls).toEqual([]);
  });
  test("every -C call trusts exactly that path via safe.directory", async () => {
    const { git, calls } = fake(result({ stdout: "worktree /w\n" }));
    await git.isRepo("/repo");
    await git.originUrl("/repo");
    await git.statusPorcelain("/repo/.slim/worktrees/dey-9");
    await git.branchDelete("/repo", "b");
    expect(calls.map((c) => c.slice(1, 3))).toEqual([
      ["-c", "safe.directory=/repo"],
      ["-c", "safe.directory=/repo"],
      ["-c", "safe.directory=/repo/.slim/worktrees/dey-9"],
      ["-c", "safe.directory=/repo"],
    ]);
    expect(calls.flat()).not.toContain("safe.directory=*");
  });
  test("fetch failure names the subcommand, not the options", async () => {
    const { git } = fake(result({ code: 128, stderr: "nope" }));
    await expect(git.fetch("/repo", "o/r")).rejects.toThrow("git fetch failed (exit 128): nope");
  });
  test("worktreeAdd per plan", async () => {
    const { git, calls } = fake();
    await git.worktreeAdd("/repo", "/repo/.slim/worktrees/dey-9", { kind: "existing-local", branch: "b" });
    await git.worktreeAdd("/repo", "/repo/.slim/worktrees/dey-9", { kind: "track", branch: "b" });
    await git.worktreeAdd("/repo", "/repo/.slim/worktrees/dey-9", { kind: "new", branch: "b", base: "origin/main" });
    expect(calls.map((c) => c.slice(3))).toEqual([
      ["-C", "/repo", "worktree", "add", "/repo/.slim/worktrees/dey-9", "b"],
      ["-C", "/repo", "worktree", "add", "--track", "-b", "b", "/repo/.slim/worktrees/dey-9", "origin/b"],
      ["-C", "/repo", "worktree", "add", "--no-track", "-b", "b", "/repo/.slim/worktrees/dey-9", "origin/main"],
    ]);
  });
  test("isIgnored maps exit codes 0, 1 and others", async () => {
    expect(await fake(result({ code: 0 })).git.isIgnored("/repo", "x")).toBe(true);
    expect(await fake(result({ code: 1 })).git.isIgnored("/repo", "x")).toBe(false);
    await expect(fake(result({ code: 128, stderr: "fatal" })).git.isIgnored("/repo", "x")).rejects.toBeInstanceOf(GitError);
  });
});
