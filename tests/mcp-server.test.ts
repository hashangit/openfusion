// T027 — MCP server tests. Handler behavior, progress, config gate.
// Calls the exported handlers directly with a mocked `extra` (no private-field poking).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fusionToolHandler,
  openDashboardToolHandler,
  UI_URL,
  type ToolExtra,
} from "../src/server/mcp-server.js";
import { createMcpServer } from "../src/server/mcp-server.js";
import { openDatabase } from "../src/store/db.js";
import { saveConfig } from "../src/config/store.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { DB } from "../src/store/db.js";

let home: string;
let db: DB;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-mcp-"));
  process.env.OPENFUSION_HOME = home;
  db = openDatabase(join(home, "test.db"));
  writeFileSync(join(home, "master.key"), generateMasterKey(), { mode: 0o600 });
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
  clearModelDescriptors();
});

/** Build a minimal MCP `extra` with an optional notification sink. */
function mkExtra(sink: string[] = []): ToolExtra {
  return {
    _meta: { progressToken: "test-token" },
    sendNotification: async (n: unknown) => {
      const params = (n as { params?: { message?: string } }).params;
      sink.push(params?.message ?? "");
    },
  };
}

describe("mcp-server: fusion tool handler", () => {
  it("returns isError with the dashboard URL when unconfigured (no browser, F4)", async () => {
    const sink: string[] = [];
    const res = await fusionToolHandler({ prompt: "hi" }, mkExtra(sink), {
      db,
      openBrowserOnNeedsConfig: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(UI_URL);
    expect(res.content[0].text).toMatch(/configured/i);
    // F4: no activity logged on a needsConfig refusal.
    expect(db.prepare("SELECT COUNT(*) AS n FROM activities").get()).toEqual({ n: 0 });
  });

  it("returns a consolidated answer when configured + emits progress", async () => {
    saveSecrets(
      { providers: { "faux-fusion": { apiKey: "k" }, "faux-judge": { apiKey: "k" } } },
      join(home, "secrets.enc"),
      join(home, "master.key"),
    );
    saveConfig({
      version: 2,
      candidates: [
        { id: "c1", provider: "faux-fusion", model: "w1", enabled: true },
        { id: "c2", provider: "faux-fusion", model: "w1", enabled: true },
      ],
      judges: [{ provider: "faux-judge", model: "j1", enabled: true }],
      settings: { workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
    });
    registerModelDescriptor("faux-fusion", "w1", {
      id: "w1", name: "w1", api: "faux-w", provider: "faux-fusion", baseUrl: "http://localhost:0",
      reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
    });
    registerModelDescriptor("faux-judge", "j1", {
      id: "j1", name: "j1", api: "faux-j", provider: "faux-judge", baseUrl: "http://localhost:0",
      reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
    });
    const wreg = registerFauxProvider({ provider: "faux-fusion", api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: "faux-judge", api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("answer A"), fauxAssistantMessage("answer B")]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
      fauxAssistantMessage("final consolidated answer"),
    ]);

    const sink: string[] = [];
    const res = await fusionToolHandler({ prompt: "compare X vs Y" }, mkExtra(sink), {
      db,
      openBrowserOnNeedsConfig: false,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("final consolidated answer");
    expect(sink.length).toBeGreaterThan(0); // progress forwarded
    wreg.unregister();
    jreg.unregister();
  });

  it("emits NO progress when the client did not send a progressToken", async () => {
    saveSecrets(
      { providers: { "faux-fusion": { apiKey: "k" }, "faux-judge": { apiKey: "k" } } },
      join(home, "secrets.enc"),
      join(home, "master.key"),
    );
    saveConfig({
      version: 2,
      candidates: [
        { id: "c1", provider: "faux-fusion", model: "w1", enabled: true },
        { id: "c2", provider: "faux-fusion", model: "w1", enabled: true },
      ],
      judges: [{ provider: "faux-judge", model: "j1", enabled: true }],
      settings: { workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
    });
    registerModelDescriptor("faux-fusion", "w1", {
      id: "w1", name: "w1", api: "faux-w", provider: "faux-fusion", baseUrl: "http://localhost:0",
      reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
    });
    registerModelDescriptor("faux-judge", "j1", {
      id: "j1", name: "j1", api: "faux-j", provider: "faux-judge", baseUrl: "http://localhost:0",
      reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
    });
    const wreg = registerFauxProvider({ provider: "faux-fusion", api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: "faux-judge", api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: [], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
      fauxAssistantMessage("final"),
    ]);

    let sent = 0;
    const extraNoToken: ToolExtra = {
      sendNotification: async (_n: unknown) => {
        sent++;
      },
      // no _meta.progressToken
    };
    const res = await fusionToolHandler({ prompt: "x" }, extraNoToken, { db, openBrowserOnNeedsConfig: false });
    expect(res.isError).toBeUndefined();
    expect(sent).toBe(0); // no progress emitted without a token
    wreg.unregister();
    jreg.unregister();
  });
});

describe("mcp-server: open_dashboard + server wiring", () => {
  it("open_dashboard handler returns a message referencing the URL", async () => {
    const res = await openDashboardToolHandler();
    expect(res.content[0].text).toContain(UI_URL);
  });

  it("createMcpServer registers both tools without throwing", async () => {
    const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
    expect(server).toBeDefined();
  });
});
