// Feature 008 — US2 sequential-mode tests (quickstart T8-T9).
//
// Sequential mode (feature 007) is ETA-guided, not long-poll: the kickoff carries an honest
// ETA + dashboard link, and each retrieval returns IMMEDIATELY with a refined remaining ETA
// (no bounded-long-poll — FR-005). This keeps a sequential retrieval from holding a codex
// call open for 12-21 minutes.
//
// We drive the real createMcpServer with executionMode:"sequential" in the config and assert:
//   T8/T21  the kickoff shape is sequentialKickoff (ETA + dashboard URL + user-facing wording)
//   T9/T22  a retrieval returns immediately (no long-poll) with the sequential processing shape
//           (remaining ETA), and a later retrieval returns completed when the fusion lands.
//
// These tests use a SHORT worker delay (the sequential budget formula is unit-tested in 007;
// here we only verify the DISPATCH picks the sequential shape, not the budget math itself).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server/mcp-server.js";
import { openDatabase } from "../src/store/db.js";
import { saveConfig } from "../src/config/store.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import { drainTasks } from "../src/fusion/task-runner.js";
import { DASHBOARD_BASE } from "../src/fusion/resume-shapes.js";
import type { DB } from "../src/store/db.js";

let home: string;
let db: DB;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-resume-seq-"));
  process.env.OPENFUSION_HOME = home;
  db = openDatabase(join(home, "test.db"));
  writeFileSync(join(home, "master.key"), generateMasterKey(), { mode: 0o600 });
});
afterEach(async () => {
  await drainTasks();
  db.close();
  rmSync(home, { recursive: true, force: true });
  clearModelDescriptors();
});

function configureFauxSequential(opts: { workerDelayMs?: number; judgeFinal?: string } = {}): {
  wreg: FauxProviderRegistration;
  jreg: FauxProviderRegistration;
} {
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
    // executionMode:"sequential" drives the dispatch to use sequentialKickoff/sequentialProcessing.
    settings: { workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false, executionMode: "sequential" },
  });
  registerModelDescriptor("faux-fusion", "w1", {
    id: "w1", name: "w1", api: "faux-w", provider: "faux-fusion", baseUrl: "http://localhost:0",
    reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
  });
  registerModelDescriptor("faux-judge", "j1", {
    id: "j1", name: "j1", api: "faux-j", provider: "faux-judge", baseUrl: "http://localhost:0",
    reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
  });
  const delay = opts.workerDelayMs ?? 0;
  const slowWorker = () =>
    new Promise((resolve) => setTimeout(resolve, delay)).then(() => fauxAssistantMessage("worker answer"));
  const wreg = registerFauxProvider({ provider: "faux-fusion", api: "faux-w", models: [{ id: "w1" }] });
  const jreg = registerFauxProvider({ provider: "faux-judge", api: "faux-j", models: [{ id: "j1" }] });
  wreg.setResponses([slowWorker, slowWorker]);
  jreg.setResponses([
    fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
    fauxAssistantMessage(opts.judgeFinal ?? "the sequential answer"),
  ]);
  return { wreg, jreg };
}

async function boot() {
  const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client({ name: "test-seq", version: "0.0.0" }, { capabilities: {} });
  await client.connect(cT);
  const close = async () => {
    await drainTasks();
    client.close();
    server.close();
  };
  return { server, client, close };
}

describe("T021/T8 — sequential kickoff shape (ETA + dashboard + user-facing wording)", () => {
  it("returns the sequentialKickoff shape with an ETA + dashboard URL, NOT the terse parallel shape", async () => {
    const { wreg, jreg } = configureFauxSequential({ workerDelayMs: 5_000 });
    const { client, close } = await boot();
    try {
      const t0 = Date.now();
      const res = (await client.callTool({ name: "fusion", arguments: { prompt: "deep research X" } })) as {
        content: { text: string }[];
        _meta?: { reference_id: string; retry_after_ms: number };
      };
      const elapsed = Date.now() - t0;
      const text = res.content[0].text;

      // Immediate kickoff (no provider work in the call path).
      expect(elapsed).toBeLessThan(1500);
      // Sequential wording: ETA + dashboard URL + user-facing "tell the user".
      expect(text).toContain("reference_id:");
      expect(text).toMatch(/approximately \d+ minutes/i);
      expect(text).toContain(DASHBOARD_BASE);
      expect(text).toMatch(/tell the user to watch the dashboard/i);
      // NOT the parallel shape: no tight-poll "call again" mandate (sequential is ETA-guided).
      expect(text).not.toMatch(/call fusion.*again/i);
      // _meta carries the reference_id + a retry_after_ms floored at 60s (eta/4).
      expect(res._meta?.reference_id).toBeDefined();
      expect(res._meta?.retry_after_ms).toBeGreaterThanOrEqual(60_000);
      // The job row is sequential.
      const refId = res._meta!.reference_id;
      const job = db.prepare("SELECT execution_mode, eta_ms FROM fusion_jobs WHERE activity_id = ?").get(refId) as
        | { execution_mode: string; eta_ms: number | null }
        | undefined;
      expect(job?.execution_mode).toBe("sequential");
      expect(job?.eta_ms).toBeGreaterThan(0);
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 15_000);
});

describe("T022/T9 — sequential retrieval is ETA-guided (immediate, no long-poll)", () => {
  it("a retrieval while in flight returns IMMEDIATELY with a remaining-ETA shape (no long-poll)", async () => {
    const { wreg, jreg } = configureFauxSequential({ workerDelayMs: 5_000 });
    const { client, close } = await boot();
    try {
      const kickoff = (await client.callTool({ name: "fusion", arguments: { prompt: "x" } })) as {
        _meta?: { reference_id: string };
      };
      const refId = kickoff._meta!.reference_id;

      const t0 = Date.now();
      const res = (await client.callTool({ name: "fusion", arguments: { _resume_from: refId } })) as {
        content: { text: string }[];
      };
      const elapsed = Date.now() - t0;
      // IMMEDIATE return — sequential retrieval does NOT bounded-long-poll (FR-005). Under
      // 500ms (vs the 45s parallel long-poll). The 5s worker is still in flight.
      expect(elapsed).toBeLessThan(500);
      // The sequential processing shape: remaining ETA + dashboard link.
      expect(res.content[0].text).toMatch(/still running/i);
      expect(res.content[0].text).toMatch(/approximately \d+ minutes remaining/i);
      expect(res.content[0].text).toContain(DASHBOARD_BASE);
      // NOT the parallel processing shape (no "call again" tight-poll mandate).
      expect(res.content[0].text).not.toMatch(/call fusion.*again/i);
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 15_000);

  it("a retrieval after the fusion completes returns the synthesized answer (SC-006 byte-identical)", async () => {
    const { wreg, jreg } = configureFauxSequential({ workerDelayMs: 0, judgeFinal: "the sequential answer" });
    const { client, close } = await boot();
    try {
      const kickoff = (await client.callTool({ name: "fusion", arguments: { prompt: "x" } })) as {
        _meta?: { reference_id: string };
      };
      const refId = kickoff._meta!.reference_id;
      // Wait for terminal.
      await new Promise((r) => setTimeout(r, 2_000));

      const res = (await client.callTool({ name: "fusion", arguments: { _resume_from: refId } })) as {
        content: { text: string }[];
      };
      expect(res.content[0].text).toBe("the sequential answer");
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 15_000);
});
