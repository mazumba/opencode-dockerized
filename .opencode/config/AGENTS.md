# OpenCode Global Working Rules

This file defines default behavior for OpenCode across projects. It sets cost/performance routing for exploration, output-size expectations, and baseline skill-loading rules so sessions are consistent, efficient, and predictable unless a repository-specific `AGENTS.md` overrides them.

- Default to `explore` subagent for codebase reconnaissance (file discovery, symbol usage search, broad grep-like scans).
- Use the main model for synthesis, architecture decisions, and code edits.
- For tiny lookups (single file/symbol), direct `glob`/`grep`/`read` is allowed to avoid handoff overhead.
- When using direct exploration for anything beyond a tiny lookup, briefly justify why `explore` was not used.

## Exploration Policy (Balanced)

- Start with one focused `explore` pass; run additional passes only if key gaps remain.
- Prefer narrow, scoped prompts (specific symbol/path/question) over broad "scan everything" requests.
- Ask `explore` for compact summaries first, then read exact files directly only when needed for implementation correctness.
- Batch independent discovery questions into one `explore` call when possible to reduce handoff overhead.
- Escalate to direct main-model exploration only when findings are ambiguous/conflicting or materially impact architecture decisions.
- If confidence remains low after exploration, do one targeted verification pass instead of a full re-scan.

## Output Budgets (Balanced)

- Default discovery output target: 5-12 most relevant files (unless user asks for exhaustive coverage).
- Default per-file note target: 1-2 lines (responsibility + relevance).
- Prefer "top matches + rationale" over exhaustive listings by default.

## Skill Loading Default

- For any non-trivial code change, load `karpathy-guidelines` by default unless a more specific skill already fully covers the task.
