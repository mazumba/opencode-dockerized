# OpenCode Global Working Rules

This file defines default behavior for OpenCode across projects. It sets cost/performance routing for exploration, output-size expectations, and baseline skill-loading rules so sessions are consistent, efficient, and predictable unless a repository-specific `AGENTS.md` overrides them.

- Prefer `explore` subagent for codebase reconnaissance (file discovery, symbol usage search, broad grep-like scans) when available in the current execution context.
- Use the main model for synthesis, architecture decisions, and code edits.
- For tiny lookups (single file/symbol), direct `glob`/`grep`/`read` is allowed to avoid handoff overhead.
- If `explore` is unavailable in the current execution context (for example, inside a subtask agent), use direct `glob`/`grep`/`read` without fallback confirmation.
- When `explore` is available and direct exploration is used beyond a tiny lookup, briefly justify why `explore` was not used.

## Exploration Policy (Balanced)

- When available, start with one focused `explore` pass; run additional passes only if key gaps remain.
- Prefer narrow, scoped prompts (specific symbol/path/question) over broad "scan everything" requests.
- When available, ask `explore` for compact summaries first, then read exact files directly only when needed for implementation correctness.
- When available, batch independent discovery questions into one `explore` call when possible to reduce handoff overhead.
- Escalate to direct main-model exploration only when findings are ambiguous/conflicting or materially impact architecture decisions.
- If confidence remains low after exploration, do one targeted verification pass instead of a full re-scan.

## Output Budgets (Balanced)

- Default discovery output target: 5-12 most relevant files (unless user asks for exhaustive coverage).
- Default per-file note target: 1-2 lines (responsibility + relevance).
- Prefer "top matches + rationale" over exhaustive listings by default.

## Skill Loading Default

- Load `concise-precise` by default for all user-facing responses unless the user explicitly requests `normal mode`.
- Keep `concise-precise` active when loading other skills; treat it as the baseline response style.
- For any non-trivial code change, load `karpathy-guidelines` by default unless a more specific skill already fully covers the task.
