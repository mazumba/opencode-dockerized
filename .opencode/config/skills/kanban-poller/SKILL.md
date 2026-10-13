---
name: kanban-poller
description: Kanban poller behaviour and operations. Use when running, dry-running, or debugging the Linear kanban poller, reading its logs, explaining why a ticket moved or did not move, or changing poller code in docker/plugins/kanban/poller.
---

# Kanban poller

Code: `docker/plugins/kanban/poller/`. Tests: `docker/plugins/kanban/tests/`. Commands it runs: `docker/plugins/kanban/kanban.commands/`.

## Who writes what

1. The poller makes every Linear write (state, labels, comments, reactions), all through the `--dry-run` guard. Agents (`ticket-worker|reviewer|investigator`) have `linear_*` denied. Agents write only code and the PR (worker), the GitHub review (reviewer), and the report file (investigator).
2. Before each work/fix/review/investigate run, and before the ticket is claimed or moved, the poller writes `<path>/.slim/worktrees/.tickets/<ID>.json` (atomic; passed as `ctx.ticketFile`; deleted when the job ends, also on failure; dry-run logs only). The snapshot `state` is the state at write time, so a work run sees the pre-move state. Content: title, description, state, labels, project name, url, attachments, all comments oldest to newest (`id`, `parentId`, `author`, `isPoller`, `createdAt`, `body`), state history. Cleanup works per ticket worktree and never touches `.tickets`.
3. Every run ends with one last line `KANBAN-RESULT: <json>`. The poller takes the LAST such line (tolerating surrounding backticks, bold, or quote markers) and rejects unknown fields or values:
   1. Worker: `{"outcome":"review","pr":<n>}` or `{"outcome":"needs-human","step","reason"}`. `review` is accepted only if `gh` finds an OPEN PR on the branch with that number; then `Agent review`. Else `Needs human`.
   2. Reviewer: `{"outcome":"approve"}` → `Ready for merge`; `{"outcome":"changes","summary"}` → comment `Agent review: changes requested (round n/2) — <PR>` + one-line summary (prefixed `Review: ` if it starts with `CI failed` or `merge conflicts`), label, `In Progress`, or `Needs human` ("review limit reached") at round ≥ 2; `needs-human` → `Needs human` with `Agent review: needs human — <step>: <reason>`.
   3. Investigator: `{"outcome":"done"}` plus the report in `<path>/.slim/worktrees/.tickets/<ID>.investigation.md`; the poller posts `Agent investigation:\n\n<report>` (cut at 60k characters with a note) as a reply to the request and reacts ✅. `needs-human`, a missing report, or a bad marker = ❌ + `Agent investigation: failed — <reason>`.
   4. Failed run (agent/server error, timeout, missing or invalid marker): one automatic retry, then `Needs human` ("agent result: marker missing|marker is not JSON|marker invalid", or the run failure).
   1. Work/fix: retry any failure IF nothing was pushed (remote branch head before the run = after a fetch; unknown counts as pushed). Review: retry only an agent/server error, not a timeout or missing marker.
   2. Retry = put the ticket back to its start lane (work: `Ready for agent`; fix: stays `In Progress` + `agent:changes-requested`; review: stays `Agent review`), THEN comment `Agent: retrying (<lane>) — <reason>`. That comment is the persisted budget (max 1 per lane entry), counted only from comments authored by the poller (`user.id` = API user) at or after the entry (work: last `Ready for agent`; review: last `Agent review`; fix: newest poller `changes requested` comment). The comparison is inclusive, so equal timestamps cannot grant another retry; a hard cap of 3 retry comments per lane per ticket ends loops whatever the timestamps. Log `run.retry`.
   3. A claim 👀 ends with its job (job `finally`, every outcome, released even if removing the ticket files fails; a reaction that is already gone is ignored); `staleClaims` ignores tickets labelled `agent:changes-requested`. Claims are written first (`claimIssue`: add the new reaction, then delete older ones), then the move/relabel.
   4. Session that could not be aborted (abort failed AND status still busy after 2 min): `Needs human` ("session could not be aborted"), never a retry or requeue.
   5. Poller stop (aborted run): same put-back, no comment, no budget used, log `run.requeued`; so a restart resumes the work. Investigations are not requeued (❌ `poller stopped`).
