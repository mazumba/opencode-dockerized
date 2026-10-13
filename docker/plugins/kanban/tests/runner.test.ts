import { describe, expect, test } from "bun:test";
import { describeRun, extractMessage, runAgent, type RunRequest } from "../poller/runner.ts";

interface Call {
  method: string;
  path: string;
  directory: string | null;
  authorization: string | null;
  body: unknown;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const assistant = (parts: unknown[], error?: unknown) => ({
  info: { id: "msg1", sessionID: "ses1", role: "assistant", ...(error ? { error } : {}) },
  parts,
});
const text = (value: string, extra: object = {}) => ({ type: "text", text: value, ...extra });

type Handler = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** Fake opencode server: records calls, routes through `handler`, defaults to a plain session create. */
function fake(handler: Handler) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      authorization: new Headers(init?.headers).get("Authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (call.method === "POST" && call.path === "/session") return json({ id: "ses1" });
    return handler(call, init?.signal ?? undefined);
  };
  return { calls, fetch: impl as unknown as typeof fetch };
}

const request = (server: ReturnType<typeof fake>, over: Partial<RunRequest> = {}): RunRequest => ({
  url: "http://oc:4096/",
  username: "opencode",
  password: "secret",
  agent: "ticket-worker",
  command: "work-ticket",
  message: 'DEY-1 ctx:{"a":1}',
  dir: "/repo",
  title: "kanban work DEY-1",
  timeoutMs: 5_000,
  pollMs: 10,
  fetch: server.fetch,
  ...over,
});

const hangUntilAborted: Handler = (_call, signal) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

