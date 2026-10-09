// Thin git wrappers (argument arrays, timeouts). Read helpers return plain values;
// everything that fails throws GitError. Mutations are the caller's to guard.
import { stat } from "node:fs/promises";
import { exec as defaultExec, type Exec } from "./exec.ts";

const GIT_TIMEOUT_MS = 60_000;

export class GitError extends Error {}

export interface Git {
  isRepo(path: string): Promise<boolean>;
  originUrl(path: string): Promise<string>;
  worktreePaths(path: string): Promise<string[]>;
  statusPorcelain(worktree: string): Promise<string>;
  revParse(path: string, ref: string): Promise<string | null>;
  worktreeRemove(path: string, worktree: string): Promise<void>;
  branchDelete(path: string, branch: string): Promise<void>;
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function createGit(run: Exec = defaultExec): Git {
  async function git(args: string[]) {
    const result = await run(["git", ...args], { timeoutMs: GIT_TIMEOUT_MS });
    if (result.timedOut) throw new GitError(`git ${args[2] ?? args[0]} timed out`);
    return result;
  }
  async function ok(args: string[]): Promise<string> {
    const result = await git(args);
    if (result.code !== 0) {
      throw new GitError(`git ${args[2] ?? args[0]} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
    }
    return result.stdout;
  }
  return {
    async isRepo(path) {
      return (await git(["-C", path, "rev-parse", "--git-dir"])).code === 0;
    },
    async originUrl(path) {
      return (await ok(["-C", path, "remote", "get-url", "origin"])).trim();
    },
    async worktreePaths(path) {
      const out = await ok(["-C", path, "worktree", "list", "--porcelain"]);
      return out
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
    },
    async statusPorcelain(worktree) {
      return (await ok(["-C", worktree, "status", "--porcelain"])).trim();
    },
    async revParse(path, ref) {
      const result = await git(["-C", path, "rev-parse", "--verify", "--quiet", ref]);
      return result.code === 0 ? result.stdout.trim() : null;
    },
    async worktreeRemove(path, worktree) {
      await ok(["-C", path, "worktree", "remove", worktree]);
    },
    async branchDelete(path, branch) {
      await ok(["-C", path, "branch", "-D", branch]);
    },
  };
}
