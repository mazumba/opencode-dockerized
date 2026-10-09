---
name: kanban-poller
description: Kanban poller behaviour and operations. Use when running, dry-running, or debugging the Linear kanban poller, reading its logs, explaining why a ticket moved or did not move, or changing poller code in docker/plugins/kanban/poller.
---

# Kanban poller

Code: `docker/plugins/kanban/poller/`. Tests: `docker/plugins/kanban/tests/`. Commands it runs: `docker/plugins/kanban/kanban.commands/`.

## Pass order (one pass every `KANBAN_POLL_INTERVAL` s, max one agent run per pass)

1. Auto-label: IF a `Backlog` ticket has none of `needs grilling`, `investigate`, `refined` THEN add `needs grilling`. No agent.
2. Cleanup (never consumes the pass): see "Cleanup".
3. Investigate: IF an `/investigate` comment by the API key owner, < 7 days old, has no 👀 THEN
   1. Config check (project `repo:`/`path:`, origin). IF it fails THEN react ❌, reply `failed`, next.
   2. ELSE react 👀, run `/investigate-ticket` (any ticket, any state, any labels), react ✅ (a new `Agent investigation:` comment exists) or ❌ + reply `failed`. End pass.
4. Review: for each `Agent review` ticket, oldest first, run the gate (see "Review gate"). IF the gate says `review` THEN run `/review-ticket`, end pass. ELSE handle it and continue with the next ticket.
5. Fix: for the oldest `In Progress` ticket with `agent:changes-requested`:
   1. Pre-flight (see below). IF it fails THEN `Needs human`, next ticket.
   2. ELSE claim with 👀 on the issue, remove the label, fetch and create/reuse the worktree, run `/work-ticket` with ctx (`fix.cause` = `ci` | `conflict` | `review`). End pass.
6. New work: for the oldest `Ready for agent` ticket:
   1. IF it has `needs grilling` or `investigate` THEN move to `Backlog` (bounce), next ticket.
   2. Pre-flight. IF it fails THEN `Needs human`, next ticket.
   3. Look up the PR for the ticket branch (`existingPrDecision`). IF it is `MERGED` or `CLOSED` THEN `Needs human` ("PR #n is merged/closed; open a new ticket"), next ticket. IF it is `OPEN` THEN pass `pr` in the ctx (follow-up, see below).
   4. ELSE claim with 👀 on the issue, move to `In Progress`, fetch and create/reuse the worktree at `<path>/.slim/worktrees/<id-lowercase>` with its `.slim/worktrees.json` lane, run `/work-ticket` with ctx. End pass.
7. IF nothing ran THEN log `pass.idle`.

## Review gate (`reviewGate` in `select.ts`, first match wins)

1. IF no PR for the ticket branch THEN `Needs human` ("no PR found").
2. IF PR is `MERGED` or `CLOSED` THEN `Needs human`.
3. IF the PR has zero checks THEN `Needs human` ("no CI checks configured").
4. IF any check is `fail` or `cancel` THEN fix `ci`.
5. IF `mergeable` is `CONFLICTING` THEN fix `conflict`.
6. IF any check is `pending` OR `mergeable` is `UNKNOWN` THEN wait (log `review.wait`, retry next pass).
7. ELSE review (reviewer gets ctx with `"ci":"green"`).

Fix handling:
1. IF `Agent review: changes requested` comments created since the ticket last entered `Ready for agent` (all of them if it never did; from Linear issue history) >= 2 THEN `Needs human` ("review limit reached").
2. ELSE add `agent:changes-requested`, move to `In Progress`, comment `Agent review: changes requested (round n/2) — <PR>` + line 2 `CI failed: <names>` or `merge conflicts with <base>`. The poller parses line 2 for `fix.cause`, so reviewer summaries must not start with those phrases.
3. IF cause is `ci` THEN reply with the last 150 lines of the failed run log.

## Follow-up after Ready for merge

A human comments the desired changes and moves the ticket to `Ready for agent`. The poller finds the open PR on the branch and runs `/work-ticket` with `pr` and no `fix`; the worker pushes to that PR. The round count restarts at each entry into `Ready for agent`, so every request gets 2 review rounds. A merged or closed PR goes to `Needs human`.

## Pre-flight (work and fix runs)

1. IF the project description lacks exactly one `repo: owner/name` and one absolute `path:` THEN fail.
2. IF the ticket has no safe branch name THEN fail.
3. IF `path` is not a git repo OR `origin` does not match `repo` THEN fail.
4. IF `.slim/worktrees/` is not git-ignored in the repo THEN fail.

