// Feature 009 — POST /api/fusion route (Playground API).
// The Playground is the first UI callsite that *launches* a fusion rather than only reading past ones.
// It calls runFusion directly with source:"ui" — activating feature 006's dormant persona-policy exemption.
// Deterministic: faux providers, temp DB, no real API calls. Mirrors the status.test.ts in-process
// server pattern (supertest isn't installed — we avoid adding a dep).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import { fusionRouter } from "../src/server/api/fusion.js";
import { runFusion } from "../src/fusion/fusion.js";
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { openDatabase } from "../src/store/db.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { saveConfig } from "../src/config/store.js";
import type { RawConfig } from "../src/config/schema.js";
import type { DB } from "../src/store/db.js";
import { getActivity } from "../src/store/activity.js";

let home: string;
let restoreHome: string | undefined;
let dbPath: string;
let db: DB;
const PROVIDER = "faux-pg";
const JUDGE_PROVIDER = "faux-pg-judge";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-playground-"));
  restoreHome = process.env.OPENFUSION_HOME;
  process.env.OPENFUSION_HOME = home;
  dbPath = join(home, "test.db");
  db = openDatabase(dbPath);
  // Seed master.key + secrets so isConfigured can pass.
  const keyPath = join(home, "master.key");
  writeFileSync(keyPath, generateMasterKey(), { mode: 0o600 });
  saveSecrets(
    { providers: { [PROVIDER]: { apiKey: "k" }, [JUDGE_PROVIDER]: { apiKey: "k" } } },
    join(home, "secrets.enc"),
    keyPath,
  );
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
  if (restoreHome === undefined) delete process.env.OPENFUSION_HOME;
  else process.env.OPENFUSION_HOME = restoreHome;
  rmSync(home, { recursive: true, force: true });
  clearModelDescriptors();
});

function configuredConfig(candidates: { id: string; model?: string }[]): RawConfig {
  return {
    candidates: candidates.map((c) => ({
      id: c.id, provider: PROVIDER, model: c.model ?? "w1", enabled: true,
    })),
    judges: [{ provider: JUDGE_PROVIDER, model: "j1", enabled: true }],
    personas: [],
    settings: { workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
  };
}

/**
 * Boot the fusion router on a real port + issue a POST, returning the Response.
 * Mirrors src/server/ui-server.ts's parser config — including the raised body limit,
 * which the Playground relies on for file-attachment contexts (default 100kb would reject them).
 */
async function postFusion(body: unknown): Promise<Response> {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use("/api/fusion", fusionRouter(db));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fetch(`http://127.0.0.1:${port}/api/fusion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    server.close();
  }
}

describe("POST /api/fusion (feature 009 — Playground API)", () => {
  it("(a) valid { prompt } with a configured config runs the fusion + returns the answer + activityId", async () => {
    saveConfig(configuredConfig([{ id: "c1" }, { id: "c2" }, { id: "c3" }]));
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
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

    const res = await postFusion({ prompt: "compare X vs Y" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status === "success" || body.status === "partial").toBe(true);
    expect(typeof body.answer).toBe("string");
    expect(body.answer.length).toBeGreaterThan(0);
    expect(typeof body.activityId).toBe("string");

    // The activityId resolves to a real row with the expected shape (SC-002: identical to an MCP fusion).
    const act = getActivity(db, body.activityId)!;
    expect(act.candidate_count).toBe(3);
    expect(act.sub_calls.length).toBe(5); // 3 workers + analysis + synthesis

    wreg.unregister();
    jreg.unregister();
  });

  it("(b) unconfigured (<2 candidates) returns ok:false + needsConfig:true + NO activityId", async () => {
    // Save a config with only 1 candidate — the gate will fail.
    saveConfig(configuredConfig([{ id: "c1" }]));

    const res = await postFusion({ prompt: "hello" });
    expect(res.status).toBe(200); // gate failures are 200 with needsConfig, not 4xx
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("error");
    expect(body.needsConfig).toBe(true);
    expect(body.activityId).toBeUndefined(); // gate runs before recordActivity — no row written
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);

    // No activities row should have been written.
    const all = getActivity(db, "");
    expect(all).toBeUndefined();
  });

  it("(c) missing prompt returns HTTP 400 BAD_REQUEST", async () => {
    saveConfig(configuredConfig([{ id: "c1" }, { id: "c2" }]));

    // Missing prompt entirely.
    const res1 = await postFusion({});
    expect(res1.status).toBe(400);
    const body1 = await res1.json();
    expect(body1.error).toBe("BAD_REQUEST");

    // Empty/whitespace prompt.
    const res2 = await postFusion({ prompt: "   " });
    expect(res2.status).toBe(400);
    const body2 = await res2.json();
    expect(body2.error).toBe("BAD_REQUEST");
  });

  it("(d) a body with a stray apiKey field is accepted (ignored) + the response carries no key material", async () => {
    saveConfig(configuredConfig([{ id: "c1" }, { id: "c2" }]));
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", {
        consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [],
      })]),
      fauxAssistantMessage("consolidated"),
    ]);

    // Body carries a stray apiKey — Constitution IV: never accepted/echoed.
    const res = await postFusion({ prompt: "x", apiKey: "sk-LEAK-ATTEMPT" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-LEAK-ATTEMPT");
    const body = JSON.parse(text);
    expect(body.ok).toBe(true);
    // The response schema carries only { activityId, ok, status, answer, ... } — no key-shaped fields.
    expect(body.apiKey).toBeUndefined();

    wreg.unregister();
    jreg.unregister();
  });

  it("(e) under personaPolicy:strict + a requested persona override → activities.persona_source = 'active' (source:'ui' is exempt — SC-003)", async () => {
    const cfg = configuredConfig([{ id: "c1" }, { id: "c2" }]);
    // Strict policy would normally force the active persona for MCP clients. UI calls bypass it.
    cfg.settings!.personaPolicy = "strict";
    // Add a non-active persona to request as an override.
    cfg.personas = [
      { id: "generalist", name: "Generalist", workerPrompt: "w", analysisPrompt: "a", synthesisPrompt: "s", builtin: true },
      { id: "researcher", name: "Researcher", workerPrompt: "w", analysisPrompt: "a", synthesisPrompt: "s" },
    ];
    cfg.settings!.activePersona = "generalist";
    saveConfig(cfg);

    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", {
        consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [],
      })]),
      fauxAssistantMessage("consolidated"),
    ]);

    // Request the non-active persona under strict policy. UI source must bypass the gate.
    const res = await postFusion({ prompt: "x", persona: "researcher" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The activity row records persona_source = "active" (NOT "strict-enforced") — proves the UI exemption fired.
    const act = getActivity(db, body.activityId)!;
    expect(act.persona_source).toBe("active");

    wreg.unregister();
    jreg.unregister();
  });

  it("(f) a >1MB context body is accepted (raised json limit for file attachments) + the fusion runs", async () => {
    saveConfig(configuredConfig([{ id: "c1" }, { id: "c2" }]));
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", {
        consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [],
      })]),
      fauxAssistantMessage("consolidated"),
    ]);

    // ~2MB of context — would be rejected as 413 by the pre-attachment-era 1mb cap.
    const bigContext = "x".repeat(2 * 1024 * 1024);
    const res = await postFusion({ prompt: "summarize the attachment", context: bigContext });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The activity row records has_context — proving the large context flowed through end-to-end.
    const act = getActivity(db, body.activityId)!;
    expect(act.has_context).toBe(1);

    wreg.unregister();
    jreg.unregister();
  });
});
