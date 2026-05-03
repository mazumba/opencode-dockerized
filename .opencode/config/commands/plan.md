---
description: "RPI phase 2 — turn a research doc into a numbered implementation plan"
subtask: true
agent: build
---

Turn the research document in `docs/thoughts/$1` into a concrete, step-by-step implementation plan.

## What to do

Read `docs/thoughts/$1/research.md` in full before doing anything else.
Write your output to `docs/thoughts/$1/plan.md`.

If the research document contains Open Questions that are not yet answered, state that planning cannot proceed and list what needs to be resolved first.
Check, if these are the answers to the Open Questions and resolve them in the plan file, if that is the case: `$2`.

Also read `AGENTS.md` to ensure the plan respects all project constraints and verification expectations. Load relevant skills from `.opencode/skills/` for any domain touched by the task.

If `explore` is unavailable in this execution context (for example, inside a subtask agent), use direct tools (`glob`/`grep`/`read`) for codebase discovery and reading without asking for fallback confirmation.

Write `plan.md` using this structure (target ~150–200 lines):

```
# Plan: <task description>

## Overview
<goal, approach, and any architectural decisions>

## Prerequisites
<anything that must be true or done before starting — env, migrations, deps>

## Implementation Steps

### Step 1: <short title>
**Files:** `path/to/file`, `path/to/other`
**Changes:** <precise description of what to add/change/remove>
**Verify:** <command or assertion to confirm this step is correct before moving on>

### Step 2: ...

(continue for all steps)

## Quality Gate
After all steps: Run quality gates as provided by the AGENTS.md

## Skills to Update
<list any `.opencode/skills/` files that must be updated after implementation to reflect the changes>

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
- **Flag schema and asset steps** — any step touching DB schema needs a migration; any step touching assets needs initialization.
- **Never create git commits.**

## Completion Contract (strict)
End the plan task with exactly these lines and nothing else, replacing the placeholders:
This sentence is the handoff artifact for RPI phase 2.
The main agent must relay this information to the user and nothing else:
- <YYYY-MM-DD>_<slug>
- A summary of the created plan
- Open Questions: <list any open questions or "None">
