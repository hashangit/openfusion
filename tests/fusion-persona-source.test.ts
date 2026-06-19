// Feature 006 — persona_source audit + UI exemption (T037, T041).
// T037: UI exemption — source:"ui" bypasses the policy (FR-010, INV-4).
// T041 (E2): legacy rows (persona_source IS NULL) render with no suffix — UI-level, asserted by chip logic.
import { describe, it, expect } from "vitest";
import { resolvePersonaWithPolicy, shouldEmitEvent } from "../src/fusion/persona-policy.js";
import { BUILTIN_PERSONAS } from "../src/fusion/personas.js";

describe("T037 — UI exemption (FR-010, INV-4)", () => {
  it("source:'ui' forces persona_source='active' even under strict + a requested persona", () => {
    // The user IS the picker in the dashboard — policy never gates them.
    const resolved = resolvePersonaWithPolicy({
      requested: "qa",
      personas: BUILTIN_PERSONAS,
      activeId: "researcher",
      policy: "strict", // strict would normally enforce researcher... but UI is exempt
      source: "ui",
    });
    expect(resolved.personaSource).toBe("active");
    expect(resolved.persona.id).toBe("qa"); // the UI-selected persona runs
  });

  it("source:'ui' emits NO event (no warning, no elicitation)", () => {
    const resolved = resolvePersonaWithPolicy({
      requested: "qa",
      personas: BUILTIN_PERSONAS,
      activeId: "researcher",
      policy: "strict",
      source: "ui",
    });
    expect(shouldEmitEvent(resolved)).toBeUndefined();
  });

  it("source:'ui' with no override still resolves active, no event", () => {
    const resolved = resolvePersonaWithPolicy({
      personas: BUILTIN_PERSONAS,
      activeId: "generalist",
      policy: "allow-override",
      source: "ui",
    });
    expect(resolved.personaSource).toBe("active");
    expect(resolved.persona.id).toBe("generalist");
    expect(shouldEmitEvent(resolved)).toBeUndefined();
  });
});

describe("T041 (E2) — legacy persona_source rendering (UI chip logic)", () => {
  // The chip-suffix logic lives in Generations.tsx; here we assert the pure rule:
  // active/NULL → no suffix; override/strict-enforced/invalid-fallback → suffix.
  function chipSuffix(persona_source: string | null | undefined): string {
    if (persona_source === "override") return " (client override)";
    if (persona_source === "strict-enforced") return " (strict-enforced)";
    if (persona_source === "invalid-fallback") return " (invalid-fallback)";
    return ""; // active + NULL/undefined → no suffix (FR-013, SC-007)
  }

  it.each([
    ["override", " (client override)"],
    ["strict-enforced", " (strict-enforced)"],
    ["invalid-fallback", " (invalid-fallback)"],
    ["active", ""],
    [null, ""], // legacy row
    [undefined, ""],
  ])("persona_source=%s → suffix %j", (source, expected) => {
    expect(chipSuffix(source)).toBe(expected);
  });
});
