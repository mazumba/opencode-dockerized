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
# -> http://localhost:4096 (user: opencode, password: OPENCODE_SERVER_PASSWORD)

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

Set a password for the web UI and server API in `.env`. The container refuses to start without one:

```sh
OPENCODE_SERVER_PASSWORD=<output of: openssl rand -base64 24>
```

The browser asks for it on first visit. The username is `opencode`.

The port is published on `127.0.0.1` only, so other machines on your network cannot reach it. The password also blocks requests that web pages in your own browser send to `localhost:4096`.

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
| `image`   | `vips` (re-encode/strip images), `exiftool` (inspect metadata), `clamav`/`clamav-freshclam` (scan for malware) — see [Image plugin](#image-plugin) below |
| `github`  | GitHub CLI (`gh`) and git, authenticated as a GitHub App — see [GitHub plugin](#github-plugin) below |

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
- **Only the `browse` agent gets the tools.** The plugin ships `browser.agent.jsonc`, which defines a `browse` subagent with `"playwright_*": "allow"`. The build also adds `"playwright_*": "deny"` to the global `permission` block, so no other agent loads the Playwright tool definitions or the large page snapshots they return. Other agents hand browser work to `browse`, which replies with a short summary.
- **Requires the markers.** Your `opencode.jsonc.base` needs the `// {{agent-plugins}}` and `// {{permission-plugins}}` markers (see `opencode.jsonc.base.dist`). If one is missing, the build stops with an error. Remove any hand-written `browse` agent from your base file; the plugin provides it.
- **oh-my-opencode-slim orchestrator.** Slim grants MCP tools per agent from its `mcps` list, which overrides the global deny. Add `"!playwright"` to the orchestrator's `mcps` (already set in `oh-my-opencode-slim.json.dist`).
- **Non-persistent state.** No browser profile or cache is retained across container restarts (non-persistent by design).
- **Standard outbound network.** The container uses the same outbound network as the base image; no extra network restrictions are added for browser traffic.
- **Reaching host services.** To access services running on the host machine from within the browser (e.g. a local dev server), use `host.docker.internal` instead of `localhost`.

**Operations:**

- **Owner:** Repo Maintainers
- **Cadence:** Monthly dependency/version review + immediate review on any OpenCode release, `@playwright/mcp` release, or CVE advisory. Review cadence: monthly.

### Image plugin

The `image` plugin installs `vips` (via `libvips-tools`), `exiftool` (via `libimage-exiftool-perl`), and `clamav`/`clamav-freshclam`. `vips`, `exiftool`, and `clamscan` are CLI tools the agent invokes manually per file (see the recommended order below) — they do not run on a schedule or watch for files.

**Opt-in:**

```sh
# .env
PLUGINS=image
```

```sh
make opencode-build-plugins
make opencode-run
```

**Startup behavior:** every container start runs `docker/plugins/image/image.entrypoint.sh` as root, before the privilege drop to the `opencode` user:

1. `freshclam --stdout` updates the virus definitions. This requires network access to the ClamAV signature mirrors on every start — there is no startup-time skip or caching of "already up to date"; the update runs unconditionally. If it fails, container startup fails (fail-closed) rather than starting with stale or missing definitions.
2. The hook then proves the final `opencode` user can actually load and use that database, by running `gosu opencode clamscan --no-summary -- /usr/bin/true` against a harmless, stable file. If this readiness check fails, startup also fails.

The virus definitions in `/var/lib/clamav` persist across container recreations **only** when the `image` plugin's Compose fragment is applied (i.e. you build/run through `docker/compose-with-plugins.sh`, which the `Makefile` targets do) — it declares the named volume `clamav_db` mounted at `/var/lib/clamav`. Without that fragment, `freshclam` re-downloads the full database on every start.

**Recommended first-pass order for an untrusted image** (virus definitions are already current thanks to the startup hook above):

1. Scan the original file:
   ```sh
   clamscan "/path/to/input.jpg"
   ```
2. Decode and re-encode with `vips`, stripping metadata explicitly. The `[strip]` option must be set per output format (JPEG, PNG, WebP):
   ```sh
   vips copy "/path/to/input.jpg" "/path/to/output.jpg[strip]"
   ```
3. Inspect the re-encoded output with ExifTool — some technical fields (image dimensions, color profile, format-level tags) are always present and expected; the goal is confirming no unexpected metadata survived, not an empty report:
   ```sh
   exiftool "/path/to/output.jpg"
   ```
4. Scan the re-encoded output again:
   ```sh
   clamscan "/path/to/output.jpg"
   ```

**`clamscan` exit codes:** `0` = clean, `1` = virus/malware detected, `2` = error (e.g. file access, corrupted definitions). Treat a non-zero exit as a signal to stop and investigate manually — do not script automatic deletion of flagged files.

**Important caveat:** ClamAV scanning supplements the vips re-encode step; it does not prove a file is safe or uncompromised. Signature-based scanning only catches known threats, and image parsers can have undiscovered vulnerabilities. Re-encoding through `vips` (which discards the original byte stream and rebuilds pixel data) is the primary defense; ClamAV is a secondary check, not a guarantee.

### GitHub plugin

The `github` plugin installs `gh` and configures git to authenticate as a **GitHub App** installation rather than a personal account — commits, pushes, issues, and PRs are all attributed to the App's bot identity (`<slug>`), not to you.

**1. Create the App:** [github.com/settings/apps](https://github.com/settings/apps) → New GitHub App. Uncheck "Active" under Webhook. Set repository permissions:

| Permission | Level |
|---|---|
| Contents | Read & write |
| Issues | Read & write |
| Pull requests | Read & write |
| Everything else | No access |

**2. Generate a private key** on the App's page — downloads a `.pem` file. Note the **App ID** shown at the top of the page.

**3. Install the App** via "Install App" in the sidebar, choosing which account/repos it can access. Note the **Installation ID** — the number in the URL after installing (`/settings/installations/<id>`).

**4. Store the private key outside the repo** — e.g. `~/.config/opencode-secrets/github-app.pem`. Never place it under this project's directory, even gitignored: editors, search indexes, and backup tools don't respect `.gitignore`.

**5. Set in `.env`:**

```sh
# .env
PLUGINS=github
GH_APP_ID=123456
GH_APP_PRIVATE_KEY_PATH=/home/you/.config/opencode-secrets/github-app.pem
# Only needed if the App is installed on more than one account:
#GH_APP_INSTALLATION_ID=
```

`GH_APP_PRIVATE_KEY_PATH` accepts absolute paths, `~/...`, and relative paths (resolved from the repo root, where `compose.yml` lives). If the path doesn't exist, Docker mounts an empty directory instead; the startup hook detects this and aborts with a clear error.

```sh
make opencode-build-plugins
make opencode-run
```

**Startup behavior:** every container start runs `docker/plugins/github/github.entrypoint.sh` as root, before the privilege drop to the `opencode` user. It signs a JWT with the mounted key, looks up the App's slug and (unless `GH_APP_INSTALLATION_ID` is set) its single installation, resolves the bot user's numeric id, verifies an installation access token can actually be minted, and configures git's credential helper and `user.name`/`user.email` for the `opencode` user. Any failure here — bad key, wrong App ID, App installed on more than one account without `GH_APP_INSTALLATION_ID` set — aborts container startup (fail-closed) rather than falling back to unauthenticated git.

**How auth stays fresh:** installation access tokens expire after 1 hour. `gh-app-token` (`/usr/local/lib/opencode/github/gh-app-token`) mints one on demand and caches it until ~5 minutes before expiry. The `gh` wrapper at `/usr/local/bin/gh` calls it before every invocation; the git credential helper calls it on every `get`. You don't need to do anything — just don't `git config --global credential.helper` or `user.email` yourself, as that would override what the hook set.

**Branch protection matters more than usual here.** `Contents: write` lets the bot force-push to or delete any branch, and merge its own PRs, unless you restrict it. Add a branch ruleset on `main` (Settings → Rules → Rulesets) requiring a PR with at least one approval and blocking force-push/deletion — the bot can't approve its own PR, so it can't merge it either. On GitHub Free this is only enforced on public repos; private repos need GitHub Pro (or Team, for organizations) for rulesets to apply.

**Revoking access:** uninstall the App, or delete/rotate the private key — either stops `gh-app-token` from minting new tokens within the hour.

### Adding a new plugin

Each plugin lives in its own subdirectory `docker/plugins/<name>/` and may include up to six files:

| File | Purpose | Required |
|---|---|---|
| `<name>.dockerfile` | apt/system dependencies injected into the image | Yes |
| `<name>.package.json` | npm deps merged into `.opencode/config/package.json` at build time | No |
| `<name>.opencode.jsonc` | MCP config fragment injected into `opencode.jsonc` at build time | No |
| `<name>.agent.jsonc` | agent fragment injected at `// {{agent-plugins}}`. If the plugin also ships an MCP fragment, that server's `<server>_*` tools are denied for all other agents at `// {{permission-plugins}}` (see [Browser MCP](#browser-mcp-playwright)) | No |
| `<name>.entrypoint.sh` | startup hook run as root before the privilege drop (see [Image plugin](#image-plugin) for an example) | No |
| `<name>.compose.yml` | Compose fragment layered onto `compose.yml` via `docker/compose-with-plugins.sh` | No |

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

### oh-my-opencode-slim (`oh-my-opencode-slim.json`)

The committed template is `.opencode/config/oh-my-opencode-slim.json.dist`. Copy it to get started:

```sh
cp .opencode/config/oh-my-opencode-slim.json.dist .opencode/config/oh-my-opencode-slim.json
```

The template differs from slim's defaults in two ways, both to keep tool definitions out of the context:

- **Marketplace tools disabled.** `"disabled_tools": ["marketplace_inspect", "marketplace_manage"]` stops slim from registering its package-management tools. Remove the entry to install marketplace packages through the agent again; restart OpenCode afterwards. A short marketplace section remains in slim's built-in orchestrator prompt.
- **No Playwright in the orchestrator.** `"!playwright"` in the orchestrator's `mcps` leaves browser work to the `browse` agent (see [Browser MCP](#browser-mcp-playwright)).

`oh-my-opencode-slim.json` is gitignored.

### Agent Defaults (`AGENTS.md`)

`.opencode/config/AGENTS.md` holds the global working rules every agent loads, including subagents:

- **Working Style**: state assumptions, make surgical changes, turn tasks into verifiable goals.
- **Response Style**: concise answers by default; say "normal mode" to switch off.

Both used to be the `karpathy-guidelines` and `concise-precise` skills; they live in `AGENTS.md` now so they apply without depending on skill loading.

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