describe("runAgent", () => {
  test("creates a session, sends the command, and returns the final text", async () => {
    const server = fake((call) => {
      if (call.path === "/session/ses1/command") return json(assistant([text("done"), text("KANBAN-RESULT: {}")]));
      return json([]);
    });
    const seen: string[] = [];
    const result = await runAgent(request(server, { onSession: (id) => seen.push(id) }));

    expect(result).toMatchObject({ sessionId: "ses1", error: null, timedOut: false, aborted: false });
    expect(result.output).toBe("done\nKANBAN-RESULT: {}");
    expect(seen).toEqual(["ses1"]);
    const [create, command] = server.calls;
    expect(create).toMatchObject({ method: "POST", path: "/session", body: { title: "kanban work DEY-1" } });
    expect(command).toMatchObject({
      method: "POST",
      path: "/session/ses1/command",
      body: { command: "work-ticket", arguments: 'DEY-1 ctx:{"a":1}', agent: "ticket-worker" },
    });
  });

  test("sends basic auth and the directory on every call", async () => {
    const server = fake((call) => (call.path.endsWith("/command") ? json(assistant([text("x")])) : json([])));
    await runAgent(request(server, { pollMs: 5 }));
    const expected = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
    expect(server.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of server.calls) {
      expect(call.authorization).toBe(expected);
      expect(call.directory).toBe("/repo");
    }
  });

  test("ignores synthetic and ignored text parts and non-text parts", () => {
    expect(
      extractMessage(assistant([text("a"), text("b", { synthetic: true }), text("c", { ignored: true }), { type: "tool" }, text("d")])),
    ).toEqual({ output: "a\nd", error: null });
  });

  test("reports a model error from the final message", async () => {
    const server = fake(() => json(assistant([], { name: "APIError", data: { message: "rate\nlimited" } })));
    const result = await runAgent(request(server));
    expect(result.error).toBe("APIError: rate limited");
    expect(result.output).toBe("");
  });

  test("an unexpected command response is an error", async () => {
    const server = fake(() => json({ nope: true }));
    expect((await runAgent(request(server))).error).toBe("unexpected response");
  });

  test("a failing session create is reported without a session", async () => {
    const server = fake(() => json({}));
    const failing = { ...server, fetch: (async () => json({ name: "Unauthorized" }, 401)) as unknown as typeof fetch };
    const result = await runAgent(request(failing));
    expect(result).toMatchObject({ sessionId: null, error: "session create failed: HTTP 401" });
    expect(server.calls).toEqual([]);
  });

  test("an HTTP error on the command is reported and not retried", async () => {
    const server = fake((call) => (call.path.endsWith("/command") ? json({ name: "NotFoundError" }, 404) : json([])));
    const result = await runAgent(request(server));
    expect(result.error).toBe("command failed: HTTP 404");
    expect(server.calls.filter((c) => c.path.endsWith("/command"))).toHaveLength(1);
  });

  test("on timeout it aborts the server session and reports timedOut", async () => {
    const server = fake((call, signal) => {
      if (call.path === "/session/ses1/abort") return json(true);
      if (call.path === "/session/ses1/command") return hangUntilAborted(call, signal);
      return json([]);
    });
    const result = await runAgent(request(server, { timeoutMs: 40 }));
    expect(result).toMatchObject({ timedOut: true, aborted: false, error: null, sessionId: "ses1" });
    const abort = server.calls.filter((c) => c.path === "/session/ses1/abort");
    expect(abort).toHaveLength(1);
    expect(abort[0].method).toBe("POST");
  });

  test("an abort signal aborts the server session and reports aborted", async () => {
    const controller = new AbortController();
    const server = fake((call, signal) => {
      if (call.path === "/session/ses1/abort") return json(true);
      if (call.path === "/session/ses1/command") {
        setTimeout(() => controller.abort(), 20);
        return hangUntilAborted(call, signal);
      }
      return json([]);
    });
    const result = await runAgent(request(server, { signal: controller.signal }));
    expect(result).toMatchObject({ aborted: true, timedOut: false });
    expect(server.calls.some((c) => c.path === "/session/ses1/abort")).toBe(true);
  });

  test("an already aborted signal never leaves the session running", async () => {
    const controller = new AbortController();
    controller.abort();
    const server = fake((call, signal) => (call.path === "/session/ses1/abort" ? json(true) : hangUntilAborted(call, signal)));
    const result = await runAgent(request(server, { signal: controller.signal }));
    expect(result.aborted).toBe(true);
    expect(server.calls.some((c) => c.path === "/session/ses1/abort")).toBe(true);
  });

  test("a failed server abort with a session that goes idle is an ordinary timeout", async () => {
    const server = fake((call, signal) => {
      if (call.path === "/session/ses1/abort") return json({}, 500);
      if (call.path === "/session/ses1/command") return hangUntilAborted(call, signal);
      if (call.path === "/session/status") return json({});
      return json([]);
    });
    const result = await runAgent(request(server, { timeoutMs: 30 }));
    expect(result).toMatchObject({ timedOut: true, stuck: false, error: null });
  });

  test("a failed server abort with a session that stays busy is stuck", async () => {
    const server = fake((call, signal) => {
      if (call.path === "/session/ses1/abort") return json({}, 500);
      if (call.path === "/session/ses1/command") return hangUntilAborted(call, signal);
      if (call.path === "/session/status") return json({ ses1: { type: "busy" } });
      return json([]);
    });
    const result = await runAgent(request(server, { timeoutMs: 30, stuckWaitMs: 100, pollMs: 10 }));
    expect(result).toMatchObject({ timedOut: true, stuck: true, error: "session could not be aborted" });
    expect(describeRun(result)).toBe("session could not be aborted");
  });

  test("a stuck session after a shutdown abort is reported as stuck too", async () => {
    const controller = new AbortController();
    const server = fake((call, signal) => {
      if (call.path === "/session/ses1/abort") return json({}, 500);
      if (call.path === "/session/ses1/command") {
        setTimeout(() => controller.abort(), 10);
        return hangUntilAborted(call, signal);
      }
      if (call.path === "/session/status") return json({ ses1: { type: "retry" } });
      return json([]);
    });
    const result = await runAgent(request(server, { signal: controller.signal, stuckWaitMs: 60, pollMs: 10 }));
    expect(result).toMatchObject({ aborted: true, stuck: true });
  });

  test("during shutdown the wait for an unabortable session is capped separately and short", async () => {
    const controller = new AbortController();
    const server = fake((call, signal) => {
      if (call.path === "/session/ses1/abort") return json({}, 500);
      if (call.path === "/session/ses1/command") {
        setTimeout(() => controller.abort(), 10);
        return hangUntilAborted(call, signal);
      }
      if (call.path === "/session/status") return json({ ses1: { type: "busy" } });
      return json([]);
    });
    const started = Date.now();
    const result = await runAgent(
      request(server, { signal: controller.signal, stuckWaitMs: 60_000, shutdownStuckWaitMs: 80, pollMs: 10 }),
    );
    expect(result).toMatchObject({ aborted: true, stuck: true });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a finished answer wins over a timeout that fired at the same moment", async () => {
    const server = fake(async (call) => {
      if (call.path === "/session/ses1/abort") return json(true);
      if (call.path === "/session/ses1/command") {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return json(assistant([text("done KANBAN-RESULT")]));
      }
      return json([]);
    });
    const result = await runAgent(request(server, { timeoutMs: 30 }));
    expect(result).toMatchObject({ timedOut: false, aborted: false, stuck: false, error: null, output: "done KANBAN-RESULT" });
  });

  test("an answer with a model error does not hide the timeout", async () => {
    const server = fake(async (call) => {
      if (call.path === "/session/ses1/abort") return json(true);
      if (call.path === "/session/ses1/command") {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return json(assistant([], { name: "MessageAbortedError", data: { message: "aborted" } }));
      }
      return json([]);
    });
    const result = await runAgent(request(server, { timeoutMs: 30 }));
    expect(result).toMatchObject({ timedOut: true });
  });

  test("rejects pending permission requests of this session only", async () => {
    let release!: (response: Response) => void;
    const server = fake((call) => {
      if (call.path === "/session/ses1/command") return new Promise<Response>((resolve) => (release = resolve));
      if (call.method === "GET" && call.path === "/permission") {
        return json([
          { id: "per1", sessionID: "ses1", permission: "bash", patterns: [], metadata: {}, always: [] },
          { id: "per2", sessionID: "ses2", permission: "edit", patterns: [], metadata: {}, always: [] },
        ]);
      }
      if (call.path.endsWith("/children")) return json([]);
      if (call.path === "/permission/per1/reply") {
        release(json(assistant([text("ok")])));
        return json(true);
      }
      return json(false);
    });
    const events: string[] = [];
    const result = await runAgent(request(server, { onEvent: (event, detail) => events.push(`${event}:${detail}`) }));
    expect(result.output).toBe("ok");
    expect(events).toEqual(["permission-rejected:bash"]);
    const replies = server.calls.filter((c) => c.path.startsWith("/permission/") && c.method === "POST");
    expect(replies.map((c) => c.path)).toEqual(["/permission/per1/reply"]);
    expect(replies[0].body).toEqual({ reply: "reject" });
  });

  test("rejects permission requests of subagent child and grandchild sessions, not of unrelated ones", async () => {
    let release!: (response: Response) => void;
    const perm = (id: string, sessionID: string, permission: string) => ({
      id, sessionID, permission, patterns: [], metadata: {}, always: [],
    });
    const server = fake((call) => {
      if (call.path === "/session/ses1/command") return new Promise<Response>((resolve) => (release = resolve));
      if (call.method === "GET" && call.path === "/permission") {
        return json([perm("per1", "ses2", "bash"), perm("per2", "ses3", "edit"), perm("per3", "ses9", "webfetch")]);
      }
      if (call.path === "/session/ses1/children") return json([{ id: "ses2" }]);
      if (call.path === "/session/ses2/children") return json([{ id: "ses3" }]);
      if (call.path === "/session/ses3/children") return json([]);
      if (call.method === "POST" && call.path === "/permission/per2/reply") {
        release(json(assistant([text("ok")])));
        return json(true);
      }
      return json(true);
    });
    const events: string[] = [];
    const result = await runAgent(request(server, { onEvent: (event, detail) => events.push(`${event}:${detail}`) }));
    expect(result.output).toBe("ok");
    expect(events).toEqual(["permission-rejected:bash", "permission-rejected:edit"]);
    const replied = server.calls.filter((c) => c.method === "POST" && c.path.startsWith("/permission/")).map((c) => c.path);
    expect(replied).toEqual(["/permission/per1/reply", "/permission/per2/reply"]);
    expect(replied).not.toContain("/permission/per3/reply");
  });

  test("a failing permission poll is reported, not fatal", async () => {
    let release!: (response: Response) => void;
    const server = fake((call) => {
      if (call.path === "/session/ses1/command") return new Promise<Response>((resolve) => (release = resolve));
      release?.(json(assistant([text("ok")])));
      return json({}, 500);
    });
    const events: string[] = [];
    const result = await runAgent(request(server, { onEvent: (event, detail) => events.push(`${event}:${detail}`) }));
    expect(result.output).toBe("ok");
    expect(events[0]).toBe("poll-error:HTTP 500");
  });

  test("a dropped command connection recovers the final message once the session is idle", async () => {
    let statusCalls = 0;
    const server = fake((call) => {
      if (call.path === "/session/ses1/command") return Promise.reject(new TypeError("connection reset"));
      if (call.path === "/session/status") return json(++statusCalls < 2 ? { ses1: { type: "busy" } } : {});
      if (call.path === "/session/ses1/message") {
        return json([
          { info: { role: "user" }, parts: [text("prompt")] },
          assistant([text("recovered")]),
        ]);
      }
      return json([]);
    });
    const result = await runAgent(request(server));
    expect(result).toMatchObject({ output: "recovered", error: null });
    expect(statusCalls).toBe(2);
  });

  test("a dropped connection with an unreachable server is reported", async () => {
    const server = fake((call) => {
      if (call.path === "/session/ses1/command" || call.path === "/session/status") return Promise.reject(new TypeError("down"));
      return json([]);
    });
    expect((await runAgent(request(server))).error).toBe("connection lost: TypeError");
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
