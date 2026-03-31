---
description: "RPI phase 2 — turn a research doc into a numbered implementation plan"
subtask: true
agent: build
model: github-copilot/claude-sonnet-4.6
---

Turn the research document in `$ARGUMENTS` into a concrete, step-by-step implementation plan.

## What to do

Read `$ARGUMENTS/research.md` in full before doing anything else.
Write your output to `$ARGUMENTS/plan.md`.

If the research document contains Open Questions that are not yet answered, state that planning cannot proceed and list what needs to be resolved first.

Also read `AGENTS.md` (Rules and Quality Gates sections) to ensure the plan respects all project constraints. Load relevant skills from `.opencode/skills/` for any domain touched by the task.

Write `plan.md` using this structure (target ~150–200 lines):

```
# Plan: <task description>

## Overview
<goal, approach, and any architectural decisions>

## Prerequisites
<anything that must be true or done before starting — env, migrations, deps>

## Implementation Steps

### Step 1: <short title>
**Files:** `path/to/file.php`, `path/to/other.php`
**Changes:** <precise description of what to add/change/remove>
**Verify:** <command or assertion to confirm this step is correct before moving on>

### Step 2: ...

(continue for all steps)

## Quality Gate
After all steps: `make dev-init && make rector-fix && make phpcs-fix && make phpstan && make phpunit`
Note any steps that require `make create-migration` before running the gate.

## Skills to Update
<list any .opencode/skills/ files that must be updated after implementation to reflect the changes>

## Rollback
<how to undo the changes if something goes wrong>
```

## Rules you must follow

- **No code changes.** Your only output is the plan document.
- **Unresolved Open Questions block planning.** List them and stop — do not guess.
- **Read AGENTS.md** before writing any steps.
- **Load relevant skills** for every domain the plan touches.
- **Reference exact file paths** in every step — not directories.
- **Every step needs a Verify command** so progress is checkable.
- **Flag schema and asset steps** — any step touching DB schema needs `make create-migration`; any step touching assets needs `make dev-init`.
- **Never hand-write migration files.** Always use `make create-migration`.
- **Never create git commits.**

After writing the document, confirm the path and suggest running `/implement $ARGUMENTS` when ready.
