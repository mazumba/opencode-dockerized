import { isAbsolute, resolve } from "node:path";

export class ConfigError extends Error {}
export interface Config {
  handle: string;
  botLogin: string;
  allowedUsers: string[];
  allowedRoles: string[];
  projectsRoot: string;
  pollIntervalMs: number;
  lookbackMs: number;
  timeoutMs: number;
  maxConcurrent: number;
  opencodeUrl: string;
  username: string;
  password: string;
  once: boolean;
  dryRun: boolean;
}
export type StartupConfig = Omit<Config, "handle" | "botLogin"> & { handle?: string; botLogin?: string };

export function loadConfig(env: Record<string, string | undefined>, argv: string[]): StartupConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`missing required environment variable: ${name}`);
    return value;
  };
  const list = (name: string, fallback?: string): string[] => {
    const values = (env[name] ?? fallback ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!values.length) throw new ConfigError(`${name} must be a non-empty comma list`);
    return [...new Set(values)];
  };
  const number = (name: string, fallback: number): number => {
    const value = Number(env[name] || fallback);
    if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number`);
    return value;
  };
  if (argv.some((arg) => arg !== "--once" && arg !== "--dry-run")) throw new ConfigError("unknown argument (use --help)");
  const handle = env.MENTION_HANDLE?.trim() || undefined;
  if (handle && !/^@[a-z0-9][a-z0-9-]*$/i.test(handle)) throw new ConfigError("MENTION_HANDLE must be @<GitHub login>");
  const botLogin = env.MENTION_BOT_LOGIN?.trim() || undefined;
  if (botLogin && !/^[a-z0-9][a-z0-9-]*\[bot\]$/i.test(botLogin)) throw new ConfigError("MENTION_BOT_LOGIN must be <app-slug>[bot]");
  const root = required("MENTION_PROJECTS_ROOT");
  if (!isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)) throw new ConfigError("MENTION_PROJECTS_ROOT must be an absolute path");
  const maxConcurrent = number("MENTION_MAX_CONCURRENT", 2);
  if (!Number.isInteger(maxConcurrent)) throw new ConfigError("MENTION_MAX_CONCURRENT must be an integer");
  const opencodeUrl = env.MENTION_OPENCODE_URL || "http://opencode:4096";
  if (!["http:", "https:"].includes(new URL(opencodeUrl).protocol)) throw new ConfigError("MENTION_OPENCODE_URL must be HTTP(S)");
  return {
    handle, botLogin, allowedUsers: list("MENTION_ALLOWED_USERS"),
    allowedRoles: list("MENTION_ALLOWED_ROLES", "admin,maintain"), projectsRoot: resolve(root),
    pollIntervalMs: number("MENTION_POLL_INTERVAL", 60) * 1_000,
    lookbackMs: number("MENTION_LOOKBACK_HOURS", 24) * 3_600_000,
    timeoutMs: number("MENTION_TIMEOUT", 45) * 60_000, maxConcurrent, opencodeUrl,
    username: env.OPENCODE_SERVER_USERNAME || "opencode", password: required("OPENCODE_SERVER_PASSWORD"),
    once: argv.includes("--once"), dryRun: argv.includes("--dry-run"),
  };
}
