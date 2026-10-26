# Mention plugin

The `mention` plugin adds a poller that watches pull request comments in every repository the GitHub App can see. When an allowed user mentions the App's bot (`@<app-slug>`) in a PR conversation comment, the poller reacts with 👀 and starts an `orchestrator` session for that PR. The agent works in its own worktree, pushes what it changed, and replies with one comment. It needs the `github` plugin (declared in `mention.requires`) and the `orchestrator` agent from oh-my-opencode-slim.

```text
@my-app-bot the date parser fails on DST days, please fix it and add a test
```

## Who can trigger it

A comment counts only if all of these hold:

- It is a PR conversation comment. Inline review comments, review summaries, and issues are ignored.
- It mentions `@<app-slug>` as a whole word, case-insensitive (`@my-app-bot2` and `x@my-app-bot` don't count).
- Its author is in `MENTION_ALLOWED_USERS`, and is neither the bot nor any other bot account.
- Its author has a role in `MENTION_ALLOWED_ROLES` (default `admin,maintain`) on that repository. The poller asks `GET /repos/{owner}/{repo}/collaborators/{user}/permission`. It does not use the comment's `author_association`: in orgs that grant access through teams, that field says `CONTRIBUTOR` even for admins.
- It is younger than `MENTION_LOOKBACK_HOURS` and has no 👀 from the bot yet.

Comments that fail the role check are logged and get no reaction. Keep the allowlist short: each user on it can make an unattended agent run on your machine (see [Security notes](#security-notes)).

## A run, step by step

1. The poller reads the PR. A closed or merged PR gets 👀 and the reply that nothing was done.
2. It clones `<MENTION_PROJECTS_ROOT>/<repo name>` if missing (HTTPS, the App's token), checks that `origin` is that repository, and adds `/.slim/worktrees/` to the checkout's `.git/info/exclude` if needed.
3. It fetches the PR head and the base branch and creates or reuses the worktree `<checkout>/.slim/worktrees/mention-pr-<n>`, detached at the PR head. Your main checkout's branch and files are never changed. A reused worktree is poller-owned scratch space: an interrupted rebase is quit and uncommitted changes and untracked files are discarded (`git reset --hard`, `git clean -fd`; ignored files stay), logged as `prepare.discard`. Do not keep hand edits there. Commits are kept: if the worktree holds commits that never reached the PR, the poller saves them under `refs/mention/saved/pr-<n>/<sha>` before resetting it.
4. It reacts 👀 on the comment (the claim) and starts the `/reply-mention` command with `ctx:<json>`: repository, PR, base and head branch, head and base SHA, worktree path, whether it may push, and the comment.
5. The agent reads the PR with `gh`, does the work in the worktree, commits, and pushes with `git push origin HEAD:<head branch>` (no force). It then posts exactly one short reply that links the request and leads with a verdict or result, followed by at most four bullets: findings that need action and, when code changed, the commits and test results. A rebase that succeeds without conflicts, pushes, and passes its tests gets no reply; the force-push in the PR timeline is the signal.
6. If the agent cannot push (PR from a fork, a rejected push, a missing App permission), the commits stay in the worktree and the reply says why and how to push them by hand.
7. The run ends with a line `MENTION-RESULT: <json>`. If the agent posted no reply (error, timeout, missing or invalid result line), the poller posts `mention-poller: run failed — <reason>`. The exception is `{"outcome":"silent"}` from a run that ended cleanly: the agent skipped the reply on purpose after a clean rebase, so the poller posts nothing. It never posts a second reply when the agent already answered.

One run per PR at a time, at most `MENTION_MAX_CONCURRENT` runs in total, oldest comment first. A mention that has to wait stays unclaimed until a slot frees up. Permission requests from the run's sessions are rejected. Questions are rejected too where the server has the `/question` routes; on a server without them, an agent that asks anyway hangs until `MENTION_TIMEOUT`. On SIGTERM the poller aborts its sessions and exits within 50 s.

## Rebasing

Only when the comment asks for it (`@my-app-bot rebase onto main`). The agent runs `git rebase origin/<base>`, keeps the commit structure, resolves conflicts commit by commit, runs the tests, and pushes with `--force-with-lease=refs/heads/<head>:<head SHA>`, the SHA the poller fetched. If someone pushed in between, the push is rejected and the agent reports it instead of retrying. If a conflict is too ambiguous, it runs `git rebase --abort` and lists the files. It never merges the base branch into the PR branch and never rebases on its own.

## Cleanup

Every pass, before new runs start, the poller looks at the `mention-pr-<n>` worktrees of each checkout. For a PR that is merged or closed it removes the worktree with `git worktree remove` (no force), but only if the worktree is registered, has no uncommitted changes, and its HEAD is contained in `refs/pull/<n>/head` (GitHub keeps that ref after the branch is deleted). Otherwise it logs `cleanup.skip` with the reason and the path, and leaves it for you. Saved refs under `refs/mention/saved/` are never deleted.

## Running alongside kanban

Both pollers can run at once. Kanban only treats `<letters>-<digits>` directories as ticket worktrees, which `mention-pr-<n>` is not, and its orphan cleanup never touches a registered worktree. Both run `git fetch` in the same checkouts; the mention poller retries a failed fetch once. Don't mention the bot on a kanban ticket's PR while the ticket is in progress: both bots would push to the same branch, and kanban's cleanup then leaves the ticket worktree alone because its branch no longer matches the PR head.

## Make targets

The `mention` plugin must be in `PLUGINS`. Rebuild with `make opencode-build-plugins` first.

| Target | Does |
|--------|------|
| `make mention-poller-run` | start the poller in the background |
| `make mention-poller-logs` | follow its logs |
| `make mention-poller-down` | stop and remove it |
| `make mention-poller-once` | one real pass, waits for the runs it started, then exits |
| `make mention-poller-dry-run` | one pass, then exit; logs the runs and cleanups it would do, no GitHub or git writes, no agent runs |

## Environment

Set these in `.env`. Compose refuses to start any service while the plugin is enabled and a required variable is missing.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MENTION_ALLOWED_USERS` | required | comma-separated GitHub logins that may trigger the bot |
| `MENTION_PROJECTS_ROOT` | required | absolute host path that holds the checkouts (`<root>/<repo name>`, cloned if missing). Mount it at the same path in `opencode` (`compose.override.yml`); the poller service mounts it itself |
| `OPENCODE_SERVER_PASSWORD` | required | password of the opencode server the poller starts sessions on |
| `MENTION_ALLOWED_ROLES` | `admin,maintain` | repository roles that may trigger the bot, checked per repository |
| `MENTION_HANDLE` | `@<app-slug>` | override the mention to look for |
| `MENTION_BOT_LOGIN` | `<app-slug>[bot]` | override the bot's login (claims, self-mentions, reply detection) |
| `MENTION_POLL_INTERVAL` | `60` | seconds between passes |
| `MENTION_LOOKBACK_HOURS` | `24` | ignore older comments |
| `MENTION_TIMEOUT` | `45` | minutes before a run is aborted |
| `MENTION_MAX_CONCURRENT` | `2` | runs at once (one per PR) |
| `MENTION_OPENCODE_URL` | `http://opencode:4096` | opencode server (user `opencode`, or `OPENCODE_SERVER_USERNAME`) |

The poller reads the App slug with `GET /app` at startup, so the handle and the bot login need no setup. It uses the `github` plugin's `GH_APP_*` variables. The App needs Contents and Issues read & write (push, reactions, replies) and Pull requests read. Pushes that change `.github/workflows/` also need the Workflows permission.

The poller logs repository names, PR and comment numbers, actions, and reasons, never comment text or tokens.

## Security notes

- An allowed comment is a prompt to an unattended agent with unrestricted `bash` in the `opencode` container. That container has the Docker socket (root on the host), your mounted projects, and an App token valid for every repository the App is installed on. Treat `MENTION_ALLOWED_USERS` as a list of people you would give a shell.
- The prompt treats PR diffs, repository files, and other comments as data, not instructions. That is an instruction to the model, not enforcement: prompt injection through PR content is still possible.
- The poller service has no Docker socket. Every git command it runs disables repository hooks and fsmonitor.
- Force pushes happen only for a requested rebase, with a lease. Protect your default branch with a ruleset; nothing in the plugin stops an agent from pushing to it.
