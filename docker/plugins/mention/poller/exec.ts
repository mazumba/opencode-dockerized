// Trimmed from kanban: argument arrays only, never a shell.
export interface ExecOptions {
  cwd?: string;
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
export const exec: Exec = async (command, options = {}) => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd, env: options.env ?? process.env,
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  }, options.timeoutMs ?? 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
};
