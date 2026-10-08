export interface Config {
  linearApiKey: string;
  team: string;
  pollIntervalMs: number;
  opencodeUrl: string;
  timeoutWorkMs: number;
  timeoutReviewMs: number;
  timeoutInvestigateMs: number;
  reviewRetryMs: number;
  once: boolean;
  dryRun: boolean;
}

export class ConfigError extends Error {}

const MINUTE = 60_000;
const SECOND = 1_000;

function positiveNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
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
    timeoutWorkMs: positiveNumber(env, "KANBAN_TIMEOUT_WORK", 60) * MINUTE,
    timeoutReviewMs: positiveNumber(env, "KANBAN_TIMEOUT_REVIEW", 20) * MINUTE,
    timeoutInvestigateMs: positiveNumber(env, "KANBAN_TIMEOUT_INVESTIGATE", 20) * MINUTE,
    reviewRetryMs: positiveNumber(env, "KANBAN_REVIEW_RETRY", 10) * MINUTE,
    once: flags.includes("--once"),
    dryRun: flags.includes("--dry-run"),
  };
}
