// HTTP client for the opencode server (legacy `/session` routes, directory via `?directory=`).
// A run = create session, POST the slash command (blocks until the agent finishes), return the final
// assistant text. Pending permission requests of the session are rejected while the command runs.
const CALL_TIMEOUT_MS = 30_000;
// A poller that is shutting down has little time: its abort calls must fail fast.
const SHUTDOWN_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_STUCK_WAIT_MS = 120_000;
// Shutdown (abort call + this wait) must fit well inside the poller's 50 s drain.
const DEFAULT_SHUTDOWN_STUCK_WAIT_MS = 15_000;
const MAX_FAMILY_SESSIONS = 100;
const DEFAULT_POLL_MS = 5_000;
const MAX_ERROR_CHARS = 200;

export interface RunRequest {
  url: string;
  username: string;
  password: string;
  agent: string;
  /** Command name without the slash. */
  command: string;
  /** The command's `$ARGUMENTS`. */
  message: string;
  /** Project directory the session runs in. */
  dir: string;
  title: string;
  timeoutMs: number;
  /** Aborts the session on poller shutdown. */
  signal?: AbortSignal;
  onSession?: (sessionId: string) => void;
  onEvent?: (event: "permission-rejected" | "poll-error", detail: string) => void;
  fetch?: typeof fetch;
  pollMs?: number;
  /** How long to wait for a session to go idle after a failed abort before declaring it stuck. */
  stuckWaitMs?: number;
  /** Same, while the poller is shutting down. */
  shutdownStuckWaitMs?: number;
}

export interface RunResult {
  sessionId: string | null;
  /** Why the run failed (session, HTTP, model or abort error), or null. Never a transcript. */
  error: string | null;
  timedOut: boolean;
  aborted: boolean;
  /** The server abort failed and the session was still busy afterwards: it may still be changing files. */
  stuck: boolean;
  /** Concatenated text parts of the final assistant message. Only for marker parsing; never log it. */
  output: string;
  durationMs: number;
}