4. Marker extraction (`parseResult` in `select.ts`) is separate from the transport (`runner.ts` gives the stdout tail). `opencode run` prints the final reply text to stdout; if the format ever wraps or decorates the line, fix only the line pattern.

## Concurrency and runner

1. Runs are opencode sessions over HTTP (`runner.ts`, legacy routes, `?directory=<project path>`, basic auth `OPENCODE_SERVER_USERNAME` or `opencode` + `OPENCODE_SERVER_PASSWORD`): `POST /session` (title `kanban <work|fix|review|investigate> <ID>`), then a blocking `POST /session/{id}/command` (`command`, `arguments`, `agent`). The result text = text parts of the final assistant message (marker parsing input). A model error in that message fails the run.
2. Timeout or shutdown: `POST /session/{id}/abort` (5 s limit during shutdown; the idle wait is capped at 15 s during shutdown so it fits the 50 s drain), then the request is dropped (`timedOut` / `aborted`). IF the abort fails THEN poll `GET /session/status` for up to 2 min; still busy = `stuck`. A finished answer without error beats a timeout that fired at the same moment. IF the command connection breaks THEN poll `GET /session/status` until the session is idle and read its last assistant message.
3. While a command runs, `GET /permission` is polled every 5 s; requests of that session and of its subagent child sessions (`GET /session/{id}/children`, recursively) are rejected (`POST /permission/{id}/reply` `reject`, log `run.permission-rejected`). Kanban agents should never need asking.
4. Passes never wait for runs. Each run is a job in a table (key = ticket ID; investigations key `investigate:<comment id>`); settle logic runs in the job, errors are logged as `job.error`.
5. Pool: at most `KANBAN_MAX_AUTOMATED` (default 3) work, fix, and review jobs together, and never two automated jobs for one ticket (`canStartAutomated`). Investigations are outside the pool and always start; they use their own snapshot and report files (`<ID>.<comment id>.json|.investigation.md`).
6. Review gate, fix, and new work skip tickets with a live automated job. IF the pool is full THEN a review-ready ticket logs `review.queued`; fix and new work wait for the next pass.
7. `--once`: starts what is eligible, then waits for all started jobs. SIGTERM/SIGINT: abort all live sessions, wait up to 50 s (compose `stop_grace_period: 60s`), exit. Aborted work/fix/review jobs put their ticket back to its start lane (see "Who writes what", retry and requeue).
8. `.slim/worktrees.json` is written only inside the sequential pass (prepare and cleanup), never by job continuations, so it needs no lock; writes are atomic (`writeJsonAtomic`: temp + rename). IF a job continuation ever has to write it THEN add serialization first. `git fetch` is serialized per project path (`createKeyedMutex`).

## Pass order (one pass every `KANBAN_POLL_INTERVAL` s; a pass starts jobs and returns)

1. Auto-label: IF a `Backlog` ticket has none of `needs grilling`, `investigate`, `refined` THEN add `needs grilling`. No agent.
2. Stale claims: IF an `In Progress` ticket has the poller's 👀 claim older than the work timeout AND no live work/fix job THEN `Needs human` ("stale claim").
3. Cleanup (see "Cleanup"), orphan cleanup (see "Orphans"), and main checkout update (see "Main checkout after Done"). None starts an agent.
4. Investigate (every eligible request starts): IF an `/investigate` comment by the API key owner, < 7 days old, has no 👀 THEN
   1. Pre-flight checks (config, clone, origin, ignore rule: see "Pre-flight"). IF it fails THEN react ❌, reply `failed`, next.
   2. Write the ticket snapshot. IF that fails THEN react ❌, reply `failed`, next.
   3. ELSE react 👀, start the `/investigate-ticket` job (any ticket, any state, any labels); on completion apply the result (see "Who writes what").
5. Review: for each `Agent review` ticket without a live job, oldest first, run the gate (see "Review gate"). IF the gate says `review` AND the pool has a slot THEN write the snapshot (failure → `Needs human`) and start `/review-ticket`. ELSE handle it and continue.
6. Fix: for each `In Progress` ticket with `agent:changes-requested`, oldest first, while the pool has a slot:
   1. Pre-flight (see below). IF it fails THEN `Needs human`, next ticket.
   2. Fetch and create/reuse the worktree with lane slot (see "Pre-flight"), write the snapshot (any failing → `Needs human`), THEN remove the label, claim with 👀, start `/work-ticket` with ctx (`fix.cause` = `ci` | `conflict` | `review`).
