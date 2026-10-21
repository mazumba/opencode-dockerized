import { describe, expect, test } from "bun:test";
import { fetchApp, GitHubError, resolveBotIdentity } from "../poller/github.ts";
import type { Exec } from "../poller/exec.ts";

const jwtRun: Exec = async (args) => {
  expect(args).toEqual(["/usr/local/lib/opencode/github/gh-app-token", "--jwt"]);
  return { code: 0, stdout: "jwt\n", stderr: "", timedOut: false };
};

describe("App identity", () => {
  for (const overrides of [{}, { handle: "@override" }, { botLogin: "override[bot]" }]) {
    test(`derives missing fields with overrides ${JSON.stringify(overrides)}`, async () => {
      let lookups = 0;
      expect(await resolveBotIdentity(overrides, { run: jwtRun, fetchApp: async (jwt) => {
        expect(jwt).toBe("jwt"); lookups++; return { slug: "example-bot" };
      } })).toEqual({ handle: overrides.handle ?? "@example-bot", botLogin: overrides.botLogin ?? "example-bot[bot]" });
      expect(lookups).toBe(1);
    });
  }
  test("both overrides skip JWT and lookup", async () => {
    expect(await resolveBotIdentity({ handle: "@override", botLogin: "override[bot]" }, {
      run: async () => { throw new Error("unexpected exec"); },
      fetchApp: async () => { throw new Error("unexpected lookup"); },
    })).toEqual({ handle: "@override", botLogin: "override[bot]" });
  });
  for (const app of [{}, { slug: "" }, { slug: "invalid slug" }, { slug: "-bad" }, null]) {
    test(`rejects missing or invalid slug ${JSON.stringify(app)}`, async () => {
      await expect(resolveBotIdentity({}, { run: jwtRun, fetchApp: async () => app })).rejects.toThrow("GET /app failed: missing slug");
    });
  }
  test("GET /app uses JWT auth and fixed HTTP errors", async () => {
    const send = (async (url, init) => {
      expect(String(url)).toBe("https://api.github.com/app");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer jwt");
      return new Response("private response", { status: 403 });
    }) as typeof fetch;
    await expect(resolveBotIdentity({}, { run: jwtRun, fetchApp: (jwt) => fetchApp(jwt, send) }))
      .rejects.toThrow("GET /app failed: HTTP 403");
  });
  test("successful GET /app reads slug", async () => {
    const send = (async () => Response.json({ slug: "Example-Bot" })) as typeof fetch;
    expect(await resolveBotIdentity({}, { run: jwtRun, fetchApp: (jwt) => fetchApp(jwt, send) }))
      .toEqual({ handle: "@Example-Bot", botLogin: "Example-Bot[bot]" });
  });
  test("lookup failures do not expose response or exception details", async () => {
    await expect(resolveBotIdentity({}, { run: jwtRun, fetchApp: async () => { throw new Error("private data"); } }))
      .rejects.toThrow("GET /app failed: missing slug");
  });
  test("JWT failure is a GitHubError", async () => {
    await expect(resolveBotIdentity({}, {
      run: async () => ({ code: 1, stdout: "", stderr: "private data", timedOut: false }), fetchApp: async () => ({}),
    })).rejects.toBeInstanceOf(GitHubError);
  });
});
