// The gh wrapper on PATH mints installation tokens. Never expose CLI stderr.
import { exec as defaultExec, type Exec } from "./exec.ts";
import { log } from "./log.ts";
import type { Comment } from "./select.ts";

const GH_TIMEOUT_MS = 60_000;
const APP_TOKEN_BIN = "/usr/local/lib/opencode/github/gh-app-token";
const INSTALLATIONS_URL = "https://api.github.com/app/installations";
export class GitHubError extends Error {}
export interface Pull {
  state: string;
  merged: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  maintainer_can_modify: boolean;
}

export function createGh(dryRun: boolean, run: Exec = defaultExec) {
  async function api(path: string, args: string[] = []): Promise<unknown> {
    const result = await run(["gh", "api", ...args, path], { timeoutMs: GH_TIMEOUT_MS });
    if (result.timedOut) throw new GitHubError("GitHub request timed out");
    if (result.code !== 0) throw new GitHubError(`GitHub request failed (exit ${result.code})`);
    try { return JSON.parse(result.stdout); } catch { throw new GitHubError("GitHub returned invalid JSON"); }
  }
  // --slurp preserves page boundaries even for the installation's object response.
  async function pages(path: string): Promise<unknown[]> {
    const value = await api(path, ["--paginate", "--slurp"]);
    if (!Array.isArray(value)) throw new GitHubError("GitHub pagination returned unexpected data");
    return value;
  }
  async function list<T>(path: string): Promise<T[]> {
    const result = await pages(path);
    if (!result.every(Array.isArray)) throw new GitHubError("GitHub list returned unexpected data");
    return result.flat() as T[];
  }
  // Every GitHub mutation, including failure replies, goes through this guard.
  async function write(action: string, path: string, fields: string[]): Promise<void> {
    if (dryRun) { log(`dry-run.${action}`, { path }); return; }
    await api(path, ["-X", "POST", ...fields]);
  }
  return {
    async repos(): Promise<{ full_name: string; archived: boolean }[]> {
      const result = await pages("/installation/repositories?per_page=100");
      return result.flatMap((page) => {
        if (!page || typeof page !== "object" || !("repositories" in page) || !Array.isArray(page.repositories)) {
          throw new GitHubError("GitHub repository list returned unexpected data");
        }
        return page.repositories;
      });
    },
    comments: (repo: string, since: string) => list<Comment>(`/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`),
    async hasEyes(repo: string, id: number, botLogin: string): Promise<boolean> {
      const reactions = await list<{ user: { login: string }; content: string }>(`/repos/${repo}/issues/comments/${id}/reactions?content=eyes&per_page=100`);
      return reactions.some((reaction) => reaction.content === "eyes" && reaction.user.login.toLowerCase() === botLogin.toLowerCase());
    },
    async role(repo: string, login: string): Promise<string> {
      const result = await api(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`) as { role_name?: string };
      if (typeof result.role_name !== "string") throw new GitHubError("GitHub permission returned no role_name");
      return result.role_name;
    },
    pull: async (repo: string, pr: number) => await api(`/repos/${repo}/pulls/${pr}`) as Pull,
    eyes: (repo: string, id: number) => write("eyes", `/repos/${repo}/issues/comments/${id}/reactions`, ["-f", "content=eyes"]),
    reply: (repo: string, pr: number, body: string) => write("reply", `/repos/${repo}/issues/${pr}/comments`, ["-f", `body=${body}`]),
    async hasReply(repo: string, pr: number, trigger: Comment, botLogin: string): Promise<boolean> {
      const comments = await list<Comment>(`/repos/${repo}/issues/${pr}/comments?since=${encodeURIComponent(trigger.created_at)}&per_page=100`);
      return comments.some((comment) => comment.id !== trigger.id
        && comment.user.login.toLowerCase() === botLogin.toLowerCase()
        && (Date.parse(comment.created_at) > Date.parse(trigger.created_at)
          || (Date.parse(comment.created_at) === Date.parse(trigger.created_at) && comment.id > trigger.id)));
    },
  };
}

// App discovery uses a JWT because installation tokens cannot read GET /app.
export async function fetchApp(jwt: string, send: typeof fetch = fetch): Promise<unknown> {
  const response = await send("https://api.github.com/app", {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(GH_TIMEOUT_MS),
  });
  if (!response.ok) throw new GitHubError(`GET /app failed: HTTP ${response.status}`);
  return response.json();
}

export async function resolveBotIdentity(
  overrides: { handle?: string; botLogin?: string },
  deps: { run: Exec; fetchApp: (jwt: string) => Promise<unknown> } = { run: defaultExec, fetchApp },
): Promise<{ handle: string; botLogin: string }> {
  if (overrides.handle && overrides.botLogin) return { handle: overrides.handle, botLogin: overrides.botLogin };
  const jwt = await deps.run([APP_TOKEN_BIN, "--jwt"], { timeoutMs: GH_TIMEOUT_MS });
  if (jwt.code !== 0 || jwt.timedOut || !jwt.stdout.trim()) throw new GitHubError("gh-app-token --jwt failed");
  let app: unknown;
  try { app = await deps.fetchApp(jwt.stdout.trim()); }
  catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError("GET /app failed: missing slug");
  }
  const slug = app && typeof app === "object" && "slug" in app ? app.slug : undefined;
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new GitHubError("GET /app failed: missing slug");
  return { handle: overrides.handle || `@${slug}`, botLogin: overrides.botLogin || `${slug}[bot]` };
}

// The sidecar bypasses the github entrypoint, so discover the installation when needed.
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
export async function ensureInstallationId(deps: InstallationDeps = defaultDeps()): Promise<void> {
  const { env } = deps;
  if (env.GH_APP_INSTALLATION_ID) return;
  const cache = `${env.HOME || "/home/opencode"}/.cache/gh-app/installation.json`;
  if (await deps.cacheExists(cache)) return;
  const jwt = await deps.run([APP_TOKEN_BIN, "--jwt"], { timeoutMs: GH_TIMEOUT_MS });
  if (jwt.code !== 0 || jwt.timedOut || !jwt.stdout.trim()) throw new GitHubError("gh-app-token --jwt failed");
  let installations: unknown;
  try { installations = await deps.fetchInstallations(jwt.stdout.trim()); }
  catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError(`GET /app/installations failed: ${(error as Error).name}`);
  }
  const list = Array.isArray(installations) ? installations : [];
  if (list.length !== 1 || typeof list[0]?.id !== "number") {
    throw new GitHubError(`found ${list.length} GitHub App installations; set GH_APP_INSTALLATION_ID`);
  }
  env.GH_APP_INSTALLATION_ID = String(list[0].id);
  log("github.installation", { id: list[0].id });
}
