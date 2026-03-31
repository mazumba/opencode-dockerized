---
description: "RPI phase 1 — research the codebase for a task and write a research doc"
subtask: true
agent: build
---

Research the codebase for the following task and write a structured research document: `$ARGUMENTS`

## What to do

Derive a short slug from the task description (lowercase, hyphens, max 40 chars).
Determine today's date using the shell: `date +%Y-%m-%d`
The artifact folder is: `docs/thoughts/<YYYY-MM-DD>_<slug>/`
Create that folder and write your output to `docs/thoughts/<YYYY-MM-DD>_<slug>/research.md`.

Before searching the codebase, read `AGENTS.md` in full (Architecture, Rules, and Session Learnings sections), load any relevant skills from `.opencode/skills/` that relate to the task, and check `docs/` for any tooling workarounds related to the task.

Use the `explore` subagent for all file discovery and code reading tasks to keep this context clean. Invoke it with focused, specific questions and collect only the compacted summaries it returns.

Investigate and record:

- Relevant files and their responsibilities
- Information flow (which code calls which, in what order)
- Existing patterns the implementation must follow (entity conventions, form patterns, controller style, etc.)
- Constraints and gotchas from Session Learnings or skill files that apply
- Quality gate implications (migrations needed? new deps? fixture changes?)

Write `research.md` using this structure (target ~150–200 lines):

```
# Research: <task description>

## Problem Summary
<2-3 sentences on what needs to be done and why>

## Relevant Files
<list of files with a one-line description of their role in this task>

## Information Flow
<narrative or bullet list describing how data/control flows through the relevant code>

## Key Findings
<bullet list of the most important discoveries — patterns, constraints, gotchas>

## Recommended Approach
<1-2 paragraphs on the approach the plan should take, based on findings>

## Open Questions
<any ambiguities that need human input before planning>
```

## Rules you must follow

- **No code changes.** Your only output is the research document.
- **Use the explore subagent** for all codebase reading — never read files directly in this context.
- **Read AGENTS.md first** before touching the codebase.
- **Load relevant skills** before forming any conclusions about patterns or conventions.
- **Open Questions must be honest.** If anything is ambiguous, list it — do not guess.

After writing the document, confirm the path and suggest running `/plan docs/thoughts/<YYYY-MM-DD>_<slug>` when ready.
