// Regression test: incremental config saves must work even when the partial
// config is incomplete (e.g. saving Candidates before a Judge is chosen).
// Constitution VI gates completeness at fusion time, NOT at save time.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
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
        { id: "c1", provider: "openai", model: "gpt-4o-mini" },
        { id: "c2", provider: "anthropic", model: "claude-3-5-sonnet-latest" },
      ],
    });
    expect(merged.candidates.length).toBe(2);
    expect(merged.judge).toBeUndefined(); // not configured yet
    expect(isConfigured(merged).configured).toBe(false); // missing judge
  });

  it("accepts a Judge-only save onto an existing candidates config", () => {
    saveConfig({
      candidates: [
        { id: "c1", provider: "openai", model: "gpt-4o-mini" },
        { id: "c2", provider: "anthropic", model: "claude-3-5-sonnet-latest" },
      ],
      settings: { workerTimeoutMs: 120_000, uiPort: 9077, bind: "127.0.0.1" },
    });
    const merged = mergeAndValidate(loadConfig(), {
      judge: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
    });
    // Candidates preserved from base; judge now present.
    expect(merged.candidates.length).toBe(2);
    expect(merged.judge).toEqual({ provider: "anthropic", model: "claude-3-5-sonnet-latest" });
  });

  it("rejects more than 5 candidates even when lenient", () => {
    expect(() =>
      mergeAndValidate(loadConfig(), {
        candidates: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, provider: "p", model: "m" })),
      }),
    ).toThrow(/at most 5/);
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
      candidates: [{ id: "c1", provider: "p", model: "m" }, { id: "c2", provider: "p", model: "m" }],
      settings: { workerTimeoutMs: 60_000, uiPort: 9077, bind: "127.0.0.1" },
    });
    const merged = mergeAndValidate(loadConfig(), { settings: { uiPort: 9999 } });
    expect(merged.settings.workerTimeoutMs).toBe(60_000); // preserved
    expect(merged.settings.uiPort).toBe(9999); // overridden
  });

  it("round-trips an incremental save through the store", () => {
    // Step 1: save candidates only (no judge).
    saveConfig(mergeAndValidate(loadConfig(), {
      candidates: [
        { id: "c1", provider: "openai", model: "gpt-4o-mini" },
        { id: "c2", provider: "openai", model: "gpt-4o" },
      ],
    }));
    // Step 2: save judge only.
    saveConfig(mergeAndValidate(loadConfig(), {
      judge: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
    }));
    const loaded = loadConfig();
    expect(loaded.candidates.length).toBe(2);
    expect(loaded.judge?.provider).toBe("anthropic");
    // Still not "configured" without keys, but structurally complete.
    expect(isConfigured(loaded).reasons).toContainEqual(expect.stringMatching(/missing API key/));
  });
});
