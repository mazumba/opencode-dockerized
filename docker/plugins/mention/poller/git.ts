// Detached worktrees only. The main checkout's branch and working files are never changed.
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exec as defaultExec, type Exec } from "./exec.ts";
import { cleanupDecision, excludeAppend, REPO_PATTERN, validRef, type CleanupDecision, type CleanupFacts } from "./select.ts";

const GH_CREDENTIAL_ARGS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const HARDENING_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
export class GitError extends Error {}
export interface PreparedWorktree {
  worktree: string;
  headSha: string;
  baseSha: string;
  /** Whether a reused worktree held an interrupted rebase or uncommitted changes that were discarded. */
  discarded: boolean;
}
export interface CleanupEntry {
  pr: number;
  path: string;
  error?: unknown;
}
export interface CleanupResult {
  decision: CleanupDecision;
  saved: number;
}
// Cleanup never follows symlinks, including the checkout and either worktree parent.
async function realDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GitError("expected a real directory, not a file or symlink");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function originRepo(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/i.exec(url);
  return match ? match[1].replace(/\.git$/i, "").toLowerCase() : null;
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
const sleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new GitError("poller stopped")); return; }
  const onAbort = () => { clearTimeout(timer); reject(new GitError("poller stopped")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

export function createGit(run: Exec = defaultExec, wait: Sleep = sleep) {
  async function gitResult(path: string | null, args: string[], timeoutMs = 60_000) {
    const location = path ? ["-c", `safe.directory=${path}`, "-C", path] : [];
    const result = await run(["git", ...GH_CREDENTIAL_ARGS, ...HARDENING_ARGS, ...location, ...args], { timeoutMs });
    if (result.timedOut) throw new GitError(`git ${args[0]} timed out`);
    return result;
  }
  async function git(path: string | null, args: string[], timeoutMs = 60_000): Promise<string> {
    const result = await gitResult(path, args, timeoutMs);
    if (result.code !== 0) throw new GitError(`git ${args[0]} failed (exit ${result.code})`);
    return result.stdout.trim();
  }
  async function fetchWithRetry(path: string, args: string[], signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new GitError("poller stopped");
      try {
        await git(path, args, 180_000);
        if (signal?.aborted) throw new GitError("poller stopped");
        return;
      } catch (error) {
        if (signal?.aborted) throw new GitError("poller stopped");
        if (attempt === 1) throw error instanceof GitError ? error : new GitError("git fetch failed");
        await wait(2_000, signal);
      }
    }
  }
  async function rebaseInProgress(worktree: string): Promise<boolean> {
    for (const name of ["rebase-merge", "rebase-apply"]) {
      const path = resolve(worktree, await git(worktree, ["rev-parse", "--git-path", name]));
      try { await lstat(path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return false;
  }
  /** Quits an interrupted rebase (HEAD stays), then drops uncommitted and untracked, non-ignored files. */
  async function discardLeftovers(worktree: string): Promise<boolean> {
    const rebasing = await rebaseInProgress(worktree);
    if (rebasing) await git(worktree, ["rebase", "--quit"]);
    const dirty = (await git(worktree, ["status", "--porcelain", "--untracked-files=all"])) !== "";
    if (dirty) {
      await git(worktree, ["reset", "--hard"]);
      await git(worktree, ["clean", "-fd"]);
    }
    return rebasing || dirty;
  }
  // Serialize checkout-level mutations, including clone/exclude/fetch, across PRs of one repo.
  const locks = new Map<string, Promise<void>>();
  async function serialized<T>(path: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(path) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((done) => { unlock = done; });
    locks.set(path, current);
    await previous;
    try { return await action(); }
    finally { unlock(); if (locks.get(path) === current) locks.delete(path); }
  }
  return {
    async cleanupEntries(root: string, repo: string): Promise<CleanupEntry[]> {
      if (!REPO_PATTERN.test(repo)) throw new GitError("invalid repository");
      const checkout = join(root, repo.split("/")[1]);
      return serialized(checkout, async () => {
        for (const path of [checkout, join(checkout, ".slim"), join(checkout, ".slim", "worktrees")]) {
          if (!(await realDirectory(path))) return [];
        }
        const parent = join(checkout, ".slim", "worktrees");
        const entries: CleanupEntry[] = [];
        for (const name of (await readdir(parent)).sort()) {
          const match = /^mention-pr-([1-9]\d*)$/.exec(name);
          if (!match || !Number.isSafeInteger(Number(match[1]))) continue;
          const entry = { pr: Number(match[1]), path: join(parent, name) };
          try {
            if (await realDirectory(entry.path)) entries.push(entry);
          } catch (error) { entries.push({ ...entry, error }); }
        }
        return entries;
      });
    },
    async cleanup(root: string, repo: string, pr: number, state: Pick<CleanupFacts, "prState" | "merged" | "liveJob" | "dryRun">, signal?: AbortSignal): Promise<CleanupResult> {
      if (!REPO_PATTERN.test(repo) || !Number.isSafeInteger(pr) || pr <= 0) throw new GitError("invalid repository or PR number");
      const checkout = join(root, repo.split("/")[1]);
      return serialized(checkout, async () => {
        const facts: CleanupFacts = { ...state, registered: false, dirty: false, ancestor: "unknown" };
        const result = (): CleanupResult => ({ decision: cleanupDecision(facts), saved: 0 });
        if (state.liveJob || (state.prState === "open" && !state.merged)) return result();
        const path = join(checkout, ".slim", "worktrees", `mention-pr-${pr}`);
        for (const directory of [checkout, join(checkout, ".slim"), join(checkout, ".slim", "worktrees"), path]) {
          if (!(await realDirectory(directory))) throw new GitError("cleanup path is not a real directory");
        }
        // Repo names can collide across owners; never clean another repository's checkout.
        if (await realpath(checkout) !== await git(checkout, ["rev-parse", "--show-toplevel"])) throw new GitError("checkout is not a repository root");
        if (originRepo(await git(checkout, ["remote", "get-url", "origin"])) !== repo.toLowerCase()) throw new GitError("checkout origin is a different repository");
        facts.registered = (await git(checkout, ["worktree", "list", "--porcelain", "-z"]))
          .split("\0").some((entry) => entry === `worktree ${path}`);
        if (!facts.registered) return result();
        facts.dirty = (await git(path, ["status", "--porcelain", "--untracked-files=all"])) !== "";
        if (facts.dirty) return result();
        const ref = `refs/mention/pull/${pr}`;
        if (state.dryRun) {
          const local = await gitResult(checkout, ["show-ref", "--verify", "--quiet", ref]);
          if (local.code === 1) return result();
          if (local.code !== 0) throw new GitError(`git show-ref failed (exit ${local.code})`);
        } else {
          await fetchWithRetry(checkout, ["fetch", "--no-recurse-submodules", `https://github.com/${repo}.git`, `+refs/pull/${pr}/head:${ref}`], signal);
        }
        const ancestry = await gitResult(path, ["merge-base", "--is-ancestor", "HEAD", ref]);
        if (ancestry.code !== 0 && ancestry.code !== 1) throw new GitError(`git merge-base failed (exit ${ancestry.code})`);
        facts.ancestor = ancestry.code === 0;
        const decision = cleanupDecision(facts);
        if (decision.action !== "remove" || state.dryRun) return { decision, saved: 0 };
        try { await git(checkout, ["worktree", "remove", path]); }
        catch { return { decision: { action: "skip", reason: "worktree remove failed" }, saved: 0 }; }
        await git(checkout, ["update-ref", "-d", ref]);
        const saved = await git(checkout, ["for-each-ref", "--format=%(refname)", `refs/mention/saved/pr-${pr}/`]);
        return { decision, saved: saved === "" ? 0 : saved.split("\n").length };
      });
    },
    async prepare(root: string, repo: string, pr: number, headRef: string, baseRef: string, pushable: boolean, signal?: AbortSignal): Promise<PreparedWorktree> {
      if (!validRef(baseRef)) throw new GitError("invalid base ref");
      if (!REPO_PATTERN.test(repo) || !validRef(headRef) || !Number.isSafeInteger(pr) || pr <= 0) throw new GitError("invalid repository, PR number, or head ref");
      const checkout = join(root, repo.split("/")[1]);
      return serialized(checkout, async () => {
        const checkStopped = () => { if (signal?.aborted) throw new GitError("poller stopped"); };
        checkStopped();
        await mkdir(root, { recursive: true });
        if (!(await exists(checkout)) || (await readdir(checkout)).length === 0) {
          await git(null, ["clone", "--", `https://github.com/${repo}.git`, checkout], 600_000);
        }
        checkStopped();
        if (await realpath(checkout) !== await git(checkout, ["rev-parse", "--show-toplevel"])) throw new GitError("checkout is not a repository root");
        const origin = await git(checkout, ["remote", "get-url", "origin"]);
        if (originRepo(origin) !== repo.toLowerCase()) throw new GitError("checkout origin is a different repository");
        // Network calls use the HTTPS URL explicitly, without changing the user's origin config.
        const common = resolve(checkout, await git(checkout, ["rev-parse", "--git-common-dir"]));
        const exclude = join(common, "info", "exclude");
        let content: string | null = null;
        try { content = await readFile(exclude, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const updated = excludeAppend(content);
        if (updated !== null) { await mkdir(dirname(exclude), { recursive: true }); await writeFile(exclude, updated); }
        // Explicit remote destination, no local branch updates and no reliance on FETCH_HEAD.
        const target = pushable ? `refs/remotes/origin/${headRef}` : `refs/mention/pull/${pr}`;
        const source = pushable ? `refs/heads/${headRef}` : `refs/pull/${pr}/head`;
        const baseTarget = `refs/remotes/origin/${baseRef}`;
        const refspecs = [...new Set([`+${source}:${target}`, `+refs/heads/${baseRef}:${baseTarget}`])];
        checkStopped();
        await fetchWithRetry(checkout, ["fetch", "--no-recurse-submodules", `https://github.com/${repo}.git`, ...refspecs], signal);
        checkStopped();
        const headSha = await git(checkout, ["rev-parse", target]);
        const baseSha = await git(checkout, ["rev-parse", baseTarget]);
        const parent = join(checkout, ".slim", "worktrees");
        // Reject symlinked poller paths before making directories or touching files.
        await exists(join(checkout, ".slim"));
        await exists(parent);
        await mkdir(parent, { recursive: true });
        const worktree = join(parent, `mention-pr-${pr}`);
        let discarded = false;
        if (await exists(worktree)) {
          const registered = (await git(checkout, ["worktree", "list", "--porcelain", "-z"]))
            .split("\0").some((entry) => entry === `worktree ${worktree}`);
          if (!registered) throw new GitError("worktree directory exists but is not registered");
          // The worktree is poller-owned scratch space: leftovers of an earlier run must not block this one.
          // Commits stay recoverable (saved below); only uncommitted state is discarded.
          discarded = await discardLeftovers(worktree);
          const localHead = await git(worktree, ["rev-parse", "HEAD"]);
          // A previous unpushed agent commit must remain recoverable, even after another mention.
          if (localHead !== headSha) {
            await git(checkout, ["update-ref", `refs/mention/saved/pr-${pr}/${localHead}`, localHead]);
          }
          await git(worktree, ["checkout", "--detach", target]);
        } else {
          await git(checkout, ["worktree", "add", "--detach", worktree, target]);
        }
        return { worktree, headSha, baseSha, discarded };
      });
    },
  };
}
