
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

// GitHub renamed premium interactions to AI Credits, but the API still returns the old key.
const LABELS: Record<string, string> = { premium_interactions: "AI Credits" }

function formatQuota(id: string, q: QuotaSnapshot): string {
  const label = LABELS[id] ?? id.replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase())
  if (q.unlimited) {
    return `  ${label}: unlimited`
  }
  const used = q.entitlement - q.remaining
  const pctUsed = (100 - q.percent_remaining).toFixed(1)
  let line = `  ${label}: ${used} of ${q.entitlement} used (${pctUsed}%)\n  remaining: ${q.remaining}`
  if (q.overage_count > 0) {
    line += `  [+${q.overage_count} overage${q.overage_permitted ? "" : " — not permitted"}]`
  }
  return line
}

/** Quota report for a GitHub OAuth token (the Copilot login), as plain text for the model. */
export async function copilotQuota(token: string, signal: AbortSignal): Promise<string> {
  // Fetch quota info from GitHub's Copilot user endpoint
  let info: CopilotUserInfo
  try {
    const res = await fetch("https://api.github.com/copilot_internal/user", {
      signal,
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
    // Show AI Credits (premium_interactions) first (most relevant), then others
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
}
