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
| `/skill <skill-name> "<description hint>"`                  | Scaffolds a new skill folder                                                                    |
| `/security-profile [init\|refresh] [project-name]`          | Creates or refreshes a project-specific defensive `security-profile` skill from `security-core` |

The RPI workflow is `research -> plan -> implement`:

- `research` reads and maps the codebase only
- `plan` converts findings into a step-by-step plan only
- `update-plan` revises an existing `plan.md` with new answers/context only
- `implement` executes the plan and runs verification gates

## Per-project security profile

For each project, run both commands so the repository gets and then maintains its security profile:

```sh
/security-profile init
/security-profile refresh
```

- `init` scaffolds `.opencode/skills/security-profile/` with `SKILL.md`, `GOTCHAS.md`, `HISTORY.md`, and `config.json`.
- `refresh` updates inferred metadata while preserving user-owned settings where possible.

The profile is defensive-only and intended to complement `.opencode/skills/security-core/`.

## Skills

Skills are domain-knowledge folders loaded on demand. In this repo, default skills live under `.opencode/config/skills/<skill-name>/` and use this structure:

### Default-loaded skills in this repo

Repository defaults come from `.opencode/config/AGENTS.md`:

- `concise-precise` is baseline for user-facing responses, inspired by [Julius Brussee's caveman](https://github.com/JuliusBrussee/caveman).
- `karpathy-guidelines` layers on for non-trivial code changes, based on [Andrej Karpathy's code review guidelines](https://github.com/forrestchang/andrej-karpathy-skills).

| File / Dir | Purpose |
|---|---|
| `SKILL.md` | Reference facts, file map, config and memory guidance |
| `GOTCHAS.md` | Accumulated failure points and fixes - never deleted |
| `HISTORY.md` | Append-only change log - one entry per session that modified the domain |
| `assets/` | Templates, static files, and output scaffolds |
| `scripts/` | Helper scripts and libraries the agent can run or compose |

### Creating a skill

```sh
/skill <skill-name> "<short description hint>"
```

By default, the scaffold command creates `.opencode/skills/<skill-name>/`.

Example:

```sh
/skill billing-lib "Internal billing library - edge cases, footguns, charge flow"
```

After creation:

1. Fill in `SKILL.md` -> `## Key Facts` with what the model needs to know (not do): file paths, data shapes, naming rules, API shapes.
2. Add reusable scripts to `scripts/` and reference them in `## File & Directory Map`.
3. Add output templates or static assets to `assets/`.
4. If the skill needs per-user config, keep `## Configuration` and define `config.json` shape.
5. If the skill benefits from memory, keep `## Memory` and choose a persistent log format.
6. Remove `## Configuration` and `## Memory` if not needed.

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
