---
description: Scaffold a new skill folder with SKILL.md, GOTCHAS.md, HISTORY.md, and starter directories
agent: build
subtask: true
model: github-copilot/claude-sonnet-4.6
---

Create a new OpenCode skill. Skill name: `$1`. Description hint: `$ARGUMENTS` (everything after the name).

## What to build

Create the following structure under `.opencode/skills/$1/`:

### 1. `.opencode/skills/$1/SKILL.md`

```
---
name: $1
description: <concise trigger-first description, ≤150 chars, starts with "Use when...">
---

# Skill: $1

## Overview

<2–3 sentences. What this domain IS. No step-by-step. Facts only.>

## File & Directory Map

| Path | Purpose |
|---|---|
| `SKILL.md` | This reference file |
| `GOTCHAS.md` | Known failure points and fixes |
| `HISTORY.md` | Append-only change log |
| `assets/` | Templates, static files, and output scaffolds (if any) |
| `scripts/` | Helper scripts and libraries the agent can run or compose (if any) |

## Key Facts

<Dense reference material. Patterns, constraints, naming rules, API shapes, config values.
Write what an agent needs to KNOW, not what it needs to DO.
Tables, code blocks, and bullet lists — no numbered instructions.>

## Configuration

<!-- Remove this section if the skill needs no per-user setup. -->
<!-- If the skill requires user-specific values (e.g. a Slack channel, an API endpoint),
     store them in config.json in this folder. On first run, check whether config.json
     exists; if not, ask the user for the required values and write the file.
     Example shape:
{
  "channel": "#deployments",
  "environment": "production"
}
-->

## Memory

<!-- Remove this section if the skill is stateless. -->
<!-- For skills that benefit from remembering past runs (standups, recaps, deploy logs),
     store data in an append-only file in this folder (e.g. history.log or runs.json).
     Read the last N entries at the start of each run so context carries across sessions. -->

## Cross-References

- Related skill: `other-skill-name` — brief reason
```

### 2. `.opencode/skills/$1/GOTCHAS.md`

```
# Gotchas

Every real mistake, wrong assumption, and edge case discovered while working in this domain.
Add an entry whenever something breaks unexpectedly. Also log it in HISTORY.md.

---

<!-- Add entries below as they are discovered. Format:

### <Short title>

**Symptom:** What you observe / what breaks
**Root cause:** Why it happens
**Fix:** What to do instead

-->
```

### 3. `.opencode/skills/$1/HISTORY.md`

```
# History

Append a dated entry each time you modify something in this skill's domain.
Include: what changed, why, and any gotcha encountered (also add to GOTCHAS.md).

---

## <YYYY-MM-DD> — Skill created

Scaffolded via `/skill $1`. No domain changes yet.
```

### 4. `.opencode/skills/$1/assets/.gitkeep`

Empty file. The `assets/` directory is for templates, output scaffolds, and static files the skill uses or produces.

### 5. `.opencode/skills/$1/scripts/.gitkeep`

Empty file. The `scripts/` directory is for helper scripts and libraries the agent can run or compose during skill execution.

## Rules you must follow

- **Description field is a MODEL trigger.** Write it as "Use when..." so the model self-selects this skill. Not a summary of contents.
- **SKILL.md is a reference, not a script.** No numbered how-to steps. Give information: file paths, data shapes, constraints, examples. Agents read what they need.
- **GOTCHAS.md accumulates forever.** Never delete entries. Every wrong assumption that caused a broken build belongs here.
- **HISTORY.md is append-only.** Newest entries at the bottom. Agents read their own history next session.
- **A skill is a folder.** Add scripts to `scripts/`, templates and output files to `assets/`. Reference them in the File & Directory Map.
- **Configuration section:** Keep it if the skill needs user-specific values; remove it if not. If kept, check for `config.json` on first run and prompt the user for missing values.
- **Memory section:** Keep it if the skill benefits from remembering past runs; remove it if stateless.

Use today's actual date (not a placeholder) in HISTORY.md.
After creating the files and directories, confirm the paths and the description you chose.
