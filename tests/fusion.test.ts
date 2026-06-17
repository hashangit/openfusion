// T020 (worker) + T021 (judge) + T022 (fusion orchestration) — all faux-provider driven.
// Deterministic: no real API calls.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { runWorker } from "../src/fusion/worker.js";
import { runAnalysis, runSynthesis, analysisTool } from "../src/fusion/judge.js";
import { runFusion } from "../src/fusion/fusion.js";
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { openDatabase } from "../src/store/db.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey, encrypt } from "../src/config/crypto.js";
import type { RawConfig } from "../src/config/schema.js";
import type { DB } from "../src/store/db.js";
import { getActivity } from "../src/store/activity.js";

let home: string;
let dbPath: string;
let db: DB;
const PROVIDER = "faux-fusion";
const JUDGE_PROVIDER = "faux-judge";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-fusion-"));
  process.env.OPENFUSION_HOME = home;
  dbPath = join(home, "test.db");
  db = openDatabase(dbPath);
  // Seed a master.key + secrets so isConfigured can pass.
  const keyPath = join(home, "master.key");
  writeFileSync(keyPath, generateMasterKey(), { mode: 0o600 });
  saveSecrets(
    { providers: { [PROVIDER]: { apiKey: "k" }, [JUDGE_PROVIDER]: { apiKey: "k" } } },
    join(home, "secrets.enc"),
    keyPath,
  );
  // Register model descriptors so the fusion's resolveModel() can find faux models,
  // which are NOT in pi-ai's static registry.
  registerModelDescriptor(PROVIDER, "w1", {
    id: "w1", name: "w1", api: "faux-w", provider: PROVIDER, baseUrl: "http://localhost:0",
    reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
  });
  registerModelDescriptor(JUDGE_PROVIDER, "j1", {
    id: "j1", name: "j1", api: "faux-j", provider: JUDGE_PROVIDER, baseUrl: "http://localhost:0",
    reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
  });
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
  clearModelDescriptors();
});

function config(candidates: { id: string; model: string }[], judgeModel: string): RawConfig {
  return {
    candidates: candidates.map((c) => ({ id: c.id, provider: PROVIDER, model: c.model })),
    judge: { provider: JUDGE_PROVIDER, model: judgeModel },
    settings: { workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1" },
  };
}

// Isolated provider names for unit tests so their faux-provider state can't leak
// into the fusion orchestration tests (which use PROVIDER/JUDGE_PROVIDER).
const WP = "faux-w-unit";
const JP = "faux-j-unit";

describe("worker (T020)", () => {
  it("returns the candidate content + usage", async () => {
    const reg = registerFauxProvider({
      provider: WP,
      api: "faux-w",
      models: [{ id: "w1" }],
    });
    reg.setResponses([fauxAssistantMessage("hello from worker", { stopReason: "stop" })]);
    const res = await runWorker({
      slotId: "c1",
      provider: WP,
      modelId: "w1",
      model: reg.getModel("w1"),
      prompt: "hi",
      apiKey: "k",
      timeoutMs: 5_000,
    });
    expect(res.status).toBe("ok");
    expect(res.content).toBe("hello from worker");
    reg.unregister();
  });

  it("records a timeout when the model hangs past the limit on every retry", async () => {
    const reg = registerFauxProvider({ provider: WP, api: "faux-w", models: [{ id: "w1" }] });
    // A factory that always hangs (so every retry attempt genuinely times out).
    const hang: FauxResponseFactory = async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return fauxAssistantMessage("late");
    };
    // Queue enough hang responses for all 3 retry attempts.
    reg.setResponses([hang, hang, hang]);
    const res = await runWorker({
      slotId: "c1",
      provider: WP,
      modelId: "w1",
      model: reg.getModel("w1"),
      prompt: "hi",
      apiKey: "k",
      timeoutMs: 50, // very short; resets on each of the 3 attempts
    });
    expect(res.status).toBe("timeout");
    reg.unregister();
  });

  it("retries and succeeds when transient errors are followed by a good response", async () => {
    // Real providers reject on transient failures (unlike the faux provider,
    // which catches throws and returns an error message). Use vi.spyOn to
    // simulate reject-then-recover across the 3 retry attempts.
    let invocations = 0;
    const bridge = await import("../src/providers/pi-ai-bridge.js");
    const spy = vi
      .spyOn(bridge, "runComplete")
      .mockImplementation(async () => {
        invocations++;
        if (invocations < 3) throw new Error("transient 503");
        return {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "recovered" }],
          stopReason: "stop",
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        };
      });
    try {
      const res = await runWorker({
        slotId: "c1",
        provider: WP,
        modelId: "w1",
        model: { id: "w1", name: "w1", api: "faux-w", provider: WP } as never,
        prompt: "hi",
        apiKey: "k",
        timeoutMs: 5_000,
      });
      expect(res.status).toBe("ok");
      expect(res.content).toBe("recovered");
      expect(invocations).toBe(3); // 2 failures + 1 success
    } finally {
      spy.mockRestore();
    }
  });

  it("gives up after 3 failed attempts and reports the error", async () => {
    let invocations = 0;
    const bridge = await import("../src/providers/pi-ai-bridge.js");
    const spy = vi
      .spyOn(bridge, "runComplete")
      .mockImplementation(async () => {
        invocations++;
        throw new Error("persistent 500");
      });
    try {
      const res = await runWorker({
        slotId: "c1",
        provider: WP,
        modelId: "w1",
        model: { id: "w1", name: "w1", api: "faux-w", provider: WP } as never,
        prompt: "hi",
        apiKey: "k",
        timeoutMs: 5_000,
      });
      expect(res.status).toBe("error");
      expect(res.error).toMatch(/persistent 500/);
      expect(invocations).toBe(3); // exhausted all attempts
    } finally {
      spy.mockRestore();
    }
  });
});

