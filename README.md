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
  # Only with the kanban plugin: the same path again.
  kanban-poller:
    volumes:
      - /full/path/to/my/projects:/full/path/to/my/projects
```

**2. Environment file** — sets local configuration variables.

```sh
cp .env.dist .env
```

With the kanban plugin, also set `KANBAN_PROJECTS_ROOT` (the projects path from step 1). The poller uses the github plugin's App. See the [kanban env table](#kanban-plugin).

Set a password for the web UI and server API in `.env`. The container refuses to start without one:

```sh
OPENCODE_SERVER_PASSWORD=<output of: openssl rand -base64 24>
```

The browser asks for it on first visit. The username is `opencode`.

The port is published on `127.0.0.1` only, so other machines on your network cannot reach it. The password also blocks requests that web pages in your own browser send to `localhost:4096`.

The container runs as a non-root user matching your host `UID`/`GID` (detected automatically by the `Makefile`).

To pin a specific OpenCode version, set `OPENCODE_VERSION` in `.env`:

```sh
OPENCODE_VERSION=1.19.4
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
| `image`   | `vips` for creating AVIF and WebP images — see [Image plugin](#image-plugin) below |
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

The `image` plugin installs `vips` (via `libvips-tools`) so the agent can create AVIF and WebP images, for example for a website. `vips` is a CLI tool the agent runs per file.

**Opt-in:**

```sh
# .env
PLUGINS=image
```

```sh
make opencode-build-plugins
make opencode-run
```

**Examples:**

```sh
vips copy input.png "output.avif[Q=50,strip]"
vips copy input.png "output.webp[Q=80,strip]"
```

`Q` sets the quality (1–100). `strip` removes metadata such as camera data or GPS coordinates from the output. Resize first with `vips thumbnail input.png resized.png 1200` if the image is larger than it will be shown.

### GitHub plugin

The `github` plugin installs `gh` and configures git to authenticate as a **GitHub App** installation rather than a personal account — commits, pushes, issues, and PRs are all attributed to the App's bot identity (`<slug>`), not to you.

**1. Create the App:** [github.com/settings/apps](https://github.com/settings/apps) → New GitHub App. Uncheck "Active" under Webhook. Set repository permissions:

| Permission | Level |
|---|---|
| Contents | Read & write |
| Issues | Read & write |
| Pull requests | Read & write |
| Checks | Read-only (kanban poller: review gate) |
| Commit statuses | Read-only (kanban poller: review gate) |
| Actions | Read-only (kanban poller: failed-run logs) |
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
| `In Progress` | the poller (claim, or changes requested by the review) |
| `Agent review` | the poller, after `/work-ticket` reports an open PR |
| `Ready for merge` | the poller, after `/review-ticket` approves |
| `Done` | Linear's GitHub integration, when the human merges the PR |
| `Needs human` | the poller, on any blocker an agent reports, on a failed run, or after 2 review rounds |
| `Canceled` | human |

**Labels:**

- `needs grilling`: scope is unclear; the human clarifies it with `/grill-ticket`.
- `investigate`: facts are missing; the human starts `/investigate-ticket`.
- `refined`: set by `/grill-ticket` when scope and acceptance criteria are agreed.
- `agent:changes-requested`: set by the poller when the review or CI asks for changes, removed when it starts the fix round.

`needs grilling` and `investigate` both mean "not refined". `refined` marks a ticket that went through grilling. Only refined tickets go to `Ready for agent`.

**Refinement flow:**

1. A new ticket gets `investigate` or `needs grilling`.
2. The human comments `/investigate` on the ticket. The agent posts an `Agent investigation:` comment; labels and state stay as they are.
3. The human runs `/grill-ticket <ID>` in a normal session, agrees on scope and acceptance criteria, and confirms the new description. `needs grilling` is replaced by `refined`.
4. The human moves the ticket to `Ready for agent` (the commands never change this state).
5. The poller bounces tickets that still carry either label back to `Backlog`.

Investigation and grilling are always started by the human.

**Answering a few questions without grilling:** write the answers as a ticket comment, add the label `refined`, then move the ticket to `Ready for agent`. Removing `needs grilling` alone is not enough: the poller adds it again to every `Backlog` ticket that has none of the three labels.

**What counts as the spec.** The agents read the ticket description plus all comments (Linear and GitHub-synced), oldest to newest. A newer statement overrides an older one. Human comments, including GitHub-synced ones, outrank `Agent investigation:` proposals: an investigation is input, a human answer is a decision. Status comments (`Agent:`, `Agent review:`, `Agent investigation: skipped`, `Agent investigation: failed`) are not spec. If comments contradict each other and their order does not resolve it, the agent reports `needs-human` with the open question instead of guessing. The reviewer checks the PR against the same spec.

**Commands:**

| Command | Agent | Started by |
|---------|-------|------------|
| `/work-ticket <ID> ctx:<json>` | `ticket-worker` | poller only |
| `/review-ticket <ID> ctx:<json>` | `ticket-reviewer` | poller only |
| `/investigate-ticket <ID> ctx:<json> [question]` | `ticket-investigator` (read-only) | poller, on a human `/investigate` comment (see below) |
| `/grill-ticket <ID>` | the primary agent of your current session (interactive) | human only |

`/work-ticket`, `/review-ticket`, and `/investigate-ticket` stop and change nothing when the arguments lack ` ctx:`.

**Linear project format.** Each Linear project maps to one repository. Its description needs one line:

```text
repo: owner/name
```

That line and the GitHub App installed on the repository are the whole setup; nothing has to be committed to the repo. The checkout is `<KANBAN_PROJECTS_ROOT>/<name>` (the name part of `owner/name`), which the poller clones over HTTPS if it is missing. To use another location, add `path: /absolute/path/to/checkout`; an explicit `path:` always wins. Without `path:` and without `KANBAN_PROJECTS_ROOT` the ticket goes to `Needs human`.

The projects root (or each explicit `path:`) must be mounted at the same path in both the `opencode` and the `kanban-poller` container (`compose.override.yml`, see `compose.override.yml.dist`), and that path must be the real host path: the Docker daemon resolves the bind mounts of lane stacks on the host. If a directory with the default name already holds another repository (`a/web` and `b/web`), the ticket goes to `Needs human` with `path collision`; give one of the projects an explicit `path:`. The poller never clones into a non-empty directory that is not a git repository.

**Manual setup checklist:**

- [ ] In Linear team `DEY`, create the workflow states listed above and the four labels (`needs grilling`, `investigate`, `refined`, `agent:changes-requested`).
- [ ] Add a `repo: owner/name` line to every project description (and `path:` only where the checkout is not `<KANBAN_PROJECTS_ROOT>/<name>`), install the GitHub App on the repository, and mount the projects root at the same path in `compose.override.yml`.
- [ ] Nothing in the repo is needed. If `.slim/worktrees/` is not git-ignored, the poller adds it (and `.slim/worktrees.json`) to the checkout's `.git/info/exclude`, which is local and shared by all its worktrees.
- [ ] If you use Linear's GitHub Issues sync, sync GitHub to Linear only, and set the project on synced tickets before moving them to `Ready for agent`.
- [ ] Keep the Linear GitHub automation "PR merged moves the ticket to Done" and disable the other PR automations, so only agents move tickets through the middle lanes.
- [ ] Enable branch protection on `main` that requires a human approval.

**Security notes:**

- Both implementing and reviewing agents have unrestricted `bash`. Branch protection on GitHub is the only merge gate.
- The Docker socket is mounted (see [Docker Socket Access](#docker-socket-access)), so an agent can control the host. The poller has the socket too, to tear down a lane's compose stacks and delete lane directories (see "Worktree lifecycle").
- `LINEAR_API_KEY` is readable by every agent with `bash`.
- Linear writes are attributed to the key's owner.
- The trust model assumes a private repository: every ticket comment, including GitHub-synced ones, is part of the spec. If the synced GitHub repo becomes public, or a public repo is linked to a project, anyone can write spec through GitHub comments. Reconsider this before that happens.
- The commands carry Hard limits that apply to whoever wrote the text (never reveal secrets, never work outside the worktree or in another repo, never change credentials, never merge or approve). They are instructions to the model, not technical enforcement.

#### Poller

The poller is an optional container that runs the agent commands unattended. It reuses the opencode image, talks to Linear, and starts agent runs as sessions on the `opencode` container over HTTP. It reads PRs and CI checks and runs `git clone`, `fetch` and `push` with the github plugin's App (`GH_APP_*`, see below). It needs your projects directory mounted at the same path as in `opencode` (the `kanban-poller:` service in `compose.override.yml`, see `compose.override.yml.dist`) and the Docker socket (for lane teardown, see below). No ports. It keeps no state; stale claims are recovered on every pass.

**Who writes what.** The poller makes every Linear write (state, labels, comments, reactions). The agents have no Linear access. Before a run, the poller writes the whole ticket (description, attachments, all comments oldest to newest with an `isPoller` flag, state history) to `<path>/.slim/worktrees/.tickets/<ID>.json` and passes the path as `ctx.ticketFile`; it deletes the file when the run ends. The agent ends its reply with one line `KANBAN-RESULT: <json>` (the worker reports the PR number, the reviewer `approve` or `changes` with a one-line summary, the investigator `done` after writing its report file, any of them `needs-human` with a step and reason). The poller validates the line and applies the result: a missing or invalid line, a timeout, or an agent error sends the ticket to `Needs human` with the reason. The worker's PR number is checked against GitHub before the ticket moves to `Agent review`.

**Runs.** Passes (default every 60 s) never wait for agents. Each run is a job; up to `KANBAN_MAX_AUTOMATED` work, fix, and review jobs run at once, never two for the same ticket, and investigations always start. Each pass:

1. Adds `needs grilling` to every `Backlog` ticket that has none of `needs grilling`, `investigate`, `refined`. No agent run.
2. Moves `In Progress` tickets whose poller 👀 reaction is older than the work timeout, and that have no running job, to `Needs human` with the reason `stale claim`.
3. Cleans up (see below) and updates the main checkout after merges.
4. Handles `/investigate` comments (see below) and starts `/investigate-ticket` on any ticket, in any state.
5. Gates every `Agent review` ticket on its PR before any agent runs:
   - CI pending: waits, no agent. After `KANBAN_CI_PENDING_TIMEOUT` minutes (earliest start of a pending check, else the PR's last update) the ticket goes to `Needs human`.
   - Merge conflicts: the poller first tries to merge the base branch into the PR branch itself, in the ticket worktree (only if it is clean and at the PR head), with the author `kanban-poller <kanban-poller@users.noreply.github.com>`. If git merges cleanly it pushes (no force), comments `Agent: merged <base> into the branch (no conflicts)`, and the ticket stays in `Agent review` with no round used; CI runs again and the gate re-checks it next pass. If the merge conflicts (it is aborted), it falls through to the next point.
   - CI failed or merge conflicts the poller cannot merge: the poller comments `Agent review: changes requested (round n/2) — <PR URL>` with `CI failed: <names>` or `merge conflicts with <base>`, then adds `agent:changes-requested` and moves the ticket to `In Progress` (plus the failing log tail as a reply). This counts toward the 2-round limit (rounds are counted since the ticket last entered `Ready for agent`); at the limit the ticket goes to `Needs human`.
   - No PR, or PR closed or merged: `Needs human`.
   - No CI checks at all (a repo without CI): not a blocker. Once there are no conflicts, the reviewer runs with `ci: none` and says in its review that no CI ran.
   - CI green and no conflicts: starts `/review-ticket`.
6. Starts `/work-ticket` (fix round; the cause is `ci`, `conflict`, or `review`) for each `In Progress` ticket labelled `agent:changes-requested`, after preparing the worktree and ticket file, removing the label, and claiming it with a 👀 reaction on the issue.
7. Starts `/work-ticket` for each `Ready for agent` ticket after preparing the worktree and ticket file, moving it to `In Progress`, and claiming it with a 👀 reaction. If the ticket branch already has an open PR (a follow-up, see below), the worker gets it and pushes there; a merged or closed PR sends the ticket to `Needs human` ("open a new ticket"). A ticket that still has `needs grilling` or `investigate` is moved back to `Backlog` instead.

**Retry and restart.** If a work or fix run fails (agent or server error, timeout, or no valid result line) and nothing was pushed to the ticket branch, the poller retries it once: it puts the ticket back to its start lane (`Ready for agent`, or `In Progress` with `agent:changes-requested`) and comments `Agent: retrying (<lane>) — <reason>`. That comment is the persisted marker, counted when written by the poller itself since the ticket entered that lane (a copy pasted by someone else does not count, and the same goes for review round comments), so a restart does not loop. A hard cap of 3 retry comments per lane on a ticket applies whatever the timestamps say. A review run is retried once only after an agent or server error (not after a timeout or a missing result line). The second failure goes to `Needs human`. The poller removes its 👀 claim when a run ends, whatever the outcome. If the server cannot abort a session (the abort fails and the session stays busy for 2 minutes), the ticket goes to `Needs human` and is never retried, because a second agent would share its worktree. On SIGTERM the poller aborts every running session (5 s per call) and waits up to 50 s (the wait for an unabortable session is capped at 15 s during shutdown); the compose service has `stop_grace_period: 60s` and `init: true`. Aborted work, fix, and review runs are put back to their start lane without a comment and without using the retry, so a restart resumes them. An aborted investigation is marked ❌ (`poller stopped`). With `--once` the poller starts what is eligible and waits for those jobs.

**Worktree lifecycle.** The poller fetches `origin` (one fetch per project at a time; a transient fetch error only skips the ticket for that pass; after 5 failures in a row for a project the ticket goes to `Needs human` with `git fetch failing repeatedly`, and the auto-merge falls through to the agent), creates (or reuses) `<path>/.slim/worktrees/<id>` on the ticket branch, and records a lane in `.slim/worktrees.json` with the lowest free integer `slot` (slots of other owners count; lanes of the poller whose worktree directory is gone are dropped and free their slot). The worker gets `slot` and `ports` (`base` = 10000 + slot × 100, `count` = 100) in its context: if the repo runs a per-worktree stack, it keys it on the slot and stays inside that port range. There are no repo hooks.

**Cleanup.** At most every 10 minutes per directory, the poller looks at the directories under `<path>/.slim/worktrees/` of every project (`.tickets` and non-ticket names are ignored; lanes owned by someone else in `.slim/worktrees.json` are left alone). For each ticket it removes the worktree and drops the lane only if the ticket is `Ready for merge` or `Done` with a merged PR (or `Canceled` with a closed or merged PR), the worktree is not locked (`git worktree lock`) and has no uncommitted changes, and the local branch tip equals the PR head SHA. It first takes down the compose stacks started only from that worktree (`docker compose -p <project> down -v --remove-orphans`, found by the compose labels on the containers, so it also deletes the stack's volumes and data). A project that also has containers started from another directory (for example the main checkout) is left alone and logged as `teardown.shared-project`. Then it runs `git worktree remove` (no force). If that fails because a stack left root-owned files, it hands the lane directory to the poller's user in a throwaway `alpine:3` container and tries `git worktree remove` once more; if that fails too, the worktree stays (`cleanup.skip`). Finally it deletes the local branch. A failing teardown also leaves the worktree in place.

**Orphans.** Every pass, for each project checkout, the poller looks for lane directories directly under `<path>/.slim/worktrees/` that git does not list as worktrees and that have no running job (`.tickets`, symlinks, files, and names that are not plain lane names are ignored). A directory that contains a `.git` file or directory is never touched (`orphan.skip reason=contains .git`), and a project whose `.slim/worktrees` is a symlink, or does not resolve to `<checkout>/.slim/worktrees`, is skipped as a whole (`orphan.skip-project`). A directory that is an orphan in two passes in a row is removed: the compose stacks that ran only from it are taken down with their volumes, the directory is deleted in an `alpine:3` container, and its lane entry (matched on the lane path, whoever owned it) is dropped (`orphan.removed`). The same rule applies to compose projects whose containers all ran from lane directories that no longer exist; a project that also runs from anywhere else is never taken down. Registered worktrees are never touched. Before every delete or chown in a bind mount the poller writes a random sentinel file into the mounted directory, and the container only acts if it sees that file; otherwise (`bind path not shared with docker host`) nothing is touched. This deletes data: anything in an unregistered `.slim/worktrees/<name>` directory, and the volumes of stacks started from it, are gone after the second pass. With `--dry-run` the poller only logs `orphan.seen` for the candidates.

**Main checkout.** At startup, and after any ticket reaches `Done`, the poller brings the local default branch up to `origin/<default branch>`. If a checkout (the main one or any worktree) has it checked out and clean, the poller fast-forwards it there; a worktree in the middle of a rebase or bisect of that branch counts as having it checked out and is left alone (`operation in progress`). If none has it checked out, it moves the branch ref (only forward, and only if the old value is still current). Local commits that are not on origin, or a dirty checkout, are left alone: it logs `main.skip` with the reason (once per change of reason) and retries every 10 minutes until the branch is up to date.

**Follow-up after `Ready for merge`:** comment the changes you want on the ticket and move it to `Ready for agent` (before merging the PR). The worker updates the same PR instead of opening a new one, and the ticket goes through agent review again. Each request gets a fresh 2 review rounds. If the PR was already merged or closed, the ticket goes to `Needs human`; open a new ticket instead.

Before a work or fix run, a pre-flight resolves the checkout (`path:` or `<KANBAN_PROJECTS_ROOT>/<name>`), clones it if it is missing, checks that `origin` matches `repo:` (otherwise `path collision`), and makes sure `.slim/worktrees/` is git-ignored (adding it to `.git/info/exclude` if needed). A failure moves the ticket to `Needs human` without an agent run. After pre-flight, the poller prepares the worktree (see above); the worker only works inside it. Investigations run the same checks, because their ticket file lives under `.slim/worktrees/`.

**Investigate comments.** Comment on any ticket, in any state, with any labels:

```text
/investigate
Optional question, on the same line or the following lines.
```

The first line must be exactly `/investigate` or start with `/investigate `. Only comments written by the API key owner count; comments with an external user, a bot actor, or a sync marker (GitHub-synced comments) are ignored, as are comments older than 7 days. The poller reports progress as reactions on your comment:

| Reaction | Meaning |
|----------|---------|
| 👀 (`eyes`) | picked up; this is the claim, so the comment is not handled twice |
| ✅ (`white_check_mark`) | finished: the poller posted the report as a reply `Agent investigation:` |
| 👀 + ❌ (`x`) | failed (agent error, timeout, no valid result or report, or `poller stopped`); a reply `Agent investigation: failed — <reason>` explains |
| ❌ (`x`) only | a check failed before the claim (project `repo:`/`path:`, clone, origin, `.slim/worktrees/` could not be ignored, or the ticket snapshot could not be written); a reply `Agent investigation: failed — <reason>` explains |

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
| `KANBAN_TEAM` | `DEY` | Linear team key |
| `KANBAN_POLL_INTERVAL` | `60` | seconds between passes |
| `KANBAN_PROJECTS_ROOT` | empty | absolute path of the directory that holds the checkouts: a project without `path:` uses `<root>/<repo name>` and is cloned there if missing. Mount it at the same path in both containers |
| `KANBAN_OPENCODE_URL` | `http://opencode:4096` | opencode server the poller starts sessions on (user `opencode`; set `OPENCODE_SERVER_USERNAME` in the poller's environment if the server uses another) |
| `KANBAN_MAX_AUTOMATED` | `3` | how many work, fix, and review runs may be active at once; investigations are not counted |
| `KANBAN_CI_PENDING_TIMEOUT` | `30` | minutes a PR may wait for CI before the ticket goes to `Needs human` |
| `KANBAN_TIMEOUT_WORK` | `60` | minutes before a work run is aborted |
| `KANBAN_TIMEOUT_REVIEW` | `20` | minutes before a review run is aborted |
| `KANBAN_TIMEOUT_INVESTIGATE` | `20` | minutes before an investigation is aborted |

The poller uses the `github` plugin's App: `GH_APP_ID`, `GH_APP_PRIVATE_KEY_PATH` and, if needed, `GH_APP_INSTALLATION_ID` (see [GitHub plugin](#github-plugin)). Compose refuses to start the poller without them. Besides the plugin's write permissions, the App needs Checks, Commit statuses and Actions read-only. Without them the review gate fails with `review.github-error` and CI failures get no log tail. The poller clones missing checkouts, fetches, and pushes one thing: the clean base merge into a conflicting PR branch (never forced). Worktree and branch cleanup uses local git only.

The poller logs only ticket identifiers, actions, results, and durations: never the key, comment text, or ticket text. It exits with an error at startup if a required variable is missing, or if a state or label name is missing in Linear.

**Poller security notes:**

- Every git command the poller runs is started with `core.hooksPath=/dev/null` and `core.fsmonitor=false`, so repo-controlled config in a worktree cannot run code in the poller.
- It runs agents unattended with unrestricted `bash`.
- `main` is not protected by the plugin: unless you enable branch protection, an agent can push to `main`.
- Delegation to subagents is allowed, so a run can hang until its timeout aborts it. The worker, reviewer, and investigator may only delegate to the read-only `explorer` and `librarian` subagents; all edits, commits, and pushes stay with the worker itself.

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
The `kanban-poller` service mounts it too and does the same group step in its inline entrypoint (it skips `docker/entrypoint.sh`).

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
