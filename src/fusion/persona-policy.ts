// Feature 006 — Persona policy: resolve which persona runs + WHY (audit).
//
// `resolvePersonaWithPolicy` wraps the existing `resolvePersona` (which never throws
// and degrades gracefully) with a policy gate. It classifies the resolution into one
// of four `PersonaSource` values recorded on the activity row for auditability.
//
// This module is PURE: no transport concerns, no elicitation. The transport layer
// (mcp-server.ts) wires the optional `onPersonaEvent` callback to emit warnings +
// elicit relax-strict prompts; this module just decides + signals.
//
// See specs/006-persona-discovery/{research.md R-001..R-011, data-model.md, contracts/}.
import { resolvePersona, type Persona } from "./personas.js";
import type { PersonaPolicy } from "../config/schema.js";

/** How the persona for a fusion was chosen. Stored on activities.persona_source (nullable for legacy). */
export type PersonaSource = "active" | "override" | "strict-enforced" | "invalid-fallback";

/**
 * Engine→transport signal for persona-policy events. The MCP layer translates:
 *  - `warning`            → notifications/message (always emitted for strict-enforced + invalid-fallback)
 *  - `elicitation-request` → elicitation/create form (only when client supports elicitation.form)
 */
export type PersonaEvent =
  | { kind: "warning"; source: PersonaSource; requested?: string; used: string }
  | { kind: "elicitation-request"; requested: string; used: string };

/**
 * The transport's response to an elicitation-request. `runFusion` honors it:
 *  - "relax"      → run the requested persona this call (source flips to "override")
 *  - "keep-strict" → run the active persona (source "strict-enforced")
 *  - undefined    → no callback / no elicitation capability → proceed strict-enforced
 *
 * Canonical enum — identical to SessionOverrideState.decision + the elicitation form
 * `choice` field. There is NO "keep" shorthand (F1 remediation).
 */
export type PersonaEventResult = "relax" | "keep-strict" | undefined;

export interface ResolveArgs {
  /** The persona id/name the caller requested (may be invalid). */
  requested?: string;
  personas: Persona[];
  activeId?: string;
  policy: PersonaPolicy;
  /** Where this call originated. "ui" bypasses the policy entirely (the user is the picker). */
  source: "mcp" | "ui";
}

export interface ResolvedPersona {
  persona: Persona;
  /** Audit reason — recorded on activities.persona_source. */
  personaSource: PersonaSource;
  /** The id the caller requested (for the warning payload); undefined if no override requested. */
  requestedId?: string;
}

/**
 * Resolve the persona + classify the resolution. Pure: no side effects, no transport.
 *
 * Decision matrix (see data-model.md state-transition diagram):
 *   source==="ui"                                   → "active"        (policy never consulted)
 *   no requested override                           → "active"
 *   requested resolves + policy "allow-override"    → "override"
 *   requested resolves + policy "strict"            → "strict-enforced"
 *     (the caller may still get "override" if the transport elicits + user relaxes;
 *      that flip happens in runFusion based on the PersonaEventResult, not here)
 *   requested does NOT resolve (invalid id)         → "invalid-fallback"
 *
 * Never throws — mirrors resolvePersona's contract (Constitution III).
 */
