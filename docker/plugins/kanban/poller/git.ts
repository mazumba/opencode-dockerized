// Thin git wrappers (argument arrays, timeouts). Read helpers return plain values;
// everything that fails throws GitError. Mutations are the caller's to guard.
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { exec as defaultExec, type Exec } from "./exec.ts";
import { BRANCH_PATTERN, REPO_PATTERN, type WorktreePlan } from "./select.ts";

const GIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 180_000;
// The poller container skips the github plugin entrypoint, so git has no global credential
// helper; borrow gh's (the gh wrapper on PATH mints GitHub App tokens, like for gh calls).
const GH_CREDENTIAL_ARGS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export class GitError extends Error {}

/** `git fetch` failed or timed out: usually transient, so callers skip and retry instead of failing the ticket. */
export class FetchError extends GitError {}

// Repo-controlled config must not run code in the poller: no git hooks, no fsmonitor daemon.
const HARDENING_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** Author and committer of merge commits the poller makes itself. */
export const POLLER_GIT_IDENTITY = { name: "kanban-poller", email: "kanban-poller@users.noreply.github.com" };

const CTIME_ARGS = ["-c", "core.trustctime=false", "-c", "core.checkStat=minimal"];
const BASE_REF_PATTERN = /^origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CLONE_TIMEOUT_MS = 600_000;
const HEAD_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface Git {
  /** Top-level directory of the repository containing `path`, or null when it is not inside one. */
  topLevel(path: string): Promise<string | null>;
  /** The repository's common git directory (shared by all its worktrees), as an absolute path. */
  commonGitDir(path: string): Promise<string>;
  /** Clones `repo` over HTTPS into `path` (which must not exist or be empty). */
  clone(repo: string, path: string): Promise<void>;
  /** All worktrees of the repository with the branch each has checked out (null when detached) and their lock state. */
  worktreeBranches(path: string): Promise<WorktreeEntry[]>;
  /**
   * The branch (as `refs/heads/<name>`) a detached worktree is in the middle of rebasing or bisecting, or null.
   * Reads `rebase-merge/head-name`, `rebase-apply/head-name`, and `BISECT_START` from the worktree's git directory.
   */
  operationBranch(worktree: string): Promise<string | null>;
  /** Sets `ref` to `newSha` only if it still is `oldSha`. */
  updateRef(path: string, ref: string, newSha: string, oldSha: string): Promise<void>;
  originUrl(path: string): Promise<string>;
  worktreePaths(path: string): Promise<string[]>;
  statusPorcelain(worktree: string): Promise<string>;
  revParse(path: string, ref: string): Promise<string | null>;
  isIgnored(path: string, relPath: string): Promise<boolean>;
  isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean>;
  /** Content of `file` at `ref`, or null when the ref has no such file. */
  showFile(path: string, ref: string, file: string): Promise<string | null>;
  fetch(path: string, repo: string): Promise<void>;
  worktreeAdd(path: string, worktree: string, plan: Exclude<WorktreePlan, { kind: "reuse" }>): Promise<void>;
  worktreeRemove(path: string, worktree: string): Promise<void>;
  /** Fast-forwards the checked-out branch to `ref`; fails instead of merging. */
  mergeFfOnly(path: string, ref: string): Promise<void>;
  /**
   * Merges `origin/<base>` into the worktree's branch with a poller-authored commit.
   * "conflict" leaves the worktree clean (merge aborted); "uptodate" means nothing to merge.
   */
  mergeBase(worktree: string, ref: string): Promise<"merged" | "conflict" | "uptodate">;
  /** Pushes HEAD to `refs/heads/<branch>` of the repo over HTTPS, never forced. */
  push(worktree: string, repo: string, branch: string): Promise<void>;
  /** Resets the worktree's branch and files to `sha` (the poller's own worktree only). */
  resetHard(worktree: string, sha: string): Promise<void>;
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

export interface WorktreeEntry {
  path: string;
  /** `refs/heads/<name>`, or null when detached. */
  branch: string | null;
  /** `git worktree lock` is set (a reason may follow it): never removed. */
  locked: boolean;
}

/** Entries of `git worktree list --porcelain`: `worktree <path>`, `branch refs/heads/<name>` unless detached, `locked`. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const worktrees: WorktreeEntry[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) worktrees.push({ path: line.slice("worktree ".length), branch: null, locked: false });
    else if (worktrees.length === 0) continue;
    else if (line.startsWith("branch ")) worktrees[worktrees.length - 1].branch = line.slice("branch ".length);
    else if (line === "locked" || line.startsWith("locked ")) worktrees[worktrees.length - 1].locked = true;
  }
  return worktrees;
}

export function createGit(run: Exec = defaultExec): Git {
  async function git(args: string[], timeoutMs = GIT_TIMEOUT_MS) {
    // Trust exactly the directory git is pointed at (never "*"), so ownership quirks
    // on the mounted checkout or its worktrees cannot fail poller calls.
    const dir = args[args.indexOf("-C") + 1];
    const trusted = args.includes("-C") ? ["-c", `safe.directory=${dir}`] : [];
    const result = await run(["git", ...trusted, ...HARDENING_ARGS, ...args], { timeoutMs });
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
    async topLevel(path) {
      const result = await git(["-C", path, "rev-parse", "--show-toplevel"]);
      return result.code === 0 ? result.stdout.trim() : null;
    },
    async commonGitDir(path) {
      return resolve(path, (await ok(["-C", path, "rev-parse", "--git-common-dir"])).trim());
    },
    async clone(repo, path) {
      if (!REPO_PATTERN.test(repo)) throw new GitError("git clone refused: invalid repo name");
      if (!path.startsWith("/") || resolve(path) !== path) {
        throw new GitError("git clone refused: path must be absolute and normalized (no `..`, `.`, or trailing slash)");
      }
      await ok([...GH_CREDENTIAL_ARGS, "clone", "--", `https://github.com/${repo}.git`, path], CLONE_TIMEOUT_MS);
    },
    async worktreeBranches(path) {
      return parseWorktreeList(await ok(["-C", path, "worktree", "list", "--porcelain"]));
    },
    async updateRef(path, ref, newSha, oldSha) {
      if (!HEAD_REF_PATTERN.test(ref)) throw new GitError("git update-ref refused: invalid ref");
      if (!SHA_PATTERN.test(newSha) || !SHA_PATTERN.test(oldSha)) throw new GitError("git update-ref refused: invalid commit id");
      await ok(["-C", path, "update-ref", ref, newSha, oldSha]);
    },
    async operationBranch(worktree) {
      const gitDir = (await ok(["-C", worktree, "rev-parse", "--absolute-git-dir"])).trim();
      for (const file of ["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"]) {
        let text: string;
        try {
          text = (await readFile(`${gitDir}/${file}`, "utf8")).trim();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (text !== "") return text.startsWith("refs/") ? text : `refs/heads/${text}`;
      }
      return null;
    },
    async originUrl(path) {
      return (await ok(["-C", path, "remote", "get-url", "origin"])).trim();
    },
    async worktreePaths(path) {
      return parseWorktreeList(await ok(["-C", path, "worktree", "list", "--porcelain"])).map((w) => w.path);
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
    async isAncestor(path, ancestor, descendant) {
      // merge-base --is-ancestor: exit 0 = yes, 1 = no, anything else = error.
      const result = await git(["-C", path, "merge-base", "--is-ancestor", ancestor, descendant]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new GitError(`git merge-base failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
    },
    async showFile(path, ref, file) {
      // ls-tree tells "absent" (empty output) apart from a bad ref (error).
      const listed = await ok(["-C", path, "ls-tree", "--name-only", ref, "--", file]);
      if (listed.trim() === "") return null;
      return ok(["-C", path, "show", `${ref}:${file}`]);
    },
    async fetch(path, repo) {
      if (!REPO_PATTERN.test(repo)) throw new GitError("git fetch refused: invalid repo name");
      // HTTPS regardless of origin's URL form: the container has no ssh.
      try {
        await ok(
          [
            ...GH_CREDENTIAL_ARGS, "-C", path, "fetch", "--prune",
            `https://github.com/${repo}.git`, "+refs/heads/*:refs/remotes/origin/*",
          ],
          FETCH_TIMEOUT_MS,
        );
      } catch (error) {
        throw error instanceof GitError ? new FetchError(error.message) : error;
      }
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
    async mergeFfOnly(path, ref) {
      // Without these flags git on the mounted checkout reports local changes on a clean tree.
      await ok([...CTIME_ARGS, "-C", path, "merge", "--ff-only", ref]);
    },
    async mergeBase(worktree, ref) {
      if (!BASE_REF_PATTERN.test(ref)) throw new GitError("git merge refused: invalid base ref");
      const identity = [
        "-c", `user.name=${POLLER_GIT_IDENTITY.name}`, "-c", `user.email=${POLLER_GIT_IDENTITY.email}`,
      ];
      const before = (await git(["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
      const merge = await git([...identity, ...CTIME_ARGS, "-C", worktree, "merge", "--no-edit", ref]);
      if (merge.code === 0) {
        const after = (await git(["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
        return after === before ? "uptodate" : "merged";
      }
      // Leave no half-done merge behind, whatever went wrong.
      await git(["-C", worktree, "merge", "--abort"]);
      if (merge.code === 1 && /CONFLICT|Automatic merge failed/.test(merge.stdout)) return "conflict";
      throw new GitError(`git merge failed (exit ${merge.code}): ${merge.stderr.trim().slice(0, 200)}`);
    },
    async push(worktree, repo, branch) {
      if (!REPO_PATTERN.test(repo)) throw new GitError("git push refused: invalid repo name");
      if (!BRANCH_PATTERN.test(branch)) throw new GitError("git push refused: invalid branch name");
      await ok(
        [
          ...GH_CREDENTIAL_ARGS, "-C", worktree, "push",
          `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`,
        ],
        FETCH_TIMEOUT_MS,
      );
    },
    async resetHard(worktree, sha) {
      if (!SHA_PATTERN.test(sha)) throw new GitError("git reset refused: invalid commit id");
      await ok(["-C", worktree, "reset", "--hard", sha]);
    },
    async branchDelete(path, branch) {
      await ok(["-C", path, "branch", "-D", branch]);
    },
  };
}
