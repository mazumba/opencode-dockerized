import { describe, expect, test, spyOn } from "bun:test";
import { loadConfig, type Config } from "../poller/config.ts";
import { createPoller } from "../poller/poller.ts";
import { createGh, ensureInstallationId } from "../poller/github.ts";
import type { RunResult } from "../poller/runner.ts";
import type { Exec } from "../poller/exec.ts";
import { createGit, type CleanupEntry, type CleanupResult } from "../poller/git.ts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const config: Config = { ...loadConfig({
  MENTION_HANDLE: "@helper", MENTION_BOT_LOGIN: "helper[bot]", MENTION_ALLOWED_USERS: "alice",
  MENTION_PROJECTS_ROOT: "/projects", OPENCODE_SERVER_PASSWORD: "test",
}, []), handle: "@helper", botLogin: "helper[bot]" };
const now = Date.parse("2026-10-20T12:00:00Z");
const trigger = (id: number, pr = 1) => ({
  id, html_url: `https://github.com/org/repo/pull/${pr}#issuecomment-${id}`,
  issue_url: `https://api.github.com/repos/org/repo/issues/${pr}`, body: "@helper help",
  created_at: new Date(now - (10 - id) * 1_000).toISOString(), user: { login: "alice", type: "User" },
});
const pull = { state: "open", merged: false, head: { ref: "feature", sha: "a".repeat(40), repo: { full_name: "org/repo" } }, base: { ref: "main" }, maintainer_can_modify: true };
const result: RunResult = { sessionId: "s1", error: null, timedOut: false, aborted: false, stuck: false, output: 'MENTION-RESULT: {"outcome":"replied"}', durationMs: 1 };
function fixture(options: { dryRun?: boolean; replied?: boolean; prepError?: boolean; role?: string; closed?: boolean; comments?: ReturnType<typeof trigger>[]; runResult?: RunResult } = {}) {
  const writes: string[] = [];
  const events: string[] = [];
  const gh = {
    repos: async () => [{ full_name: "org/repo", archived: false }, { full_name: "org/archive", archived: true }],
    comments: async () => options.comments ?? [trigger(1)],
    hasEyes: async () => false,
    role: async () => { events.push("role"); return options.role ?? "admin"; },
    pull: async () => options.closed ? { ...pull, state: "closed" } : pull,
    eyes: async () => { writes.push("eyes"); events.push("claim"); },
    reply: async (_repo: string, _pr: number, body: string) => { writes.push(body); },
    hasReply: async () => options.replied ?? false,
  };
  const git = {
    cleanupEntries: async (): Promise<CleanupEntry[]> => [],
    cleanup: async (_root: string, _repo: string, _pr: number): Promise<CleanupResult> => ({ decision: { action: "remove" }, saved: 0 }),
    prepare: async (..._args: Parameters<ReturnType<typeof createGit>["prepare"]>) => {
      events.push("prepare");
      if (options.prepError) throw new Error("private detail");
      return { worktree: "/projects/repo/.slim/worktrees/mention-pr-1", headSha: "a".repeat(40), baseSha: "b".repeat(40) };
    },
  };
  const run = async () => { events.push("run"); return options.runResult ?? result; };
  const poller = createPoller({ ...config, dryRun: options.dryRun ?? false }, gh, git, run);
  return { poller, gh, git, writes, events };
}
describe("poller lifecycle", () => {
  test("passes base ref to prepare and fetched SHAs to runner context", async () => {
    const f = fixture({ replied: true });
    const prepare = spyOn(f.git, "prepare");
    const requests: import("../poller/runner.ts").RunRequest[] = [];
    const p = createPoller(config, f.gh, f.git, async (req) => { requests.push(req); return result; });
    await p.pass(now); await p.drain();
    expect(prepare.mock.calls[0].slice(0, 6)).toEqual([config.projectsRoot, "org/repo", 1, "feature", "main", true]);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].message.slice("ctx:".length))).toMatchObject({
      baseRef: "main", headRef: "feature", headSha: "a".repeat(40), baseSha: "b".repeat(40),
      worktree: "/projects/repo/.slim/worktrees/mention-pr-1",
    });
    expect(requests[0].dir).toBe("/projects/repo/.slim/worktrees/mention-pr-1");
  });
  test("dry-run has no mutations or agents", async () => {
    const f = fixture({ dryRun: true }); await f.poller.pass(now); await f.poller.drain();
    expect(f.writes).toEqual([]); expect(f.events).toEqual(["role"]);
  });
  test("prepare then claim then agent; no duplicate when agent replied", async () => {
    const f = fixture({ replied: true }); await f.poller.pass(now); await f.poller.drain();
    expect(f.events).toEqual(["role", "prepare", "claim", "run"]); expect(f.writes).toEqual(["eyes"]);
  });
  test("missing reply gets exactly one fallback", async () => {
    const f = fixture(); await f.poller.pass(now); await f.poller.drain();
    expect(f.writes).toEqual(["eyes", "@alice mention-poller: run failed — agent posted no reply"]);
  });
  test("failed marker does not cause a second reply", async () => {
    const f = fixture({ replied: true, runResult: { ...result, output: 'MENTION-RESULT: {"outcome":"failed","reason":"blocked"}' } });
    await f.poller.pass(now); await f.poller.drain(); expect(f.writes).toEqual(["eyes"]);
  });
  test("prep failure is claimed and reported without leaking arbitrary errors", async () => {
    const f = fixture({ prepError: true }); await f.poller.pass(now); await f.poller.drain();
    expect(f.writes).toEqual(["eyes", "@alice mention-poller failed: internal error"]); expect(f.events).not.toContain("run");
  });
  test("closed PR skips git and agents", async () => {
    const f = fixture({ closed: true }); await f.poller.pass(now); await f.poller.drain();
    expect(f.writes).toEqual(["eyes", "@alice PR is closed; nothing done."]); expect(f.events).toEqual(["role", "claim"]);
  });
  test("denied role stays unclaimed", async () => {
    const f = fixture({ role: "write" }); await f.poller.pass(now); await f.poller.drain(); expect(f.writes).toEqual([]);
  });
  test("passes do not await jobs; one per PR; role cached per pass", async () => {
    const f = fixture({ comments: [trigger(2), trigger(1), trigger(3, 2), trigger(4, 3)] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    const p = createPoller(config, f.gh, f.git, async () => { runs++; await gate; return result; });
    await p.pass(now); await p.pass(now);
    expect(runs).toBe(2); expect(f.events.filter((event) => event === "role")).toHaveLength(2);
    release(); await p.drain();
  });
  test("shutdown aborts live run", async () => {
    const f = fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    const p = createPoller(config, f.gh, f.git, async (req) => {
      started();
      await new Promise<void>((resolve) => req.signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return { ...result, aborted: true, output: "" };
    });
    await p.pass(now); await ready; p.stop(); await p.drain(); expect(aborted).toBe(true);
  });
});
describe("worktree cleanup", () => {
  const entry = { pr: 12, path: "/projects/repo/.slim/worktrees/mention-pr-12" };
  test("open PR is untouched", async () => {
    const f = fixture({ comments: [] });
    f.git.cleanupEntries = async () => [entry];
    const inspect = spyOn(f.git, "cleanup");
    await f.poller.pass(now);
    expect(inspect).not.toHaveBeenCalled();
  });
  test("live job is untouched without even requesting PR state", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const p = createPoller(config, f.gh, f.git, async () => { started(); await gate; return result; });
    await p.pass(now); await ready;
    f.git.cleanupEntries = async () => [{ ...entry, pr: 1 }];
    f.gh.comments = async () => [];
    const pulls = spyOn(f.gh, "pull");
    const inspect = spyOn(f.git, "cleanup");
    try {
      await p.pass(now);
      expect(pulls).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
    } finally { release(); await p.drain(); }
  });
  test("cleanup failure continues to next worktree and new jobs", async () => {
    const f = fixture({ closed: true });
    f.git.cleanupEntries = async () => [entry, { ...entry, pr: 13 }];
    const inspected: number[] = [];
    f.git.cleanup = async (_root, _repo, pr) => {
      inspected.push(pr);
      if (pr === 12) throw new Error("private error");
      return { decision: { action: "remove" }, saved: 1 };
    };
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      await f.poller.pass(now); await f.poller.drain();
      expect(inspected).toEqual([12, 13]);
      expect(f.writes).toContain("eyes");
      const lines = logs.mock.calls.map(([line]) => JSON.parse(line));
      expect(lines).toContainEqual(expect.objectContaining({ event: "cleanup.error", repo: "org/repo", pr: 12, reason: "internal error" }));
      expect(lines).toContainEqual(expect.objectContaining({ event: "pass.done", cleanup: 1 }));
    } finally { logs.mockRestore(); }
  });
  test("dry-run cleanup performs read checks but no fetch, remove or update-ref", async () => {
    const root = await mkdtemp("/tmp/opencode/mention-cleanup-poller-");
    const checkout = join(root, "repo");
    const path = join(checkout, ".slim/worktrees/mention-pr-12");
    await mkdir(path, { recursive: true });
    const calls: string[][] = [];
    const run: Exec = async (args) => {
      calls.push(args);
      let stdout = "";
      if (args.includes("--show-toplevel")) stdout = checkout;
      else if (args.includes("get-url")) stdout = "https://github.com/org/repo.git";
      else if (args.includes("list")) stdout = `worktree ${path}\0detached\0\0`;
      return { code: 0, stdout, stderr: "", timedOut: false };
    };
    const f = fixture({ comments: [], closed: true });
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      await createPoller({ ...config, projectsRoot: root, dryRun: true }, f.gh, createGit(run)).pass(now);
      expect(calls.some((args) => args.includes("status"))).toBe(true);
      expect(calls.some((args) => args.includes("merge-base"))).toBe(true);
      expect(calls.some((args) => args.includes("fetch") || args.includes("remove") || args.includes("update-ref"))).toBe(false);
      const lines = logs.mock.calls.map(([line]) => JSON.parse(line));
      expect(lines).toContainEqual(expect.objectContaining({ event: "dry-run.cleanup", pr: 12, decision: "remove" }));
      expect(lines).toContainEqual(expect.objectContaining({ event: "pass.done", cleanup: 0 }));
    } finally { logs.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
  test("skip logs deduplicate, change with reason, and reset after open or done", async () => {
    const f = fixture({ closed: true, comments: [] });
    f.git.cleanupEntries = async () => [entry];
    let reason = "not registered";
    f.git.cleanup = async () => ({ decision: { action: "skip", reason }, saved: 0 });
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      await f.poller.pass(now); await f.poller.pass(now);
      reason = "uncommitted changes"; await f.poller.pass(now);
      f.gh.pull = async () => pull; await f.poller.pass(now);
      f.gh.pull = async () => ({ ...pull, state: "closed" }); await f.poller.pass(now);
      f.git.cleanup = async () => ({ decision: { action: "remove" }, saved: 0 }); await f.poller.pass(now);
      f.git.cleanup = async () => ({ decision: { action: "skip", reason }, saved: 0 }); await f.poller.pass(now);
      expect(logs.mock.calls.map(([line]) => JSON.parse(line)).filter((line) => line.event === "cleanup.skip").map((line) => line.reason))
        .toEqual(["not registered", "uncommitted changes", "uncommitted changes", "uncommitted changes"]);
    } finally { logs.mockRestore(); }
  });
});
describe("GitHub wrapper", () => {
  test("all writes share the dry-run guard", async () => {
    const calls: string[][] = [];
    const run: Exec = async (args) => { calls.push(args); return { code: 0, stdout: "{}", stderr: "", timedOut: false }; };
    const gh = createGh(true, run);
    await gh.eyes("org/repo", 1); await gh.reply("org/repo", 1, "private body"); expect(calls).toEqual([]);
    await createGh(false, run).reply("org/repo", 1, "body; not shell code");
    expect(calls[0]).toContain("body=body; not shell code"); expect(calls[0][0]).toBe("gh");
  });
  test("installation discovery sets child env without /app token request", async () => {
    const env: Record<string, string | undefined> = {};
    await ensureInstallationId({ env, cacheExists: async () => false,
      run: async (args) => { expect(args[1]).toBe("--jwt"); return { code: 0, stdout: "jwt", stderr: "", timedOut: false }; },
      fetchInstallations: async () => [{ id: 123 }],
    });
    expect(env.GH_APP_INSTALLATION_ID).toBe("123");
  });
});
