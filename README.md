# opencode-dockerized

Run [opencode](https://opencode.ai) inside a Docker container with the Docker CLI mounted and access to the host Docker socket.

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
