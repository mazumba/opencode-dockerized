# opencode-dockerized

Run [opencode](https://opencode.ai) inside Docker instead of installing it locally.

## Documentation Map

- `README.md` (this file): Docker setup, plugins, run flow, auth, config, and security notes.
- `.env.dist`: template for local environment variables (`PLUGINS`, `OPENCODE_VERSION`, etc.).
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

Before first run, copy both templates and configure them for your environment.

**1. Compose override** — sets the path to your projects directory.
Full absolute paths are required to avoid Docker-in-Docker volume mounting issues.

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

**2. Environment file** — sets local configuration variables.

```sh
cp .env.dist .env
```

The container runs as a non-root user matching your host `UID`/`GID` (detected automatically by the `Makefile`).

To pin a specific OpenCode version, set `OPENCODE_VERSION` in `.env`:

```sh
OPENCODE_VERSION=1.15.4
```

## Plugins

Plugins extend the base image with additional tools and libraries.
They are installed as separate optional layers — the base image stays lean by default.

Available plugins:

| Plugin    | Adds |
|-----------|------|
| `midi`    | `fluidsynth`, `timidity`, `mido`, `pretty_midi`, `music21`, and related Python audio libraries |
| `excel`   | `openpyxl` for reading and writing `.xlsx` files |
| `browser` | Playwright Chromium (headless, MCP-controlled) — see [Browser MCP](#browser-mcp-playwright) below |

To enable plugins, set `PLUGINS` in your `.env` file (comma-separated):

```sh
PLUGINS=midi,excel
```

Then build with:

```sh
make opencode-build-plugins
```

### Browser MCP (Playwright)

The `browser` plugin adds [`@playwright/mcp@0.0.72`](https://github.com/microsoft/playwright-mcp) — a local MCP server that lets the `browse` agent control a headless Chromium browser.

**Opt-in:**

```sh
# .env
PLUGINS=browser
```

```sh
make opencode-build-plugins
make opencode-run
```

**Runtime behavior:**

- **Headless by default.** The browser runs without a visible UI (`PLAYWRIGHT_HEADLESS=true`).
- **Enabled when active.** The MCP entry is `enabled: true` when the browser plugin is active — activating the plugin is the opt-in.
- **Tool access is user-configurable.** By default all agents can use `playwright_*` tools. Restrict or scope access via `opencode.jsonc` if needed.
- **Non-persistent state.** No browser profile or cache is retained across container restarts (non-persistent by design).
- **Standard outbound network.** The container uses the same outbound network as the base image; no extra network restrictions are added for browser traffic.

**Operations:**

- **Owner:** Repo Maintainers
- **Cadence:** Monthly dependency/version review + immediate review on any OpenCode release, `@playwright/mcp` release, or CVE advisory. Review cadence: monthly.

### Adding a new plugin

Each plugin lives in its own subdirectory `docker/plugins/<name>/` and may include up to three files:

| File | Purpose | Required |
|---|---|---|
| `<name>.dockerfile` | apt/system dependencies injected into the image | Yes |
| `<name>.package.json` | npm deps merged into `.opencode/config/package.json` at build time | No |
| `<name>.opencode.jsonc` | MCP config fragment injected into `opencode.jsonc` at build time | No |

Copy the template for the Dockerfile layer:

```sh
cp docker/plugins/plugin.dockerfile.dist docker/plugins/myplugin/myplugin.dockerfile
```

The template documents the available package managers (`apt-get`, `pip`) and their conventions for this base image.

## Authentication (`auth.json`)

If you already use opencode locally, you can reuse existing credentials and skip signing in again:

```sh
# macOS / Linux
cp ~/.local/share/opencode/auth.json .opencode/share/auth.json
```

Otherwise, run `make opencode-run`, open `http://localhost:4096`, and authenticate in the UI.
Credentials are written automatically to `.opencode/share/auth.json`.

> **Note:** `auth.json` may contain provider tokens. It is covered by `.gitignore` and is not committed.

## Configuration (`opencode.jsonc`)

`.opencode/config/` is mapped to the opencode config directory inside the container.
The committed template is `.opencode/config/opencode.jsonc.base.dist`. Copy it to get started:

```sh
cp .opencode/config/opencode.jsonc.base.dist .opencode/config/opencode.jsonc.base
```

Edit `opencode.jsonc.base` to customize behavior — providers, models, permissions, agents.
When you run `make opencode-build-plugins`, this file is used to generate `opencode.jsonc`.

> **Note:** Do not edit `opencode.jsonc` directly — it is a generated file and will be overwritten on the next plugin build. Edit `opencode.jsonc.base` instead.

If you are not using plugins, you can create `opencode.jsonc` directly:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "share": "disabled",
  "enabled_providers": ["github-copilot"],
  "permission": {
    "bash": "ask",
    "*": "allow"
  }
}
```

Both files are gitignored, so local customization does not affect others.

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
