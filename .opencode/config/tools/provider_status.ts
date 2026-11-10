import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"

// Reports the status of OpenAI-compatible providers from the global opencode config:
// the LiteLLM budget (/key/info) when the proxy exposes it, and per-model availability
// from a 1-token request. Secrets come only from the {env:...}/{file:...} references
// in the config and are never printed.

const COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
const CONFIG_DIR = path.join(homedir(), ".config", "opencode")
const CONFIG_FILES = ["opencode.jsonc", "opencode.json"]
const REQUEST_TIMEOUT_MS = 60_000
const MAX_MESSAGE_CHARS = 200
const SHARED_QUOTA_PATTERN = /Quota exceeded|RESOURCE_EXHAUSTED/i

type ProviderConfig = {
  name?: string
  npm?: string
  options?: { baseURL?: string; apiKey?: string; headers?: Record<string, string> }
  models?: Record<string, unknown>
}

type OpencodeConfig = { provider?: Record<string, ProviderConfig> }

async function loadConfig(): Promise<{ file: string; config: OpencodeConfig }> {
  for (const name of CONFIG_FILES) {
    const file = path.join(CONFIG_DIR, name)
    let raw: string
    try {
      raw = await readFile(file, "utf8")
    } catch {
      continue
    }
    return { file, config: Bun.JSONC.parse(raw) as OpencodeConfig }
  }
  throw new Error(`no ${CONFIG_FILES.join(" or ")} in ${CONFIG_DIR}`)
}

// Mirrors opencode's config substitution for {env:VAR} and {file:path}.
async function resolveValue(value: string): Promise<string> {
  let result = value
  for (const [match, name] of value.matchAll(/\{env:([^}]+)\}/g)) {
    const resolved = process.env[name]
    if (!resolved) throw new Error(`environment variable ${name} is not set`)
    result = result.replace(match, () => resolved)
  }
  for (const [match, filePath] of value.matchAll(/\{file:([^}]+)\}/g)) {
    const absolute = filePath.startsWith("~/")
      ? path.join(homedir(), filePath.slice(2))
      : path.resolve(CONFIG_DIR, filePath)
    let content: string
    try {
      content = (await readFile(absolute, "utf8")).trim()
    } catch {
      throw new Error(`cannot read file ${filePath}`)
    }
    result = result.replace(match, () => content)
  }
  return result
}

async function resolveHeaders(options: NonNullable<ProviderConfig["options"]>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.apiKey) headers.Authorization = `Bearer ${await resolveValue(options.apiKey)}`
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name] = await resolveValue(value)
  }
  return headers
}

function errorMessage(body: string): string {
  let message = body
  try {
    const parsed = JSON.parse(body)
    message = parsed?.error?.message ?? parsed?.detail ?? body
  } catch {
    // Not JSON; use the raw text.
  }
  // Proxies like LiteLLM wrap the upstream error JSON inside their own message string.
  const upstream = String(message).match(/"message":\s*"([^"]+)"/)
  return (upstream ? upstream[1] : String(message)).replace(/\s+/g, " ").slice(0, MAX_MESSAGE_CHARS)
}

async function request(url: string, init: RequestInit): Promise<{ res: Response; body: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  return { res, body: await res.text() }
}

async function budgetLine(baseURL: string, headers: Record<string, string>): Promise<string> {
  const url = `${baseURL.replace(/\/v1\/?$/, "")}/key/info`
  try {
    const { res, body } = await request(url, { headers })
    if (!res.ok) return `Budget: not exposed (/key/info returned ${res.status})`
    const info = JSON.parse(body)?.info ?? {}
    const spend = info.spend ?? "unknown"
    const max = info.max_budget ?? "no limit"
    const reset = info.budget_reset_at ?? "n/a"
    return `Budget: spend ${spend} of ${max} (resets ${reset})`
  } catch (e) {
    return `Budget: request failed (${e instanceof Error ? e.message : String(e)})`
  }
}

async function probeModel(baseURL: string, headers: Record<string, string>, model: string): Promise<string[]> {
  try {
    const { res, body } = await request(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    })
    const lines: string[] = []
    if (res.ok) {
      lines.push("available")
    } else {
      const message = errorMessage(body)
      const label = res.status === 429 ? "throttled (429)" : `error (${res.status})`
      const hint = SHARED_QUOTA_PATTERN.test(body) ? " [likely a shared upstream quota]" : ""
      lines.push(`${label}${hint}: ${message}`)
    }
    for (const [name, value] of res.headers.entries()) {
      if (name.includes("ratelimit") || name === "x-litellm-key-spend") lines.push(`${name}: ${value}`)
    }
    return lines
  } catch (e) {
    return [`request failed: ${e instanceof Error ? e.message : String(e)}`]
  }
}

async function providerReport(id: string, provider: ProviderConfig, models: string[] | undefined): Promise<string> {
  const lines = [`${id}${provider.name ? ` (${provider.name})` : ""}`]
  const baseURL = provider.options?.baseURL
  if (!baseURL) return [...lines, "  error: options.baseURL is not set"].join("\n")

  let headers: Record<string, string>
  try {
    headers = await resolveHeaders(provider.options ?? {})
  } catch (e) {
    return [...lines, `  error: ${e instanceof Error ? e.message : String(e)}`].join("\n")
  }

  const modelIds = models?.length ? models : Object.keys(provider.models ?? {})
  const [budget, probes] = await Promise.all([
    budgetLine(baseURL, headers),
    Promise.all(modelIds.map((model) => probeModel(baseURL, headers, model))),
  ])

  lines.push(`  ${budget}`)
  if (modelIds.length === 0) lines.push("  No models configured; pass `models` to probe specific ones.")
  const width = Math.max(0, ...modelIds.map((m) => m.length))
  modelIds.forEach((model, i) => {
    const [status, ...details] = probes[i]
    lines.push(`  ${model.padEnd(width)}  ${status}`)
    for (const detail of details) lines.push(`  ${" ".repeat(width)}    ${detail}`)
  })
  return lines.join("\n")
}

export default tool({
  description:
    "Check OpenAI-compatible providers from the global opencode config (e.g. LiteLLM proxies): budget from /key/info when exposed, and per-model availability or throttling via a 1-token request. Each run costs a few tokens per model.",
  args: {
    provider: tool.schema
      .string()
      .optional()
      .describe("Provider ID from opencode.jsonc. Defaults to every @ai-sdk/openai-compatible provider."),
    models: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Model IDs to probe. Defaults to the provider's configured models."),
  },
  async execute(args, _context) {
    let loaded: Awaited<ReturnType<typeof loadConfig>>
    try {
      loaded = await loadConfig()
    } catch (e) {
      return `Error reading opencode config: ${e instanceof Error ? e.message : String(e)}`
    }

    const providers = Object.entries(loaded.config.provider ?? {}).filter(([id, p]) =>
      args.provider ? id === args.provider : p.npm === COMPATIBLE_NPM,
    )
    if (providers.length === 0) {
      return args.provider
        ? `Provider "${args.provider}" not found in ${loaded.file}.`
        : `No ${COMPATIBLE_NPM} providers configured in ${loaded.file}.`
    }

    const reports = await Promise.all(providers.map(([id, p]) => providerReport(id, p, args.models)))
    return reports.join("\n\n")
  },
})
