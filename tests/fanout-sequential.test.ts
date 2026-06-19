// Feature 007 — sequential fan-out (Phase 3 / US1 MVP).
// T010: parallel mode unchanged (guards the T007 dispatch extraction — INV-4).
// T011: sequential mode runs candidates one at a time in slot order, non-overlapping,
//        producing the same 1 activity + N+2 sub_calls structure as parallel (FR-011).
// Deterministic: faux providers with timestamped + delayed response factories.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { runFusion } from "../src/fusion/fusion.js";
import { fusionStatusRegistry } from "../src/fusion/status.js";
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { openDatabase } from "../src/store/db.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { getActivity } from "../src/store/activity.js";
import type { RawConfig } from "../src/config/schema.js";
import type { DB } from "../src/store/db.js";

let home: string;
let db: DB;
const PROVIDER = "faux-seq";
const JUDGE_PROVIDER = "faux-seq-judge";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-seq-"));
  process.env.OPENFUSION_HOME = home;
  db = openDatabase(join(home, "test.db"));
  const keyPath = join(home, "master.key");
  writeFileSync(keyPath, generateMasterKey(), { mode: 0o600 });
  saveSecrets(
    { providers: { [PROVIDER]: { apiKey: "k" }, [JUDGE_PROVIDER]: { apiKey: "k" } } },
    join(home, "secrets.enc"),
    keyPath,
  );
  registerModelDescriptor(PROVIDER, "w1", {
    id: "w1", name: "w1", api: "faux-w", provider: PROVIDER, baseUrl: "http://localhost:0",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
  });
  registerModelDescriptor(JUDGE_PROVIDER, "j1", {
    id: "j1", name: "j1", api: "faux-j", provider: JUDGE_PROVIDER, baseUrl: "http://localhost:0",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
  });
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
  clearModelDescriptors();
});

function config(mode: "parallel" | "sequential"): RawConfig {
  return {
    candidates: [
      { id: "c1", provider: PROVIDER, model: "w1", enabled: true },
      { id: "c2", provider: PROVIDER, model: "w1", enabled: true },
      { id: "c3", provider: PROVIDER, model: "w1", enabled: true },
    ],
    judges: [{ provider: JUDGE_PROVIDER, model: "j1", enabled: true }],
    settings: {
      workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1",
      benchmarkMode: false, executionMode: mode,
    },
  };
}

/**
 * A faux response factory that records a [start, end] wall-clock window for each worker
 * call and introduces a fixed delay so parallel vs serial overlap is observable.
 *
 * APPENDs each window to `windows` (no indexing by callCount) — callCount is shared mutable
 * state and is unsafe to index by under concurrency (parallel calls race on it). After the
 * run, sort `windows` by `start` and assert overlap (parallel) or strict non-overlap (serial).
 */
function makeWorkerFactory(
  windows: Array<{ start: number; end: number }>,
  delayMs: number,
  answer: string,
): FauxResponseStep {
  return () => {
    const start = Date.now();
    return new Promise((resolve) => {
      setTimeout(() => {
        windows.push({ start, end: Date.now() });
        resolve(fauxAssistantMessage(answer));
      }, delayMs);
    });
  };
}

describe("T010 — parallel mode unchanged (FR-002, INV-4)", () => {
  it("candidate windows OVERLAP in parallel mode; same 1 activity + 5 sub_calls structure", async () => {
    const windows: Array<{ start: number; end: number }> = [];
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    // 3 workers each take ~80ms; in parallel they overlap (total ~80ms, not ~240ms).
    const factory = makeWorkerFactory(windows, 80, "answer");
    wreg.setResponses([factory, factory, factory]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["ok"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
      fauxAssistantMessage("parallel consolidated"),
    ]);

    const res = await runFusion({
      prompt: "p", config: config("parallel"), db,
      secretsPath: join(home, "secrets.enc"), keyPath: join(home, "master.key"),
    });

    expect(res.ok).toBe(true);
    expect(res.answer).toBe("parallel consolidated");
    expect(res.status).toBe("success");
    const act = getActivity(db, res.activityId!)!;
    expect(act.candidate_count).toBe(3);
    expect(act.survivor_count).toBe(3);
    expect(act.sub_calls.length).toBe(5); // 3 workers + analysis + synthesis (SC-005)

    // PARALLEL signature: all 3 windows overlap. Sort by start; consecutive windows overlap
    // (each starts before the previous ends). Total wall-clock ≈ one delay, not 3× delay.
    expect(windows.length).toBe(3);
    const sorted = [...windows].sort((a, b) => a.start - b.start);
    expect(sorted[0].start).toBeLessThan(sorted[1].end); // w0 + w1 overlap
    expect(sorted[1].start).toBeLessThan(sorted[2].end); // w1 + w2 overlap
    wreg.unregister();
    jreg.unregister();
  });
});

