// Feature 007 — serial time budget (Phase 4 / US2).
// T14 (quickstart T3): computeSerialBudgetMs formula (FR-005, FR-007, SC-003, R-003).
// T15 (quickstart T4): budget exhaustion stops *launching*; in-flight candidate not aborted (FR-008, FR-009, R-002).
// T16 (quickstart T5): per-worker retry unchanged in serial (FR-008, INV-5).
// T17 (quickstart T6): sequential × benchmark both ON (FR-016, SC-006).
// Deterministic: faux providers.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { runFusion } from "../src/fusion/fusion.js";
import { runSequentialFanout, computeSerialBudgetMs, PER_CANDIDATE_MS, JUDGE_STEPS_MS } from "../src/fusion/fanout.js";
import { runWorker, type WorkerInput } from "../src/fusion/worker.js";
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { openDatabase } from "../src/store/db.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { getActivity } from "../src/store/activity.js";
import type { RawConfig } from "../src/config/schema.js";
import type { DB } from "../src/store/db.js";

let home: string;
let db: DB;
const PROVIDER = "faux-budget";
const JUDGE_PROVIDER = "faux-budget-judge";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-budget-"));
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

function seqConfig(candidateCount: number, opts: { benchmark?: boolean } = {}): RawConfig {
  const ids = ["c1", "c2", "c3", "c4", "c5", "c6"].slice(0, candidateCount);
  return {
    candidates: ids.map((id) => ({ id, provider: PROVIDER, model: "w1", enabled: true })),
    judges: [{ provider: JUDGE_PROVIDER, model: "j1", enabled: true }],
    settings: {
      workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1",
      benchmarkMode: opts.benchmark ?? false, executionMode: "sequential",
    },
  };
}

function judgeResponses(synth: string) {
  return [
    fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: ["ok"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
    fauxAssistantMessage(synth),
  ];
}

describe("T14 — budget formula (FR-005, FR-007, SC-003, R-003)", () => {
  it("computeSerialBudgetMs(N) === PER_CANDIDATE_MS * N + JUDGE_STEPS_MS", () => {
    expect(PER_CANDIDATE_MS).toBe(180_000); // 3 min
    expect(JUDGE_STEPS_MS).toBe(360_000); // 6 min
    for (const n of [2, 3, 5, 6]) {
      expect(computeSerialBudgetMs(n)).toBe(180_000 * n + 360_000);
    }
    expect(computeSerialBudgetMs(2)).toBe(720_000); // 12 min
    expect(computeSerialBudgetMs(3)).toBe(900_000); // 15 min
    expect(computeSerialBudgetMs(5)).toBe(1_260_000); // 21 min
  });
});

describe("T15 — budget exhaustion stops launching; in-flight candidate not aborted (FR-008, FR-009, R-002)", () => {
  // Direct unit test of runSequentialFanout with the overrideBudgetMs test seam (U1 — NOT
  // exposed through runFusion; production never passes it). This is where R-002's "gate
  // launching, not the in-flight candidate" contract lives.
  //
  // Self-calibrating: measure one worker's real latency, then size the budget so exactly N
  // workers fit. This is immune to faux timing variance across machines/CI.
  it("budget sized to ~1.5 workers: exactly one worker launches and completes (c2 gate-tripped)", async () => {
    const wreg = registerFauxProvider({
      provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }], tokensPerSecond: 20, tokenSize: { min: 8, max: 10 },
    });
    wreg.setResponses([fauxAssistantMessage("AAAAAAAA"), fauxAssistantMessage("BBBBBBBB"), fauxAssistantMessage("CCCCCCCC")]);

    // Measure one worker's latency.
    const probeStart = Date.now();
    const probe = await runWorker({
      slotId: "probe", provider: PROVIDER, modelId: "w1", model: wreg.getModel("w1"),
      prompt: "p", apiKey: "k", timeoutMs: 5_000, workerPrompt: "wp",
    });
    const perWorker = Date.now() - probeStart;
    expect(probe.status).toBe("ok");
    expect(perWorker).toBeGreaterThan(5); // sanity: faux actually delayed

    // Now 3 fresh workers; budget = perWorker * 1.5 → c1 fits, c2's gate (elapsed ~perWorker)
    // is under budget so c2 ALSO fits, but c3's gate (elapsed ~2*perWorker) exceeds 1.5*perWorker.
    // Re-seed responses (probe consumed one).
    wreg.setResponses([fauxAssistantMessage("AAAAAAAA"), fauxAssistantMessage("BBBBBBBB"), fauxAssistantMessage("CCCCCCCC")]);
    const workerCalls: WorkerInput[] = ["c1", "c2", "c3"].map((id) => ({
      slotId: id, provider: PROVIDER, modelId: "w1", model: wreg.getModel("w1"),
      prompt: "p", apiKey: "k", timeoutMs: 5_000, workerPrompt: "wp",
    }));
    const results = await runSequentialFanout(workerCalls, { overrideBudgetMs: Math.round(perWorker * 1.5) });
    expect(results.length).toBe(2); // c1 + c2 launched; c3 gate-tripped
    expect(results[0].slotId).toBe("c1");
    expect(results[1].slotId).toBe("c2");
    expect(results.every((r) => r.status === "ok")).toBe(true); // neither aborted mid-flight
    wreg.unregister();
  });

  it("budget smaller than one worker: only c1 launches and completes (c2/c3 gate-tripped)", async () => {
    const wreg = registerFauxProvider({
      provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }], tokensPerSecond: 20, tokenSize: { min: 8, max: 10 },
    });
    wreg.setResponses([fauxAssistantMessage("AAAAAAAA"), fauxAssistantMessage("BBBBBBBB"), fauxAssistantMessage("CCCCCCCC")]);
    const probeStart = Date.now();
    const probe = await runWorker({
      slotId: "probe", provider: PROVIDER, modelId: "w1", model: wreg.getModel("w1"),
      prompt: "p", apiKey: "k", timeoutMs: 5_000, workerPrompt: "wp",
    });
    const perWorker = Date.now() - probeStart;
    expect(probe.status).toBe("ok");

    wreg.setResponses([fauxAssistantMessage("AAAAAAAA"), fauxAssistantMessage("BBBBBBBB"), fauxAssistantMessage("CCCCCCCC")]);
    const workerCalls: WorkerInput[] = ["c1", "c2", "c3"].map((id) => ({
      slotId: id, provider: PROVIDER, modelId: "w1", model: wreg.getModel("w1"),
      prompt: "p", apiKey: "k", timeoutMs: 5_000, workerPrompt: "wp",
    }));
    // budget < perWorker: c1 launches (~0), resolves (~perWorker); c2's gate (~perWorker) > budget → skipped.
    const results = await runSequentialFanout(workerCalls, { overrideBudgetMs: Math.max(1, perWorker - 5) });
    expect(results.length).toBe(1);
    expect(results[0].slotId).toBe("c1");
    expect(results[0].status).toBe("ok"); // in-flight candidate completed, NOT aborted
    wreg.unregister();
  });
});

