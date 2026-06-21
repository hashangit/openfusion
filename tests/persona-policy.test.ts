// Feature 006 — Persona policy: override, strict, elicitation, concurrency.
// T016: allow-override honors valid id (SC-002).
// T020-T023: strict mode (notification + elicitation + relax + concurrency) — added in Phase 4.
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
import { registerModelDescriptor, clearModelDescriptors } from "../src/providers/pi-ai-bridge.js";
import { openDatabase } from "../src/store/db.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { getActivity } from "../src/store/activity.js";
import { resolvePersonaWithPolicy, shouldEmitEvent, askRelaxStrict, resetSessionOverride } from "../src/fusion/persona-policy.js";
import { BUILTIN_PERSONAS } from "../src/fusion/personas.js";
import type { RawConfig } from "../src/config/schema.js";
import type { DB } from "../src/store/db.js";

let home: string;
let db: DB;
const PROVIDER = "faux-p";
const JUDGE_PROVIDER = "faux-p-j";

function seed() {
  home = mkdtempSync(join(tmpdir(), "of-pp-"));
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
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 16384,
  });
  registerModelDescriptor(JUDGE_PROVIDER, "j1", {
    id: "j1", name: "j1", api: "faux-j", provider: JUDGE_PROVIDER, baseUrl: "http://localhost:0",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 16384,
  });
}
beforeEach(seed);
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
  clearModelDescriptors();
});

function baseConfig(policy: "strict" | "allow-override" = "allow-override", activePersona = "generalist"): RawConfig {
  return {
    candidates: [
      { id: "c1", provider: PROVIDER, model: "w1", enabled: true },
      { id: "c2", provider: PROVIDER, model: "w1", enabled: true },
    ],
    judges: [{ provider: JUDGE_PROVIDER, model: "j1", enabled: true }],
    personas: BUILTIN_PERSONAS.map((p) => ({ ...p })),
    settings: { workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false, activePersona, personaPolicy: policy },
  } as RawConfig;
}

/** Seed 2 worker responses + an analysis tool call + synthesis for a successful fusion. */
function seedFauxResponses() {
  const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
  const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
  wreg.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
  jreg.setResponses([
    fauxAssistantMessage([fauxToolCall("record_analysis", {
      consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [],
    })]),
    fauxAssistantMessage("synthesized"),
  ]);
  return { wreg, jreg };
}

describe("T016 — allow-override honors valid persona (SC-002, FR-007)", () => {
  it("classifies a valid requested id as override under allow-override", () => {
    const resolved = resolvePersonaWithPolicy({
      requested: "qa",
      personas: BUILTIN_PERSONAS,
      activeId: "generalist",
      policy: "allow-override",
      source: "mcp",
    });
    expect(resolved.personaSource).toBe("override");
    expect(resolved.persona.id).toBe("qa");
  });

  it("fusion under allow-override records persona=qa, persona_source=override", async () => {
    const { wreg, jreg } = seedFauxResponses();
    const result = await runFusion({
      prompt: "review this code",
      persona: "qa",
      config: baseConfig("allow-override", "generalist"),
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
    });
    expect(result.ok).toBe(true);

    const row = getActivity(db, result.activityId!);
    expect(row?.persona).toBe("qa");
    expect(row?.persona_source).toBe("override");

    wreg.unregister();
    jreg.unregister();
  });
});

