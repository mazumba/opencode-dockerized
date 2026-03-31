---
description: "RPI phase 3 — execute a plan step by step and run the quality gate"
subtask: true
agent: build
---

Execute the implementation plan in `$ARGUMENTS` step by step and run the quality gate when done.

## What to do

Read `$ARGUMENTS/plan.md` in full before doing anything else.
If `$ARGUMENTS/progress.md` exists, read it too — it means a previous session started this task.

Load all skills listed in the plan's "Skills to Update" section before writing any code.

Execute each step from the plan in order. For each step:

- Announce which step you are starting.
- Make the changes specified.
- Run the verification command listed in the step, if any.
- Mark the step complete in `$ARGUMENTS/progress.md` (see format below).
- If verification fails, fix the issue before moving to the next step.

After all steps are complete, run the full quality gate:

```
make dev-init && make rector-fix && make phpcs-fix && make phpstan && make phpunit
```

Fix any failures before declaring the task done.

If the plan requires a database migration, run `make create-migration`, review the generated file, then include it in the quality gate run.

After the quality gate passes, update any skill files listed in the plan's "Skills to Update" section to reflect the implementation changes.

Maintain `$ARGUMENTS/progress.md` throughout so the task can be resumed if the session is interrupted:

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

## Rules you must follow

- **Never hand-write migration files.** Always use `make create-migration`.
- **Never create git commits.**
- **Quality gate must pass** before the task is declared done.
- **Update skills after implementation.** Stale skills mislead future sessions.
- **Follow the plan step order.** Do not skip or reorder steps without noting it in Issues.

After completing all steps and the quality gate, confirm which steps were completed and whether any skills were updated.
