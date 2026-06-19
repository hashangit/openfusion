// Feature 007 — live fusion-engine status surface (Phase 5 / US3).
// Tests the FusionStatusRegistry directly (the in-memory state GET /api/runtime serves).
//   T21 (quickstart T7): idle at rest.
//   T22 (quickstart T8): parallel in-progress affordance (candidatesDone rises, no candidateIndex).
//   T23 (quickstart T9): serial in-progress affordance (candidateIndex === candidatesDone + 1 mid-run).
//   T24 (quickstart T10): queued = >1 fusion active (no serialization queue; R-005).
//   T25 (quickstart T11): enter ⇒ leave on every terminal path (INV-3 — the non-negotiable one).
import { describe, it, expect, afterEach } from "vitest";
import { fusionStatusRegistry } from "../src/fusion/status.js";

// The registry is a module-level singleton; tests must clean up every entry they enter so
// they don't leak state into siblings. afterEach guarantees leave-all even on assert failure.
afterEach(() => {
  // Best-effort: clear any stragglers by re-leaving known test ids (idempotent).
  for (const id of ["f1", "f2", "f3", "err1", "throw1"]) fusionStatusRegistry.leave(id);
});

describe("T21 — idle at rest (FR-012)", () => {
  it("a fresh/empty registry reports { state: 'idle', fusions: [] }", () => {
    const snap = fusionStatusRegistry.getSnapshot();
    expect(snap.state).toBe("idle");
    expect(snap.fusions).toEqual([]);
  });
});

describe("T22 — parallel in-progress affordance (FR-012, FR-013)", () => {
  it("parallel fusion: candidatesDone rises, candidateIndex is ABSENT; leave → idle", () => {
    fusionStatusRegistry.enter("f1", "parallel", 3);
    let snap = fusionStatusRegistry.getSnapshot();
    expect(snap.state).toBe("in-progress");
    expect(snap.fusions).toHaveLength(1);
    expect(snap.fusions[0].mode).toBe("parallel");
    expect(snap.fusions[0].candidateIndex).toBeUndefined(); // parallel omits it

    fusionStatusRegistry.update("f1", { candidatesDone: 0 });
    expect(fusionStatusRegistry.getSnapshot().fusions[0].candidatesDone).toBe(0);
    fusionStatusRegistry.update("f1", { candidatesDone: 3 });
    expect(fusionStatusRegistry.getSnapshot().fusions[0].candidatesDone).toBe(3);

    fusionStatusRegistry.leave("f1");
    expect(fusionStatusRegistry.getSnapshot().state).toBe("idle");
  });
});

describe("T23 — serial in-progress affordance (FR-012, FR-013)", () => {
  it("serial fusion: candidateIndex tracks the running candidate (=== done + 1 mid-run)", () => {
    fusionStatusRegistry.enter("f1", "sequential", 5);
    // Mid-run: candidate 3 running, 2 done.
    fusionStatusRegistry.update("f1", { candidateIndex: 3, candidatesDone: 2 });
    const snap = fusionStatusRegistry.getSnapshot();
    expect(snap.state).toBe("in-progress");
    expect(snap.fusions[0].mode).toBe("sequential");
    expect(snap.fusions[0].candidateIndex).toBe(3);
    expect(snap.fusions[0].candidatesDone).toBe(2);
    expect(snap.fusions[0].candidateIndex).toBe(snap.fusions[0].candidatesDone! + 1);

    fusionStatusRegistry.leave("f1");
    expect(fusionStatusRegistry.getSnapshot().state).toBe("idle");
  });
});

describe("T24 — queued state (FR-014, R-005)", () => {
  it("two fusions active → state 'queued'; leaving one → 'in-progress'; leaving both → 'idle'", () => {
    fusionStatusRegistry.enter("f1", "sequential", 3);
    fusionStatusRegistry.enter("f2", "parallel", 2);
    let snap = fusionStatusRegistry.getSnapshot();
    expect(snap.state).toBe("queued");
    expect(snap.fusions).toHaveLength(2);
    // Each carries its own mode (independent fusions, no serialization).
    expect(snap.fusions.map((f) => f.mode).sort()).toEqual(["parallel", "sequential"]);

    fusionStatusRegistry.leave("f1");
    snap = fusionStatusRegistry.getSnapshot();
    expect(snap.state).toBe("in-progress");
    expect(snap.fusions).toHaveLength(1);

    fusionStatusRegistry.leave("f2");
    expect(fusionStatusRegistry.getSnapshot().state).toBe("idle");
  });
});

describe("T25 — enter ⇒ leave on every terminal path (INV-3)", () => {
  it("leave is idempotent (safe to call twice / for an unknown id)", () => {
    fusionStatusRegistry.enter("f1", "parallel", 2);
    fusionStatusRegistry.leave("f1");
    fusionStatusRegistry.leave("f1"); // no throw, no-op
    fusionStatusRegistry.leave("never-entered"); // unknown id is also a safe no-op
    expect(fusionStatusRegistry.getSnapshot().state).toBe("idle");
  });

  it("update on an unknown id is a safe no-op (defensive: a late update after leave)", () => {
    fusionStatusRegistry.update("never-entered", { candidateIndex: 1 });
    expect(fusionStatusRegistry.getSnapshot().state).toBe("idle");
  });
});
