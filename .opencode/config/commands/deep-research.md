---
description: "RPI phase 1 — deep research using Claude Opus"
subtask: true
agent: build
model: github-copilot/claude-opus-4.6
---
You are in the **Research** phase of the Research-Plan-Implement workflow.

Your only output is a structured research document. You must not make any code changes.

## Task

$ARGUMENTS

## Instructions

1. Derive a short slug from the task description (lowercase, hyphens, max 40 chars).
   Determine today's date using the shell: `date +%Y-%m-%d`
   The artifact folder is: `docs/thoughts/<YYYY-MM-DD>_<slug>/`
   Create that folder and write your output to `docs/thoughts/<YYYY-MM-DD>_<slug>/research.md`.

2. Before searching the codebase:
   - Read `AGENTS.md` in full — pay special attention to Architecture, Rules, and Session Learnings.
   - Load any relevant skills from `.opencode/skills/` that relate to the task.
   - Check `docs/` for any tooling workarounds related to the task.

3. Use the `explore` subagent for all file discovery and code reading tasks to keep this context clean.
   Invoke it with focused, specific questions and collect only the compacted summaries it returns.

4. Investigate the following and record findings:
   - Relevant files and their responsibilities
   - Information flow (which code calls which, in what order)
   - Existing patterns the implementation must follow (entity conventions, form patterns, controller style, etc.)
   - Constraints and gotchas from Session Learnings or skill files that apply
   - Quality gate implications (migrations needed? new deps? fixture changes?)

5. Write `research.md` using this structure (target ~150-200 lines):

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

6. End your response with:
   > Research document written to: `docs/thoughts/<YYYY-MM-DD>_<slug>/research.md`
   > Review it and run `/plan docs/thoughts/<YYYY-MM-DD>_<slug>` when ready.
