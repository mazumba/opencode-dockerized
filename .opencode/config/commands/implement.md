---
description: "RPI phase 3 — execute a plan step by step and run the quality gate"
subtask: true
agent: build
---
You are in the **Implement** phase of the Research-Plan-Implement workflow.

## Artifact folder

$ARGUMENTS

Read `$ARGUMENTS/plan.md` in full before doing anything else.
If a `$ARGUMENTS/progress.md` file exists, read it too — it means a previous session started this task.

## Instructions

1. Load all skills referenced in the plan's "Skills to Update" section before writing any code.

2. Execute each step from the plan **in order**. For each step:
   a. Announce which step you are starting.
   b. Make the changes specified.
   c. Run the verification command listed in the step, if any.
   d. Mark the step complete in `$ARGUMENTS/progress.md` (see format below).
   e. If verification fails, fix the issue before moving to the next step.

3. After ALL steps are complete, run the full quality gate:
   ```
   make dev-init && make rector-fix && make phpcs-fix && make phpstan && make phpunit
   ```
   Fix any failures before declaring the task done.

4. If the plan requires a database migration (noted in a step), run:
   ```
   make create-migration
   ```
   Review the generated migration file, then include it in the quality gate run.

5. After the quality gate passes, update any skill files listed in the plan's "Skills to Update"
   section to reflect the implementation changes. Skills are the long-term source of truth —
   stale skills mislead future sessions.

6. Never create git commits. The user commits manually.

## Progress file format

Maintain `$ARGUMENTS/progress.md` throughout implementation so the task can be resumed if the
session is interrupted:

```
# Progress: <task description>

## Status
In progress / Complete

## Completed Steps
- [x] Step 1: <title>
- [x] Step 2: <title>

## Current Step
- [ ] Step 3: <title>
  <any notes on where you left off or issues encountered>

## Remaining Steps
- [ ] Step 4: <title>
- [ ] Step 5: <title>

## Issues
<any blockers or decisions made that deviate from the plan>
```

Update `Status: Complete` and remove the "Current Step" block when all steps and the quality gate pass.
