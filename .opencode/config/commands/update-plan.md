---
description: "RPI helper - update an existing plan with newly answered questions"
subtask: true
agent: build
---

Update the existing implementation plan in `docs/thoughts/$1` using this new information: `$2`.

## What to do

Read `docs/thoughts/$1/plan.md` in full before doing anything else.
Update and overwrite `docs/thoughts/$1/plan.md` only.

Apply the new information from `$2` to:

- resolve previously open questions or ambiguities
- adjust step order, files, and verify commands as needed
- keep the plan concrete and implementation-ready

Preserve the existing plan structure:

- Overview
- Prerequisites
- Implementation Steps
- Quality Gate
- Skills to Update
- Rollback

## Rules you must follow

- **Plan-only change.** Do not implement code.
- **Update only `plan.md`** in the specified artifact folder.
- **No git commits.**
- **Keep exact file paths** in each step.
- **Every step must include a Verify command.**

After updating, confirm the path and suggest running `/implement $1` when ready.
