// Feature 006 — Persona discovery (list_personas) + invalid-fallback (T015, T028).
// T015: list_personas shape (FR-001, FR-002, FR-016, SC-001) — descriptors only, no prompts.
// T028: invalid persona id falls back gracefully (SC-005).
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
import { resolvePersonaWithPolicy, shouldEmitEvent } from "../src/fusion/persona-policy.js";
import { toLite, BUILTIN_PERSONAS } from "../src/fusion/personas.js";
import { listPersonasToolHandler, FUSION_DESCRIPTION, PRE_006_FUSION_DESCRIPTION } from "../src/server/mcp-server.js";
import type { RawConfig } from "../src/config/schema.js";
import type { DB } from "../src/store/db.js";

let home: string;
let db: DB;
const PROVIDER = "faux-d";
const JUDGE_PROVIDER = "faux-d-j";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-pd-"));
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
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
  clearModelDescriptors();
});

function baseConfig(overrides: Partial<RawConfig> = {}): RawConfig {
  return {
    candidates: [
      { id: "c1", provider: PROVIDER, model: "w1", enabled: true },
      { id: "c2", provider: PROVIDER, model: "w1", enabled: true },
    ],
    judges: [{ provider: JUDGE_PROVIDER, model: "j1", enabled: true }],
    personas: BUILTIN_PERSONAS.map((p) => ({ ...p })),
    settings: { workerTimeoutMs: 5_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false, activePersona: "generalist", personaPolicy: "allow-override" },
    ...overrides,
  } as RawConfig;
}

describe("T015 — list_personas shape (FR-001, FR-002, FR-016, SC-001)", () => {
  it("projects builtins to PersonaLite with exactly 5 keys (no prompt fields)", () => {
    const cfg = baseConfig();
    const activeId = "qa";
    const list = (cfg.personas ?? []).map((p) => toLite(p, activeId));

    // SC-001: serialized output contains NO prompt fields.
    const serialized = JSON.stringify(list);
    expect(serialized).not.toMatch(/workerPrompt|analysisPrompt|synthesisPrompt/);

    // ≥4 builtins present.
    expect(list.length).toBeGreaterThanOrEqual(4);

    // FR-001: each entry has EXACTLY {id, name, description, builtin, active}.
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(["active", "builtin", "description", "id", "name"]);
    }

    // FR-002: exactly one active.
    expect(list.filter((e) => e.active).length).toBe(1);
    expect(list.find((e) => e.active)?.id).toBe("qa");

    // builtins flagged.
    expect(list.filter((e) => e.builtin).length).toBeGreaterThanOrEqual(4);
  });

  it("FR-016: discovery output is identical regardless of personaPolicy (strict vs allow)", () => {
    // The list_personas projection (toLite) never consults the policy — FR-016.
    const cfgAllow = baseConfig({ settings: { ...baseConfig().settings!, personaPolicy: "allow-override" } });
    const cfgStrict = baseConfig({ settings: { ...baseConfig().settings!, personaPolicy: "strict" } });

    const listAllow = JSON.stringify((cfgAllow.personas ?? []).map((p) => toLite(p, "generalist")));
    const listStrict = JSON.stringify((cfgStrict.personas ?? []).map((p) => toLite(p, "generalist")));

    expect(listStrict).toEqual(listAllow);
  });

  it("listPersonasToolHandler returns the JSON array via the handler (integration)", () => {
    const res = listPersonasToolHandler({
      personas: BUILTIN_PERSONAS,
      settings: { activePersona: "generalist" },
    });
    const parsed = JSON.parse(res.content[0].text) as { id: string; active: boolean }[];
    expect(parsed.length).toBeGreaterThanOrEqual(4);
    expect(parsed.filter((e) => e.active).length).toBe(1);
    expect(parsed.find((e) => e.active)?.id).toBe("generalist");
  });

  it("FR-001: merges a newly-shipped builtin into a persisted persona list (no shadowing)", () => {
    // Regression: a v3 config persists its persona list on disk. The handler used to do
    // `config.personas ?? BUILTIN_PERSONAS` (fallback only), so a stored list missing a
    // newly-shipped builtin would shadow it — list_personas would never show the new one.
    // The handler must merge missing builtins, mirroring the REST withBuiltins() path.
    const staleStoredList = BUILTIN_PERSONAS.filter((p) => p.id !== "architect");
    expect(staleStoredList.length).toBe(BUILTIN_PERSONAS.length - 1); // simulates a pre-architect config

    const res = listPersonasToolHandler({
      personas: staleStoredList,
      settings: { activePersona: "generalist" },
    });
    const parsed = JSON.parse(res.content[0].text) as { id: string; builtin: boolean }[];

    // The missing builtin is surfaced, not shadowed.
    expect(parsed.map((p) => p.id)).toContain("architect");
    // No duplicates of anything in the stored list.
    expect(parsed.length).toBe(BUILTIN_PERSONAS.length);
    // Exactly one active.
    expect((JSON.parse(res.content[0].text) as { active: boolean }[]).filter((e) => e.active).length).toBe(1);
  });

  it("SC-006: fusion description trimmed — shorter + no inline persona enumeration", () => {
    // SC-006: the new description is strictly shorter than the pre-006 one.
    expect(FUSION_DESCRIPTION.length).toBeLessThan(PRE_006_FUSION_DESCRIPTION.length);
    // And the inline id enumeration ("qa", "researcher", "pm" as examples) is gone.
    // The discovery nudge mentions `list_personas`, but must not list the persona ids.
    expect(FUSION_DESCRIPTION).not.toContain("'qa'");
    expect(FUSION_DESCRIPTION).not.toContain("'researcher'");
    expect(FUSION_DESCRIPTION).not.toContain("'pm'");
    expect(FUSION_DESCRIPTION).toContain("list_personas");
  });
});

