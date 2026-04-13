---
description: "Create or refresh a project-specific defensive security profile skill"
subtask: true
agent: build
---

Create or update a project-local `security-profile` skill using `security-core` as the baseline.

Command usage:
- `/security-profile init`
- `/security-profile refresh`
- `/security-profile init <project-name>`
- `/security-profile refresh <project-name>`

Default mode is `init` when no mode is provided.

## Spec

### Inputs

- `mode`: `init` or `refresh`
- `project_name` (optional): override inferred project name

### Outputs

Under `.opencode/skills/security-profile/` ensure these files exist:

- `SKILL.md`
- `GOTCHAS.md`
- `HISTORY.md`
- `config.json`
- `assets/.gitkeep`
- `scripts/.gitkeep`

### `config.json` shape

```json
{
  "project": "<string>",
  "stack": ["<string>"],
  "environments": ["dev", "staging", "production"],
  "severity_sla_days": {
    "critical": 0,
    "high": 7,
    "medium": 30,
    "low": 90,
    "informational": 999
  },
  "risk_threshold": {
    "block_release_at_or_above": "high"
  },
  "ci_verify_commands": ["<command>"],
  "ownership": {
    "security": "<team-or-handle>",
    "default_service_owner": "<team-or-handle>"
  },
  "defensive_only": true
}
```

### Defensive policy

- This command and resulting skill are defensive-only.
- Never add exploit-building, payload development, bypass instructions, or offensive operation guidance.
- If asked for offensive detail, redirect to detection, mitigation, patching, validation, and disclosure handling.

## What to do

1. Read `.opencode/skills/security-core/SKILL.md` first.
2. Parse `$ARGUMENTS` into `mode` and optional `project_name`.
3. Infer project metadata from repo files when possible:
   - project name from root directory or manifest
   - stack from common files (`composer.json`, `package.json`, `pyproject.toml`, `go.mod`, `Dockerfile`, `*.tf`)
   - CI verify commands from existing project tooling
4. Ensure `.opencode/skills/security-profile/` exists with required files.
5. Write or update files:

### `SKILL.md`

- Frontmatter:
  - `name: security-profile`
  - `description`: must start with `Use when...` and be <= 150 chars
- Sections:
  - `# Skill: security-profile`
  - `## Overview`
  - `## File & Directory Map`
  - `## Key Facts`
  - `## Configuration` (keep; points to `config.json`)
  - `## Memory` (remove unless a persistent run log is intentionally added)
  - `## Cross-References` with `security-core`
- Content requirements:
  - repository-specific constraints only
  - severity gate and SLA mapping from `config.json`
  - explicit defensive-only statement

### `GOTCHAS.md`

- Ensure append-only gotcha template exists.
- Never delete prior entries.

### `HISTORY.md`

- Append-only.
- Add one dated entry for each run:
  - `init`: `## <YYYY-MM-DD> — Security profile initialized`
  - `refresh`: `## <YYYY-MM-DD> — Security profile refreshed`
- Mention what changed and why.

### `config.json`

- On `init`, create with inferred defaults.
- On `refresh`, preserve user-owned fields when present; only patch missing or stale inferred values.
- Always enforce `"defensive_only": true`.

6. If required values cannot be inferred (owner handles, release gate preference, env list), ask concise questions and then update `config.json`.

## Rules you must follow

- Keep `security-core` reusable; put repo-specific details only in `security-profile`.
- `SKILL.md` is reference material, not procedural numbered instructions.
- Use today's actual date in `HISTORY.md`.
- Preserve existing user edits on refresh whenever safe.
- Never create git commits.

After completion, confirm:

- resolved `mode`
- chosen project name
- detected stack
- files created/updated
- any fields still requiring user input
