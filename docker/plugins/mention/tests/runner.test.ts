import { describe, expect, test } from "bun:test";
import { describeRun, extractMessage, runAgent, type RunRequest } from "../poller/runner.ts";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  body: unknown;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });
const unexpected = (status: number) => json({ name: status === 401 ? "NotAuthorized" : "ApiError" }, status);

const assistant = (content: unknown[], error?: unknown) => ({
  id: "msg1",
  type: "assistant",
  agent: "orchestrator",
  content,
  ...(error ? { error } : {}),
});
const idle = (outcome: "succeeded" | "failed" | "interrupted" = "succeeded") => ({ id: "msg2", type: "idle", outcome, time: { created: 1 } });
const text = (value: string) => ({ type: "text", text: value });
const page = (data: unknown[]) => json({ data, cursor: {} });

type Override = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response> | undefined;

const hangUntilAborted = (_call: Call, signal: AbortSignal | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

/** Answers the default routes of a run that completes at once; `override` runs first and returns undefined to fall through. */
function defaults(call: Call): Response {
  if (call.path === "/api/session/active") return json({ data: {} });
  if (call.path === "/api/session" && call.query.get("parentID")) return page([]);
  if (call.path === "/api/permission/request") return json({ location: { directory: "/repo" }, data: [] });
  if (call.path === "/api/form") return json({ location: { directory: "/repo" }, data: [] });
  if (call.path === "/api/session/ses1/message" && call.query.get("type") === "assistant") {
    return page([assistant([text("done"), text("MENTION-RESULT: {}")])]);
  }
  if (call.path === "/api/session/ses1/message" && call.query.get("type") === "idle") return page([idle()]);
  if (call.path === "/api/session/ses1/interrupt") return json({ interrupted: true });
  return noContent();
}

/** Fake OpenCode V2 server: records calls, answers session creation, then `override`, then the defaults. */
function fake(override: Override = () => undefined) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      authorization: new Headers(init?.headers).get("Authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (call.method === "POST" && call.path === "/api/session") return json({ data: { id: "ses1" } });
    return (await override(call, init?.signal ?? undefined)) ?? defaults(call);
  };
  return { calls, fetch: impl as unknown as typeof fetch };
}

const request = (server: ReturnType<typeof fake>, over: Partial<RunRequest> = {}): RunRequest => ({
  url: "http://oc:4096/",
  password: "secret",
  agent: "orchestrator",
  command: "reply-mention",
  message: 'ctx:{"a":1}',
  dir: "/repo",
  title: "mention org/repo#1",
  timeoutMs: 5_000,
  pollMs: 10,
  fetch: server.fetch,
  ...over,
});