export function describeRun(result: RunResult): string {
  if (result.stuck) return "session could not be aborted";
  if (result.aborted) return "poller stopped";
  if (result.timedOut) return `timeout after ${Math.round(result.durationMs / 60_000)} min`;
  return `agent error: ${result.error}`;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const shorten = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
const describeError = (error: unknown) => (error instanceof HttpError ? error.message : (error as Error).name);

interface Extracted {
  output: string;
  error: string | null;
}

/** Final text and error of an assistant message (`{info, parts}`). */
export function extractMessage(message: unknown): Extracted {
  const { info, parts } = (message ?? {}) as { info?: { error?: { name?: string; data?: { message?: string } } }; parts?: unknown };
  if (!info || !Array.isArray(parts)) return { output: "", error: "unexpected response" };
  const texts = parts
    .filter((p) => p?.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string")
    .map((p) => p.text as string);
  const failure = info.error;
  return {
    output: texts.join("\n"),
    error: failure ? shorten(`${failure.name ?? "error"}: ${failure.data?.message ?? ""}`) : null,
  };
}

function createApi(req: RunRequest) {
  const send = req.fetch ?? fetch;
  const base = req.url.replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${req.username}:${req.password}`).toString("base64")}`;
  return async function call(
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ) {
    const url = new URL(`${base}${path}`);
    url.searchParams.set("directory", req.dir);
    const response = await send(url.toString(), {
      method,
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS),
    });
    if (!response.ok) throw new HttpError(response.status);
    const text = await response.text();
    return text === "" ? null : JSON.parse(text);
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Never throws: every failure is reported in the result. */
export async function runAgent(req: RunRequest): Promise<RunResult> {
  const started = Date.now();
  const call = createApi(req);
  const pollMs = req.pollMs ?? DEFAULT_POLL_MS;
  let sessionId: string | null = null;
  let timedOut = false;
  let aborted = false;
  let stuck = false;
  const result = (partial: Partial<RunResult>): RunResult => ({
    sessionId,
    error: null,
    timedOut,
    aborted,
    stuck,
    output: "",
    durationMs: Date.now() - started,
    ...partial,
  });

  try {
    const session = await call("POST", "/session", { body: { title: req.title } });
    if (typeof session?.id !== "string") return result({ error: "session create: unexpected response" });
    sessionId = session.id;
  } catch (error) {
    return result({ error: `session create failed: ${describeError(error)}` });
  }
  const id = sessionId;
  req.onSession?.(id);

  const controller = new AbortController();

  /** Polls until the session is no longer busy; false if it still is after `stuckWaitMs` (or cannot be read). */
  async function waitIdle(reason: "timeout" | "abort"): Promise<boolean> {
    const limit = reason === "abort" ? (req.shutdownStuckWaitMs ?? DEFAULT_SHUTDOWN_STUCK_WAIT_MS) : (req.stuckWaitMs ?? DEFAULT_STUCK_WAIT_MS);
    const deadline = Date.now() + Math.min(limit, req.stuckWaitMs ?? limit);
    for (;;) {
      try {
        const status = (await call("GET", "/session/status")) as Record<string, { type: string }>;
        const type = status?.[id]?.type;
        if (type !== "busy" && type !== "retry") return true;
      } catch {
        // an unreadable status is retried until the deadline
      }
      if (Date.now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  let stopped: Promise<void> | null = null;
  const stop = (reason: "timeout" | "abort"): Promise<void> => {
    if (stopped) return stopped;
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    stopped = (async () => {
      let abortFailed = false;
      try {
        await call("POST", `/session/${id}/abort`, {
          timeoutMs: reason === "abort" ? SHUTDOWN_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS,
        });
      } catch {
        abortFailed = true;
      }
      controller.abort();
      // A session that cannot be aborted may still be editing the worktree: never let anyone start a second one.
      if (abortFailed && !(await waitIdle(reason))) stuck = true;
    })();
    return stopped;
  };
  const onShutdown = () => void stop("abort");
  const timer = setTimeout(() => void stop("timeout"), req.timeoutMs);
  req.signal?.addEventListener("abort", onShutdown, { once: true });
  if (req.signal?.aborted) onShutdown();

  /** The session and all subagent sessions below it (permission requests may come from any of them). */
  async function sessionFamily(): Promise<Set<string>> {
    const family = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0 && family.size < MAX_FAMILY_SESSIONS) {
      const children = (await call("GET", `/session/${queue.shift()}/children`)) as { id?: unknown }[];
      for (const child of children) {
        if (typeof child?.id === "string" && !family.has(child.id)) {
          family.add(child.id);
          queue.push(child.id);
        }
      }
    }
    return family;
  }

  async function rejectPermissions(): Promise<void> {
    try {
      const pending = (await call("GET", "/permission")) as { id: string; sessionID: string; permission: string }[];
      const family = pending.some((p) => p.sessionID !== id) ? await sessionFamily() : new Set([id]);
      for (const request of pending.filter((p) => family.has(p.sessionID))) {
        await call("POST", `/permission/${request.id}/reply`, { body: { reply: "reject" } });
        req.onEvent?.("permission-rejected", request.permission);
      }
    } catch (error) {
      req.onEvent?.("poll-error", describeError(error));
    }
  }
  let inflight = false;
  const ticker = setInterval(() => {
    if (inflight) return;
    inflight = true;
    void rejectPermissions().finally(() => {
      inflight = false;
    });
  }, pollMs);

  /** The command request broke (not aborted by us): wait for the session to go idle, then read its last message. */
  async function recover(): Promise<Extracted> {
    for (;;) {
      if (timedOut || aborted) return { output: "", error: null };
      try {
        const status = (await call("GET", "/session/status")) as Record<string, { type: string }>;
        const type = status?.[id]?.type;
        if (type !== "busy" && type !== "retry") break;
      } catch (error) {
        return { output: "", error: `connection lost: ${describeError(error)}` };
      }
      await sleep(pollMs);
    }
    try {
      const messages = (await call("GET", `/session/${id}/message`)) as { info?: { role?: string } }[];
      const last = [...messages].reverse().find((m) => m.info?.role === "assistant");
      return last ? extractMessage(last) : { output: "", error: "no assistant message" };
    } catch (error) {
      return { output: "", error: `connection lost: ${describeError(error)}` };
    }
  }

  let extracted: Extracted = { output: "", error: null };
  let responded = false;
  try {
    const response = await call("POST", `/session/${id}/command`, {
      body: { command: req.command, arguments: req.message, agent: req.agent },
      signal: controller.signal,
    });
    extracted = extractMessage(response);
    responded = true;
  } catch (error) {
    if (!timedOut && !aborted) {
      extracted = error instanceof HttpError ? { output: "", error: `command failed: ${error.message}` } : await recover();
    }
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    req.signal?.removeEventListener("abort", onShutdown);
  }
  await stopped;
  // A finished answer beats a late timeout or shutdown: the run is over and its result is real.
  if (responded && extracted.error === null && !stuck) {
    return result({ ...extracted, timedOut: false, aborted: false });
  }
  if (timedOut || aborted) return result({ error: stuck ? "session could not be aborted" : null });
  return result(extracted);
}