The poller, not the agent, fetches and creates the worktree. The GitHub App is also used for `git fetch` (needs `contents:read`).

## Cleanup

Candidates: `Ready for merge`; `Done` and `Canceled` updated in the last 14 days.

1. IF `<path>/.slim/worktrees/<id-lowercase>` does not exist THEN skip silently.
2. IF no PR OR PR is `OPEN` THEN skip.
3. IF state is `Ready for merge`/`Done` AND PR is `CLOSED` (not merged) THEN skip.
4. IF the worktree is unregistered, dirty, its HEAD or the local branch differs from the PR head SHA THEN log `cleanup.skip` with the reason. Leave it for a human.
5. ELSE `git worktree remove` (no force), `git branch -D <branch>`, drop the lane from `.slim/worktrees.json`. Log `cleanup.done`.

## Run it (from the repo root)

1. IF code changed THEN `cd docker/plugins/kanban && bun test tests/` first.
2. IF checking behaviour without side effects THEN `make kanban-poller-dry-run` (no Linear writes, no agent runs, no git mutations; GitHub and git reads are real).
3. IF running outside Docker THEN `cd docker/plugins/kanban && bun poller/poller.ts --once --dry-run` with `LINEAR_API_KEY`, `OPENCODE_SERVER_PASSWORD`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY_PATH` set.
4. IF the image or poller code changed THEN `make opencode-build-plugins` before the container targets.
5. Long-running: `make kanban-poller-run`, `make kanban-poller-logs`, `make kanban-poller-down`. One real pass: `make kanban-poller-once`.

## Required env

1. Always: `LINEAR_API_KEY`, `OPENCODE_SERVER_PASSWORD`, `KANBAN_GH_APP_ID`, `KANBAN_GH_APP_PRIVATE_KEY_PATH`.
2. IF the App is installed on more than one account THEN `KANBAN_GH_APP_INSTALLATION_ID`.
3. Projects directory mounted into `kanban-poller` at the same path as in `opencode` (`compose.override.yml`).
4. Never print `.env` or token output. IF a value must be checked THEN test presence only (`[ -n "$VAR" ]`).

## Troubleshoot (match the log event or symptom)

1. `startup failed` / `set KANBAN_GH_APP_INSTALLATION_ID` THEN set that var, or fix App ID and key path.
2. compose: `KANBAN_GH_APP_* is not set` THEN add both vars to `.env` (same values as `GH_APP_*` is fine).
3. `pass.error kind=linear` THEN read the GraphQL message; IF a state or label is missing THEN create it in Linear with the exact name.
4. `review.wait` repeating for one ticket THEN check `gh pr checks <n> --repo <repo>`; IF a check never finishes THEN fix CI, the poller waits indefinitely.
5. `review.github-error` / `fix.github-error` / `work.github-error` THEN run the same `gh` call by hand; IF 403/404 THEN the App lacks a permission or is not installed on the repo.
6. `review.fix-error` THEN the ticket may be half-updated (label/state without comment); check it in Linear.
7. `needs-human reason=...` THEN fix the cause named in the reason, then move the ticket back by hand.
8. `cleanup.skip reason=uncommitted changes` or `... differs from PR head` THEN inspect the worktree; IF the work is not needed THEN remove it by hand.
9. `cleanup.lanes-skip` THEN `.slim/worktrees.json` is missing, unreadable, or has no matching lane; harmless.
10. Ticket ends in `Needs human` with `ended in state <x>` THEN the agent did not move the ticket; read its run output in opencode.
11. `stale claim` at startup (the poller's 👀 on an `In Progress` issue is older than the work timeout) THEN a previous work run died; check the worktree and branch before moving the ticket back.

## Editing the poller

1. IF changing a decision THEN change the pure function in `select.ts` and its table test in `tests/gate.test.ts`.
2. IF adding a Linear, GitHub, or git write THEN route it through the `--dry-run` guard in `poller.ts`.
3. IF calling `gh` or `git` THEN use the arg-array wrappers in `github.ts` / `git.ts`, never a shell string.
4. IF changing the ctx JSON THEN update `work-ticket.md` / `review-ticket.md` / `investigate-ticket.md` (plugin and `.opencode/config/commands/` copies). The commands are poller-only and stop without ` ctx:`.
5. Log ticket IDs, actions, and reasons only; never comment bodies, ticket text, or tokens.