export function resolvePersonaWithPolicy(args: ResolveArgs): ResolvedPersona {
  const { requested, personas, activeId, policy, source } = args;

  // UI calls: the user is the picker. Always "active", policy never consulted (FR-010, INV-4).
  if (source === "ui") {
    const persona = resolvePersona({ override: requested, personas, activeId });
    return { persona, personaSource: "active", requestedId: requested };
  }

  // No override requested → the active persona runs.
  if (!requested) {
    const persona = resolvePersona({ personas, activeId });
    return { persona, personaSource: "active" };
  }

  // Does the requested id/name resolve to a real persona?
  const requestedPersona = personas.find(
    (p) => p.id === requested || p.name.toLowerCase() === requested.toLowerCase(),
  );

  if (!requestedPersona) {
    // Invalid id — graceful fallback to active (never throws). Made visible via the audit
    // field + warning (FR-008).
    const persona = resolvePersona({ personas, activeId });
    return { persona, personaSource: "invalid-fallback", requestedId: requested };
  }

  // Valid request. Under strict policy, the active persona runs (unless the transport elicits
  // a relax opt-in — handled in runFusion via the callback return). Under allow-override, the
  // requested persona runs.
  if (policy === "strict") {
    const persona = resolvePersona({ personas, activeId });
    return { persona, personaSource: "strict-enforced", requestedId: requested };
  }

  return { persona: requestedPersona, personaSource: "override", requestedId: requested };
}

/**
 * Decide whether `runFusion` should emit a persona event for this resolution.
 * Warnings fire for strict-enforced + invalid-fallback. Elicitation requests fire
 * only for strict-enforced (invalid ids don't warrant a relax prompt — the id was wrong).
 */
export function shouldEmitEvent(resolved: ResolvedPersona): PersonaEvent | undefined {
  if (resolved.personaSource === "strict-enforced") {
    return {
      kind: "elicitation-request",
      requested: resolved.requestedId!,
      used: resolved.persona.id,
    };
  }
  if (resolved.personaSource === "invalid-fallback") {
    return {
      kind: "warning",
      source: "invalid-fallback",
      requested: resolved.requestedId,
      used: resolved.persona.id,
    };
  }
  return undefined;
}

// ─── Session relax-strict state (feature 006, FR-006, SC-004) ───────────────────
//
// Per-stdio-session singleton tracking whether the user has opted to relax strict mode
// for this session. Stdio = one client per process, so one global state object is
// correct (research.md R-007). The decision is in-memory only — NEVER persisted to
// config.json (would silently flip the user's global setting; INV-5).
//
// Concurrency contract (SC-004): the FIRST strict-enforcement call under elicitation
// triggers exactly one prompt; concurrent + subsequent calls await/share the result.

export interface SessionOverrideState {
  /** undefined = not yet asked; "relax" | "keep-strict" once decided. */
  decision?: "relax" | "keep-strict";
  /** Shared in-flight promise: concurrent callers await this rather than re-prompting. */
  inflight?: Promise<"relax" | "keep-strict">;
}

/** The session singleton (module-scoped). Cleared only by process restart. */
let sessionOverride: SessionOverrideState = {};

/**
 * Ask the user whether to relax strict mode for this session, deduping across
 * concurrent + subsequent callers via a shared in-flight promise (SC-004).
 *
 * @param elicit a function that sends the elicitation and resolves to the user's choice.
 *               Reject/timeout should be caught by the caller and treated as "keep-strict".
 * @returns the session decision ("relax" or "keep-strict").
 */
export async function askRelaxStrict(
  elicit: () => Promise<"relax" | "keep-strict">,
): Promise<"relax" | "keep-strict"> {
  // Already decided this session → return immediately (no re-prompt).
  if (sessionOverride.decision) return sessionOverride.decision;
  // Another caller is mid-elicitation → await the same promise (no duplicate prompt).
  if (sessionOverride.inflight) return sessionOverride.inflight;
  // First caller — fire the elicitation, share the promise.
  const p = elicit()
    .then((answer) => {
      sessionOverride.decision = answer;
      return answer;
    })
    .catch(() => {
      // Reject/timeout → treat as keep-strict, and lock it so we don't re-prompt.
      sessionOverride.decision = "keep-strict";
      return "keep-strict" as const;
    })
    .finally(() => {
      sessionOverride.inflight = undefined;
    });
  sessionOverride.inflight = p;
  return p;
}

/** Reset the session state (used by tests + on a fresh server process). */
export function resetSessionOverride(): void {
  sessionOverride = {};
}