describe("T020 — strict mode: user wins, agent warned not blocked (SC-003, FR-005)", () => {
  it("classifies a valid request under strict as strict-enforced (active runs)", () => {
    const resolved = resolvePersonaWithPolicy({
      requested: "qa",
      personas: BUILTIN_PERSONAS,
      activeId: "researcher",
      policy: "strict",
      source: "mcp",
    });
    expect(resolved.personaSource).toBe("strict-enforced");
    expect(resolved.persona.id).toBe("researcher"); // active ran, not qa
  });

  it("emits an elicitation-request event for strict-enforced", () => {
    const resolved = resolvePersonaWithPolicy({
      requested: "qa",
      personas: BUILTIN_PERSONAS,
      activeId: "researcher",
      policy: "strict",
      source: "mcp",
    });
    const event = shouldEmitEvent(resolved);
    expect(event?.kind).toBe("elicitation-request");
    expect(event).toMatchObject({ requested: "qa", used: "researcher" });
  });

  it("fusion under strict runs active persona + records strict-enforced (no callback = notification-only client)", async () => {
    const { wreg, jreg } = seedFauxResponses();
    const result = await runFusion({
      prompt: "review",
      persona: "qa",
      config: baseConfig("strict", "researcher"),
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
      // No onPersonaEvent → simulates a client with no elicitation; runFusion proceeds strict-enforced.
    });
    expect(result.ok).toBe(true);
    const row = getActivity(db, result.activityId!);
    expect(row?.persona).toBe("researcher");
    expect(row?.persona_source).toBe("strict-enforced");
    wreg.unregister();
    jreg.unregister();
  });
});

describe("T022/T023 — elicitation relax + concurrency (SC-004, FR-006)", () => {
  beforeEach(resetSessionOverride);

  it("T022: user 'relax' → runFusion honors requested persona (override); session remembers", async () => {
    const { wreg, jreg } = seedFauxResponses();
    let elicited = 0;
    const result = await runFusion({
      prompt: "review",
      persona: "qa",
      config: baseConfig("strict", "researcher"),
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
      onPersonaEvent: async (e) => {
        if (e.kind === "elicitation-request") {
          elicited++;
          return "relax";
        }
        return undefined;
      },
    });
    expect(result.ok).toBe(true);
    expect(elicited).toBe(1);
    // User relaxed → requested persona ran (audit: override, not strict-enforced).
    const row = getActivity(db, result.activityId!);
    expect(row?.persona).toBe("qa");
    expect(row?.persona_source).toBe("override");
    wreg.unregister();
    jreg.unregister();
  });

  it("T023: concurrent calls trigger exactly ONE elicitation (SC-004)", async () => {
    // Three concurrent runFusion calls under strict + relax; askRelaxStrict dedupes via
    // the shared in-flight promise, so the elicitation function runs exactly once.
    let elicitCalls = 0;
    const elicit = async (): Promise<"relax" | "keep-strict"> => {
      elicitCalls++;
      await new Promise((r) => setTimeout(r, 10)); // simulate user thinking
      return "relax";
    };
    const results = await Promise.all([
      askRelaxStrict(elicit),
      askRelaxStrict(elicit),
      askRelaxStrict(elicit),
    ]);
    expect(elicitCalls).toBe(1); // SC-004: exactly one elicitation
    expect(results).toEqual(["relax", "relax", "relax"]); // all callers share the answer
  });

  it("T021b: user 'keep-strict' → strict stays for the session (no re-prompt)", async () => {
    let elicitCalls = 0;
    const first = await askRelaxStrict(async () => {
      elicitCalls++;
      return "keep-strict";
    });
    const second = await askRelaxStrict(async () => {
      elicitCalls++;
      return "relax"; // would relax if called, but it shouldn't be
    });
    expect(first).toBe("keep-strict");
    expect(second).toBe("keep-strict"); // session remembered; no re-prompt
    expect(elicitCalls).toBe(1);
  });

  it("elicitation reject/timeout → treated as keep-strict, no re-prompt", async () => {
    let elicitCalls = 0;
    const first = await askRelaxStrict(async () => {
      elicitCalls++;
      throw new Error("timeout");
    });
    const second = await askRelaxStrict(async () => {
      elicitCalls++;
      return "relax";
    });
    expect(first).toBe("keep-strict");
    expect(second).toBe("keep-strict"); // locked after timeout
    expect(elicitCalls).toBe(1);
  });
});
