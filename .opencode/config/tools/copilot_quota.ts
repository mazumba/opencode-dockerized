import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"

type QuotaSnapshot = {
  quota_id: string
  unlimited: boolean
  entitlement: number
  remaining: number
  percent_remaining: number
  overage_count: number
  overage_permitted: boolean
  timestamp_utc: string
}

type CopilotUserInfo = {
  login: string
  copilot_plan: string
  access_type_sku: string
  quota_reset_date: string
  quota_snapshots: Record<string, QuotaSnapshot>
  token_based_billing: boolean
  chat_enabled: boolean
  message?: string // error case
}

function formatQuota(id: string, q: QuotaSnapshot): string {
  if (q.unlimited) {
    return `  ${id}: unlimited`
  }
  const used = q.entitlement - q.remaining
  const pctUsed = (100 - q.percent_remaining).toFixed(1)
  const bar = buildBar(q.percent_remaining, 20)
  let line = `  ${id}: ${used} / ${q.entitlement} used (${pctUsed}%) ${bar}`
  if (q.overage_count > 0) {
    line += `  [+${q.overage_count} overage${q.overage_permitted ? "" : " — not permitted"}]`
  }
  return line
}

function buildBar(percentRemaining: number, width: number): string {
  const filled = Math.round(((100 - percentRemaining) / 100) * width)
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]"
}

export default tool({
  description:
    "Check your GitHub Copilot quota and usage. Shows remaining premium interactions, chat usage, completions, and plan details for the current billing period.",
  args: {},
  async execute(_args, _context) {
    // Read GitHub OAuth token from OpenCode's auth store
    const authPath = path.join(homedir(), ".local", "share", "opencode", "auth.json")
    let token: string
    try {
      const raw = await readFile(authPath, "utf8")
      const auth = JSON.parse(raw)
      token = auth?.["github-copilot"]?.access
      if (!token) throw new Error("No github-copilot access token found in auth.json")
    } catch (e) {
      return `Error reading auth: ${e instanceof Error ? e.message : String(e)}\n\nRun /connect and select GitHub Copilot first.`
    }

    // Fetch quota info from GitHub's Copilot user endpoint
    let info: CopilotUserInfo
    try {
      const res = await fetch("https://api.github.com/copilot_internal/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "opencode-copilot-quota/1.0",
        },
      })
      const data = await res.json()
      if (!res.ok) {
        return `GitHub API error (${res.status}): ${data?.message ?? res.statusText}`
      }
      info = data as CopilotUserInfo
    } catch (e) {
      return `Network error: ${e instanceof Error ? e.message : String(e)}`
    }

    const lines: string[] = []

    lines.push(`User:  ${info.login}`)
    lines.push(`Plan:  ${info.copilot_plan ?? "unknown"} (${info.access_type_sku ?? ""})`)
    lines.push(`Reset: ${info.quota_reset_date ?? "unknown"}`)
    lines.push("")

    const snapshots = info.quota_snapshots ?? {}
    if (Object.keys(snapshots).length === 0) {
      lines.push("No quota snapshot data available.")
    } else {
      lines.push("Quota:")
      // Show premium_interactions first (most relevant), then others
      const order = ["premium_interactions", "premium_models", "chat", "completions"]
      const sorted = [
        ...order.filter((k) => k in snapshots),
        ...Object.keys(snapshots).filter((k) => !order.includes(k)),
      ]
      for (const key of sorted) {
        lines.push(formatQuota(key, snapshots[key]))
      }
    }

    return lines.join("\n")
  },
})