7. New work: for each `Ready for agent` ticket, oldest first:
   1. IF it has `needs grilling` or `investigate` THEN move to `Backlog` (bounce), next ticket.
   2. IF the pool has no slot THEN next ticket.
   3. Pre-flight. IF it fails THEN `Needs human`, next ticket.
   4. Look up the PR for the ticket branch (`existingPrDecision`). IF it is `MERGED` or `CLOSED` THEN `Needs human` ("PR #n is merged/closed; open a new ticket"), next ticket. IF it is `OPEN` THEN pass `pr` in the ctx (follow-up, see below).
   5. ELSE fetch and create/reuse the worktree at `<path>/.slim/worktrees/<id-lowercase>` with its `.slim/worktrees.json` lane and slot, write the snapshot (any failing → `Needs human`), THEN move to `In Progress`, claim with 👀, start `/work-ticket` with ctx.
8. IF nothing started and no job is live THEN log `pass.idle`.

## Review gate (`reviewGate` in `select.ts`, first match wins)

1. IF no PR for the ticket branch THEN `Needs human` ("no PR found").
2. IF PR is `MERGED` or `CLOSED` THEN `Needs human`.
3. IF any check is `fail` or `cancel` THEN fix `ci`.
4. IF `mergeable` is `CONFLICTING` THEN fix `conflict` (after trying the clean auto-merge below).
5. IF any check is `pending` OR `mergeable` is `UNKNOWN` THEN
   1. IF pending for more than `KANBAN_CI_PENDING_TIMEOUT` min (default 30) THEN `Needs human` ("CI pending for more than <n> min"). Pending-since = earliest `startedAt` of the pending checks (`gh pr checks`); IF none has one (queued, or only `mergeable` UNKNOWN) THEN the PR's `updatedAt`. Both from GitHub, no poller state; `updatedAt` only moves later, so the fallback delays escalation, never hastens it. IF neither is known THEN wait.
   2. ELSE wait (log `review.wait`, retry next pass).
6. ELSE review: ctx `"ci":"green"`, or `"ci":"none"` when the PR has no checks at all (a repo without CI; the reviewer says so in its review and never assumes tests pass).

