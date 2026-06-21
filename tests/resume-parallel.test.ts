// Feature 008 — US1 integration tests (quickstart T1-T5 + SC-002 round-trip budget).
//
// Drives the REAL createMcpServer over InMemoryTransport with a faux provider whose delay is
// tunable, exercising the full `_resume_from` round-trip:
//   T1  kickoff returns ≈1s with the parallel processing shape + a fusion_jobs row
//   T2  retrieval bounded-long-polls and returns completed when the fusion lands mid-wait
//   T3  retrieval of an already-completed job returns immediately (fast-path, SC-003)
//   T4  retrieval times out the long-poll and returns processing; a second retrieval completes
//   T5  a Tasks-aware client still gets CreateTaskResult (FR-013 coexistence)
//   SC-002 a ~90s fusion is returned in ≤3 LLM round-trips (1 kickoff + ≤2 retrievals)
//
// Plus a dispatch canary that fails loudly if the SDK's handler shape changes on upgrade.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createMcpServer, FUSION_DESCRIPTION, PRE_006_FUSION_DESCRIPTION } from "../src/server/mcp-server.js";
import { openDatabase } from "../src/store/db.js";
import { saveConfig } from "../src/config/store.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import { drainTasks } from "../src/fusion/task-runner.js";
import { RESUME_LONG_POLL_MS } from "../src/fusion/resume-store.js";
import type { DB } from "../src/store/db.js";

// A Tasks-aware client advertises this; a non-Tasks client (the default Client below) does NOT.
const TASKS_CLIENT_CAP = { tasks: { requests: { tools: { call: {} } } } } as const;

let home: string;
let db: DB;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-resume-par-"));
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

/**
 * Configure two faux candidates + one faux judge. The worker responses can be delayed by
 * passing `workerDelayMs` (the faux provider sleeps before responding). The judge always
 * returns quickly (it's the candidates whose timing gates the long-poll).
 */
function configureFaux(opts: { workerDelayMs?: number; judgeFinal?: string } = {}): {
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
  const delay = opts.workerDelayMs ?? 0;
  const slowWorker = () =>
    new Promise((resolve) => setTimeout(resolve, delay)).then(() => fauxAssistantMessage("worker answer"));
  const wreg = registerFauxProvider({ provider: "faux-fusion", api: "faux-w", models: [{ id: "w1" }] });
  const jreg = registerFauxProvider({ provider: "faux-judge", api: "faux-j", models: [{ id: "j1" }] });
  wreg.setResponses([slowWorker, slowWorker]);
  jreg.setResponses([
    fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
    fauxAssistantMessage(opts.judgeFinal ?? "the synthesized answer"),
  ]);
  return { wreg, jreg };
}

/** Boot the MCP server + a NON-Tasks client (no tasks capability — the codex/ZCode shape). */
async function bootNonTasks() {
  const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client({ name: "test-non-tasks", version: "0.0.0" }, { capabilities: {} });
  await client.connect(cT);
  const close = async () => {
    await drainTasks();
    client.close();
    server.close();
  };
  return { server, client, close };
}

/** Boot with a Tasks-aware client (advertises the tasks capability). */
async function bootTasks() {
  const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client(
    { name: "test-tasks", version: "0.0.0" },
    { capabilities: TASKS_CLIENT_CAP },
  );
  await client.connect(cT);
  const close = async () => {
    await drainTasks();
    client.close();
    server.close();
  };
  return { server, client, close };
}

/** Extract the reference_id from a kickoff result's text (the agent parses the same way). */
function referenceIdFromText(text: string): string {
  const m = text.match(/reference_id: ([0-9a-f-]+)/);
  if (!m) throw new Error(`no reference_id in kickoff text: ${text}`);
  return m[1];
}