describe("T011 — sequential ordering (FR-003, FR-010, FR-011, SC-001, SC-005)", () => {
  it("candidate windows do NOT overlap and run in slot order; same 5 sub_calls structure", async () => {
    const windows: Array<{ start: number; end: number }> = [];
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    const factory = makeWorkerFactory(windows, 60, "answer");
    wreg.setResponses([factory, factory, factory]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["ok"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
      fauxAssistantMessage("serial consolidated"),
    ]);

    const res = await runFusion({
      prompt: "p", config: config("sequential"), db,
      secretsPath: join(home, "secrets.enc"), keyPath: join(home, "master.key"),
    });

    expect(res.ok).toBe(true);
    expect(res.answer).toBe("serial consolidated");
    expect(res.status).toBe("success");
    const act = getActivity(db, res.activityId!)!;
    expect(act.candidate_count).toBe(3);
    expect(act.survivor_count).toBe(3);
    // FR-011: identical fields + row count to parallel (NOT row order — serial is deterministic,
    // parallel is race-ordered; only count + field presence must be invariant).
    expect(act.sub_calls.length).toBe(5);
    expect(act.sub_calls.filter((s) => s.role === "worker").length).toBe(3);
    expect(act.sub_calls.filter((s) => s.role === "judge_analysis").length).toBe(1);
    expect(act.sub_calls.filter((s) => s.role === "judge_synthesis").length).toBe(1);

    // SEQUENTIAL signature: non-overlapping. Sort by start; each window ends before the
    // next starts. (Slot order falls out of non-overlap + the for…of dispatch order.)
    expect(windows.length).toBe(3);
    const sorted = [...windows].sort((a, b) => a.start - b.start);
    expect(sorted[0].end).toBeLessThanOrEqual(sorted[1].start); // c1 before c2
    expect(sorted[1].end).toBeLessThanOrEqual(sorted[2].start); // c2 before c3
    wreg.unregister();
    jreg.unregister();
  });
});

describe("T010b — parallel runFusion updates the registry mid-run (FR-013, Finding 1)", () => {
  // Regression: the parallel branch must call registry.update(candidatesDone) as workers land,
  // NOT rely on a manual update. The earlier T022 mocked the update and missed that the
  // production parallel path never called it — leaving the widget frozen at "0 of N".
  // This test spies on registry.update directly (exercising the REAL runFusion → fanout →
  // registry path) rather than polling, because faux workers resolve near-simultaneously and
  // intermediate registry state is unobservable from outside the microtask batch.
  it("runFusion(parallel) calls registry.update with rising candidatesDone (1,2,3)", async () => {
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("AAAA"), fauxAssistantMessage("BBBB"), fauxAssistantMessage("CCCC")]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["ok"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
      fauxAssistantMessage("parallel consolidated"),
    ]);

    // Spy on the real registry.update; record every candidatesDone it's called with.
    // try/finally restores it so a future runFusion throw can't leak the spy to siblings.
    const seen: number[] = [];
    const realUpdate = fusionStatusRegistry.update.bind(fusionStatusRegistry);
    fusionStatusRegistry.update = (id, patch) => {
      if (typeof patch.candidatesDone === "number") seen.push(patch.candidatesDone);
      return realUpdate(id, patch);
    };

    let res: Awaited<ReturnType<typeof runFusion>>;
    try {
      res = await runFusion({
        prompt: "p", config: config("parallel"), db,
        secretsPath: join(home, "secrets.enc"), keyPath: join(home, "master.key"),
      });
    } finally {
      // Restore the real method even if runFusion throws (it doesn't today, but defensively).
      fusionStatusRegistry.update = realUpdate;
    }

    expect(res.ok).toBe(true);
    // Pre-fix: `seen` was empty (parallel never updated). Post-fix: rising 1,2,3.
    expect(seen).toEqual([1, 2, 3]);
    // After completion the registry is empty (leave ran in finally — INV-3).
    expect(fusionStatusRegistry.getSnapshot().state).toBe("idle");
    wreg.unregister();
    jreg.unregister();
  });
});
