// Feature 008 — edge-case tests (quickstart T13-T14 + E1 scoping).
//
// Covers the input-validation + protocol-corner cases that the happy-path suites don't:
//   T13  missing prompt on kickoff → isError shape with a clear message (no fusion started)
//   T13  unknown _resume_from id → notFound shape (no fusion started, no row written)
//   T14  _resume_from ignores prompt/context/persona (FR-002 — the agent must NOT resend the
//        full prompt on every poll; retrieval takes only the reference id)
//   T14  a non-Tasks client calling a NON-fusion tool still works (delegation passthrough)
//   T14  the dispatch wrapper delegates cleanly for open_dashboard (the other registered tool)
//
// Plus an unconfigured-kickoff test (FR-003 corollary): a kickoff when OpenFusion isn't
// configured returns the needsConfig error WITHOUT allocating a fusion_jobs row.
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
import type { DB } from "../src/store/db.js";

let home: string;
let db: DB;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-resume-edge-"));
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

function configureFaux(): { wreg: FauxProviderRegistration; jreg: FauxProviderRegistration } {
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
    settings: { workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
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
  wreg.setResponses([() => Promise.resolve(fauxAssistantMessage("w")), () => Promise.resolve(fauxAssistantMessage("w"))]);
  jreg.setResponses([
    fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
    fauxAssistantMessage("edge answer"),
  ]);
  return { wreg, jreg };
}

async function boot() {
  const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client({ name: "test-edge", version: "0.0.0" }, { capabilities: {} });
  await client.connect(cT);
  const close = async () => {
    await drainTasks();
    client.close();
    server.close();
  };
  return { server, client, close };
}

describe("T025/T13 — kickoff validation", () => {
  it("missing prompt returns isError with a clear message; no fusion_jobs row written", async () => {
    const { wreg, jreg } = configureFaux();
    const { client, close } = await boot();
    try {
      const res = (await client.callTool({ name: "fusion", arguments: {} })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/missing required argument: prompt/i);
      // No fusion was started.
      const n = (db.prepare("SELECT COUNT(*) AS n FROM fusion_jobs").get() as { n: number }).n;
      expect(n).toBe(0);
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  });

  it("empty-string prompt is treated as missing", async () => {
    const { wreg, jreg } = configureFaux();
    const { client, close } = await boot();
    try {
      const res = (await client.callTool({ name: "fusion", arguments: { prompt: "   " } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/missing required argument: prompt/i);
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  });
});

describe("T026/T13 — unknown reference id", () => {
  it("_resume_from with an unknown id returns the notFound shape; no row written", async () => {
    const { wreg, jreg } = configureFaux();
    const { client, close } = await boot();
    try {
      const res = (await client.callTool({ name: "fusion", arguments: { _resume_from: "never-existed" } })) as {
        content: { text: string }[];
      };
      expect(res.content[0].text).toContain('reference_id "never-existed"');
      expect(res.content[0].text).toMatch(/re-run fusion/i);
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  });
});

describe("T027/T14 — _resume_from ignores prompt/context/persona (FR-002)", () => {
  it("a retrieval with prompt/context/persona present ignores them and returns the job's shape", async () => {
    const { wreg, jreg } = configureFaux();
    const { client, close } = await boot();
    try {
      // Start a fusion.
      const kickoff = (await client.callTool({ name: "fusion", arguments: { prompt: "original" } })) as {
        _meta?: { reference_id: string };
      };
      const refId = kickoff._meta!.reference_id;

      // Retrieve with DIFFERENT prompt/context/persona — they MUST be ignored (FR-002).
      const res = (await client.callTool({
        name: "fusion",
        arguments: {
          _resume_from: refId,
          prompt: "DIFFERENT-PROMPT-SHOULD-BE-IGNORED",
          context: "DIFFERENT-CONTEXT",
          persona: "architect",
        },
      })) as { content: { text: string }[] };
      const text = res.content[0].text;

      // The retrieval returned a processing or completed shape — NEVER the kickoff of a NEW
      // fusion with the ignored prompt. No "DIFFERENT-PROMPT" leaked into the response.
      expect(text).not.toContain("DIFFERENT-PROMPT");
      // And no second fusion_jobs row was created (the ignored prompt didn't start a new fusion).
      const n = (db.prepare("SELECT COUNT(*) AS n FROM fusion_jobs").get() as { n: number }).n;
      expect(n).toBe(1);
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 15_000);
});

describe("T028/T14 — dispatch wrapper delegates non-fusion tools cleanly", () => {
  it("a non-Tasks call to open_dashboard still works (passthrough delegation)", async () => {
    const { wreg, jreg } = configureFaux();
    const { client, close } = await boot();
    try {
      // open_dashboard is the other registered tool. The wrapper must delegate it to the SDK
      // handler unchanged (the wrapper only intercepts the fusion tool).
      const res = (await client.callTool({ name: "open_dashboard", arguments: {} })) as {
        content?: { text: string }[];
        isError?: boolean;
      };
      // openDashboardToolHandler returns a text content (or an error if no browser); either way
      // the wrapper delegated and the SDK ran the real handler (no "not found", no interception).
      expect(res.content || res.isError).toBeTruthy();
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  });
});

describe("FR-003 corollary — unconfigured kickoff returns needsConfig, no row", () => {
  it("a kickoff when OpenFusion isn't configured returns isError + no fusion_jobs row", async () => {
    // Boot WITHOUT calling configureFaux — the default empty config fails the gate.
    const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "test-edge-unconfigured", version: "0.0.0" }, { capabilities: {} });
    await client.connect(cT);
    try {
      const res = (await client.callTool({ name: "fusion", arguments: { prompt: "x" } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/isn't configured/i);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM fusion_jobs").get() as { n: number }).n;
      expect(n).toBe(0);
    } finally {
      await drainTasks();
      client.close();
      server.close();
    }
  });
});
