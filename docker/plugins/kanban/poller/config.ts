export interface Config {
  linearApiKey: string;
  team: string;
  pollIntervalMs: number;
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword: string;
  maxAutomated: number;
  /** Parent of the default checkouts (`<root>/<repo name>`); null when projects must give a `path:`. */
  projectsRoot: string | null;
  timeoutWorkMs: number;
  timeoutReviewMs: number;
  timeoutInvestigateMs: number;
  ciPendingTimeoutMs: number;
  once: boolean;
  dryRun: boolean;
}

export class ConfigError extends Error {}

const MINUTE = 60_000;
const SECOND = 1_000;
const DEFAULT_CI_PENDING_TIMEOUT_MIN = 30;
const DEFAULT_MAX_AUTOMATED = 3;

function positiveNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = positiveNumber(env, name, fallback);
  if (!Number.isInteger(value)) throw new ConfigError(`${name} must be a positive integer, got "${env[name]}"`);
  return value;
}

function projectsRoot(env: Record<string, string | undefined>): string | null {
  const raw = env.KANBAN_PROJECTS_ROOT;
  if (raw === undefined || raw === "") return null;
  if (!/^\/[^\0-\x1f]*$/.test(raw)) throw new ConfigError(`KANBAN_PROJECTS_ROOT must be an absolute path, got "${raw}"`);
  return raw.replace(/\/+$/, "") || "/";
}

export function loadConfig(env: Record<string, string | undefined>, argv: string[]): Config {
  const missing = ["LINEAR_API_KEY", "OPENCODE_SERVER_PASSWORD"].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment variable(s): ${missing.join(", ")}`);
  }
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const unknown = flags.filter((flag) => flag !== "--once" && flag !== "--dry-run");
  if (unknown.length > 0) throw new ConfigError(`unknown argument(s): ${unknown.join(", ")}`);

  return {
    linearApiKey: env.LINEAR_API_KEY as string,
    team: env.KANBAN_TEAM || "DEY",
    pollIntervalMs: positiveNumber(env, "KANBAN_POLL_INTERVAL", 60) * SECOND,
    opencodeUrl: env.KANBAN_OPENCODE_URL || "http://opencode:4096",
    opencodeUsername: env.OPENCODE_SERVER_USERNAME || "opencode",
    opencodePassword: env.OPENCODE_SERVER_PASSWORD as string,
    projectsRoot: projectsRoot(env),
    maxAutomated: positiveInteger(env, "KANBAN_MAX_AUTOMATED", DEFAULT_MAX_AUTOMATED),
    timeoutWorkMs: positiveNumber(env, "KANBAN_TIMEOUT_WORK", 60) * MINUTE,
    timeoutReviewMs: positiveNumber(env, "KANBAN_TIMEOUT_REVIEW", 20) * MINUTE,
    timeoutInvestigateMs: positiveNumber(env, "KANBAN_TIMEOUT_INVESTIGATE", 20) * MINUTE,
    ciPendingTimeoutMs: positiveNumber(env, "KANBAN_CI_PENDING_TIMEOUT", DEFAULT_CI_PENDING_TIMEOUT_MIN) * MINUTE,
    once: flags.includes("--once"),
    dryRun: flags.includes("--dry-run"),
  };
}
