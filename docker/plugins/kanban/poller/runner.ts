const OUTPUT_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 10_000;

export interface RunRequest {
  opencodeBin: string;
  url: string;
  agent: string;
  command: string;
  /** Single message argument passed to the command; never starts with "-". */
  message: string;
  dir: string | null;
  timeoutMs: number;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Last 64 KB of stdout. Only for marker checks; never log it. */
  outputTail: string;
  durationMs: number;
}

let current: { proc: ReturnType<typeof Bun.spawn>; abort: () => void } | null = null;

/** Kills the running child, if any. Used on SIGTERM/SIGINT. */
export function abortCurrentRun(): void {
  current?.abort();
}

export function describeRun(result: RunResult): string {
  if (result.aborted) return "poller stopped";
  if (result.timedOut) return `timeout after ${Math.round(result.durationMs / 60_000)} min`;
  return `exit code ${result.exitCode}`;
}

export function buildArgs(req: RunRequest): string[] {
  const args = ["run", "--attach", req.url, "--agent", req.agent, "--command", req.command];
  if (req.dir) args.push("--dir", req.dir);
  args.push(req.message);
  return args;
}

export async function runAgent(req: RunRequest): Promise<RunResult> {
  const started = Date.now();
  const proc = Bun.spawn([req.opencodeBin, ...buildArgs(req)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  let timedOut = false;
  let aborted = false;
  const kill = () => {
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS).unref();
  };
  current = {
    proc,
    abort: () => {
      aborted = true;
      kill();
    },
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, req.timeoutMs);

  let tail = Buffer.alloc(0);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail = Buffer.concat([tail, value]);
    if (tail.length > OUTPUT_TAIL_BYTES) tail = tail.subarray(tail.length - OUTPUT_TAIL_BYTES);
  }
  const exitCode = await proc.exited;
  clearTimeout(timer);
  current = null;
  return {
    exitCode,
    timedOut,
    aborted,
    outputTail: tail.toString("utf8"),
    durationMs: Date.now() - started,
  };
}
