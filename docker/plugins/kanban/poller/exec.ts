// Runs a child process without a shell: argument arrays only, with a timeout.
const KILL_GRACE_MS = 5_000;

export interface ExecOptions {
  cwd?: string;
  /** Replaces the whole environment; the poller's own is used when omitted. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (command: string[], options?: ExecOptions) => Promise<ExecResult>;

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

export const exec: Exec = async (command, options = {}) => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ?? process.env,
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  }, options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
};

const STDERR_KEEP_BYTES = 4 * 1024;
const STDERR_DRAIN_GRACE_MS = 1_000;

/**
 * For scripts that may start background children: its own process group, stdout discarded, stderr read
 * incrementally (only the last 4 KB kept). On timeout the whole group is killed, so a grandchild holding a pipe
 * cannot keep the call from returning. Children left behind after a normal exit do not delay the result either.
 */
export const execGroup: Exec = async (command, options = {}) => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: options.env ?? process.env,
    detached: true,
  });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      proc.kill(signal);
    }
  };
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
  }, options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);

  let kept = Buffer.alloc(0);
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const draining = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      kept = Buffer.concat([kept, value]);
      if (kept.length > STDERR_KEEP_BYTES) kept = kept.subarray(kept.length - STDERR_KEEP_BYTES);
    }
  })().catch(() => undefined);
  try {
    const code = await proc.exited;
    await Promise.race([draining, new Promise((resolve) => setTimeout(resolve, STDERR_DRAIN_GRACE_MS))]);
    return { code, stdout: "", stderr: kept.toString("utf8"), timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    // After a timeout nothing in the group may outlive the call, even if the leader already exited on SIGTERM.
    if (timedOut) killGroup("SIGKILL");
    await reader.cancel().catch(() => undefined);
  }
};
