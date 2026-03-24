---
description: "RPI phase 2 — turn a research doc into a numbered implementation plan"
subtask: true
agent: plan
---
You are in the **Plan** phase of the Research-Plan-Implement workflow.

Your only output is a structured implementation plan. You must not make any code changes.

## Artifact folder

$ARGUMENTS

Read `$ARGUMENTS/research.md` in full before doing anything else.
Write your output to `$ARGUMENTS/plan.md`.

## Instructions

1. Read the research document thoroughly. If it contains Open Questions that are not yet answered,
   state that planning cannot proceed and list what needs to be resolved first.

2. Also read `AGENTS.md` (Rules section and Quality Gates) to ensure the plan respects all project constraints:
   - Never hand-write migration files — always use `make create-migration`
   - Never create git commits
   - Quality gate must pass after every change: `make dev-init && make rector-fix && make phpcs-fix && make phpstan && make phpunit`
   - Load relevant skills from `.opencode/skills/` for any domain touched

3. Write `plan.md` using this structure (target ~150-200 lines):

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

4. Requirements for each step:
   - Reference exact file paths (not directories)
   - Be specific enough that the implementer does not need to make architectural decisions
   - Include a verification command or assertion so progress is checkable
   - Flag any step that touches DB schema (needs migration) or assets (needs `make dev-init`)

5. End your response with:
   > Plan written to: `$ARGUMENTS/plan.md`
   > Review it and run `/implement $ARGUMENTS` when ready.
