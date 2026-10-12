// Runs a child process without a shell: argument arrays only, with a timeout.
const KILL_GRACE_MS = 5_000;

export interface ExecOptions {
  cwd?: string;
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
    env: process.env,
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
