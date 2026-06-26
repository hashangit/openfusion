// /api/providers route tests — model discovery error shapes (PR #6 review).
//
// Covers the two server error paths the owner flagged:
//   - GET /api/providers/:provider/models  -> { models: [], error } on discovery failure
//   - GET /api/providers/:provider/discover -> 502 { error } on discovery failure
// plus the happy + defensive-parse paths through the route.
//
// globalThis.fetch is spied with URL-based dispatch: calls to the in-process
// Express test server (127.0.0.1) go to the real fetch; calls to a provider's
// /v1/models endpoint return the per-test mock. The suite never makes a real
// network call (CONTRIBUTING: no real API calls).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { providersRouter } from "../src/server/api/providers.js";
import { clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";

let home: string;
let restoreHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-providers-"));
  restoreHome = process.env.OPENFUSION_HOME;
  process.env.OPENFUSION_HOME = home;
  clearModelDescriptors();
});
afterEach(() => {
  if (restoreHome === undefined) delete process.env.OPENFUSION_HOME;
  else process.env.OPENFUSION_HOME = restoreHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Boot the providers router on a real port and GET the given sub-path.
 * `providerFetch` is called for any fetch to a provider's /v1/models URL
 * (it may return a Response or throw to simulate a failure); the test's own
 * call to the Express server is routed to the real fetch.
 */
async function getProvidersRoute(
  subPath: string,
  providerFetch: (url: string) => Response | Promise<Response>,
): Promise<Response> {
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input as URL | string) as Promise<Response>;
    return Promise.resolve(providerFetch(url));
  });
  const app = express();
  app.use(express.json());
  app.use("/api/providers", providersRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fetch(`http://127.0.0.1:${port}/api/providers${subPath}`);
  } finally {
    server.close();
  }
}

describe("/api/providers/:provider/models (discovery)", () => {
  it("returns the discovered models on a happy 200 response", async () => {
    const res = await getProvidersRoute("/ollama-cloud/models", () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-oss:120b" }, { id: "gpt-oss:20b" }] }), { status: 200 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([{ id: "gpt-oss:120b" }, { id: "gpt-oss:20b" }]);
    expect(body.error).toBeUndefined();
  });

  it("returns { models: [], error } when discovery fails (e.g. 401 auth rejected)", async () => {
    const res = await getProvidersRoute("/ollama-cloud/models", () =>
      new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    // The /models route surfaces the error with a 200 + an `error` field (not a
    // 5xx) so the UI can show "couldn't reach the provider" vs "no models".
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.error).toMatch(/ollama-cloud/);
    expect(body.error).toMatch(/401/);
  });

  it("returns { models: [] } (no error) when the provider responds 200 with non-array data", async () => {
    const res = await getProvidersRoute("/ollama-cloud/models", () =>
      new Response(JSON.stringify({ data: null }), { status: 200 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.error).toBeUndefined();
  });
});

describe("/api/providers/:provider/discover (local manual retry)", () => {
  it("returns 502 { error } when discovery fails (e.g. local server down)", async () => {
    const res = await getProvidersRoute("/rapid-mlx/discover", () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/rapid-mlx/);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  it("returns 404 for a provider that does not support discovery (non-local)", async () => {
    // ollama-cloud is discoverable but NOT local, so /discover is 404 (its
    // /models route already does discovery).
    const res = await getProvidersRoute("/ollama-cloud/discover", () =>
      new Response("{}", { status: 200 }),
    );
    expect(res.status).toBe(404);
  });
});