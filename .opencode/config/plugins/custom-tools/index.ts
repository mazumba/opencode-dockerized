import { Plugin } from "@opencode/plugin"
import { copilotQuota } from "./copilot-quota.ts"
import { pdftotext, pdftotextInputSchema, type PdftotextInput } from "./pdftotext.ts"
import { providerStatus, providerStatusInputSchema, type ProviderStatusInput } from "./provider-status.ts"

const COPILOT_INTEGRATION_ID = "github-copilot"
const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const

// Custom tools, ported from the V1 `.opencode/tools/*.ts` files. V2 no longer loads that directory:
// tools must be registered by a plugin. `codemode: false` keeps them direct tool calls, as in V1.
export default Plugin.define({
  id: "opencode-dockerized.custom-tools",
  async setup(ctx) {
    /** GitHub OAuth token of the active Copilot login, read from OpenCode's credential store. */
    async function copilotToken(): Promise<string | undefined> {
      const connection = await ctx.integration.connection.active(COPILOT_INTEGRATION_ID)
      if (!connection) return undefined
      const credential = await ctx.integration.connection.resolve(connection)
      // The Copilot device login stores the GitHub token as `refresh` (V2's own quota call uses it);
      // an environment connection resolves to a plain key.
      if (credential?.type === "oauth") return credential.refresh
      if (credential?.type === "key") return credential.key
      return undefined
    }

    /** Project directory of the session that called the tool; relative paths resolve against it. */
    async function sessionDirectory(sessionID: string): Promise<string> {
      const session = await ctx.session.get({ sessionID })
      return session.location.directory
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "pdftotext",
        description: "Extract text from a PDF file with pdftotext",
        input: pdftotextInputSchema,
        options: { codemode: false },
        async execute(input, context) {
          const directory = await sessionDirectory(context.sessionID)
          return { content: await pdftotext(input as PdftotextInput, directory, context.signal) }
        },
      })

      editor.add({
        name: "copilot_quota",
        description:
          "Check your GitHub Copilot quota and usage. Shows used and remaining AI Credits, chat usage, completions, and plan details for the current billing period.",
        input: NO_INPUT,
        options: { codemode: false },
        async execute(_input, context) {
          const token = await copilotToken()
          if (!token) {
            return { content: "No GitHub Copilot login found. Connect GitHub Copilot first (/connect, or `opencode auth login github-copilot`)." }
          }
          return { content: await copilotQuota(token, context.signal) }
        },
      })

      editor.add({
        name: "provider_status",
        description:
          "Check OpenAI-compatible providers from the global opencode config (e.g. LiteLLM proxies): budget from /key/info when exposed, and per-model availability or throttling via a 1-token request. Each run costs a few tokens per model.",
        input: providerStatusInputSchema,
        options: { codemode: false },
        async execute(input) {
          return { content: await providerStatus(input as ProviderStatusInput) }
        },
      })
    })
  },
})
