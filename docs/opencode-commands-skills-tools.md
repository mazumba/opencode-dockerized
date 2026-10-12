# OpenCode Commands, Skills, and Tools

This page documents repository-specific slash commands, the skill layout, and custom tools shipped in this repo.

## At a glance

- Use `README.md` for Docker setup and runtime config.
- Use this page for slash commands, skills, and custom tool behavior.
- Repo-local OpenCode config lives under `.opencode/`.

## Slash commands

| Command                                                     | Purpose                                                                                         |
|-------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `/research <task-title> "<additional information>"`         | RPI phase 1 - explores the codebase and writes a research doc to `docs/thoughts/`               |
| `/plan <artifact-folder> "<additional information>"`        | RPI phase 2 - turns a research doc into a numbered implementation plan                          |
| `/update-plan <artifact-folder> "<additional information>"` | RPI helper - updates an existing plan using newly answered questions                            |
| `/implement <artifact-folder>`                              | RPI phase 3 - executes the plan step by step and runs the quality gate                          |
| `/skill <skill-name> "<description hint>"`                  | Builds a new skill via the `skill-creator` skill                                                |
| `/security-profile [init\|refresh] [project-name]`          | Creates or refreshes a project-specific defensive `security-profile` skill from `security-core` |

The RPI workflow is `research -> plan -> implement`:

- `research` reads and maps the codebase only
- `plan` converts findings into a step-by-step plan only
- `update-plan` revises an existing `plan.md` with new answers/context only
- `implement` executes the plan and runs verification gates

RPI command execution notes:

- Prefer `explore` for reconnaissance when available.
- If `explore` is unavailable in the current execution context (for example, inside a subtask agent), use direct `glob`/`grep`/`read` without asking for fallback confirmation.

## Per-project security profile

For each project, run both commands so the repository gets and then maintains its security profile:

```sh
/security-profile init
/security-profile refresh
```

- `init` scaffolds `.opencode/skills/security-profile/` with `SKILL.md`, `GOTCHAS.md`, and `config.json`.
- `refresh` updates inferred metadata while preserving user-owned settings where possible.

The profile is defensive-only and intended to complement `.opencode/skills/security-core/`.

## Skills

Skills are domain-knowledge folders loaded on demand. In this repo, default skills live under `.opencode/config/skills/<skill-name>/` and use this structure:

### Always-on rules

Response style and working rules live in `.opencode/config/AGENTS.md`, not in skills, so every agent gets them:

- **Response Style**, inspired by [Julius Brussee's caveman](https://github.com/JuliusBrussee/caveman).
- **Working Style**, based on [Andrej Karpathy's guidelines](https://github.com/forrestchang/andrej-karpathy-skills).

Upstream skills (mattpocock/skills, shadcn/improve) are pinned in `.opencode/config/skills-lock.json`.

| File / Dir | Purpose |
|---|---|
| `SKILL.md` | Required. Lean entry point: steps and/or reference every branch needs |
| `references/` | Disclosed reference, loaded only when a pointer in `SKILL.md` fires |
| `scripts/` | Helper scripts the agent can run or compose |
| `assets/` | Templates, static files, and output scaffolds |
| `GOTCHAS.md` | Optional. Known failure points for domains with recurring footguns |
| `config.json` | Optional. Per-user values, written on first run |

Only `SKILL.md` is required; the rest exist only when the skill uses them.

### Creating a skill

The `skill-creator` skill (`.opencode/config/skills/skill-creator/`) builds new skills. It triggers on its own when you ask for a skill. `/skill` is a shortcut that loads it:

```sh
/skill <skill-name> "<short description hint>"
```

By default the skill goes in `.opencode/skills/<skill-name>/`. Ask for `.opencode/config/skills/` to ship it to every container.

Example:

```sh
/skill billing-lib "Internal billing library - edge cases, footguns, charge flow"
```

Restart opencode afterwards so it loads the new skill.

## Custom tools

The custom tool `.opencode/tools/pdftotext.ts` exposes `pdftotext` with these arguments:

- `filePath` (required): PDF path, absolute or relative to the current directory
- `firstPage` / `lastPage` (optional): 1-based page range
- `preserveLayout` (optional): uses `pdftotext -layout`
- `rawOrder` (optional): uses `pdftotext -raw`
- `maxChars` (optional): maximum characters returned (default `40000`)

Example prompt:

```text
Read from docs/some-pdf-file.pdf, pages 2-4, preserving layout.
```

## Playwright MCP (browser plugin)

The `browser` plugin provides [`@playwright/mcp@0.0.72`](https://github.com/microsoft/playwright-mcp) — a local MCP server for headless Chromium automation.

**How it works:**

- Enabled with `PLUGINS=browser` in `.env`, then `make opencode-build-plugins` (opt-in).
- The MCP entry is `enabled: true` by default when the plugin is active — activating the plugin is the opt-in.
- Tool access policy (`playwright_*`) is user-configurable via `opencode.jsonc`.
- Browser state is not persisted across restarts (non-persistent).
- Headless by default (`PLAYWRIGHT_HEADLESS=true`); no headed debug mode unless configured manually.
- Standard container outbound network — no extra restrictions or proxying for browser traffic.

**Operations:**

- **Owner:** Repo Maintainers
- **Cadence:** Monthly dependency/version review + immediate review on any OpenCode release, `@playwright/mcp` release, or CVE advisory. Review cadence: monthly.

## Linear MCP (linear plugin)

The `linear` plugin provides Linear's remote MCP server (`https://mcp.linear.app/mcp`), authenticated with `LINEAR_API_KEY`.

**How it works:**

- Enabled with `PLUGINS=linear` and `LINEAR_API_KEY` in `.env`, then `make opencode-build-plugins` (opt-in).
- Only the `linear` subagent can use `linear_*` tools; other agents delegate to it.
- Startup fails if the API key is missing or rejected by Linear.
- Writes are attributed to the owner of the API key. See README "Linear plugin".
