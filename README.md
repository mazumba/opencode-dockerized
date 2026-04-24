# opencode-dockerized

Run [opencode](https://opencode.ai) inside Docker instead of installing it locally.

## Documentation Map

- `README.md` (this file): Docker setup, run flow, auth, config, and security notes.
- `docs/opencode-commands-skills-tools.md`: slash commands, skills, and custom tool reference.
- `.opencode/config/AGENTS.md`: default agent behavior and skill loading policy.

## Quick Start

```sh
# 1) Build image (run once, or after Dockerfile changes)
make opencode-build

# 2) Start container
make opencode-run
# -> http://localhost:4096

# 3) Stop and remove container
make opencode-down
```

## Initial Setup

Before first run, copy the override template and set the **full absolute path** to your projects directory.
Full paths are required to avoid Docker-in-Docker volume mounting issues.

```sh
cp compose.override.yml.dist compose.override.yml
```

Edit `compose.override.yml` and replace the placeholder path:

```yaml
services:
  opencode:
    volumes:
      - /full/path/to/my/projects:/full/path/to/my/projects
```

The container runs as a non-root user matching your host `UID`/`GID` (detected automatically by the `Makefile`).

## Authentication (`auth.json`)

If you already use opencode locally, you can reuse existing credentials and skip signing in again:

```sh
# macOS / Linux
cp ~/.local/share/opencode/auth.json .opencode/share/auth.json
```

Otherwise, run `make opencode-run`, open `http://localhost:4096`, and authenticate in the UI.
Credentials are written automatically to `.opencode/share/auth.json`.

> **Note:** `auth.json` may contain provider tokens. It is covered by `.gitignore` and is not committed.

## Configuration (`opencode.json`)

`.opencode/config/` is mapped to the opencode config directory inside the container.
Create or edit `.opencode/config/opencode.json` to customize behavior:

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

This file is gitignored, so local customization does not affect others.

### Agent Defaults (`AGENTS.md`)

This repo uses `.opencode/config/AGENTS.md` to define default skill-loading behavior.

- `concise-precise` is loaded by default for user-facing responses.
- `karpathy-guidelines` is loaded on top for non-trivial code changes.

This means response style stays concise by default, while coding workflow guidance is added when implementation tasks are complex.

### Permissions

The `permission` field controls which tool calls require approval.
The example above asks for confirmation on every `bash` command while allowing everything else.

To require approval for additional tools:

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

See the [permissions docs](https://opencode.ai/docs/permissions) for all options.

## Docker Socket Access

The container mounts `/var/run/docker.sock` so opencode can run Docker commands on the host.
Socket permissions are handled automatically at startup by `docker/entrypoint.sh`:
it reads the socket owner GID and adds the `opencode` user to that group before dropping privileges.

Mounting the Docker socket grants the container full access to the host Docker daemon,
so this setup does not provide meaningful isolation from the host.

| Host OS                | Typical socket GID |
|------------------------|--------------------|
| macOS (Docker Desktop) | `0` (`root`)       |
| Linux (Docker Engine)  | `999` or varies    |

## Further Reading

This repo includes custom slash commands, a reusable skill system, and a PDF extraction tool.

See [OpenCode commands, skills, and tools](docs/opencode-commands-skills-tools.md) for the full command catalog and skill/tool reference.

If you only need the defensive baseline in a project:

```sh
/security-profile init
/security-profile refresh
```

Happy agentic coding! Suggestions welcome!
