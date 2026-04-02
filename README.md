# opencode-dockerized

Run [opencode](https://opencode.ai) inside a Docker container - a practical alternative to installing it locally, useful if you prefer to keep your local machine clean.

## Prerequisites

Copy the override template and set the **full absolute path** to your projects directory.
Full paths are required to avoid Docker-in-Docker volume mounting issues:

```sh
cp compose.override.yml.dist compose.override.yml
```

Then edit `compose.override.yml` and replace the placeholder path:

```yaml
services:
  opencode:
    volumes:
      - /full/path/to/my/projects:/full/path/to/my/projects
```

## Usage

```sh
# Build the image (run once, or after Dockerfile changes)
make opencode-build

# Start the container
make opencode-run
# → http://localhost:4096

# Tear down
make opencode-down
```

The container runs as a non-root user matching your host `UID`/`GID` (detected automatically by the `Makefile`).

## Docker socket access

The container mounts `/var/run/docker.sock` so opencode can run Docker commands on the host.
Socket permissions are handled automatically at container startup by `docker/entrypoint.sh`:
it reads the GID that owns the socket and adds the `opencode` user to that group before
dropping privileges. No manual configuration is needed.

Note that mounting the Docker socket gives the container full access to the host Docker daemon,
so this setup does not provide meaningful isolation from the host.

| Host OS                | Typical socket GID |
|------------------------|--------------------|
| macOS (Docker Desktop) | `0` (`root`)       |
| Linux (Docker Engine)  | `999` or varies    |

## Authentication (`auth.json`)

If you already have opencode installed locally and are authenticated, you can copy your
existing credentials into the share directory to avoid re-authenticating inside the container:

```sh
# macOS / Linux
cp ~/.local/share/opencode/auth.json .opencode/share/auth.json
```

Otherwise, start the container with `make opencode-run`, open `http://localhost:4096`, and
authenticate through the UI. The credentials will be written to `.opencode/share/auth.json`
automatically.

> **Note:** `auth.json` may contain provider tokens. It is covered by `.gitignore` and will
> not be committed to version control.

## Configuration (`opencode.json`)

The container maps `.opencode/config/` to the opencode config directory inside the container.
Create or edit `.opencode/config/opencode.json` to customise behaviour:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": true,
  "share": "disabled",
  "enabled_providers": ["github-copilot"],
  "permission": {
    "bash": "ask",
    "*": "allow"
  }
}
```

This file is gitignored so it is safe to customise locally without affecting others.

### Permissions

The `permission` field controls which tool calls require your approval before execution.
The example above asks for confirmation on every `bash` command while allowing everything else.

To require approval for more tools, add them explicitly:

```json
{
  "permission": {
    "bash": "ask",
    "edit": "ask",
    "write": "ask",
    "*": "allow"
  }
}
```

See the [permissions docs](https://opencode.ai/docs/permissions) for all available options.

Happy agentic coding!

## Custom commands & skills

This repo ships a set of slash commands in `.opencode/config/commands/` and a skill system in `.opencode/skills/`.

### Slash commands

| Command                                 | Purpose |
|-----------------------------------------|---|
| `/research <task>`                      | RPI phase 1 — explores the codebase and writes a research doc to `docs/thoughts/` |
| `/deep-research <task>`                 | Same as `/research` but uses Claude Opus for harder problems |
| `/plan <artifact-folder>`               | RPI phase 2 — turns a research doc into a numbered implementation plan |
| `/implement <artifact-folder>`          | RPI phase 3 — executes the plan step by step and runs the quality gate |
| `/skill <skill-name> "<description hint>"` | Scaffolds a new skill folder (see below) |

The Research → Plan → Implement workflow keeps each phase focused: research never touches code, plan never touches code, implement follows the plan exactly.

### Skills

Skills are domain-knowledge folders that the model loads on demand. Each lives under `.opencode/skills/<skill-name>/` and contains:

| File / Dir | Purpose |
|---|---|
| `SKILL.md` | Reference facts, file map, config and memory guidance |
| `GOTCHAS.md` | Accumulated failure points and fixes — never deleted |
| `HISTORY.md` | Append-only change log — one entry per session that modified the domain |
| `assets/` | Templates, static files, and output scaffolds |
| `scripts/` | Helper scripts and libraries the agent can run or compose |

#### Creating a skill

```sh
/skill <skill-name> "<short description hint>"
```

Example:

```sh
/skill billing-lib "Internal billing library — edge cases, footguns, charge flow"
```

This scaffolds all five files/directories with the correct templates pre-filled. After creation:

1. Fill in `SKILL.md` → `## Key Facts` with what the model needs to *know* (not do): file paths, data shapes, naming rules, API shapes.
2. Add any reusable scripts to `scripts/` and reference them in `## File & Directory Map`.
3. Add output templates or static assets to `assets/`.
4. If the skill needs per-user config (e.g. a Slack channel), keep the `## Configuration` section and define the shape of `config.json`.
5. If the skill benefits from remembering past runs, keep the `## Memory` section and choose a log file format.
6. Remove the `## Configuration` and `## Memory` sections if the skill needs neither.

Gotchas and history accumulate automatically as the agent works — you should not need to edit those files manually.
