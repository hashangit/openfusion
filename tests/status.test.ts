// /api/status + version helper tests.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { statusRouter } from "../src/server/api/status.js";
import { VERSION } from "../src/util/version.js";
import { saveConfig } from "../src/config/store.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";

// supertest isn't installed; fall back to a tiny in-process fetch via the app listener.
// (We avoid adding a dep — exercise the router by invoking it directly through a real server.)

let home: string;
let restoreHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-status-"));
  restoreHome = process.env.OPENFUSION_HOME;
  process.env.OPENFUSION_HOME = home;
});
afterEach(() => {
  if (restoreHome === undefined) delete process.env.OPENFUSION_HOME;
  else process.env.OPENFUSION_HOME = restoreHome;
  rmSync(home, { recursive: true, force: true });
});

/** Boot the status router on a real port and GET it via fetch. */
async function getStatus(): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use("/api/status", statusRouter());
  const server = app.listen(0, "127.0.0.1");
  // Wait until the server is actually listening before reading the assigned port.
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fetch(`http://127.0.0.1:${port}/api/status`);
  } finally {
    server.close();
  }
}

describe("version helper", () => {
  it("reads a semver string from package.json", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("/api/status", () => {
  it("reports version, home, firstRun=true, configured=false on a fresh install", async () => {
    const res = await getStatus();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(VERSION);
    expect(body.home).toBe(home);
    expect(body.firstRun).toBe(true);
    expect(body.configured).toBe(false);
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("reports configured=true + no reasons when fully set up", async () => {
    const keyPath = join(home, "master.key");
    writeFileSync(keyPath, generateMasterKey(), { mode: 0o600 });
    saveSecrets(
      { providers: { openai: { apiKey: "sk-test1234567890" } } },
      join(home, "secrets.enc"),
      keyPath,
    );
    saveConfig({
      version: 2,
      candidates: [
        { id: "c1", provider: "openai", model: "gpt-4o-mini", enabled: true },
        { id: "c2", provider: "openai", model: "gpt-4o", enabled: true },
      ],
      judges: [{ provider: "openai", model: "gpt-4o", enabled: true }],
      settings: { workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
    });
    const res = await getStatus();
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.firstRun).toBe(false); // config file now exists
    expect(body.reasons).toBeUndefined();
  });
});
