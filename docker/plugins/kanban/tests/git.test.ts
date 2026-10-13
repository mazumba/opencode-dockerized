import { describe, expect, test } from "bun:test";
import { FetchError, GitError, createGit } from "../poller/git.ts";
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
      "git", "-c", "safe.directory=/repo", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
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
    await git.topLevel("/repo");
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
    expect(calls.map((c) => c.slice(7))).toEqual([
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
  test("mergeFfOnly passes the ctime flags and --ff-only", async () => {
    const { git, calls } = fake();
    await git.mergeFfOnly("/repo", "origin/main");
    expect(calls[0]).toEqual([
      "git", "-c", "safe.directory=/repo", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "core.trustctime=false", "-c", "core.checkStat=minimal",
      "-C", "/repo", "merge", "--ff-only", "origin/main",
    ]);
  });
  test("mergeFfOnly failure names the subcommand", async () => {
    const { git } = fake(result({ code: 128, stderr: "Not possible to fast-forward" }));
    await expect(git.mergeFfOnly("/repo", "origin/main")).rejects.toThrow("git merge failed (exit 128)");
  });
  test("isAncestor maps exit 0/1 and throws otherwise", async () => {
    expect(await fake(result({ code: 0 })).git.isAncestor("/repo", "a", "b")).toBe(true);
    expect(await fake(result({ code: 1 })).git.isAncestor("/repo", "a", "b")).toBe(false);
    await expect(fake(result({ code: 128, stderr: "bad" })).git.isAncestor("/repo", "a", "b")).rejects.toBeInstanceOf(GitError);
  });
  test("showFile is null when ls-tree finds nothing, content otherwise, and errors on a bad ref", async () => {
    const calls: string[][] = [];
    const answers = [result({ stdout: "" })];
    const run: Exec = async (command) => {
      calls.push(command);
      return answers.shift() ?? result();
    };
    expect(await createGit(run).showFile("/repo", "origin/main", ".kanban/setup.sh")).toBeNull();
    expect(calls).toHaveLength(1);
    const second = [result({ stdout: ".kanban/setup.sh\n" }), result({ stdout: "echo hi\n" })];
    const run2: Exec = async (command) => {
      calls.push(command);
      return second.shift()!;
    };
    expect(await createGit(run2).showFile("/repo", "origin/main", ".kanban/setup.sh")).toBe("echo hi\n");
    expect(calls.at(-1)?.slice(-4)).toEqual(["-C", "/repo", "show", "origin/main:.kanban/setup.sh"]);
    await expect(fake(result({ code: 128, stderr: "bad ref" })).git.showFile("/repo", "origin/x", "f")).rejects.toBeInstanceOf(GitError);
  });
  describe("auto-merge helpers", () => {
    const sha = "a".repeat(40);
    const scripted = (...results: ExecResult[]) => {
      const calls: string[][] = [];
      const run: Exec = async (command) => {
        calls.push(command);
        return results.shift() ?? result();
      };
      return { git: createGit(run), calls };
    };
    const IDENTITY = ["-c", "user.name=kanban-poller", "-c", "user.email=kanban-poller@users.noreply.github.com"];

    test("mergeBase merges with the poller identity and ctime flags", async () => {
      const { git, calls } = scripted(result({ stdout: "aaa\n" }), result({ stdout: "Merge made" }), result({ stdout: "bbb\n" }));
      expect(await git.mergeBase("/wt", "origin/main")).toBe("merged");
      expect(calls[1]).toEqual([
        "git", "-c", "safe.directory=/wt", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...IDENTITY,
        "-c", "core.trustctime=false", "-c", "core.checkStat=minimal",
        "-C", "/wt", "merge", "--no-edit", "origin/main",
      ]);
    });
    test("mergeBase reports uptodate when HEAD did not move", async () => {
      const { git } = scripted(result({ stdout: "aaa\n" }), result({ stdout: "Already up to date." }), result({ stdout: "aaa\n" }));
      expect(await git.mergeBase("/wt", "origin/main")).toBe("uptodate");
    });
    test("mergeBase aborts the merge and reports a conflict", async () => {
      const { git, calls } = scripted(
        result({ stdout: "aaa\n" }),
        result({ code: 1, stdout: "CONFLICT (content): Merge conflict in x\nAutomatic merge failed" }),
        result(),
      );
      expect(await git.mergeBase("/wt", "origin/main")).toBe("conflict");
      expect(calls[2].slice(-3)).toEqual(["/wt", "merge", "--abort"]);
    });
    test("mergeBase aborts and throws on other failures", async () => {
      const { git, calls } = scripted(result({ stdout: "aaa\n" }), result({ code: 128, stderr: "fatal: bad" }), result());
      await expect(git.mergeBase("/wt", "origin/main")).rejects.toThrow("git merge failed (exit 128): fatal: bad");
      expect(calls[2].slice(-2)).toEqual(["merge", "--abort"]);
    });
    test("mergeBase only accepts origin/<branch> refs", async () => {
      const { git, calls } = scripted();
      for (const ref of ["main", "origin/", "origin/-x", "origin/a b", "HEAD~1", "--abort"]) {
        await expect(git.mergeBase("/wt", ref)).rejects.toBeInstanceOf(GitError);
      }
      expect(calls).toEqual([]);
    });
    test("push uses HTTPS, the gh credential helper, an explicit refspec, and never force", async () => {
      const { git, calls } = scripted();
      await git.push("/wt", "o/r", "max/dey-9");
      expect(calls[0]).toEqual([
        "git", "-c", "safe.directory=/wt", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
        "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
        "-C", "/wt", "push", "https://github.com/o/r.git", "HEAD:refs/heads/max/dey-9",
      ]);
      expect(calls[0].join(" ")).not.toMatch(/force|--delete|\+HEAD/);
    });
    test("push rejects bad repo and branch names", async () => {
      const { git, calls } = scripted();
      await expect(git.push("/wt", "o", "b")).rejects.toBeInstanceOf(GitError);
      for (const branch of ["", "-x", "a b", "a;b", "+b"]) {
        await expect(git.push("/wt", "o/r", branch)).rejects.toBeInstanceOf(GitError);
      }
      expect(calls).toEqual([]);
    });
    test("push failure names the subcommand", async () => {
      const { git } = scripted(result({ code: 1, stderr: "! [rejected] non-fast-forward" }));
      await expect(git.push("/wt", "o/r", "b")).rejects.toThrow("git push failed (exit 1)");
    });
    test("resetHard needs a full commit id", async () => {
      const { git, calls } = scripted();
      await git.resetHard("/wt", sha);
      expect(calls[0].slice(-4)).toEqual(["/wt", "reset", "--hard", sha]);
      await expect(git.resetHard("/wt", "HEAD~1")).rejects.toBeInstanceOf(GitError);
      await expect(git.resetHard("/wt", "abc")).rejects.toBeInstanceOf(GitError);
    });
  });
  test("every call, whatever the subcommand, runs without repo hooks and fsmonitor", async () => {
    const { git, calls } = fake(result({ stdout: "x\n" }));
    await git.topLevel("/repo");
    await git.revParse("/repo", "HEAD");
    await git.statusPorcelain("/repo");
    await git.worktreeRemove("/repo", "/repo/.slim/worktrees/dey-9");
    await git.mergeFfOnly("/repo", "origin/main");
    await git.fetch("/repo", "o/r");
    for (const call of calls) {
      expect(call).toContain("core.hooksPath=/dev/null");
      expect(call).toContain("core.fsmonitor=false");
    }
  });
  test("a fetch failure is a FetchError (still a GitError)", async () => {
    const { git } = fake(result({ code: 128, stderr: "unable to access" }));
    const error = await git.fetch("/repo", "o/r").catch((e) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect(error).toBeInstanceOf(GitError);
  });
  test("a fetch timeout is a FetchError, other failures are not", async () => {
    const timedOut = createGit(async () => result({ code: null, timedOut: true }));
    await expect(timedOut.fetch("/repo", "o/r")).rejects.toBeInstanceOf(FetchError);
    const { git } = fake(result({ code: 1, stderr: "x" }));
    expect(await git.mergeFfOnly("/repo", "origin/main").catch((e) => e)).not.toBeInstanceOf(FetchError);
  });
  describe("generic workflow helpers", () => {
    const H = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
    test("topLevel is the repo root, or null outside a repository", async () => {
      expect(await fake(result({ stdout: "/repo\n" })).git.topLevel("/repo")).toBe("/repo");
      expect(await fake(result({ code: 128, stderr: "not a git repository" })).git.topLevel("/x")).toBeNull();
    });
    test("commonGitDir resolves a relative answer against the checkout", async () => {
      expect(await fake(result({ stdout: ".git\n" })).git.commonGitDir("/repo")).toBe("/repo/.git");
      expect(await fake(result({ stdout: "/repo/.git\n" })).git.commonGitDir("/repo/.slim/worktrees/dey-1")).toBe("/repo/.git");
      expect(await fake(result({ stdout: "../../../.git\n" })).git.commonGitDir("/repo/.slim/worktrees/dey-1")).toBe("/repo/.git");
    });
    test("clone uses HTTPS and the gh credential helper, with -- before the positional arguments", async () => {
      const { git, calls } = fake();
      await git.clone("o/web", "/root/web");
      expect(calls[0]).toEqual([
        "git", ...H, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
        "clone", "--", "https://github.com/o/web.git", "/root/web",
      ]);
    });
    test("clone refuses bad repo names and relative paths", async () => {
      const { git, calls } = fake();
      for (const repo of ["", "o", "o/r;rm", "o/r --upload-pack=x"]) await expect(git.clone(repo, "/root/r")).rejects.toBeInstanceOf(GitError);
      await expect(git.clone("o/r", "relative")).rejects.toBeInstanceOf(GitError);
      await expect(git.clone("o/r", "-x")).rejects.toBeInstanceOf(GitError);
      expect(calls).toEqual([]);
    });
    test("clone failure names the subcommand", async () => {
      const { git } = fake(result({ code: 128, stderr: "fatal: repository not found" }));
      await expect(git.clone("o/r", "/root/r")).rejects.toThrow("git clone failed (exit 128): fatal: repository not found");
    });
    test("worktreeBranches parses the porcelain list", async () => {
      const { git, calls } = fake(result({ stdout: "worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /w\nHEAD b\ndetached\n" }));
      expect(await git.worktreeBranches("/r")).toEqual([
        { path: "/r", branch: "refs/heads/main", locked: false },
        { path: "/w", branch: null, locked: false },
      ]);
      expect(calls[0].slice(-4)).toEqual(["/r", "worktree", "list", "--porcelain"]);
    });
    test("updateRef is a compare-and-swap on a local branch ref", async () => {
      const { git, calls } = fake();
      const a = "a".repeat(40);
      const b = "b".repeat(40);
      await git.updateRef("/r", "refs/heads/main", b, a);
      expect(calls[0].slice(-6)).toEqual(["-C", "/r", "update-ref", "refs/heads/main", b, a]);
    });
    test("updateRef refuses other refs and malformed commit ids", async () => {
      const { git, calls } = fake();
      const a = "a".repeat(40);
      for (const ref of ["refs/remotes/origin/main", "HEAD", "refs/heads/", "refs/heads/-x", "main"]) {
        await expect(git.updateRef("/r", ref, a, a)).rejects.toBeInstanceOf(GitError);
      }
      await expect(git.updateRef("/r", "refs/heads/main", "abc", a)).rejects.toBeInstanceOf(GitError);
      await expect(git.updateRef("/r", "refs/heads/main", a, "HEAD")).rejects.toBeInstanceOf(GitError);
      expect(calls).toEqual([]);
    });
    test("there is no repo-wide prune", () => {
      expect("worktreePrune" in fake().git).toBe(false);
    });
    test("clone refuses paths that are not normalized", async () => {
      const { git, calls } = fake();
      for (const path of ["/root/web/", "/root/../web", "/root/./web", "/root//web", "/root/web/.."]) {
        await expect(git.clone("o/web", path)).rejects.toBeInstanceOf(GitError);
      }
      await git.clone("o/web", "/root/web");
      expect(calls).toHaveLength(1);
    });
    test("operationBranch reads the branch of a rebase or bisect from the git directory", async () => {
      const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const root = await mkdtemp(join(tmpdir(), "kanban-opbranch-"));
      try {
        const gitDir = join(root, "gitdir");
        await mkdir(join(gitDir, "rebase-merge"), { recursive: true });
        const { git } = fake(result({ stdout: `${gitDir}\n` }));
        expect(await git.operationBranch("/wt")).toBeNull();
        await writeFile(join(gitDir, "rebase-merge", "head-name"), "refs/heads/main\n");
        expect(await git.operationBranch("/wt")).toBe("refs/heads/main");
        await rm(join(gitDir, "rebase-merge"), { recursive: true });
        await mkdir(join(gitDir, "rebase-apply"), { recursive: true });
        await writeFile(join(gitDir, "rebase-apply", "head-name"), "refs/heads/feature/x\n");
        expect(await git.operationBranch("/wt")).toBe("refs/heads/feature/x");
        await rm(join(gitDir, "rebase-apply"), { recursive: true });
        await writeFile(join(gitDir, "BISECT_START"), "main\n");
        expect(await git.operationBranch("/wt")).toBe("refs/heads/main");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
