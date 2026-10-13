import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerError, SENTINEL_PREFIX, createDocker } from "../poller/docker.ts";
import type { Exec, ExecResult } from "../poller/exec.ts";

const result = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over });

function fake(...results: ExecResult[]) {
  const calls: { command: string[]; timeoutMs?: number }[] = [];
  const run: Exec = async (command, options) => {
    calls.push({ command, timeoutMs: options?.timeoutMs });
    return results.shift() ?? result();
  };
  return { docker: createDocker(run, run), calls };
}

describe("composeProjects", () => {
  test("asks docker ps for the compose labels and parses the output", async () => {
    const { docker, calls } = fake(result({ stdout: "picshow-dey-7\t/r/.slim/worktrees/dey-7\n" }));
    expect(await docker.composeProjects()).toEqual([{ project: "picshow-dey-7", workingDir: "/r/.slim/worktrees/dey-7" }]);
    expect(calls[0].command.slice(0, 4)).toEqual(["docker", "ps", "-a", "--format"]);
    expect(calls[0].command[4]).toContain("com.docker.compose.project");
    expect(calls[0].command[4]).toContain("com.docker.compose.project.working_dir");
  });
  test("a docker failure names the subcommand and the last stderr line", async () => {
    const { docker } = fake(result({ code: 1, stderr: "x\nCannot connect to the Docker daemon" }));
    await expect(docker.composeProjects()).rejects.toThrow("docker ps failed (exit 1): Cannot connect to the Docker daemon");
  });
});

describe("composeDown", () => {
  test("runs compose down with volumes and orphans for exactly that project, as an argument array", async () => {
    const { docker, calls } = fake();
    await docker.composeDown("picshow-dey-7");
    expect(calls[0].command).toEqual(["docker", "compose", "-p", "picshow-dey-7", "down", "-v", "--remove-orphans"]);
    expect(calls[0].timeoutMs).toBeGreaterThan(60_000);
  });
  test.each(["", "Bad", "a b", "a;rm -rf /", "-p", "../x", "a$(x)"])("refuses the project name %j", async (name) => {
    const { docker, calls } = fake();
    await expect(docker.composeDown(name)).rejects.toBeInstanceOf(DockerError);
    expect(calls).toEqual([]);
  });
  test("a timeout is an error", async () => {
    const { docker } = fake(result({ code: null, timedOut: true }));
    await expect(docker.composeDown("p")).rejects.toThrow("docker compose timed out");
  });
});

describe("lane directory actions with a sentinel", () => {
  const withLanes = async (body: (lanes: string) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), "kanban-docker-"));
    try {
      await body(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  /** Fake exec that records the call, and what the sentinel looked like while it ran. */
  function sentinelFake(lanes: string, answer: ExecResult = result()) {
    const calls: string[][] = [];
    const seen: { files: string[] }[] = [];
    const run: Exec = async (command) => {
      calls.push(command);
      seen.push({ files: (await readdir(lanes)).filter((f) => f.startsWith(SENTINEL_PREFIX)) });
      return answer;
    };
    return { docker: createDocker(run, run, () => "abc123"), calls, seen };
  }

  test("removeLaneDir writes a sentinel, the container deletes only if it sees it, and the sentinel is removed after", async () => {
    await withLanes(async (lanes) => {
      const { docker, calls, seen } = sentinelFake(lanes);
      await docker.removeLaneDir(lanes, "dey-7");
      expect(calls[0]).toEqual([
        "docker", "run", "--rm", "--network", "none", "-v", `${lanes}:/lanes`, "alpine:3", "sh", "-c",
        "test -f /lanes/.kanban-sentinel-abc123 || exit 42; rm -rf -- /lanes/dey-7",
      ]);
      expect(seen[0].files).toEqual([".kanban-sentinel-abc123"]);
      expect(await readdir(lanes)).toEqual([]);
    });
  });

  test("a sentinel the container cannot see means the bind path is not shared: error, nothing deleted", async () => {
    await withLanes(async (lanes) => {
      const { docker } = sentinelFake(lanes, result({ code: 42 }));
      await expect(docker.removeLaneDir(lanes, "dey-7")).rejects.toThrow("bind path not shared with docker host");
      expect(await readdir(lanes)).toEqual([]);
    });
  });

  test("the sentinel is removed when the container fails or times out", async () => {
    await withLanes(async (lanes) => {
      await expect(sentinelFake(lanes, result({ code: 1, stderr: "rm: boom" })).docker.removeLaneDir(lanes, "dey-7")).rejects.toThrow(
        "docker run failed (exit 1): rm: boom",
      );
      await expect(sentinelFake(lanes, result({ code: null, timedOut: true })).docker.removeLaneDir(lanes, "dey-7")).rejects.toThrow(
        "docker run timed out",
      );
      expect(await readdir(lanes)).toEqual([]);
    });
  });

  test("chownLaneDir hands the lane to the given uid and gid, with the same sentinel guard", async () => {
    await withLanes(async (lanes) => {
      const { docker, calls } = sentinelFake(lanes);
      await docker.chownLaneDir(lanes, "dey-7", 1000, 1001);
      expect(calls[0].at(-1)).toBe("test -f /lanes/.kanban-sentinel-abc123 || exit 42; chown -R -h 1000:1001 -- /lanes/dey-7");
      await expect(sentinelFake(lanes, result({ code: 42 })).docker.chownLaneDir(lanes, "dey-7", 1, 1)).rejects.toThrow("not shared");
    });
  });

  test.each([[-1, 0], [0, -1], [1.5, 0], [Number.NaN, 0]])("chownLaneDir refuses uid %p gid %p", async (uid, gid) => {
    await withLanes(async (lanes) => {
      const { docker, calls } = sentinelFake(lanes);
      await expect(docker.chownLaneDir(lanes, "dey-7", uid, gid)).rejects.toBeInstanceOf(DockerError);
      expect(calls).toEqual([]);
    });
  });

  test.each(["..", "a/b", "", "-rf", ".tickets", "A", "a;rm -rf /", "a$(x)"])("refuses the lane name %j and writes no sentinel", async (slug) => {
    await withLanes(async (lanes) => {
      const { docker, calls } = sentinelFake(lanes);
      await expect(docker.removeLaneDir(lanes, slug)).rejects.toBeInstanceOf(DockerError);
      await expect(docker.chownLaneDir(lanes, slug, 1, 1)).rejects.toBeInstanceOf(DockerError);
      expect(calls).toEqual([]);
      expect(await readdir(lanes)).toEqual([]);
    });
  });

  test.each(["relative", "/a:/etc", "/a,b", "/a\nb"])("refuses the unsafe directory %j", async (dir) => {
    const { docker, calls } = fake();
    await expect(docker.removeLaneDir(dir, "dey-7")).rejects.toBeInstanceOf(DockerError);
    expect(calls).toEqual([]);
  });

  test("sentinel names are random per call", async () => {
    await withLanes(async (lanes) => {
      const names: string[] = [];
      const run: Exec = async (command) => {
        names.push(command.at(-1) as string);
        return result();
      };
      const docker = createDocker(run, run);
      await docker.removeLaneDir(lanes, "dey-7");
      await docker.removeLaneDir(lanes, "dey-7");
      expect(names[0]).not.toBe(names[1]);
      expect(names[0]).toMatch(/\.kanban-sentinel-[0-9a-f]{24}/);
    });
  });
});