describe("T028 — invalid persona id falls back gracefully (SC-005, FR-008)", () => {
  it("classifies an unresolvable id as invalid-fallback under allow-override", () => {
    const cfg = baseConfig();
    const resolved = resolvePersonaWithPolicy({
      requested: "does-not-exist",
      personas: cfg.personas ?? [],
      activeId: cfg.settings!.activePersona,
      policy: "allow-override",
      source: "mcp",
    });
    expect(resolved.personaSource).toBe("invalid-fallback");
    expect(resolved.persona.id).toBe("generalist"); // fell back to active
  });

  it("classifies an unresolvable id as invalid-fallback under STRICT too (FR-008: any policy)", () => {
    // FR-008: invalid id falls back regardless of policy. Strict governs VALID overrides,
    // not invalid ones — a bad id was never going to run anyway.
    const cfg = baseConfig({ settings: { ...baseConfig().settings!, personaPolicy: "strict" } });
    const resolved = resolvePersonaWithPolicy({
      requested: "nope",
      personas: cfg.personas ?? [],
      activeId: cfg.settings!.activePersona,
      policy: "strict",
      source: "mcp",
    });
    expect(resolved.personaSource).toBe("invalid-fallback");
  });

  it("emits a warning event with reason invalid-fallback", () => {
    const cfg = baseConfig();
    const resolved = resolvePersonaWithPolicy({
      requested: "nope",
      personas: cfg.personas ?? [],
      activeId: cfg.settings!.activePersona,
      policy: "allow-override",
      source: "mcp",
    });
    const event = shouldEmitEvent(resolved);
    expect(event?.kind).toBe("warning");
    expect(event).toMatchObject({ source: "invalid-fallback", requested: "nope", used: "generalist" });
  });

  it("fusion with invalid persona id never errors; records invalid-fallback on the row", async () => {
    const wreg = registerFauxProvider({ provider: PROVIDER, api: "faux-w", models: [{ id: "w1" }] });
    const jreg = registerFauxProvider({ provider: JUDGE_PROVIDER, api: "faux-j", models: [{ id: "j1" }] });
    wreg.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
    jreg.setResponses([
      fauxAssistantMessage([fauxToolCall("record_analysis", {
        consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [],
      })]),
      fauxAssistantMessage("synthesized"),
    ]);

    const cfg = baseConfig();
    const result = await runFusion({
      prompt: "p",
      persona: "does-not-exist",
      config: cfg,
      db,
      secretsPath: join(home, "secrets.enc"),
      keyPath: join(home, "master.key"),
    });
    // FR-008: never errors.
    expect(result.ok).toBe(true);

    const row = getActivity(db, result.activityId!);
    expect(row?.persona).toBe("generalist");
    expect(row?.persona_source).toBe("invalid-fallback");

    wreg.unregister();
    jreg.unregister();
  });
});
