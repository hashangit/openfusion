// Regression test: incremental config saves must work even when the partial
// config is incomplete (e.g. saving Candidates before a Judge is chosen).
// Constitution VI gates completeness at fusion time, NOT at save time.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAndValidate, saveConfig, loadConfig } from "../src/config/store.js";
import { isConfigured } from "../src/config/completeness.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-cfg-"));
  process.env.OPENFUSION_HOME = home;
});

describe("mergeAndValidate: incremental setup", () => {
  it("accepts a Candidates-only save (no judge yet)", () => {
    const merged = mergeAndValidate(loadConfig(), {
      candidates: [
        { id: "c1", provider: "openai", model: "gpt-4o-mini", enabled: true },
        { id: "c2", provider: "anthropic", model: "claude-3-5-sonnet-latest", enabled: true },
      ],
    });
    expect(merged.candidates.length).toBe(2);
    expect(merged.judges).toEqual([]); // not configured yet
    expect(isConfigured(merged).configured).toBe(false); // missing judge
  });

  it("accepts a Judge-only save onto an existing candidates config", () => {
    saveConfig({
      version: 2,
      candidates: [
        { id: "c1", provider: "openai", model: "gpt-4o-mini", enabled: true },
        { id: "c2", provider: "anthropic", model: "claude-3-5-sonnet-latest", enabled: true },
      ],
      judges: [],
      settings: { workerTimeoutMs: 120_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
    });
    const merged = mergeAndValidate(loadConfig(), {
      judges: [{ provider: "anthropic", model: "claude-3-5-sonnet-latest", enabled: true }],
    });
    // Candidates preserved from base; judge now present.
    expect(merged.candidates.length).toBe(2);
    expect(merged.judges).toEqual([{ provider: "anthropic", model: "claude-3-5-sonnet-latest", enabled: true }]);
  });

  it("allows >5 candidates in the schema (benchmark mode), but isConfigured flags it unless benchmark", () => {
    // The schema is lenient (benchmark mode legitimately enables 6+ candidates).
    const merged = mergeAndValidate(loadConfig(), {
      candidates: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, provider: "p", model: "m", enabled: true })),
    });
    expect(merged.candidates.length).toBe(6); // accepted by the store
    // But the completeness gate rejects >5 enabled outside benchmark mode.
    expect(isConfigured(merged).configured).toBe(false);
    expect(isConfigured(merged).reasons.some((r) => /at most 5/.test(r))).toBe(true);
    // In benchmark mode the cap is lifted.
    merged.settings.benchmarkMode = true;
    // (Still unconfigured due to no keys, but the >5 reason must be gone.)
    expect(isConfigured(merged).reasons.some((r) => /at most 5/.test(r))).toBe(false);
  });

  it("rejects a malformed candidate slot (missing model)", () => {
    expect(() =>
      mergeAndValidate(loadConfig(), {
        candidates: [{ id: "c1", provider: "openai" }], // no model
      }),
    ).toThrow();
  });

  it("deep-merges settings, preserving unspecified settings fields", () => {
    saveConfig({
      version: 2,
      candidates: [{ id: "c1", provider: "p", model: "m", enabled: true }, { id: "c2", provider: "p", model: "m", enabled: true }],
      judges: [],
      settings: { workerTimeoutMs: 60_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
    });
    const merged = mergeAndValidate(loadConfig(), { settings: { uiPort: 9999 } });
    expect(merged.settings.workerTimeoutMs).toBe(60_000); // preserved
    expect(merged.settings.uiPort).toBe(9999); // overridden
  });

  it("round-trips an incremental save through the store", () => {
    // Step 1: save candidates only (no judge).
    saveConfig(mergeAndValidate(loadConfig(), {
      candidates: [
        { id: "c1", provider: "openai", model: "gpt-4o-mini", enabled: true },
        { id: "c2", provider: "openai", model: "gpt-4o", enabled: true },
      ],
    }));
    // Step 2: save judge only.
    saveConfig(mergeAndValidate(loadConfig(), {
      judges: [{ provider: "anthropic", model: "claude-3-5-sonnet-latest", enabled: true }],
    }));
    const loaded = loadConfig();
    expect(loaded.candidates.length).toBe(2);
    expect(loaded.judges[0]?.provider).toBe("anthropic");
    // Still not "configured" without keys, but structurally complete.
    expect(isConfigured(loaded).reasons).toContainEqual(expect.stringMatching(/missing API key/));
  });

  it("migrates a v1 config (single judge -> judges, backfills candidate.enabled)", () => {
    // Write a v1-shaped config directly to disk.
    const v1 = {
      version: 1,
      candidates: [{ id: "c1", provider: "openai", model: "gpt-4o-mini" }],
      judge: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
      settings: { workerTimeoutMs: 120_000, uiPort: 9077, bind: "127.0.0.1" },
    };
    writeFileSync(join(home, "config.json"), JSON.stringify(v1));
    const loaded = loadConfig();
    // v1 judge mapped to judges[0] with enabled:true
    expect(loaded.judges).toEqual([{ provider: "anthropic", model: "claude-3-5-sonnet-latest", enabled: true }]);
    expect(loaded.judge).toBeUndefined(); // old key removed
    // candidate.enabled backfilled
    expect(loaded.candidates[0].enabled).toBe(true);
    // benchmarkMode defaulted
    expect(loaded.settings.benchmarkMode).toBe(false);
  });
});