describe("judge (T021)", () => {
  it("step 1 emits the record_analysis tool call with all 5 fields", async () => {
    const reg = registerFauxProvider({ provider: JP, api: "faux-j", models: [{ id: "j1" }] });
    const analysis = {
      consensus: ["c1"],
      contradictions: ["c2"],
      partialCoverage: ["c3"],
      uniqueInsights: ["c4"],
      blindSpots: ["c5"],
    };
    reg.setResponses([fauxAssistantMessage([fauxToolCall("record_analysis", analysis)])]);
    const res = await runAnalysis(reg.getModel("j1"), "prompt", [
      { index: 1, provider: PROVIDER, model: "w1", content: "answer" },
    ], "k");
    expect(res.ok).toBe(true);
    expect(res.value).toEqual(analysis);
    expect(analysisTool.name).toBe("record_analysis");
    reg.unregister();
  });

  it("step 1 fails when the model does not emit the tool call", async () => {
    const reg = registerFauxProvider({ provider: JP, api: "faux-j", models: [{ id: "j1" }] });
    reg.setResponses([fauxAssistantMessage("I refuse to analyze")]); // no tool call
    const res = await runAnalysis(reg.getModel("j1"), "prompt", [
      { index: 1, provider: PROVIDER, model: "w1", content: "answer" },
    ], "k");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/record_analysis/);
    reg.unregister();
  });

  it("step 2 synthesizes text from candidates + analysis", async () => {
    const reg = registerFauxProvider({ provider: JP, api: "faux-j", models: [{ id: "j1" }] });
    reg.setResponses([fauxAssistantMessage("consolidated answer")]);
    const res = await runSynthesis(
      reg.getModel("j1"),
      "prompt",
      [{ index: 1, provider: PROVIDER, model: "w1", content: "answer" }],
      { consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] },
      "k",
    );
    expect(res.ok).toBe(true);
    expect(res.value).toBe("consolidated answer");
    reg.unregister();
  });
});

