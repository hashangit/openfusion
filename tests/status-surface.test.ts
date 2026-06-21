// Feature 007 — live fusion-engine status surface (Phase 5 / US3).
// Tests the FusionStatusRegistry directly (the in-memory state GET /api/runtime serves).
//   T21 (quickstart T7): idle at rest.
//   T22 (quickstart T8): parallel in-progress affordance (candidatesDone rises, no candidateIndex).
//   T23 (quickstart T9): serial in-progress affordance (candidateIndex === candidatesDone + 1 mid-run).
//   T24 (quickstart T10): queued = >1 fusion active (no serialization queue; R-005).
//   T25 (quickstart T11): enter ⇒ leave on every terminal path (INV-3 — the non-negotiable one).
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { fusionStatusRegistry } from "../src/fusion/status.js";
import { runtimeRouter } from "../src/server/api/runtime.js";
import { openDatabase } from "../src/store/db.js";
import { allocateActivity } from "../src/store/activity.js";
import type { DB } from "../src/store/db.js";

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

describe("T27 — phase advances fan-out → analysis → synthesis", () => {
  it("enter defaults phase to fan-out; update advances it through the phases", () => {
    fusionStatusRegistry.enter("f1", "parallel", 3);
    // enter sets phase fan-out
    let snap = fusionStatusRegistry.getSnapshot();
    expect(snap.fusions[0].phase).toBe("fan-out");

    // analysis boundary
    fusionStatusRegistry.update("f1", { phase: "analysis" });
    snap = fusionStatusRegistry.getSnapshot();
    expect(snap.fusions[0].phase).toBe("analysis");

    // synthesis boundary
    fusionStatusRegistry.update("f1", { phase: "synthesis" });
    snap = fusionStatusRegistry.getSnapshot();
    expect(snap.fusions[0].phase).toBe("synthesis");

    fusionStatusRegistry.leave("f1");
  });

  it("phase update on an unknown id is a no-op (no throw)", () => {
    fusionStatusRegistry.update("never-entered", { phase: "analysis" });
    expect(fusionStatusRegistry.getSnapshot().state).toBe("idle");
  });
});

// Cross-process regression: the dashboard process and the fusion process are often DIFFERENT
// Node processes sharing one OPENFUSION_HOME (hence one DB). The in-process registry only
// sees same-process fusions; the DB's status='running' rows are the cross-process floor.
// Bug was: /api/runtime returned idle while a fusion ran in another process, because it read
// only the (empty) registry. Fix: merge DB running-rows into the snapshot.
describe("T26 — /api/runtime sees DB-running fusions even with an empty registry (cross-process)", () => {
  let home: string;
  let db: DB;
  let restoreHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "of-runtime-xproc-"));
    restoreHome = process.env.OPENFUSION_HOME;
    process.env.OPENFUSION_HOME = home;
    db = openDatabase(join(home, "t.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (restoreHome === undefined) delete process.env.OPENFUSION_HOME;
    else process.env.OPENFUSION_HOME = restoreHome;
  });

  /** Boot runtimeRouter(db) on a real port and GET /api/runtime. */
  async function getRuntime(): Promise<{ state: string; fusions: { activityId: string; mode: string; candidateCount: number; phase?: string }[] }> {
    const app = express();
    app.use(express.json());
    app.use("/api/runtime", runtimeRouter(db));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runtime`);
      return (await res.json()) as { state: string; fusions: { activityId: string; mode: string; candidateCount: number }[] };
    } finally {
      server.close();
    }
  }

  it("a DB status='running' row → state='in-progress' even when the in-process registry is empty", async () => {
    // Simulate a fusion running in ANOTHER process: it allocated an activity row (status
    // 'running') in the shared DB, but never entered THIS process's registry.
    const id = allocateActivity(db, { candidate_count: 3, survivor_count: 0 });
    // Registry deliberately empty — this process didn't run the fusion.
    expect(fusionStatusRegistry.getSnapshot().fusions).toHaveLength(0);

    const body = await getRuntime();
    expect(body.state).toBe("in-progress");
    expect(body.fusions).toHaveLength(1);
    expect(body.fusions[0].activityId).toBe(id);
    expect(body.fusions[0].candidateCount).toBe(3);
    expect(body.fusions[0].mode).toBe("parallel"); // defaulted — executionMode not persisted on the row
    expect(body.fusions[0].phase).toBeUndefined(); // phase is same-process only; DB-only entry can't know it
  });

  it("two DB running rows → state='queued'", async () => {
    allocateActivity(db, { candidate_count: 2, survivor_count: 0 });
    allocateActivity(db, { candidate_count: 4, survivor_count: 0 });
    const body = await getRuntime();
    expect(body.state).toBe("queued");
    expect(body.fusions).toHaveLength(2);
  });

  it("no running rows + empty registry → state='idle'", async () => {
    const body = await getRuntime();
    expect(body.state).toBe("idle");
    expect(body.fusions).toHaveLength(0);
  });
});
