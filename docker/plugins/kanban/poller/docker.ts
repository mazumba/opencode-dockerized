// Docker calls the poller needs for worktree teardown: list compose stacks, take one down, and act on a lane
// directory that contains root-owned files (delete it, or hand it to the poller's user) from a throwaway
// container. Argument arrays only, with timeouts; execGroup kills the whole process group when a call hangs.
//
// Bind paths are resolved by the Docker daemon on the host. Before any destructive action in a bind mount the
// poller writes a random sentinel file into the mounted directory and the container only acts if it sees that
// file: if the daemon's host does not share the path, nothing is touched.
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { exec, execGroup, type Exec } from "./exec.ts";
import { COMPOSE_PROJECT_PATTERN, LANE_SLUG_PATTERN, isBindSafe, parseComposeProjects, type ComposeProject } from "./select.ts";

export class DockerError extends Error {}

const PS_TIMEOUT_MS = 30_000;
const DOWN_TIMEOUT_MS = 300_000;
const LANE_ACTION_TIMEOUT_MS = 300_000;
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_WORKDIR_LABEL = "com.docker.compose.project.working_dir";
/** Exit code of the container script when the sentinel is not visible. */
const SENTINEL_MISSING_EXIT = 42;
export const SENTINEL_PREFIX = ".kanban-sentinel-";

export interface Docker {
  /** Compose projects that have containers (running or not), one entry per working directory. */
  composeProjects(): Promise<ComposeProject[]>;
  /** `docker compose -p <project> down -v --remove-orphans`: containers, networks, and volumes of the project. */
  composeDown(project: string): Promise<void>;
  /** Deletes `<lanesDir>/<slug>` as root inside an alpine container (the lane may hold root-owned files). */
  removeLaneDir(lanesDir: string, slug: string): Promise<void>;
  /** Gives `<lanesDir>/<slug>` and everything in it to `uid:gid`, so a plain `git worktree remove` can delete it. */
  chownLaneDir(lanesDir: string, slug: string, uid: number, gid: number): Promise<void>;
}

// Listing needs stdout; `execGroup` discards it, so it is only used for the calls that can hang or leave children.
export function createDocker(
  runGrouped: Exec = execGroup,
  runPlain: Exec = exec,
  randomHex: () => string = () => randomBytes(12).toString("hex"),
): Docker {
  async function docker(args: string[], timeoutMs: number, run: Exec = runGrouped) {
    const result = await run(["docker", ...args], { timeoutMs });
    if (result.timedOut) throw new DockerError(`docker ${args[0]} timed out`);
    if (result.code !== 0) {
      const line = result.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
      throw new DockerError(`docker ${args[0]} failed (exit ${result.code}): ${line}`);
    }
    return result.stdout;
  }

  /** Runs `action` (a fixed sh command line) on /lanes in alpine, but only if the sentinel is visible there. */
  async function inLanes(lanesDir: string, slug: string, action: (path: string) => string): Promise<void> {
    if (!isBindSafe(lanesDir)) throw new DockerError("docker run refused: unsafe lanes directory path");
    if (!LANE_SLUG_PATTERN.test(slug)) throw new DockerError("docker run refused: invalid lane name");
    const sentinel = `${SENTINEL_PREFIX}${randomHex()}`;
    if (!/^[A-Za-z0-9.-]+$/.test(sentinel)) throw new DockerError("docker run refused: invalid sentinel name");
    const file = `${lanesDir}/${sentinel}`;
    await writeFile(file, "");
    try {
      const script = `test -f /lanes/${sentinel} || exit ${SENTINEL_MISSING_EXIT}; ${action(`/lanes/${slug}`)}`;
      const result = await runGrouped(
        ["docker", "run", "--rm", "--network", "none", "-v", `${lanesDir}:/lanes`, "alpine:3", "sh", "-c", script],
        { timeoutMs: LANE_ACTION_TIMEOUT_MS },
      );
      if (result.timedOut) throw new DockerError("docker run timed out");
      if (result.code === SENTINEL_MISSING_EXIT) throw new DockerError("bind path not shared with docker host");
      if (result.code !== 0) {
        const line = result.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
        throw new DockerError(`docker run failed (exit ${result.code}): ${line}`);
      }
    } finally {
      await rm(file, { force: true });
    }
  }

  return {
    async composeProjects() {
      const format = `{{.Label "${COMPOSE_PROJECT_LABEL}"}}\t{{.Label "${COMPOSE_WORKDIR_LABEL}"}}`;
      return parseComposeProjects(await docker(["ps", "-a", "--format", format], PS_TIMEOUT_MS, runPlain));
    },
    async composeDown(project) {
      if (!COMPOSE_PROJECT_PATTERN.test(project)) throw new DockerError("docker compose refused: invalid project name");
      await docker(["compose", "-p", project, "down", "-v", "--remove-orphans"], DOWN_TIMEOUT_MS);
    },
    async removeLaneDir(lanesDir, slug) {
      await inLanes(lanesDir, slug, (path) => `rm -rf -- ${path}`);
    },
    async chownLaneDir(lanesDir, slug, uid, gid) {
      if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) {
        throw new DockerError("docker run refused: invalid uid or gid");
      }
      await inLanes(lanesDir, slug, (path) => `chown -R -h ${uid}:${gid} -- ${path}`);
    },
  };
}
