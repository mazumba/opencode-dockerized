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
| `linear`  | Linear remote MCP and a `linear` subagent, authenticated with a Linear API key — see [Linear plugin](#linear-plugin) below |
| `kanban`  | Linear kanban workflow: agents implement and review tickets, you merge. Requires `linear` and `github` — see [Kanban plugin](#kanban-plugin) below |

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

**Startup behavior:** every container start runs `docker/plugins/github/github.entrypoint.sh` as root, before the privilege drop to the `opencode` user. It signs a JWT with the mounted key, looks up the App's slug and (unless `GH_APP_INSTALLATION_ID` is set) its single installation, mints an installation access token, uses it to resolve the bot user's numeric id, and configures git's credential helper and `user.name`/`user.email` for the `opencode` user. Any failure here — bad key, wrong App ID, App installed on more than one account without `GH_APP_INSTALLATION_ID` set — aborts container startup (fail-closed) rather than falling back to unauthenticated git. Errors name the failed step and include GitHub's HTTP status and message.

**Hidden bot account (e.g. enterprise orgs):** the commit email needs the numeric user id of the App's bot account, `<slug>[bot]`. This is not the App ID or the Client ID. Some orgs hide that account, and startup then fails at "bot lookup". Find the id while logged in as an org member, with `gh api "/users/<slug>%5Bbot%5D" --jq .id`, or read `user.id` from any issue, comment or PR the bot created. Then set it in `.env`:

```sh
GH_APP_BOT_USER_ID=123456789
```

**How auth stays fresh:** installation access tokens expire after 1 hour. `gh-app-token` (`/usr/local/lib/opencode/github/gh-app-token`) mints one on demand and caches it until ~5 minutes before expiry. The `gh` wrapper at `/usr/local/bin/gh` calls it before every invocation; the git credential helper calls it on every `get`. You don't need to do anything — just don't `git config --global credential.helper` or `user.email` yourself, as that would override what the hook set.

**Branch protection matters more than usual here.** `Contents: write` lets the bot force-push to or delete any branch, and merge its own PRs, unless you restrict it. Add a branch ruleset on `main` (Settings → Rules → Rulesets) requiring a PR with at least one approval and blocking force-push/deletion — the bot can't approve its own PR, so it can't merge it either. On GitHub Free this is only enforced on public repos; private repos need GitHub Pro (or Team, for organizations) for rulesets to apply.

**Revoking access:** uninstall the App, or delete/rotate the private key — either stops `gh-app-token` from minting new tokens within the hour.

### Linear plugin

The `linear` plugin adds Linear's remote MCP server (`https://mcp.linear.app/mcp`) and a `linear` subagent for reading, searching, creating, and updating issues, projects, cycles, and comments. It authenticates with a Linear personal API key.

**1. Create an API key** in Linear: Settings → Account → Security & Access → Personal API keys. For read-only access, create the key with only the Read permission.

**2. Set in `.env`:**

```sh
# .env
PLUGINS=linear
LINEAR_API_KEY=lin_api_...
```

```sh
make opencode-build-plugins
make opencode-run
```

**Startup behavior:** every container start runs `docker/plugins/linear/linear.entrypoint.sh` as root, before the privilege drop. It queries the Linear GraphQL API with the key and prints `linear plugin: ready (<user> @ <organization>)`. If the key is missing or Linear rejects it, container startup fails (fail-closed).

**Access:** only the `linear` subagent can call `linear_*` tools. The build denies them for every other agent, which delegate Linear work to `linear` and get back a short summary. Your `opencode.jsonc.base` needs the `// {{agent-plugins}}` and `// {{permission-plugins}}` markers, as for the browser plugin.

**Security notes:**

- The key is in the container environment, so any agent with `bash` can read it. Use a dedicated key, or a Read-only key if writes are not needed.
- Everything the agent writes in Linear is attributed to the key's owner.
- OAuth is not supported: its callback targets `localhost` inside the container.

### Kanban plugin

The `kanban` plugin turns a Linear board (team `DEY`) into a work queue. Agents refine, implement, and review tickets; a human approves and merges the pull requests. It needs the `linear` and `github` plugins (declared in `kanban.requires`; the build fails if either is missing from `PLUGINS`). It adds three primary agents (`ticket-worker`, `ticket-reviewer`, `ticket-investigator`) and four slash commands.

**Lanes** (Linear workflow states, exact names):

| Lane | Moved there by |
|------|----------------|
| `Backlog` | human (new tickets); the poller, when a `Ready for agent` ticket is not refined |
| `Ready for agent` | human, after refinement. Counts as approval for the poller to create the worktree and ticket branch, and for the worker to push it |
| `In Progress` | the poller (claim); `/review-ticket` (changes requested) |
| `Agent review` | `/work-ticket` (PR opened or fixes pushed) |
| `Ready for merge` | `/review-ticket` (clean review) |
| `Done` | Linear's GitHub integration, when the human merges the PR |
| `Needs human` | agents, on any blocker or after 2 review rounds |
| `Canceled` | human |

**Labels:**

- `needs grilling`: scope is unclear; the human clarifies it with `/grill-ticket`.
- `investigate`: facts are missing; the human starts `/investigate-ticket`.
- `refined`: set by `/grill-ticket` when scope and acceptance criteria are agreed.
- `agent:changes-requested`: set by `/review-ticket`, removed by the poller when it starts the fix round.

`needs grilling` and `investigate` both mean "not refined". `refined` marks a ticket that went through grilling. Only refined tickets go to `Ready for agent`.

**Refinement flow:**

1. A new ticket gets `investigate` or `needs grilling`.
2. The human comments `/investigate` on the ticket. The agent posts an `Agent investigation:` comment; labels and state stay as they are.
3. The human runs `/grill-ticket <ID>` in a normal session, agrees on scope and acceptance criteria, and confirms the new description. `needs grilling` is replaced by `refined`.
4. The human moves the ticket to `Ready for agent` (the commands never change this state).
5. The poller bounces tickets that still carry either label back to `Backlog`.

Investigation and grilling are always started by the human.

**Answering a few questions without grilling:** write the answers as a ticket comment, add the label `refined`, then move the ticket to `Ready for agent`. Removing `needs grilling` alone is not enough: the poller adds it again to every `Backlog` ticket that has none of the three labels.

**What counts as the spec.** The agents read the ticket description plus all comments (Linear and GitHub-synced), oldest to newest. A newer statement overrides an older one. Human comments, including GitHub-synced ones, outrank `Agent investigation:` proposals: an investigation is input, a human answer is a decision. Status comments (`Agent:`, `Agent review:`, `Agent investigation: skipped`, `Agent investigation: failed`) are not spec. If comments contradict each other and their order does not resolve it, the agent moves the ticket to `Needs human` with the open question instead of guessing. The reviewer checks the PR against the same spec.

**Commands:**

| Command | Agent | Started by |
|---------|-------|------------|
| `/work-ticket <ID> ctx:<json>` | `ticket-worker` | poller only |
| `/review-ticket <ID> ctx:<json>` | `ticket-reviewer` | poller only |
| `/investigate-ticket <ID> ctx:<json> [question]` | `ticket-investigator` (read-only) | poller, on a human `/investigate` comment (see below) |
| `/grill-ticket <ID>` | the primary agent of your current session (interactive) | human only |

`/work-ticket`, `/review-ticket`, and `/investigate-ticket` stop and change nothing when the arguments lack ` ctx:`.

**Linear project format.** Each Linear project maps to one repository. Its description must contain these lines:

```text
repo: owner/name
path: /absolute/path/to/checkout
```

Host repositories must be mounted into the container at identical paths (see `compose.override.yml`), so `path` is valid both on the host and in the container.

**Manual setup checklist:**

- [ ] In Linear team `DEY`, create the workflow states listed above and the four labels (`needs grilling`, `investigate`, `refined`, `agent:changes-requested`).
- [ ] Add `repo:` and `path:` lines to every project description, and mount each checkout at the same path in `compose.override.yml`.
- [ ] In each repo, commit the managed worktrees block to `.gitignore` (`.slim/worktrees/` and `.slim/worktrees.json` between the `oh-my-opencode-slim worktrees` markers). The poller's pre-flight requires `.slim/worktrees/` to be ignored. Agents do not edit `.gitignore`.
- [ ] If you use Linear's GitHub Issues sync, sync GitHub to Linear only, and set the project on synced tickets before moving them to `Ready for agent`.
- [ ] Keep the Linear GitHub automation "PR merged moves the ticket to Done" and disable the other PR automations, so only agents move tickets through the middle lanes.
- [ ] Enable branch protection on `main` that requires a human approval.

**Security notes:**

- Both implementing and reviewing agents have unrestricted `bash`. Branch protection on GitHub is the only merge gate.
- The Docker socket is mounted (see [Docker Socket Access](#docker-socket-access)), so an agent can control the host.
- `LINEAR_API_KEY` is readable by every agent with `bash`.
- Linear writes are attributed to the key's owner.
- The trust model assumes a private repository: every ticket comment, including GitHub-synced ones, is part of the spec. If the synced GitHub repo becomes public, or a public repo is linked to a project, anyone can write spec through GitHub comments. Reconsider this before that happens.
- The commands carry Hard limits that apply to whoever wrote the text (never reveal secrets, never work outside the worktree or in another repo, never change credentials, never merge or approve). They are instructions to the model, not technical enforcement.

#### Poller

The poller is an optional container that runs the agent commands unattended. It reuses the opencode image and talks to Linear and to the `opencode` container over HTTP. It reads PRs and CI checks, and runs `git fetch`, through its own GitHub App credentials (`KANBAN_GH_APP_ID`, `KANBAN_GH_APP_PRIVATE_KEY_PATH`, see below) and needs your projects directory mounted at the same path as in `opencode` (the `kanban-poller:` service in `compose.override.yml`, see `compose.override.yml.dist`) for pre-flight checks, worktree creation, and worktree cleanup. No Docker socket, no ports. It keeps no state; startup recovery handles stale claims.

Each pass (default every 60 s) performs at most one agent run:

1. Adds `needs grilling` to every `Backlog` ticket that has none of `needs grilling`, `investigate`, `refined`. No agent run.
2. Handles `/investigate` comments (see below) and runs `/investigate-ticket` on any ticket, in any state.
3. Gates the oldest ticket in `Agent review` on its PR before any agent runs:
   - CI pending: waits, no agent.
   - CI failed or merge conflicts: the poller moves the ticket to `In Progress`, adds `agent:changes-requested`, and comments `Agent review: changes requested (round n/2) — <PR URL>` with `CI failed: <names>` or `merge conflicts with <base>` (plus the failing log tail as a reply). This counts toward the 2-round limit (rounds are counted since the ticket last entered `Ready for agent`); at the limit the ticket goes to `Needs human`.
   - No PR, PR closed or merged, or no CI checks configured: `Needs human`.
   - CI green and no conflicts: runs `/review-ticket`.
4. Runs `/work-ticket` (fix round; the cause is `ci`, `conflict`, or `review`) for the oldest `In Progress` ticket labelled `agent:changes-requested`, after claiming it with a 👀 reaction on the issue, removing the label, and preparing the worktree.
5. Runs `/work-ticket` for the oldest `Ready for agent` ticket after claiming it with a 👀 reaction on the issue, moving it to `In Progress`, and preparing the worktree. If the ticket branch already has an open PR (a follow-up, see below), the worker gets it and pushes there; a merged or closed PR sends the ticket to `Needs human` ("open a new ticket"). A ticket that still has `needs grilling` or `investigate` is moved back to `Backlog` instead, and the next ticket is considered.
6. Cleanup, each pass: for tickets in `Ready for merge`, `Done`, or `Canceled` (the last two updated within 14 days) whose PR is merged (or closed, for `Canceled`) and whose worktree `<path>/.slim/worktrees/<id>` exists, the poller removes the worktree (`git worktree remove`, no force), deletes the local branch, and drops the lane from `.slim/worktrees.json`. It does so only if the worktree is clean and the local branch tip equals the PR head SHA; otherwise it skips and logs.

**Follow-up after `Ready for merge`:** comment the changes you want on the ticket and move it to `Ready for agent` (before merging the PR). The worker updates the same PR instead of opening a new one, and the ticket goes through agent review again. Each request gets a fresh 2 review rounds. If the PR was already merged or closed, the ticket goes to `Needs human`; open a new ticket instead.

Before a work or fix run, a pre-flight checks the project's `repo:` and `path:`, that `path` is a git repo, and that `origin` matches `repo:`. It also requires `.slim/worktrees/` to be git-ignored. A failure moves the ticket to `Needs human` without an agent run. After pre-flight, the poller fetches `origin` and creates (or reuses) the worktree `<path>/.slim/worktrees/<id>` on the ticket branch, with its `.slim/worktrees.json` lane; the worker only works inside it.

After a work or review run, the ticket must be in `Agent review` (or `Needs human`, for work), otherwise the poller moves it to `Needs human` with the reason (exit code, timeout, or the state it ended in). At startup, `In Progress` tickets whose poller 👀 reaction is older than the work timeout go to `Needs human` with the reason `stale claim`. On SIGTERM the running agent is killed and its ticket goes to `Needs human` with the reason `poller stopped`.

**Investigate comments.** Comment on any ticket, in any state, with any labels:

```text
/investigate
Optional question, on the same line or the following lines.
```

The first line must be exactly `/investigate` or start with `/investigate `. Only comments written by the API key owner count; comments with an external user, a bot actor, or a sync marker (GitHub-synced comments) are ignored, as are comments older than 7 days. The poller reports progress as reactions on your comment:

| Reaction | Meaning |
|----------|---------|
| 👀 (`eyes`) | picked up; this is the claim, so the comment is not handled twice |
| ✅ (`white_check_mark`) | finished: a new `Agent investigation:` comment exists |
| 👀 + ❌ (`x`) | failed (non-zero exit, timeout, no new investigation comment, or `poller stopped`); a reply `Agent investigation: failed — <reason>` explains |
| ❌ (`x`) only | config check failed before the claim (project `repo:`/`path:` or origin); a reply `Agent investigation: failed — <reason>` explains |

If the 👀 reaction cannot be added, nothing runs and the poller retries on the next pass. Legacy comments that already have a reply starting with `Agent investigation:` count as handled. Reactions by other users are ignored.

**Make targets** (the `kanban` plugin must be in `PLUGINS`, then rebuild with `make opencode-build-plugins`):

| Target | Does |
|--------|------|
| `make kanban-poller-run` | start the poller in the background |
| `make kanban-poller-logs` | follow its logs |
| `make kanban-poller-down` | stop and remove it |
| `make kanban-poller-once` | one real pass, then exit |
| `make kanban-poller-dry-run` | one pass, then exit; logs intended actions, no Linear writes, no agent runs |

**Environment** (`.env`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `LINEAR_API_KEY` | required | Linear API key (shared with the `linear` plugin) |
| `OPENCODE_SERVER_PASSWORD` | required | password of the opencode server the poller attaches to |
| `KANBAN_GH_APP_ID` | required | ID of the GitHub App the poller uses |
| `KANBAN_GH_APP_PRIVATE_KEY_PATH` | required | host path to that App's private key (`.pem`), mounted read-only |
| `KANBAN_GH_APP_INSTALLATION_ID` | empty | only needed if the App is installed on more than one account |
| `KANBAN_TEAM` | `DEY` | Linear team key |
| `KANBAN_POLL_INTERVAL` | `60` | seconds between passes |
| `KANBAN_OPENCODE_URL` | `http://opencode:4096` | opencode server to attach to |
| `KANBAN_TIMEOUT_WORK` | `60` | minutes before a work run is killed |
| `KANBAN_TIMEOUT_REVIEW` | `20` | minutes before a review run is killed |
| `KANBAN_TIMEOUT_INVESTIGATE` | `20` | minutes before an investigation is killed |

The `KANBAN_GH_APP_*` variables are required whenever `kanban` is in `PLUGINS`; compose refuses to start without them. To reuse the `github` plugin's App, set them to the same values as `GH_APP_ID` and `GH_APP_PRIVATE_KEY_PATH`. The poller only reads from GitHub, so you can instead create a separate App with these repository permissions, all read-only: Contents, Pull requests, Checks, Commit statuses, Actions (for failed-run logs), and Metadata. The same App is used for `git fetch`, so add Contents: read. Worktree and branch cleanup uses local git only and needs no GitHub write access.

The poller logs only ticket identifiers, actions, results, and durations: never the key, comment text, or ticket text. It exits with an error at startup if a required variable is missing, or if a state or label name is missing in Linear.

**Poller security notes:**

- It runs agents unattended with unrestricted `bash`.
- `main` is not protected by the plugin: unless you enable branch protection, an agent can push to `main`.
- Delegation to subagents is allowed, so a run can hang until its timeout kills it. The worker, reviewer, and investigator may only delegate to the read-only `explorer` and `librarian` subagents; all edits, commits, and pushes stay with the worker itself.

### Adding a new plugin

Each plugin lives in its own subdirectory `docker/plugins/<name>/` and may include up to eight files:

| File | Purpose | Required |
|---|---|---|
| `<name>.dockerfile` | apt/system dependencies injected into the image | Yes |
| `<name>.package.json` | npm deps merged into `.opencode/config/package.json` at build time | No |
| `<name>.opencode.jsonc` | MCP config fragment injected into `opencode.jsonc` at build time | No |
| `<name>.agent.jsonc` | agent fragment injected at `// {{agent-plugins}}`. If the plugin also ships an MCP fragment, that server's `<server>_*` tools are denied for all other agents at `// {{permission-plugins}}` (see [Browser MCP](#browser-mcp-playwright)) | No |
| `<name>.entrypoint.sh` | startup hook run as root before the privilege drop (see [Image plugin](#image-plugin) for an example) | No |
| `<name>.compose.yml` | Compose fragment layered onto `compose.yml` via `docker/compose-with-plugins.sh` | No |
| `<name>.requires` | plugin names this plugin depends on, one per line (`#` comments and blank lines ignored). The build fails if one is missing from `PLUGINS` | No |
| `<name>.commands/` | slash-command files (`<command>.md`) copied into `.opencode/config/commands/` on build and removed again when the plugin is disabled (tracked in `.opencode/config/commands/.plugin-commands`). The build fails if a file would overwrite an existing command or another plugin's command | No |

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
