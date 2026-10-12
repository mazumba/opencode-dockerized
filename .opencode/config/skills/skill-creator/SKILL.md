---
name: skill-creator
description: Creates or rewrites opencode skills (SKILL.md folders). Use when the user wants a new skill, to turn a workflow or prompt into a reusable skill, says "I want the agent to always do X", or a skill is not triggering. Not for agent definitions or AGENTS.md.
---

# Skill creator

Builds one skill folder: a lean `SKILL.md` plus disclosed files reached by pointers. [`writing-for-agents`](../writing-for-agents/SKILL.md) is the writing reference (pointers, information hierarchy, completion criteria, pruning); its [`SKILL-MECHANICS.md`](../writing-for-agents/SKILL-MECHANICS.md) covers frontmatter, invocation and leading words. Load both before drafting.

## Steps

1. **Capture intent.** Pin down what the skill does, its trigger branches (the distinct situations and the words a user actually types), its exclusions, and its output. IF the request is vague ("a skill for APIs"): ask 1-2 targeted questions about domain, triggers and output before drafting. Done when every trigger branch and the output contract can be stated in one line each.
2. **Choose invocation and scope.** Model-invoked or user-invoked, per `SKILL-MECHANICS.md`. Project scope (`.opencode/skills/`) or this container's shared config (`.opencode/config/skills/`). Done when both are decided.
3. **Research (conditional).** IF the domain is unfamiliar: gather its precise terms and named failure modes via @librarian (external) or @explorer (project-specific). Done when you hold enough terms for the vocabulary payload and 5-10 named anti-patterns, each passing the practitioner test in [`references/anatomy.md`](references/anatomy.md).
4. **Draft `SKILL.md`.** Follow the section order and formats in [`references/anatomy.md`](references/anatomy.md). Use numbered steps for workflows, reference for knowledge domains, or both; keep only what every branch needs in the file.
5. **Disclose.** Move material that only some branches reach (pattern libraries, long examples, checklists, scripts, templates) into sibling files behind pointers that say when to read them. File layout, optional `GOTCHAS.md`, `config.json` and memory files: [`references/layout.md`](references/layout.md). Done when `SKILL.md` is under 200 lines and every disclosed file has a pointer stating its read condition.
6. **Validate.** Check the draft against every entry in [`references/watchlist.md`](references/watchlist.md) and fix each hit. Check frontmatter: `name` is kebab-case, 1-64 chars, equal to the directory name; `description` is 1024 chars or fewer. Done when the watchlist is clean.
7. **Trial (conditional).** IF subagents are available: run 3 prompts a real user would type (one casual, one imprecise, one formal). Done when each one triggers the skill and the output matches its output contract.
8. **Report.** List the created paths and the final description, and tell the user to restart opencode so it loads the skill.