describe("fusion orchestration (T022)", () => {
  it("fans out in parallel and returns a synthesized answer; logs 1 activity + N+2 sub_calls", async () => {
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    // 3 worker responses (faux returns them in order across calls), then analysis tool call, then synthesis.
    wreg.setResponses([
      fauxAssistantMessage("answer A"),
      fauxAssistantMessage("answer B"),
      fauxAssistantMessage("answer C"),
    ]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", {
        consensus: ["agreed"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [],
      })]),
      fauxAssistantMessage("final consolidated answer"),
    ]);

    const events: string[] = [];
    const res = await runFusion({
      prompt: "compare X vs Y",
      config: config(
        [
          { id: "c1", model: "w1" },
          { id: "c2", model: "w1" },
          { id: "c3", model: "w1" },
        ],
        "j1",
      ),
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
      onProgress: (_p, _t, m) => events.push(m),
    });

    expect(res.ok).toBe(true);
    expect(res.answer).toBe("final consolidated answer");
    expect(res.status).toBe("success");
    expect(events.length).toBeGreaterThan(0);

    const act = getActivity(db, res.activityId!)!;
    expect(act.candidate_count).toBe(3);
    expect(act.survivor_count).toBe(3);
    // 3 workers + analysis + synthesis
    expect(act.sub_calls.length).toBe(5);
    expect(act.sub_calls.filter((s) => s.role === "worker").length).toBe(3);
    expect(act.sub_calls.filter((s) => s.role === "judge_analysis").length).toBe(1);
    expect(act.sub_calls.filter((s) => s.role === "judge_synthesis").length).toBe(1);
    wreg.unregister();
    jreg.unregister();
  });

  it("errors with <2 survivors; logs status=error with failed sub_calls", async () => {
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    // Only 1 worker succeeds; the other errors (empty message => error).
    wreg.setResponses([
      fauxAssistantMessage("only good answer"),
      fauxAssistantMessage(""), // empty -> worker error
    ]);
    const res = await runFusion({
      prompt: "x",
      config: config(
        [
          { id: "c1", model: "w1" },
          { id: "c2", model: "w1" },
        ],
        "j1",
      ),
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/minimum 2/);
    const act = getActivity(db, res.activityId!)!;
    expect(act.status).toBe("error");
    expect(act.sub_calls.filter((s) => s.status === "error").length).toBeGreaterThanOrEqual(1);
    wreg.unregister();
  });

  it("marks status=partial when some (>=2) but not all candidates survive", async () => {
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([
      fauxAssistantMessage("ok 1"),
      fauxAssistantMessage("ok 2"),
      fauxAssistantMessage(""), // 3rd fails
    ]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", {
        consensus: [], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [],
      })]),
      fauxAssistantMessage("consolidated"),
    ]);
    const res = await runFusion({
      prompt: "x",
      config: config(
        [
          { id: "c1", model: "w1" },
          { id: "c2", model: "w1" },
          { id: "c3", model: "w1" },
        ],
        "j1",
      ),
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("partial");
    const act = getActivity(db, res.activityId!)!;
    expect(act.survivor_count).toBe(2);
    expect(act.candidate_count).toBe(3);
    wreg.unregister();
    jreg.unregister();
  });

  it("F1: judge analysis failure yields status=error with worker sub_calls logged", async () => {
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("ok 1"), fauxAssistantMessage("ok 2")]);
    // Judge analysis step refuses to emit the tool call -> analysis fails.
    jreg.setResponses([fauxAssistantMessage("no analysis")]);
    const res = await runFusion({
      prompt: "x",
      config: config(
        [
          { id: "c1", model: "w1" },
          { id: "c2", model: "w1" },
        ],
        "j1",
      ),
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/analysis/);
    const act = getActivity(db, res.activityId!)!;
    expect(act.status).toBe("error");
    // worker sub_calls were still logged even though the judge failed
    expect(act.sub_calls.filter((s) => s.role === "worker" && s.status === "ok").length).toBe(2);
    wreg.unregister();
    jreg.unregister();
  });

  it("F2: wall-clock budget — a fusion of 3 workers + 2 judge steps completes quickly", async () => {
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", { consensus: [], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] })]),
      fauxAssistantMessage("final"),
    ]);
    const start = Date.now();
    const res = await runFusion({
      prompt: "x",
      config: config([{ id: "c1", model: "w1" }, { id: "c2", model: "w1" }, { id: "c3", model: "w1" }], "j1"),
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
    });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(true);
    // Faux provider is effectively instant; a 3+2 fusion should finish well under any client timeout.
    expect(elapsed).toBeLessThan(10_000);
    wreg.unregister();
    jreg.unregister();
  });

  it("F4: refuses when unconfigured (needsConfig=true) and does not log an activity", async () => {
    const res = await runFusion({
      prompt: "x",
      config: { candidates: [], settings: { workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1" } },
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
    });
    expect(res.ok).toBe(false);
    expect(res.needsConfig).toBe(true);
    expect(res.error).toMatch(/configured/i);
    // No activity should have been logged.
    expect(db.prepare("SELECT COUNT(*) AS n FROM activities").get()).toEqual({ n: 0 });
  });
});
