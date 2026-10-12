// Thin git wrappers (argument arrays, timeouts). Read helpers return plain values;
// everything that fails throws GitError. Mutations are the caller's to guard.
import { stat } from "node:fs/promises";
import { exec as defaultExec, type Exec } from "./exec.ts";
import { REPO_PATTERN, type WorktreePlan } from "./select.ts";

const GIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 180_000;
// The poller container skips the github plugin entrypoint, so git has no global credential
// helper; borrow gh's (the gh wrapper on PATH mints GitHub App tokens, like for gh calls).
const GH_CREDENTIAL_ARGS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export class GitError extends Error {}

export interface Git {
  isRepo(path: string): Promise<boolean>;
  originUrl(path: string): Promise<string>;
  worktreePaths(path: string): Promise<string[]>;
  statusPorcelain(worktree: string): Promise<string>;
  revParse(path: string, ref: string): Promise<string | null>;
  isIgnored(path: string, relPath: string): Promise<boolean>;
  fetch(path: string, repo: string): Promise<void>;
  worktreeAdd(path: string, worktree: string, plan: Exclude<WorktreePlan, { kind: "reuse" }>): Promise<void>;
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

/** The git subcommand of an argument array, skipping `-C <dir>` and `-c <key=value>` options. */
function subcommand(args: string[]): string {
  let i = 0;
  while (args[i] === "-C" || args[i] === "-c") i += 2;
  return args[i] ?? args[0];
}

export function createGit(run: Exec = defaultExec): Git {
  async function git(args: string[], timeoutMs = GIT_TIMEOUT_MS) {
    // Trust exactly the directory git is pointed at (never "*"), so ownership quirks
    // on the mounted checkout or its worktrees cannot fail poller calls.
    const dir = args[args.indexOf("-C") + 1];
    const trusted = args.includes("-C") ? ["-c", `safe.directory=${dir}`] : [];
    const result = await run(["git", ...trusted, ...args], { timeoutMs });
    if (result.timedOut) throw new GitError(`git ${subcommand(args)} timed out`);
    return result;
  }
  async function ok(args: string[], timeoutMs?: number): Promise<string> {
    const result = await git(args, timeoutMs);
    if (result.code !== 0) {
      throw new GitError(`git ${subcommand(args)} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
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
    async isIgnored(path, relPath) {
      // check-ignore: exit 0 = ignored, 1 = not ignored, anything else = error.
      const result = await git(["-C", path, "check-ignore", "-q", relPath]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new GitError(`git check-ignore failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
    },
    async fetch(path, repo) {
      if (!REPO_PATTERN.test(repo)) throw new GitError("git fetch refused: invalid repo name");
      // HTTPS regardless of origin's URL form: the container has no ssh.
      await ok(
        [
          ...GH_CREDENTIAL_ARGS, "-C", path, "fetch", "--prune",
          `https://github.com/${repo}.git`, "+refs/heads/*:refs/remotes/origin/*",
        ],
        FETCH_TIMEOUT_MS,
      );
    },
    async worktreeAdd(path, worktree, plan) {
      const base = ["-C", path, "worktree", "add"];
      if (plan.kind === "existing-local") await ok([...base, worktree, plan.branch]);
      else if (plan.kind === "track") await ok([...base, "--track", "-b", plan.branch, worktree, `origin/${plan.branch}`]);
      else await ok([...base, "--no-track", "-b", plan.branch, worktree, plan.base]);
    },
    async worktreeRemove(path, worktree) {
      await ok(["-C", path, "worktree", "remove", worktree]);
    },
    async branchDelete(path, branch) {
      await ok(["-C", path, "branch", "-D", branch]);
    },
  };
}