describe("runAgent", () => {
  test("creates a session in the project, submits the command, and returns the final text", async () => {
    const server = fake();
    const seen: string[] = [];
    const result = await runAgent(request(server, { onSession: (id) => seen.push(id) }));

    expect(result).toMatchObject({ sessionId: "ses1", error: null, timedOut: false, aborted: false });
    expect(result.output).toBe("done\nMENTION-RESULT: {}");
    expect(seen).toEqual(["ses1"]);
    expect(server.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/session",
      body: { title: "mention org/repo#1", agent: "orchestrator", location: { directory: "/repo" } },
    });
    expect(server.calls.find((c) => c.path === "/api/session/ses1/command")).toMatchObject({
      method: "POST",
      body: { name: "reply-mention", text: 'ctx:{"a":1}' },
    });
  });

  test("sends basic auth with the fixed username on every call", async () => {
    const server = fake();
    await runAgent(request(server));
    const expected = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
    expect(server.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of server.calls) expect(call.authorization).toBe(expected);
  });

  test("ignores non-text content parts", () => {
    expect(
      extractMessage(assistant([text("a"), { type: "reasoning", text: "hidden" }, { type: "tool" }, text("d")])),
    ).toEqual({ output: "a\nd", error: null });
  });

  test("reports a model error from the final message", async () => {
    const server = fake((call) =>
      call.path === "/api/session/ses1/message" && call.query.get("type") === "assistant"
        ? page([assistant([], { type: "APIError", message: "rate\nlimited" })])
        : undefined,
    );
    const result = await runAgent(request(server));
    expect(result.error).toBe("APIError: rate limited");
    expect(result.output).toBe("");
  });

  test("a run that ends in failure without a model error is reported", async () => {
    const server = fake((call) =>
      call.path === "/api/session/ses1/message" && call.query.get("type") === "idle" ? page([idle("failed")]) : undefined,
    );
    expect((await runAgent(request(server))).error).toBe("run failed");
  });

  test("a failed run without an assistant message reports the cause from the idle message", async () => {
    const server = fake((call) => {
      if (call.path !== "/api/session/ses1/message") return undefined;
      if (call.query.get("type") === "assistant") return page([]);
      return page([{ ...idle("failed"), error: { type: "provider.no-route", message: "No model is available" } }]);
    });
    expect((await runAgent(request(server))).error).toBe("provider.no-route: No model is available");
  });

  test("a run that succeeds without an assistant message is an error", async () => {
    const server = fake((call) =>
      call.path === "/api/session/ses1/message" && call.query.get("type") === "assistant" ? page([]) : undefined,
    );
    expect((await runAgent(request(server))).error).toBe("no assistant message");
  });

  test("a failing session create is reported without a session", async () => {
    const server = fake();
    const failing = { ...server, fetch: (async () => unexpected(401)) as unknown as typeof fetch };
    const result = await runAgent(request(failing));
    expect(result).toMatchObject({ sessionId: null, error: "session create failed: NotAuthorized" });
    expect(server.calls).toEqual([]);
  });

  test("an HTTP error on the command is reported and not retried", async () => {
    const server = fake((call) => (call.path === "/api/session/ses1/command" ? unexpected(404) : undefined));
    const result = await runAgent(request(server));
    expect(result.error).toMatch(/^run failed: /);
    expect(server.calls.filter((c) => c.path === "/api/session/ses1/command")).toHaveLength(1);
  });

  test("on timeout it interrupts the server session and reports timedOut", async () => {
    const server = fake((call, signal) => (call.path === "/api/experimental/session/ses1/wait" ? hangUntilAborted(call, signal) : undefined));
    const result = await runAgent(request(server, { timeoutMs: 40 }));
    expect(result).toMatchObject({ timedOut: true, aborted: false, error: null, sessionId: "ses1" });
    const interrupts = server.calls.filter((c) => c.path === "/api/session/ses1/interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].method).toBe("POST");
  });

  test("an abort signal interrupts the server session and reports aborted", async () => {
    const controller = new AbortController();
    const server = fake((call, signal) => {
      if (call.path !== "/api/experimental/session/ses1/wait") return undefined;
      setTimeout(() => controller.abort(), 20);
      return hangUntilAborted(call, signal);
    });
    const result = await runAgent(request(server, { signal: controller.signal }));
    expect(result).toMatchObject({ aborted: true, timedOut: false });
    expect(server.calls.some((c) => c.path === "/api/session/ses1/interrupt")).toBe(true);
  });

  test("an already aborted signal never leaves the session running", async () => {
    const controller = new AbortController();
    controller.abort();
    const server = fake((call, signal) => (call.path === "/api/experimental/session/ses1/wait" ? hangUntilAborted(call, signal) : undefined));
    const result = await runAgent(request(server, { signal: controller.signal }));
    expect(result.aborted).toBe(true);
    expect(server.calls.some((c) => c.path === "/api/session/ses1/interrupt")).toBe(true);
  });

  test("a failed interrupt with a session that goes idle is an ordinary timeout", async () => {
    const server = fake((call, signal) => {
      if (call.path === "/api/session/ses1/interrupt") return unexpected(500);
      return call.path === "/api/experimental/session/ses1/wait" ? hangUntilAborted(call, signal) : undefined;
    });
    const result = await runAgent(request(server, { timeoutMs: 30 }));
    expect(result).toMatchObject({ timedOut: true, stuck: false, error: null });
  });

  test("a failed interrupt with a session that stays running is stuck", async () => {
    const server = fake((call, signal) => {
      if (call.path === "/api/session/ses1/interrupt") return unexpected(500);
      if (call.path === "/api/session/active") return json({ data: { ses1: { type: "running" } } });
      return call.path === "/api/experimental/session/ses1/wait" ? hangUntilAborted(call, signal) : undefined;
    });
    const result = await runAgent(request(server, { timeoutMs: 30, stuckWaitMs: 100, pollMs: 10 }));
    expect(result).toMatchObject({ timedOut: true, stuck: true, error: "session could not be aborted" });
    expect(describeRun(result)).toBe("session could not be aborted");
  });

  test("during shutdown the wait for an unabortable session is capped separately and short", async () => {
    const controller = new AbortController();
    const server = fake((call, signal) => {
      if (call.path === "/api/session/ses1/interrupt") return unexpected(500);
      if (call.path === "/api/session/active") return json({ data: { ses1: { type: "running" } } });
      if (call.path !== "/api/experimental/session/ses1/wait") return undefined;
      setTimeout(() => controller.abort(), 10);
      return hangUntilAborted(call, signal);
    });
    const started = Date.now();
    const result = await runAgent(
      request(server, { signal: controller.signal, stuckWaitMs: 60_000, shutdownStuckWaitMs: 80, pollMs: 10 }),
    );
    expect(result).toMatchObject({ aborted: true, stuck: true });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("waits for subagent sessions to go idle before reading the result", async () => {
    let activeCalls = 0;
    const server = fake((call) => {
      if (call.path === "/api/session" && call.query.get("parentID") === "ses1") {
        return page([{ id: "ses2", parentID: "ses1" }]);
      }
      if (call.path === "/api/session/active") {
        activeCalls++;
        return json({ data: activeCalls < 3 ? { ses2: { type: "running" } } : {} });
      }
      return undefined;
    });
    const result = await runAgent(request(server));
    expect(result).toMatchObject({ error: null, output: "done\nMENTION-RESULT: {}" });
    expect(activeCalls).toBe(3);
  });

  test("a finished answer wins over a timeout that fired at the same moment", async () => {
    const server = fake(async (call) => {
      if (call.path !== "/api/experimental/session/ses1/wait") return undefined;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return noContent();
    });
    const result = await runAgent(request(server, { timeoutMs: 30 }));
    expect(result).toMatchObject({ timedOut: false, aborted: false, stuck: false, error: null, output: "done\nMENTION-RESULT: {}" });
  });

  test("rejects pending permission requests of this session only", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const server = fake(async (call) => {
      if (call.path === "/api/experimental/session/ses1/wait") {
        await released;
        return noContent();
      }
      if (call.path === "/api/permission/request") {
        return json({
          location: { directory: "/repo" },
          data: [
            { id: "per1", sessionID: "ses1", action: "shell", resources: ["rm"] },
            { id: "per2", sessionID: "ses2", action: "edit", resources: ["x"] },
          ],
        });
      }
      if (call.path === "/api/session/ses1/permission/per1/reply") {
        release();
        return noContent();
      }
      return undefined;
    });
    const events: string[] = [];
    const result = await runAgent(request(server, { onEvent: (event, detail) => events.push(`${event}:${detail}`) }));
    expect(result.output).toBe("done\nMENTION-RESULT: {}");
    expect(events).toEqual(["permission-rejected:shell"]);
    const replies = server.calls.filter((c) => c.method === "POST" && c.path.endsWith("/reply"));
    expect(replies.map((c) => c.path)).toEqual(["/api/session/ses1/permission/per1/reply"]);
    expect(replies[0].body).toEqual({ decision: "reject" });
  });

  test("a failing permission poll is reported, not fatal", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const server = fake(async (call) => {
      if (call.path === "/api/experimental/session/ses1/wait") {
        await released;
        return noContent();
      }
      if (call.path === "/api/permission/request") {
        release();
        return unexpected(500);
      }
      return undefined;
    });
    const events: string[] = [];
    const result = await runAgent(request(server, { onEvent: (event, detail) => events.push(`${event}:${detail}`) }));
    expect(result.output).toBe("done\nMENTION-RESULT: {}");
    expect(events[0]).toMatch(/^poll-error:/);
  });

  test("a dropped command connection is reported", async () => {
    const server = fake((call) =>
      call.path === "/api/session/ses1/command" ? (Promise.reject(new TypeError("connection reset")) as Promise<Response>) : undefined,
    );
    expect((await runAgent(request(server))).error).toBe("run failed: Transport: connection reset");
  });

  test("cancels question forms of this session family, not of unrelated sessions", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const form = (id: string, sessionID: string, kind: string) => ({
      id,
      sessionID,
      title: "Question",
      metadata: { kind },
      fields: [],
    });
    const server = fake(async (call) => {
      if (call.path === "/api/experimental/session/ses1/wait") {
        await released;
        return noContent();
      }
      if (call.path === "/api/form") {
        return json({
          location: { directory: "/repo" },
          data: [form("f1", "ses1", "question"), form("f2", "ses9", "question"), form("f3", "ses1", "other")],
        });
      }
      if (call.path === "/api/session" && call.query.get("parentID") === "ses1") return page([]);
      if (call.method === "DELETE" && call.path === "/api/session/ses1/form/f1") {
        release();
        return noContent();
      }
      return undefined;
    });
    const events: string[] = [];
    const result = await runAgent(request(server, { onEvent: (event, detail) => events.push(`${event}:${detail}`) }));
    expect(result.output).toBe("done\nMENTION-RESULT: {}");
    expect(events).toEqual(["question-rejected:rejected"]);
    const cancelled = server.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(cancelled).toEqual(["/api/session/ses1/form/f1"]);
  });
});

describe("describeRun", () => {
  const base = { sessionId: "s", error: null, timedOut: false, aborted: false, stuck: false, output: "", durationMs: 125_000 };
  test("names the most specific cause", () => {
    expect(describeRun({ ...base, aborted: true })).toBe("poller stopped");
    expect(describeRun({ ...base, timedOut: true })).toBe("timeout after 2 min");
    expect(describeRun({ ...base, error: "APIError: x" })).toBe("agent error: APIError: x");
  });
});
