// Client for the OpenCode V2 server (`/api` routes, via @opencode/client).
// A run = create session, submit the slash command (returns once admitted), wait until the session
// and its subagent sessions are idle, then return the final assistant text. Pending permission
// requests of the session are rejected while the run is in progress.
import { OpenCode } from "@opencode/client";

const CALL_TIMEOUT_MS = 30_000;
// A poller that is shutting down has little time: its abort calls must fail fast.
const SHUTDOWN_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_STUCK_WAIT_MS = 120_000;
// Shutdown (abort call + this wait) must fit well inside the poller's 50 s drain.
const DEFAULT_SHUTDOWN_STUCK_WAIT_MS = 15_000;
const MAX_FAMILY_SESSIONS = 100;
const DEFAULT_POLL_MS = 5_000;
const MAX_ERROR_CHARS = 200;
// OpenCode V2 always authenticates with this username; only the password is configurable.
const SERVER_USERNAME = "opencode";

export interface RunRequest {
  url: string;
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
  onEvent?: (event: "permission-rejected" | "question-rejected" | "poll-error", detail: string) => void;
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

const shorten = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
// Declared API errors carry their detail in `name`, with an empty message.
const describeError = (error: unknown) => (error instanceof Error ? shorten(error.message || error.name) : "error");

interface Extracted {
  output: string;
  error: string | null;
}

/** Final text and error of an assistant message (`{content, error?}`). */
export function extractMessage(message: unknown): Extracted {
  const assistant = message as { content?: unknown; error?: { type?: unknown; message?: unknown } } | undefined;
  if (!assistant || !Array.isArray(assistant.content)) return { output: "", error: "unexpected response" };
  const texts = assistant.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
  return { output: texts.join("\n"), error: assistant.error ? describeFailure(assistant.error) : null };
}

/** A structured session error (`{type, message}`) as a one-line reason. */
function describeFailure(failure: { type?: unknown; message?: unknown }): string {
  return shorten(`${String(failure.type ?? "error")}: ${String(failure.message ?? "")}`);
}

function createClient(req: RunRequest) {
  const credentials = Buffer.from(`${SERVER_USERNAME}:${req.password}`).toString("base64");
  return OpenCode.make({
    baseUrl: req.url,
    fetch: req.fetch,
    headers: { Authorization: `Basic ${credentials}` },
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const callSignal = (ms: number) => AbortSignal.timeout(ms);

/** Never throws: every failure is reported in the result. */
export async function runAgent(req: RunRequest): Promise<RunResult> {
  const started = Date.now();
  const client = createClient(req);
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

  let id: string;
  try {
    const session = await client.session.create(
      { title: req.title, agent: req.agent, location: { directory: req.dir } },
      { signal: callSignal(CALL_TIMEOUT_MS) },
    );
    id = session.id;
  } catch (error) {
    return result({ error: `session create failed: ${describeError(error)}` });
  }
  sessionId = id;
  req.onSession?.(id);

  const controller = new AbortController();

  /** True while any of the sessions is running. */
  async function anyBusy(ids: Iterable<string>, signal: AbortSignal): Promise<boolean> {
    const active = await client.session.active({ signal });
    return [...ids].some((sessionID) => sessionID in active);
  }

  /** Polls until the session is no longer running; false if it still is after the limit (or cannot be read). */
  async function waitIdle(reason: "timeout" | "abort"): Promise<boolean> {
    const limit = reason === "abort" ? (req.shutdownStuckWaitMs ?? DEFAULT_SHUTDOWN_STUCK_WAIT_MS) : (req.stuckWaitMs ?? DEFAULT_STUCK_WAIT_MS);
    const deadline = Date.now() + Math.min(limit, req.stuckWaitMs ?? limit);
    for (;;) {
      try {
        if (!(await anyBusy([id], callSignal(CALL_TIMEOUT_MS)))) return true;
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
        await client.session.interrupt(
          { sessionID: id },
          { signal: callSignal(reason === "abort" ? SHUTDOWN_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS) },
        );
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
    for (let index = 0; index < queue.length && family.size < MAX_FAMILY_SESSIONS; index++) {
      const children = await client.session.list({ parentID: queue[index], limit: MAX_FAMILY_SESSIONS }, { signal: callSignal(CALL_TIMEOUT_MS) });
      for (const child of children.data) {
        if (!family.has(child.id)) {
          family.add(child.id);
          queue.push(child.id);
        }
      }
    }
    return family;
  }

  async function rejectPermissions(): Promise<void> {
    try {
      const { data: pending } = await client.permission.request.list(
        { location: { directory: req.dir } },
        { signal: callSignal(CALL_TIMEOUT_MS) },
      );
      const family = pending.some((request) => request.sessionID !== id) ? await sessionFamily() : new Set([id]);
      for (const request of pending.filter((p) => family.has(p.sessionID))) {
        await client.permission.reply(
          { sessionID: request.sessionID, requestID: request.id, decision: "reject" },
          { signal: callSignal(CALL_TIMEOUT_MS) },
        );
        req.onEvent?.("permission-rejected", request.action);
      }
    } catch (error) {
      req.onEvent?.("poll-error", describeError(error));
    }
  }
  /** Cancels question forms (the `question` tool) of this session family: nobody answers them unattended. */
  async function rejectQuestions(): Promise<void> {
    try {
      const { data: forms } = await client.form.list({ location: { directory: req.dir } }, { signal: callSignal(CALL_TIMEOUT_MS) });
      const questions = forms.filter((form) => form.metadata?.kind === "question");
      const family = questions.some((form) => form.sessionID !== id) ? await sessionFamily() : new Set([id]);
      for (const form of questions.filter((q) => family.has(q.sessionID))) {
        await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal: callSignal(CALL_TIMEOUT_MS) });
        req.onEvent?.("question-rejected", "rejected");
      }
    } catch (error) {
      req.onEvent?.("poll-error", describeError(error));
    }
  }
  let inflight = false;
  const ticker = setInterval(() => {
    if (inflight) return;
    inflight = true;
    void Promise.all([rejectPermissions(), rejectQuestions()]).finally(() => {
      inflight = false;
    });
  }, pollMs);

  /** Returns once the session and its subagents are idle, or once the run is stopped. */
  async function settle(): Promise<void> {
    await client.experimental.session.wait({ sessionID: id }, { signal: controller.signal });
    while (!timedOut && !aborted) {
      const family = await sessionFamily();
      if (!(await anyBusy(family, callSignal(CALL_TIMEOUT_MS)))) return;
      await sleep(pollMs);
    }
  }

  /** Final assistant text and the run's outcome, read after the session has settled. */
  async function readOutcome(): Promise<Extracted> {
    const [last] = (await client.message.list({ sessionID: id, type: "assistant", order: "desc", limit: 1 }, { signal: callSignal(CALL_TIMEOUT_MS) })).data;
    const [idle] = (await client.message.list({ sessionID: id, type: "idle", order: "desc", limit: 1 }, { signal: callSignal(CALL_TIMEOUT_MS) })).data;
    const extracted = last ? extractMessage(last) : { output: "", error: null };
    if (extracted.error !== null) return extracted;
    // A failed run often has no assistant error (e.g. no model available): the idle message carries the cause.
    if (idle?.type === "idle" && idle.outcome !== "succeeded") {
      return { ...extracted, error: idle.error ? describeFailure(idle.error) : `run ${idle.outcome}` };
    }
    return last ? extracted : { output: "", error: "no assistant message" };
  }

  let extracted: Extracted = { output: "", error: null };
  let responded = false;
  try {
    await client.session.command({ sessionID: id, name: req.command, text: req.message }, { signal: callSignal(CALL_TIMEOUT_MS) });
    await settle();
    extracted = await readOutcome();
    responded = true;
  } catch (error) {
    if (!timedOut && !aborted) extracted = { output: "", error: `run failed: ${describeError(error)}` };
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
