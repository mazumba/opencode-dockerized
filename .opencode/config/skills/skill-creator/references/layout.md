# Skill folder layout

A skill is a folder. Create only what the skill uses; link every file from `SKILL.md` with its read or run condition.

```
<name>/
  SKILL.md        # required
  references/     # disclosed reference, each file under 300 lines
  scripts/        # helpers the agent runs or composes
  assets/         # templates, static files, output scaffolds
  GOTCHAS.md      # optional, see below
  config.json     # optional, see below
```

## Locations

| Scope | Path |
|---|---|
| Shared config in this repo (every container) | `.opencode/config/skills/<name>/` |
| Project | `.opencode/skills/`, `.agents/skills/` or `.claude/skills/`, found by walking up from the working directory to the git worktree root |
| User | `~/.config/opencode/skills/`, `~/.agents/skills/` or `~/.claude/skills/` |

## GOTCHAS.md

Add it only for domains where real failures keep surfacing (a library with footguns, a deploy flow). Link it from `SKILL.md` with its condition, e.g. "Read `GOTCHAS.md` before changing X; add an entry when something breaks unexpectedly." Entry format:

```
### <Short title>
**Symptom:** what breaks
**Root cause:** why
**Fix:** what to do instead
```

## Per-user configuration

IF the skill needs user-specific values (a Slack channel, an endpoint): store them in `config.json` in the skill folder. Add a step to `SKILL.md`: on first run, IF `config.json` is missing, ask the user for the values and write the file. Show the expected shape in `SKILL.md`.

## Memory

IF the skill benefits from remembering past runs (standups, recaps, deploy logs): keep an append-only file in the skill folder (e.g. `runs.log`) and add a step that reads the last N entries at the start of each run. Leave it out for stateless skills.
