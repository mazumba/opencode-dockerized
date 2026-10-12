// GitHub access through the `gh` CLI (a wrapper on PATH mints GitHub App tokens).
// Never logs tokens, JWTs, or log contents.
import { exec as defaultExec, type Exec } from "./exec.ts";
import { log } from "./log.ts";
import type { Check, CheckBucket, PrInfo, PrState } from "./select.ts";

const GH_TIMEOUT_MS = 60_000;
const APP_TOKEN_BIN = "/usr/local/lib/opencode/github/gh-app-token";
const INSTALLATIONS_URL = "https://api.github.com/app/installations";
const MAX_FAILED_RUNS = 3;
const DEFAULT_LOG_LINES = 150;

export class GitHubError extends Error {}

export interface Gh {
  findPr(repo: string, branch: string): Promise<PrInfo | null>;
  checks(repo: string, pr: number): Promise<Check[]>;
  failedLogTail(repo: string, pr: PrInfo, maxLines?: number): Promise<string>;
  defaultBranch(repo: string): Promise<string>;
}

const PR_STATES: PrState[] = ["OPEN", "CLOSED", "MERGED"];
const BUCKETS: CheckBucket[] = ["pass", "fail", "pending", "skipping", "cancel"];

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubError(`${what}: output is not JSON`);
  }
}

/** Prefers an OPEN PR (newest first), else the most recent one. */
export function parsePrList(json: unknown): PrInfo | null {
  if (!Array.isArray(json)) throw new GitHubError("pr list: unexpected output");
  const prs: PrInfo[] = json.map((raw) => ({
    number: Number(raw.number),
    url: String(raw.url),
    state: PR_STATES.includes(raw.state) ? raw.state : "CLOSED",
    mergeable: raw.mergeable === "MERGEABLE" || raw.mergeable === "CONFLICTING" ? raw.mergeable : "UNKNOWN",
    baseRefName: String(raw.baseRefName),
    headRefOid: String(raw.headRefOid),
  }));
  const newestFirst = [...prs].sort((a, b) => b.number - a.number);
  return newestFirst.find((p) => p.state === "OPEN") ?? newestFirst[0] ?? null;
}

export function parseChecks(json: unknown): Check[] {
  if (!Array.isArray(json)) throw new GitHubError("pr checks: unexpected output");
  return json.map((raw) => ({
    name: String(raw.name),
    // An unknown bucket must not read as green.
    bucket: BUCKETS.includes(raw.bucket) ? raw.bucket : "pending",
  }));
}

export function tailLines(text: string, maxLines: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-maxLines).join("\n");
}

export function createGh(run: Exec = defaultExec): Gh {
  async function gh(args: string[]) {
    const result = await run(["gh", ...args], { timeoutMs: GH_TIMEOUT_MS });
    if (result.timedOut) throw new GitHubError(`gh ${args[0]} ${args[1]} timed out`);
    return result;
  }
  async function ghJson(args: string[]): Promise<unknown> {
    const result = await gh(args);
    if (result.code !== 0) {
      throw new GitHubError(`gh ${args[0]} ${args[1]} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
    }
    return parseJson(result.stdout, `gh ${args[0]} ${args[1]}`);
  }

  return {
    async findPr(repo, branch) {
      return parsePrList(
        await ghJson([
          "pr", "list", "--repo", repo, "--head", branch, "--state", "all",
          "--json", "number,url,state,mergeable,baseRefName,headRefOid",
        ]),
      );
    },

    async checks(repo, pr) {
      // gh exits 8 while checks are pending and 1 when some failed; stdout is still JSON.
      const result = await gh(["pr", "checks", String(pr), "--repo", repo, "--json", "name,bucket"]);
      const stdout = result.stdout.trim();
      if (stdout.startsWith("[")) return parseChecks(parseJson(stdout, "gh pr checks"));
      if (/no checks reported/i.test(result.stderr) || /no checks reported/i.test(stdout)) return [];
      throw new GitHubError(`gh pr checks failed (exit ${result.code}): ${result.stderr.trim().slice(0, 200)}`);
    },

    async failedLogTail(repo, pr, maxLines = DEFAULT_LOG_LINES) {
      try {
        const runs = (await ghJson([
          "run", "list", "--repo", repo, "--commit", pr.headRefOid, "--json", "databaseId,conclusion",
        ])) as { databaseId: number; conclusion: string }[];
        const failed = runs.filter((r) => r.conclusion === "failure").slice(0, MAX_FAILED_RUNS);
        const parts: string[] = [];
        for (const { databaseId } of failed) {
          const result = await gh(["run", "view", String(databaseId), "--repo", repo, "--log-failed"]);
          if (result.code === 0) parts.push(result.stdout);
        }
        return tailLines(parts.join("\n"), maxLines);
      } catch (error) {
        log("github.log-tail.error", { pr: pr.number, message: (error as Error).message });
        return "";
      }
    },

    async defaultBranch(repo) {
      const json = (await ghJson(["repo", "view", repo, "--json", "defaultBranchRef"])) as {
        defaultBranchRef?: { name?: string } | null;
      };
      const name = json.defaultBranchRef?.name;
      if (!name) throw new GitHubError(`repo ${repo} has no default branch`);
      return name;
    },
  };
}

// ── App installation discovery (the poller container skips the github entrypoint) ──

interface InstallationDeps {
  env: Record<string, string | undefined>;
  run: Exec;
  fetchInstallations: (jwt: string) => Promise<unknown>;
  cacheExists: (path: string) => Promise<boolean>;
}

const defaultDeps = (): InstallationDeps => ({
  env: process.env,
  run: defaultExec,
  cacheExists: (path) => Bun.file(path).exists(),
  fetchInstallations: async (jwt) => {
    const response = await fetch(INSTALLATIONS_URL, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
    if (!response.ok) throw new GitHubError(`GET /app/installations failed: HTTP ${response.status}`);
    return response.json();
  },
});

/**
 * Makes sure gh-app-token can find the installation id: via GH_APP_INSTALLATION_ID,
 * the entrypoint's cache file, or (once) by asking GitHub. Sets the env var for children.
 */
export async function ensureInstallationId(deps: InstallationDeps = defaultDeps()): Promise<void> {
  const { env } = deps;
  if (env.GH_APP_INSTALLATION_ID) return;
  const cache = `${env.HOME || "/home/opencode"}/.cache/gh-app/installation.json`;
  if (await deps.cacheExists(cache)) return;

  const jwt = await deps.run([APP_TOKEN_BIN, "--jwt"], { timeoutMs: GH_TIMEOUT_MS });
  if (jwt.code !== 0 || !jwt.stdout.trim()) {
    throw new GitHubError(`gh-app-token --jwt failed: ${jwt.stderr.trim().slice(0, 200)}`);
  }
  let installations: unknown;
  try {
    installations = await deps.fetchInstallations(jwt.stdout.trim());
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError(`GET /app/installations failed: ${(error as Error).name}`);
  }
  const list = Array.isArray(installations) ? installations : [];
  if (list.length !== 1 || typeof list[0]?.id !== "number") {
    throw new GitHubError(
      `found ${list.length} GitHub App installations; set KANBAN_GH_APP_INSTALLATION_ID`,
    );
  }
  env.GH_APP_INSTALLATION_ID = String(list[0].id);
  log("github.installation", { id: list[0].id });
}
