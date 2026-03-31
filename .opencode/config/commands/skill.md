---
description: Scaffold a new skill folder with SKILL.md, GOTCHAS.md, and HISTORY.md
agent: build
subtask: true
model: github-copilot/claude-sonnet-4.6
---

Create a new OpenCode skill. Skill name: `$1`. Description hint: `$ARGUMENTS` (everything after the name).

## What to build

Create exactly three files under `.opencode/skills/$1/`:

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
| `path/to/file` | What it does |

## Key Facts

<Dense reference material. Patterns, constraints, naming rules, API shapes, config values.
Write what an agent needs to KNOW, not what it needs to DO.
Tables, code blocks, and bullet lists — no numbered instructions.>

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

## Rules you must follow

- **Description field is a MODEL trigger.** Write it as "Use when..." so the model self-selects this skill. Not a summary of contents.
- **SKILL.md is a reference, not a script.** No numbered how-to steps. Give information: file paths, data shapes, constraints, examples. Agents read what they need.
- **GOTCHAS.md accumulates forever.** Never delete entries. Every wrong assumption that caused a broken build belongs here.
- **HISTORY.md is append-only.** Newest entries at the bottom. Agents read their own history next session.
- **A skill is a folder.** If you later add scripts, templates, or data files, place them alongside SKILL.md in the same folder — not inside it.

Use today's actual date (not a placeholder) in HISTORY.md.
After creating the three files, confirm the paths and the description you chose.