Clean auto-merge (before a `conflict` fix; `autoMergeBase`, poller work, no pool slot, never for a ticket with a live job): `ensureWorktree` only (no lane, no setup hook), require it clean and HEAD = PR head, then `git merge --no-edit origin/<base>` there (author `kanban-poller <kanban-poller@users.noreply.github.com>`, ctime flags).
1. Merged: push `HEAD:refs/heads/<branch>` over HTTPS with the gh credential helper (never force; needs the App's `contents: write`), comment `Agent: merged <base> into the branch (no conflicts)`, log `review.auto-merged`, ticket stays in `Agent review`, no round used. IF the push fails THEN `git reset --hard <PR head>` and fall through.
2. Conflicts: `git merge --abort`, log `review.auto-merge-skip`, fall through to the fix handling. Same for dirty or moved worktree, "base already merged", and git errors (`review.auto-merge-error`).
3. Dry-run only logs `dry-run.auto-merge`.

Fix handling:
1. IF `Agent review: changes requested` comments created since the ticket last entered `Ready for agent` (all of them if it never did; from Linear issue history) >= 2 THEN `Needs human` ("review limit reached").
2. ELSE in this order: comment `Agent review: changes requested (round n/2) — <PR>` + line 2 `CI failed: <names>` or `merge conflicts with <base>` (first, so a failure never leaves an uncounted round), add `agent:changes-requested`, move to `In Progress`. The poller parses line 2 for `fix.cause`, so reviewer summaries must not start with those phrases.
3. IF cause is `ci` THEN last, reply with the last 150 lines of the failed run log.

## Follow-up after Ready for merge

A human comments the desired changes and moves the ticket to `Ready for agent`. The poller finds the open PR on the branch and runs `/work-ticket` with `pr` and no `fix`; the worker pushes to that PR. The round count restarts at each entry into `Ready for agent`, so every request gets 2 review rounds. A merged or closed PR goes to `Needs human`.

## Pre-flight (work, fix, and investigate runs)

1. Project config: exactly one `repo: owner/name`; `path:` is optional (explicit wins). Without it the checkout is `<KANBAN_PROJECTS_ROOT>/<repo name>`; IF there is no root either THEN fail. A malformed `path:` line fails (no silent default).
2. IF the ticket has no safe branch name THEN fail (work/fix).
3. Checkout (`ensureCheckout`, `checkoutPlan`): missing path or empty directory THEN `git clone https://github.com/<repo>.git <path>` (the path must be absolute and normalized: no `..`, `.`, `//` or trailing slash; HTTPS, gh credential helper, 10 min, dry-run only logs `dry-run.clone`). Repo whose origin is another repo THEN fail `path collision: <path> holds <other repo>`. Non-empty directory that is not a repo, or a file, THEN fail. Never clone into a non-empty non-repo directory.
4. Ignore rule (`ensureIgnored`): IF `.slim/worktrees/` is not git-ignored THEN append `/.slim/worktrees/` and `/.slim/worktrees.json` to `<git-common-dir>/info/exclude` (idempotent, `excludeAppend`; nothing is committed), re-check; IF still not ignored THEN fail. Dry-run only logs `dry-run.exclude`.

The poller, not the agent, fetches and creates the worktree. The GitHub App is also used for `git clone` and `git fetch` (needs `contents:read`). `ensureWorktree` (fetch + worktree add/reuse) comes first; the auto-merge uses only that. `prepareWorktree` adds:

1. Lane: the lowest integer `slot` >= 1 not used by any lane of any owner (`lowestFreeSlot`, at most `MAX_SLOT` = 554); an existing lane keeps its slot (a lane without one gets one). The lane is stored with `owner: kanban-poller` and `slot`. The poller's own lanes whose worktree directory no longer exists (`abandonedLanes`) are dropped first, so a failed registry update during cleanup (`cleanup.lanes-error`) cannot leak a slot.
2. The worker ctx gets `slot` and `ports` = `{base: 10000 + slot*100, count: 100}` (`slotPorts`); there are no repo hooks. The worker keys any per-worktree stack on the slot and stays inside that port range.
3. Then the ticket snapshot, then claim, then move/relabel (see "Pass order"). IF `git fetch` fails (`work.fetch-error` / `fix.fetch-error` / `review.fetch-error`) THEN the ticket is skipped for this pass, no state change, until the fetch failed 5 times in a row for that project (in memory, reset by a success): then work/fix go to `Needs human` ("git fetch failing repeatedly: <msg>") and the auto-merge falls through to the agent (`fetchFailureDecision`); only worktree add failures, a full slot table, and snapshot failures go to `Needs human` immediately.

## Cleanup (disk-driven)

Candidates are the directories under `<path>/.slim/worktrees/` of every project of the team (projects from Linear: `repo:`, optional `path:`). Ignored: `.tickets`, names that are not `<letters>-<digits>`, lanes whose registry `owner` is not `kanban-poller` (or whose registry is unreadable/malformed). A directory with no registry entry counts. No age window.

1. IF the ticket has a live automated job, or the directory was looked at less than 10 min ago (in memory), THEN skip.
2. Look up the ticket (any age). IF it is not `Ready for merge`, `Done`, or `Canceled`, or its project path differs from the directory's project THEN skip.
3. IF no PR OR PR is `OPEN` THEN skip.
4. IF state is `Ready for merge`/`Done` AND PR is `CLOSED` (not merged) THEN skip.
5. IF the worktree is unregistered, `locked` (`git worktree lock`, never forced), dirty, its HEAD or the local branch differs from the PR head SHA THEN log `cleanup.skip` with the reason. Leave it for a human. (Dry-run stops here: `dry-run.cleanup stacks=<n>`.)
6. Teardown: `docker ps -a` with the compose labels (`com.docker.compose.project`, `.working_dir`) lists containers. Group them by project (`partitionProjects`): a project is lane-exclusive only if EVERY working dir is the worktree or below it (real path too, path boundary: `dey-4` is not `dey-42`); run `docker compose -p <project> down -v --remove-orphans` (arg array, 5 min, `execGroup`) only for those. A project that also runs from elsewhere (for example the main checkout) is logged `teardown.shared-project project=<p>` and skipped. IF a down fails THEN `cleanup.skip reason=teardown failed`; the worktree stays.
7. `git worktree remove` (no force). IF that fails (root-owned leftovers) THEN `cleanup.remove-fallback`: `chown -R <poller uid:gid>` on `<checkout>/.slim/worktrees/<slug>` in an alpine container (sentinel-guarded, see below), then retry `git worktree remove`. IF it fails again THEN `cleanup.skip reason=worktree remove failed`. No repo-wide `git worktree prune` is ever run.
8. `git branch -D <branch>`, log `cleanup.done`, drop the lane (and its slot) from `.slim/worktrees.json`. IF the registry write fails THEN log `cleanup.lanes-error`; the stale lane is dropped by the next lane creation.

## Orphans (every pass, per project checkout)

Guards first: the project is skipped (`orphan.skip-project`) when `lstat(<checkout>/.slim/worktrees)` is a symlink or its real path is not `<real checkout>/.slim/worktrees` (`lanesDirSafe`). Candidates: entries directly under it that lstat as real directories (not symlinks or files), whose real path is exactly `<real worktrees dir>/<name>`, whose name matches `^[a-z0-9][a-z0-9._-]*$` (so `.tickets` is skipped), that are NOT in `git worktree list` (real paths), have no live job for that ticket slug, and do NOT contain `.git` (file or directory; `orphan.skip reason=contains .git`, also re-checked right before deleting). Also compose projects whose containers ALL have a working dir below the worktrees dir in a directory that is missing or an orphan candidate (`orphanStackProjects`); a project that also runs from anywhere else is never a candidate.

1. Two-pass rule (`orphanPass`, in memory per project): act only on candidates that were also candidates in the previous pass. First sight logs `orphan.seen kind=dir|stack name=<x> stacks=<n>`; with `--once` nothing is ever due, so `--dry-run` shows what would go next pass.
2. Due directory: re-check live jobs and `.git`, take down its lane-exclusive stacks (as in Cleanup step 6), delete the directory in the alpine container (no `git worktree prune`: it was not a worktree), drop its lane entry (`removeLane` matches the lane `path` `.slim/worktrees/<slug>` or the absolute equivalent, never the slug alone, whoever owned it). Log `orphan.removed`. Due stack: `docker compose -p <project> down -v --remove-orphans`.
3. Any failure logs `orphan.error` and is retried next pass (the candidate stays seen). Registered worktrees are never touched. This deletes data (stack volumes, files in the directory).
4. Dry-run: `docker ps` (a read) is allowed; no docker or git mutation, only logs.
5. Sentinel guard (`docker.ts`, every `docker run` that deletes or chowns in a bind mount): the poller writes `<lanes dir>/.kanban-sentinel-<random>` first; the container runs `test -f /lanes/<sentinel> || exit 42; <action>`; exit 42 = `bind path not shared with docker host`, nothing was touched; the sentinel is deleted in a `finally`.

## Main checkout after Done

A pending set holds projects whose main checkout may be behind: every project once at startup, and each project with a ticket that moved to `Done` since the last pass. A pending project is tried when never tried or its last try is >= 10 min old: fetch, then `mainUpdateDecision`: (a) IF a checkout (main or any worktree from `git worktree list`, including a detached one in the middle of a rebase or bisect of the default branch: `rebase-merge/head-name`, `rebase-apply/head-name`, `BISECT_START`; then `main.skip reason=operation in progress in <path>`) has the default branch checked out THEN, if its tree is clean, `git -c core.trustctime=false -c core.checkStat=minimal merge --ff-only origin/<default>` there; (b) IF no checkout has it THEN `git update-ref refs/heads/<default> <origin sha> <old sha>` (compare-and-swap). Both only if local is an ancestor of `origin/<default>`. A project whose checkout directory does not exist yet counts as up to date. Up to date or updated THEN leave the set. Else (`main.skip reason=...`, or `main.error`) it stays pending and is retried every 10 min; the log line repeats only when the reason changes. Log `main.updated`. Dry-run: no fetch, logs `dry-run.main-update`.

## Run it (from the repo root)

1. IF code changed THEN `cd docker/plugins/kanban && bun test tests/` first.
2. IF checking behaviour without side effects THEN `make kanban-poller-dry-run` (no Linear writes, no agent runs, no git mutations; GitHub and git reads are real).
3. IF running outside Docker THEN `cd docker/plugins/kanban && bun poller/poller.ts --once --dry-run` with `LINEAR_API_KEY`, `OPENCODE_SERVER_PASSWORD`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY_PATH` set.
4. IF the image or poller code changed THEN `make opencode-build-plugins` before the container targets (it stops the `opencode` container first, so never run it from inside an opencode session). IF only checking the poller code THEN run it from source: `cd docker/plugins/kanban && bun poller/poller.ts --once --dry-run` with the `.env` values exported (`GH_APP_ID`, `GH_APP_PRIVATE_KEY_PATH`).
5. Long-running: `make kanban-poller-run`, `make kanban-poller-logs`, `make kanban-poller-down`. One real pass: `make kanban-poller-once`.

## Required env

1. Always: `LINEAR_API_KEY`, `OPENCODE_SERVER_PASSWORD`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY_PATH` (the github plugin's App).
2. IF the App is installed on more than one account THEN `GH_APP_INSTALLATION_ID`. The App needs Contents, Issues and Pull requests read & write, plus Checks, Commit statuses and Actions read-only (review gate, failed-run logs).
3. Optional: `KANBAN_MAX_AUTOMATED` (default 3), `KANBAN_CI_PENDING_TIMEOUT` (minutes, default 30), `KANBAN_TIMEOUT_WORK|REVIEW|INVESTIGATE`, `KANBAN_POLL_INTERVAL`, `OPENCODE_SERVER_USERNAME` (default `opencode`; set it only if the server uses another).
4. `KANBAN_PROJECTS_ROOT` (absolute path, optional): parent of the default checkouts `<root>/<repo name>`. Needed unless every project description has `path:`.
5. Projects directory (the root, and any explicit `path:`) mounted into `kanban-poller` AND `opencode` at the same real host path (`compose.override.yml`): the Docker daemon resolves lane stack bind mounts on the host.
6. The compose fragment mounts `/var/run/docker.sock` into `kanban-poller` and joins the socket group in its inline entrypoint; IF teardown/orphan cleanup cannot run `docker` THEN check that mount and `id` inside the container.
7. Never print `.env` or token output. IF a value must be checked THEN test presence only (`[ -n "$VAR" ]`).

## Troubleshoot (match the log event or symptom)

1. `startup failed` / `set GH_APP_INSTALLATION_ID` THEN set that var, or fix App ID and key path.
2. compose: `GH_APP_* is not set` THEN set up the github plugin's App in `.env` (README "GitHub plugin").
3. `pass.error kind=linear` THEN read the GraphQL message; IF a state or label is missing THEN create it in Linear with the exact name.
4. `review.wait` repeating for one ticket THEN check `gh pr checks <n> --repo <repo>`; IF a check never finishes THEN fix CI; after `KANBAN_CI_PENDING_TIMEOUT` min the ticket goes to `Needs human` ("CI pending for more than <n> min").
5. `review.github-error` / `fix.github-error` / `work.github-error` THEN run the same `gh` call by hand; IF 403/404 THEN the App lacks a permission or is not installed on the repo.
6. `review.fix-error` THEN the comment is written first, so the ticket may have the comment but lack the label or `In Progress` state, or the log-tail reply; check it in Linear. The next pass redoes the fix and counts another round.
7. `needs-human reason=...` THEN fix the cause named in the reason, then move the ticket back by hand.
8. `cleanup.skip reason=uncommitted changes` or `... differs from PR head` THEN inspect the worktree; IF the work is not needed THEN remove it by hand.
9. `Needs human` with `path collision: <path> holds <repo>` THEN two projects map to one directory name (`a/web`, `b/web`): give one an explicit `path:`. `... exists, is not empty, and is not a git repository` THEN clean the directory or set `path:`. `git clone failed` THEN check the App (`contents:read`) and the repo name.
10. `cleanup.skip reason=teardown failed` THEN `docker compose down` failed for a stack (message in the log); fix by hand (`docker compose -p <project> down -v`), the next pass retries. `cleanup.remove-fallback` is informational (root-owned files).
11. `orphan.seen` repeating for the same name THEN it is in the two-pass window or removal fails (`orphan.error`); IF a directory must stay THEN register it as a worktree (`git worktree add`), or move it out of `.slim/worktrees/`.
12. `main.skip reason=...` THEN the main checkout was left alone: `checkout is on <branch>` (switch back to the default branch), `uncommitted changes`, `not a fast-forward` (local default branch has its own commits). Fix by hand; it is retried every 10 min. `main.error` THEN read the message (fetch or git failure).
13. `cleanup.lanes-skip` THEN `.slim/worktrees.json` is missing, unreadable, or has no matching lane; harmless.
14. `Needs human` with `agent result: marker missing` / `marker invalid` THEN the agent did not end with a valid `KANBAN-RESULT` line; read its run output in opencode. `reported PR #n is not the open PR of the branch` THEN the agent named a wrong PR or never opened one.
15. `run.start session=<id>` has no `run.end` for long THEN the session is stuck (for example a question the agent cannot get answered). Find it by title `kanban <kind> <ID>` (`GET /session`, same auth and `?directory=`), abort it with `POST /session/<id>/abort`; the job then ends as `Needs human`. The timeout aborts it anyway.
16. `run.permission-rejected` THEN an agent tried something its config does not allow; fix the agent permissions in `kanban.agent.jsonc`.
17. `run.poll-error` repeating THEN the server is unreachable or rejects the credentials (`OPENCODE_SERVER_USERNAME`/`PASSWORD`); IF `agent error: session create failed: HTTP 401` THEN same.
18. `job.error` THEN a Linear or GitHub write failed while settling; the ticket may be half-updated (claimed `In Progress`, or still `Agent review`); check it in Linear.
19. `review.auto-merge-error` with `git push failed` (403) THEN the poller's GitHub App lacks `contents: write` or branch protection rejects the push; conflicts then go to the agent as before. `review.auto-merge-skip reason=...` is informational.
20. `Needs human` with `session could not be aborted` THEN the opencode session may still be running in the worktree: find it by title (`GET /session`), abort it (`POST /session/<id>/abort`) or restart the opencode container, and inspect the worktree before moving the ticket back.
21. `review.fix-resumed` THEN the `changes requested` comment was already written but the label or move failed earlier; the poller only redid those (no second round).
22. `run.retry` followed by the same failure THEN the second failure goes to `Needs human`; read the reason. IF a ticket keeps bouncing between lanes THEN look for `Agent: retrying` comments: more than one since the lane entry means a human moved it back.
23. `stale claim` (checked every pass; the poller's 👀 on an `In Progress` issue is older than the work timeout) THEN a previous work run died; check the worktree and branch before moving the ticket back.

## Editing the poller

1. IF changing a decision THEN change the pure function in `select.ts` and its table test in `tests/gate.test.ts` (scheduling: `tests/schedule.test.ts`; runner with a fake fetch: `tests/runner.test.ts`; cleanup candidates, main update, execGroup: `tests/lifecycle.test.ts`; project path, checkout plan, exclude, orphans, stacks: `tests/generic.test.ts`; docker calls: `tests/docker.test.ts`; auto-merge, retry, main retry: `tests/recovery.test.ts`; claims, keyed mutex: `tests/claims.test.ts`).
2. IF a decision depends on an agent result THEN extend `parseResult` and `workResultActions` / `reviewResultActions` (pure, tested in `tests/result.test.ts`); agents never get Linear write access.
3. IF adding a Linear, GitHub, or git write THEN route it through the `--dry-run` guard in `poller.ts`.
4. IF calling `gh` or `git` THEN use the arg-array wrappers in `github.ts` / `git.ts`, never a shell string.
5. IF changing the ctx JSON THEN update `work-ticket.md` / `review-ticket.md` / `investigate-ticket.md` (plugin and `.opencode/config/commands/` copies) and the ctx builders in `select.ts`. The commands are poller-only and stop without ` ctx:`.
6. Log ticket IDs, actions, and reasons only; never comment bodies, ticket text, or tokens.