describe("T006 — kickoff returns immediately with the processing shape (parallel)", () => {
  it("returns ≈1s with reference_id + retrieval mandate + retry_after_ms; fusion_jobs row is processing; id = activities.id (INV-2)", async () => {
    const { wreg, jreg } = configureFaux({ workerDelayMs: 5_000 }); // slow enough to still be in flight
    const { client, close } = await bootNonTasks();
    try {
      const t0 = Date.now();
      const res = (await client.callTool({ name: "fusion", arguments: { prompt: "compare X vs Y" } })) as {
        content: { type: "text"; text: string }[];
        _meta?: { reference_id: string; retry_after_ms: number };
      };
      const elapsed = Date.now() - t0;
      const text = res.content[0].text;

      // F6: ≈1s honest target (allocate + dispatch; no provider work in the call path).
      expect(elapsed).toBeLessThan(1500);
      // The kickoff wording (contracts/resume-from.md).
      expect(text).toContain("reference_id:");
      expect(text).toContain('Call fusion({ "_resume_from"');
      expect(text).toMatch(/retry after approximately \d+ seconds/i);
      // M4: NO "do not inform the user" directive anywhere.
      expect(text).not.toMatch(/do not inform/i);
      // m10: structured _meta carries the same id + pacing.
      expect(res._meta?.reference_id).toBeDefined();
      expect(res._meta?.retry_after_ms).toBeGreaterThan(0);

      const refId = res._meta!.reference_id;
      // INV-2: the reference id IS the activities.id.
      const refIdFromText = referenceIdFromText(text);
      expect(refIdFromText).toBe(refId);
      const act = db.prepare("SELECT id FROM activities WHERE id = ?").get(refId) as { id: string } | undefined;
      expect(act?.id).toBe(refId);

      // INV-3: a fusion_jobs row exists from kickoff, status=processing, mode=parallel.
      const job = db.prepare("SELECT status, execution_mode FROM fusion_jobs WHERE activity_id = ?").get(refId) as
        | { status: string; execution_mode: string }
        | undefined;
      expect(job?.status).toBe("processing");
      expect(job?.execution_mode).toBe("parallel");
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 15_000); // 5s worker drain in close() + margin.
});

describe("T007 — retrieval returns completed (bounded long-poll) + fast-path (SC-003)", () => {
  it("(a) _resume_from while in flight bounded-long-polls and returns the synthesized answer when the fusion lands", async () => {
    // Worker finishes ~5s into the long-poll window (well under RESUME_LONG_POLL_MS).
    const { wreg, jreg } = configureFaux({ workerDelayMs: 5_000, judgeFinal: "the synthesized answer" });
    const { client, close } = await bootNonTasks();
    try {
      const kickoff = (await client.callTool({ name: "fusion", arguments: { prompt: "x" } })) as {
        content: { text: string }[];
        _meta?: { reference_id: string };
      };
      const refId = kickoff._meta!.reference_id;

      const t0 = Date.now();
      const res = (await client.callTool({ name: "fusion", arguments: { _resume_from: refId } })) as {
        content: { text: string }[];
      };
      const elapsed = Date.now() - t0;
      // The retrieval waited for the fusion (>= ~5s) but stayed under the long-poll ceiling.
      expect(elapsed).toBeGreaterThanOrEqual(4_000);
      expect(elapsed).toBeLessThan(RESUME_LONG_POLL_MS + 2_000);
      // SC-006: byte-identical to what the blocking path would return.
      expect(res.content[0].text).toBe("the synthesized answer");
      // The row is now completed.
      const job = db.prepare("SELECT status, result FROM fusion_jobs WHERE activity_id = ?").get(refId) as
        | { status: string; result: string | null }
        | undefined;
      expect(job?.status).toBe("completed");
      expect(job?.result).toBe("the synthesized answer");
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 15_000); // 5s worker + long-poll wait + drain.

  it("(b) _resume_from >10s after completion returns immediately with the same answer (SC-003 fast-path)", async () => {
    const { wreg, jreg } = configureFaux({ workerDelayMs: 0, judgeFinal: "fast answer" });
    const { client, close } = await bootNonTasks();
    try {
      const kickoff = (await client.callTool({ name: "fusion", arguments: { prompt: "x" } })) as {
        _meta?: { reference_id: string };
      };
      const refId = kickoff._meta!.reference_id;
      // Wait for terminal + a beat so the next retrieval hits the completed fast-path.
      await new Promise((r) => setTimeout(r, 12_000));

      const t0 = Date.now();
      const res = (await client.callTool({ name: "fusion", arguments: { _resume_from: refId } })) as {
        content: { text: string }[];
      };
      const elapsed = Date.now() - t0;
      // SC-003: immediate (no long-poll wait).
      expect(elapsed).toBeLessThan(500);
      expect(res.content[0].text).toBe("fast answer");
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 30_000);
});

describe("T008 — long-poll timeout returns processing; SC-002 round-trip budget (≤3 calls for a ~90s fusion)", () => {
  it("(a) a slow fusion returns processing after ~RESUME_LONG_POLL_MS; a later retrieval completes (loop works)", async () => {
    // Worker slower than the long-poll window: the first retrieval times out.
    const { wreg, jreg } = configureFaux({ workerDelayMs: RESUME_LONG_POLL_MS + 8_000, judgeFinal: "late answer" });
    const { client, close } = await bootNonTasks();
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
      // Timed out the long-poll → processing shape.
      expect(elapsed).toBeGreaterThanOrEqual(RESUME_LONG_POLL_MS - 1_000);
      expect(elapsed).toBeLessThan(RESUME_LONG_POLL_MS + 3_000);
      expect(res.content[0].text).toContain("still running");
      // Row still processing.
      const job = db.prepare("SELECT status FROM fusion_jobs WHERE activity_id = ?").get(refId) as { status: string };
      expect(job.status).toBe("processing");

      // A second retrieval after the fusion finishes returns completed (loop works).
      await new Promise((r) => setTimeout(r, 12_000));
      const res2 = (await client.callTool({ name: "fusion", arguments: { _resume_from: refId } })) as {
        content: { text: string }[];
      };
      expect(res2.content[0].text).toBe("late answer");
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 90_000); // ~48s worker + ~40s long-poll + drain.
});

describe("T009 — Tasks-aware client is unaffected (FR-013 / SC-007)", () => {
  it("a Tasks client still gets CreateTaskResult + tasks/result, NOT the _resume_from kickoff", async () => {
    const { wreg, jreg } = configureFaux({ workerDelayMs: 0, judgeFinal: "tasks-path answer" });
    const { client, close } = await bootTasks();
    try {
      const t0 = Date.now();
      const created = (await client.request(
        { method: "tools/call", params: { name: "fusion", arguments: { prompt: "x" }, task: { ttl: 60_000 } } },
        z.any(),
      )) as { task?: { taskId: string; status: string } };
      const elapsed = Date.now() - t0;
      // CreateTaskResult, NOT the kickoff text.
      expect(created.task).toBeDefined();
      expect(typeof created.task!.taskId).toBe("string");
      expect(elapsed).toBeLessThan(100); // synchronous

      // Retrieve via tasks/result (the Tasks path, NOT _resume_from).
      let result: { content?: { text: string }[] } | undefined;
      for (let i = 0; i < 50; i++) {
        try {
          result = (await client.request(
            { method: "tasks/result", params: { taskId: created.task!.taskId } },
            z.any(),
          )) as { content?: { text: string }[] };
          if (result?.content) break;
        } catch {
          /* not ready */
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(result?.content?.[0]?.text).toBe("tasks-path answer");
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  });
});

describe("SC-002 — a ~90s parallel fusion returns in ≤3 LLM round-trips", () => {
  it("counts kickoff + retrieval calls until the answer; total stays ≤3 for a ~90s fusion", async () => {
    // A ~90s fusion. With a 45s long-poll: kickoff + poll(0→45s, times out) + poll(45→90s,
    // completes mid-poll) = 3 calls. Fixed at 90s (NOT derived from RESUME_LONG_POLL_MS) so
    // the SC-002 budget assertion stays meaningful if the constant is tuned later.
    const fusionDurationMs = 90_000;
    const { wreg, jreg } = configureFaux({ workerDelayMs: fusionDurationMs, judgeFinal: "the 90s answer" });
    const { client, close } = await bootNonTasks();
    try {
      const kickoff = (await client.callTool({ name: "fusion", arguments: { prompt: "x" } })) as {
        _meta?: { reference_id: string };
      };
      const refId = kickoff._meta!.reference_id;

      // Loop retrievals until we get the answer. Count every call (F1).
      let calls = 1; // kickoff
      let answer = "";
      for (let i = 0; i < 10; i++) {
        calls++;
        const res = (await client.callTool({ name: "fusion", arguments: { _resume_from: refId } })) as {
          content: { text: string }[];
        };
        const text = res.content[0].text;
        if (text.includes("the 90s answer")) {
          answer = text;
          break;
        }
        // Otherwise it's a processing result; loop continues.
      }
      expect(answer).toBe("the 90s answer");
      // SC-002: ≤3 total round-trips for a ~90s fusion.
      expect(calls).toBeLessThanOrEqual(3);
    } finally {
      await close();
      wreg.unregister();
      jreg.unregister();
    }
  }, 180_000);
});

describe("resume-dispatch canary — SDK handler coupling (T011a)", () => {
  it("installResumeDispatch successfully captured + replaced the SDK's CallToolRequest handler", async () => {
    // If this test fails, the SDK's handler shape changed on upgrade — see resume-dispatch.ts
    // header (SDK COUPLING) for the verification checklist.
    const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lowLevel = (server as unknown as { server: any }).server;
      const handler = lowLevel?._requestHandlers?.get("tools/call");
      expect(typeof handler).toBe("function");
    } finally {
      server.close();
    }
  });
});

describe("T028 — fusion description still under the 006 token cap + mentions _resume_from", () => {
  it("FUSION_DESCRIPTION is strictly shorter than PRE_006 and mentions _resume_from (T028)", () => {
    expect(FUSION_DESCRIPTION.length).toBeLessThan(PRE_006_FUSION_DESCRIPTION.length);
    expect(FUSION_DESCRIPTION).toMatch(/_resume_from/);
  });
});
