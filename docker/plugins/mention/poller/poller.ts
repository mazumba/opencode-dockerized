import { loadConfig, type Config } from "./config.ts";
import { createGh, ensureInstallationId, resolveBotIdentity } from "./github.ts";
import { createGit } from "./git.ts";
import { log } from "./log.ts";
import { describeRun, runAgent } from "./runner.ts";
import { isCandidate, jobKey, parseResult, planStarts, prNumber, pushPolicy, REPO_PATTERN, roleAllowed, type Candidate } from "./select.ts";

// Only fixed diagnostics from our own wrappers; never CLI stderr, transcripts or bodies.
function reasonOf(error: unknown): string {
  return error instanceof Error && ["GitError", "GitHubError", "ConfigError"].includes(error.constructor.name)
    ? error.message : "internal error";
}

export function createPoller(config: Config, gh = createGh(config.dryRun), git = createGit(), run = runAgent) {
  const live = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let stopping = false;
  let questionWarningLogged = false;
  const cleanupSkips = new Map<string, string>();
  const shutdown = new AbortController();

  async function cleanupRepo(repo: string): Promise<number> {
    let removed = 0;
    let entries;
    try { entries = await git.cleanupEntries(config.projectsRoot, repo); }
    catch (error) {
      log("cleanup.error", { repo, pr: 0, reason: reasonOf(error) });
      return removed;
    }
    for (const entry of entries) {
      if (stopping) break;
      const { pr, path } = entry;
      const key = jobKey({ repo, pr });
      if (live.has(key)) continue;
      try {
        if (entry.error !== undefined) throw entry.error;
        const pull = await gh.pull(repo, pr);
        if (pull.state === "open" && !pull.merged) {
          cleanupSkips.delete(key);
          continue;
        }
        if (stopping) break;
        const { decision, saved } = await git.cleanup(config.projectsRoot, repo, pr, {
          prState: pull.state, merged: pull.merged, liveJob: live.has(key), dryRun: config.dryRun,
        }, shutdown.signal);
        if (config.dryRun) {
          log("dry-run.cleanup", { repo, pr, decision: decision.action === "skip" ? decision.reason : decision.action });
          continue;
        }
        if (decision.action === "remove") {
          removed++;
          cleanupSkips.delete(key);
          log("cleanup.done", { repo, pr, saved });
        } else if (decision.action === "keep") {
          cleanupSkips.delete(key);
        } else if (cleanupSkips.get(key) !== decision.reason) {
          cleanupSkips.set(key, decision.reason);
          log("cleanup.skip", { repo, pr, reason: decision.reason, path });
        }
      } catch (error) { log("cleanup.error", { repo, pr, reason: reasonOf(error) }); }
    }
    return removed;
  }

  async function job(candidate: Candidate, controller: AbortController): Promise<boolean> {
    const { repo, pr, comment } = candidate;
    let keepLocked = false;
    let claimed = false;
    let agentStarted = false;
    let replyAttempted = false;
    const started = Date.now();
    const claim = async () => { await gh.eyes(repo, comment.id); claimed = true; };
    // If verification fails, do not risk posting a duplicate reply.
    const replyIfMissing = async (body: string) => {
      if (!(await gh.hasReply(repo, pr, comment, config.botLogin))) {
        replyAttempted = true;
        await gh.reply(repo, pr, body);
      }
    };
    log("run.start", { repo, pr, comment: comment.id });
    try {
      const pull = await gh.pull(repo, pr);
      if (stopping) return false;
      if (pull.state === "closed" || pull.merged) {
        await claim();
        await replyIfMissing(`@${comment.user.login} PR is closed; nothing done.`);
        return false;
      }
      const policy = pushPolicy(repo, pull.head.repo?.full_name ?? null);
      const { worktree, headSha, baseSha } = await git.prepare(config.projectsRoot, repo, pr, pull.head.ref, pull.base.ref, policy.pushable, controller.signal);
      if (stopping || controller.signal.aborted) return false;
      await claim();
      if (stopping || controller.signal.aborted) {
        await replyIfMissing(`@${comment.user.login} mention-poller: run failed — poller stopped`);
        return false;
      }
      const context = {
        repo, pr, url: `https://github.com/${repo}/pull/${pr}`,
        baseRef: pull.base.ref, headRef: pull.head.ref, headSha, baseSha, worktree, ...policy,
        comment: { id: comment.id, author: comment.user.login, url: comment.html_url, body: comment.body },
      };
      agentStarted = true;
      const result = await run({
        url: config.opencodeUrl, username: config.username, password: config.password,
        agent: "orchestrator", command: "reply-mention", message: `ctx:${JSON.stringify(context)}`,
        dir: worktree, title: `mention ${repo}#${pr}`, timeoutMs: config.timeoutMs, signal: controller.signal,
        onSession: (session) => log("run.session", { repo, pr, session }),
        onEvent: (event) => {
          if (event === "question-unavailable") {
            if (questionWarningLogged) return;
            questionWarningLogged = true;
          }
          log(`run.${event}`, { repo, pr });
        },
      });
      keepLocked = result.stuck;
      const parsed = parseResult(result.output);
      const reason = result.error || result.timedOut || result.aborted || result.stuck
        ? describeRun(result)
        : !parsed.ok ? parsed.reason
          : parsed.result.outcome === "failed" ? parsed.result.reason : "agent posted no reply";
      await replyIfMissing(`@${comment.user.login} mention-poller: run failed — ${reason}`);
      log("run.result", { repo, pr, marker: parsed.ok, stuck: result.stuck, timedOut: result.timedOut, aborted: result.aborted });
    } catch (error) {
      // Only known fixed diagnostics reach replies; never CLI stderr, transcripts or bodies.
      const reason = reasonOf(error);
      log("run.error", { repo, pr, phase: agentStarted ? "settle" : "prepare", reason });
      if (!stopping && !replyAttempted) {
        try {
          if (!claimed) await claim();
          await replyIfMissing(`@${comment.user.login} mention-poller failed: ${reason}`);
        } catch { log("run.failure-reply.error", { repo, pr }); }
      }
    } finally {
      log("run.end", { repo, pr, comment: comment.id, durationMs: Date.now() - started, stuck: keepLocked });
    }
    return keepLocked;
  }

  async function pass(now = Date.now()): Promise<void> {
    const candidates: Candidate[] = [];
    const roles = new Map<string, string>();
    let repoCount = 0, scanned = 0, cleanup = 0;
    for (const repository of await gh.repos()) {
      if (stopping) return;
      const repo = repository.full_name;
      if (repository.archived || !REPO_PATTERN.test(repo)) continue;
      repoCount++;
      cleanup += await cleanupRepo(repo);
      try {
        const comments = await gh.comments(repo, new Date(now - config.lookbackMs).toISOString());
        scanned += comments.length;
        for (const comment of comments) {
          if (stopping) return;
          if (!isCandidate(comment, config, now)) continue;
          if (await gh.hasEyes(repo, comment.id, config.botLogin)) continue;
          const roleKey = `${repo.toLowerCase()}:${comment.user.login.toLowerCase()}`;
          let role = roles.get(roleKey);
          if (role === undefined) { role = await gh.role(repo, comment.user.login); roles.set(roleKey, role); }
          if (!roleAllowed(role, config.allowedRoles)) {
            log("candidate.rejected-role", { repo, comment: comment.id });
            continue;
          }
          candidates.push({ repo, pr: prNumber(comment)!, comment });
        }
      } catch (error) { log("pass.repo.error", { repo, reason: reasonOf(error) }); }
    }
    if (stopping) return;
    const starts = planStarts(candidates, new Set(live.keys()), config.maxConcurrent);
    log("pass.done", { repos: repoCount, comments: scanned, candidates: candidates.length, starts: starts.length, live: live.size, cleanup });
    for (const candidate of starts) {
      const key = jobKey(candidate);
      if (config.dryRun) {
        log("dry-run.start", { repo: candidate.repo, pr: candidate.pr, comment: candidate.comment.id });
        continue;
      }
      const controller = new AbortController();
      const entry = { controller, promise: Promise.resolve() };
      live.set(key, entry);
      entry.promise = job(candidate, controller).then((keepLocked) => {
        // A server that cannot be stopped must never share its worktree with a new run.
        if (!keepLocked) live.delete(key);
      }).catch(() => { log("run.unexpected-error", { repo: candidate.repo, pr: candidate.pr }); });
    }
  }
  return {
    pass,
    drain: () => Promise.all([...live.values()].map((entry) => entry.promise)),
    stop: () => {
      stopping = true;
      shutdown.abort();
      for (const entry of live.values()) entry.controller.abort();
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun poller/poller.ts [--once] [--dry-run]\n--once waits for started jobs. --dry-run reads GitHub only; no claims, replies, git changes or agent runs.");
    return;
  }
  const startupConfig = loadConfig(process.env, args);
  await ensureInstallationId();
  const config: Config = { ...startupConfig, ...await resolveBotIdentity(startupConfig) };
  const poller = createPoller(config);
  let stopping = false;
  let wake: (() => void) | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("shutdown.start");
    poller.stop();
    wake?.();
    shutdownTimer = setTimeout(() => { log("shutdown.deadline"); process.exit(1); }, 50_000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    do {
      try { await poller.pass(); } catch (error) { log("pass.error", { reason: reasonOf(error) }); }
      if (config.once || stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, config.pollIntervalMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    } while (!stopping);
    await poller.drain();
  } finally {
    clearTimeout(shutdownTimer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (import.meta.main) {
  main().catch((error) => { log("startup.error", { reason: reasonOf(error), hint: "check required MENTION_* and OPENCODE_SERVER_PASSWORD configuration and GitHub App installation" }); process.exitCode = 1; });
}
