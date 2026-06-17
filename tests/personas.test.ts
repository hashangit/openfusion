// Persona resolution + v2->v3 migration tests.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePersona, BUILTIN_PERSONAS, getBuiltin, DEFAULT_PERSONA_ID } from "../src/fusion/personas.js";
import { loadConfig } from "../src/config/store.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-persona-"));
  process.env.OPENFUSION_HOME = home;
});

describe("resolvePersona", () => {
  it("uses the per-call override when present (by id or name)", () => {
    const p = resolvePersona({ override: "qa", personas: BUILTIN_PERSONAS, activeId: "generalist" });
    expect(p.id).toBe("qa");

    const byName = resolvePersona({ override: "Researcher", personas: BUILTIN_PERSONAS });
    expect(byName.id).toBe("researcher");
  });

  it("falls back to the active persona when no override", () => {
    const p = resolvePersona({ personas: BUILTIN_PERSONAS, activeId: "pm" });
    expect(p.id).toBe("pm");
  });

  it("falls back to generalist, then first available, when nothing matches", () => {
    expect(resolvePersona({ personas: BUILTIN_PERSONAS }).id).toBe(DEFAULT_PERSONA_ID);
    // Unknown override + empty-ish list -> generalist builtin.
    expect(resolvePersona({ override: "nope", personas: [], activeId: undefined }).id).toBe(DEFAULT_PERSONA_ID);
  });

  it("every builtin has non-empty worker/analysis/synthesis prompts", () => {
    for (const p of BUILTIN_PERSONAS) {
      expect(p.workerPrompt.length).toBeGreaterThan(20);
      expect(p.analysisPrompt.length).toBeGreaterThan(20);
      expect(p.synthesisPrompt.length).toBeGreaterThan(20);
      expect(p.analysisPrompt.toLowerCase()).toMatch(/record_analysis|tool/); // forces the tool call
    }
  });

  it("getBuiltin returns the shipped default for a reset", () => {
    const qa = getBuiltin("qa");
    expect(qa?.id).toBe("qa");
    expect(getBuiltin("nonexistent")).toBeUndefined();
  });
});

describe("config v2 -> v3 migration", () => {
  it("injects builtin personas + sets activePersona on a v2 config with no personas", () => {
    const v2 = {
      version: 2,
      candidates: [{ id: "c1", provider: "p", model: "m", enabled: true }],
      judges: [{ provider: "p", model: "m", enabled: true }],
      settings: { workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
    };
    writeFileSync(join(home, "config.json"), JSON.stringify(v2));
    const loaded = loadConfig();
    expect(loaded.personas.length).toBeGreaterThanOrEqual(BUILTIN_PERSONAS.length);
    expect(loaded.personas.map((p) => p.id)).toContain("generalist");
    expect(loaded.personas.map((p) => p.id)).toContain("qa");
    expect(loaded.settings.activePersona).toBe("generalist");
  });

  it("preserves a user-authored persona through migration", () => {
    const custom = {
      id: "custom-1",
      name: "My Persona",
      workerPrompt: "be terse",
      analysisPrompt: "analyze tersely",
      synthesisPrompt: "synthesize tersely",
    };
    const v3partial = {
      version: 3,
      candidates: [],
      judges: [],
      personas: [custom],
      settings: { workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
    };
    writeFileSync(join(home, "config.json"), JSON.stringify(v3partial));
    const loaded = loadConfig();
    expect(loaded.personas.map((p) => p.id)).toContain("custom-1");
    // builtins still merged in on read via the store (migrate leaves existing personas intact)
    expect(loaded.settings.activePersona).toBe("generalist");
  });
});
