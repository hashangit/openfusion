// Feature 005 — MCP Tasks (SEP-1686) async non-blocking fusion.
// Tests map 1:1 to quickstart.md T1–T7. Drives the real `createMcpServer` over
// InMemoryTransport (task creation + tasks/result are protocol-level, so unlike
// mcp-server.test.ts we need the full round-trip, not a mocked `extra`).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createMcpServer } from "../src/server/mcp-server.js";
import { openDatabase } from "../src/store/db.js";
import { saveConfig } from "../src/config/store.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { DB } from "../src/store/db.js";

// Per research.md R-010 / T002 probe: the client MUST advertise this capability or the
// server rejects task-augmented calls with "Client does not support task creation".
const TASKS_CLIENT_CAP = { tasks: { requests: { tools: { call: {} } } } } as const;

let home: string;
let db: DB;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-tasks-"));
  process.env.OPENFUSION_HOME = home;
  db = openDatabase(join(home, "test.db"));
  writeFileSync(join(home, "master.key"), generateMasterKey(), { mode: 0o600 });
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
  clearModelDescriptors();
});

/** Configure OpenFusion with two faux candidates + one faux judge, returning the registrations. */
function configureFaux(opts?: { workerResponses?: string[]; judgeFinal?: string }) {
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
  const w = opts?.workerResponses ?? ["answer A", "answer B"];
  const wreg = registerFauxProvider({ provider: "faux-fusion", api: "faux-w", models: [{ id: "w1" }] });
  const jreg = registerFauxProvider({ provider: "faux-judge", api: "faux-j", models: [{ id: "j1" }] });
  wreg.setResponses([fauxAssistantMessage(w[0]), fauxAssistantMessage(w[1] ?? "answer B")]);
  jreg.setResponses([
    fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
    fauxAssistantMessage(opts?.judgeFinal ?? "final consolidated answer"),
  ]);
  return { wreg, jreg };
}

/** Boot the real MCP server + a tasks-capable client over linked in-memory transports. */
async function boot() {
  const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: TASKS_CLIENT_CAP },
  );
  await client.connect(cT);
  return { server, client, close: () => { client.close(); server.close(); } };
}

describe("US1 — task path: CreateTaskResult + tasks/result (quickstart T1)", () => {
  it("returns a CreateTaskResult synchronously (< 50ms) for a task-augmented call", async () => {
    const { wreg, jreg } = configureFaux();
    const { client, close } = await boot();
    try {
      const t0 = Date.now();
      // Task-augmented tools/call — must return CreateTaskResult, NOT block on fusion.
      const res: any = await client.request(
        { method: "tools/call", params: { name: "fusion", arguments: { prompt: "compare X vs Y" }, task: { ttl: 60000 } } },
        z.any(),
      );
      const elapsed = Date.now() - t0;
      expect(res.task).toBeDefined();
      expect(typeof res.task.taskId).toBe("string");
      expect(res.task.status).toBe("working");
      // Synchronous return: fusion takes >50ms even with faux providers (fan-out + 2 judge calls).
      expect(elapsed).toBeLessThan(50);
    } finally {
      close();
      wreg.unregister();
      jreg.unregister();
    }
  });

  it("tasks/result fetches the synthesized CallToolResult; one activity row + N+2 sub_calls", async () => {
    const { wreg, jreg } = configureFaux({ judgeFinal: "the synthesized answer" });
    const { client, close } = await boot();
    try {
      const created: any = await client.request(
        { method: "tools/call", params: { name: "fusion", arguments: { prompt: "compare X vs Y" }, task: { ttl: 60000 } } },
        z.any(),
      );
      const taskId = created.task.taskId;

      // Poll tasks/result until terminal (the handler blocks server-side, but the faux
      // fusion is fast; allow a short wait loop for determinism).
      let result: any;
      for (let i = 0; i < 50; i++) {
        try {
          result = await client.request(
            { method: "tasks/result", params: { taskId } },
            z.any(),
          );
          if (result?.content) break;
        } catch {
          // not ready yet
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(result).toBeDefined();
      expect(result.content[0].text).toBe("the synthesized answer");

      // FR-007 / INV-1: exactly ONE activities row, candidate_count(2)+2 = 4 sub_calls.
      const actCount = (db.prepare("SELECT COUNT(*) AS n FROM activities").get() as { n: number }).n;
      expect(actCount).toBe(1);
      const subCount = (db.prepare("SELECT COUNT(*) AS n FROM sub_calls").get() as { n: number }).n;
      expect(subCount).toBe(4); // 2 workers + judge_analysis + judge_synthesis
    } finally {
      close();
      wreg.unregister();
      jreg.unregister();
    }
  });
});