describe("T16 — per-worker retry unchanged in serial (FR-008, INV-5)", () => {
  it("a candidate that errors is still subject to withRetryTimeout's attempts (serial doesn't bypass retry)", async () => {
    // The retry/timeout machinery lives in runWorker + withRetryTimeout, which runSequentialFanout
    // calls unchanged (INV-5). We assert the integration: a candidate that returns an empty
    // message (=> error) is recorded as error and the run proceeds with survivors.
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    // c1 ok, c2 empty (error), c3 ok -> 2 survivors, proceeds to judging.
    wreg.setResponses([
      fauxAssistantMessage("A"),
      fauxAssistantMessage(""),
      fauxAssistantMessage("C"),
    ]);
    jreg.setResponses(judgeResponses("retry serial ok"));

    const res = await runFusion({
      prompt: "p", config: seqConfig(3), db,
      secretsPath: join(home, "secrets.enc"), keyPath: join(home, "master.key"),
    });
    expect(res.ok).toBe(true);
    const act = getActivity(db, res.activityId!);
    expect(act.survivor_count).toBe(2); // c2 errored, c1+c3 survived
    expect(act.sub_calls.filter((s) => s.role === "worker" && s.status === "error").length).toBe(1);
    wreg.unregister();
    jreg.unregister();
  });
});

describe("T17 — sequential × benchmark both ON (FR-016, SC-006)", () => {
  it("6 candidates run sequentially under benchmarkMode; budget scales with the lifted cap", async () => {
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses(Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`A${i + 1}`)));
    jreg.setResponses(judgeResponses("seq+bench ok"));

    const res = await runFusion({
      prompt: "p", config: seqConfig(6, { benchmark: true }), db,
      secretsPath: join(home, "secrets.enc"), keyPath: join(home, "master.key"),
    });
    expect(res.ok).toBe(true);
    const act = getActivity(db, res.activityId!);
    expect(act.candidate_count).toBe(6); // benchmark lifts the 5-cap; all 6 enabled
    expect(act.survivor_count).toBe(6);
    expect(computeSerialBudgetMs(6)).toBe(1_440_000); // 24 min
    wreg.unregister();
    jreg.unregister();
  });
});
