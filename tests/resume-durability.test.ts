// Feature 008 — US3 durability tests (quickstart T10-T12).
//
// Covers the restart-resilience surface that distinguishes the durable `_resume_from` path
// from feature 005's non-durable Tasks path:
//   T10/T15  a processing row from a previous process is swept to interrupted at boot, and a
//            retrieval returns the interrupted shape (NOT a hang, NOT a stale processing result)
//   T11/T16  the stalled circuit reclassifies a processing row with stale last_progress_at to
//            error/stalled on read, so a hung fusion can't empty long-poll forever (FR-012)
//   T12/T17  the write-late guard extends expires_at for a processing row near eviction, so a
//            late completion stores its result rather than landing as expired (FR-011)
//
// Strategy: use the real createMcpServer + InMemoryTransport so the startup sweep runs for
// real, but simulate "previous process" by writing fusion_jobs rows directly + using a fresh
// server boot (the sweep fires in createMcpServer). The unit-level invariants are already
// locked in resume-store.test.ts; here we verify the WIRING (sweep runs at boot, retrieval
// surfaces the right shape).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server/mcp-server.js";
import { openDatabase } from "../src/store/db.js";
import { saveConfig } from "../src/config/store.js";
import { saveSecrets } from "../src/config/secrets.js";
import { generateMasterKey } from "../src/config/crypto.js";
import { recordActivity } from "../src/store/activity.js";
import { kickoffJob, markTerminal, RESUME_STALL_MS, RESUME_TTL_MS, _clearWaitersForTests } from "../src/fusion/resume-store.js";
import { drainTasks } from "../src/fusion/task-runner.js";
import type { DB } from "../src/store/db.js";

let home: string;
let db: DB;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-resume-dur-"));
  process.env.OPENFUSION_HOME = home;
  db = openDatabase(join(home, "test.db"));
  writeFileSync(join(home, "master.key"), generateMasterKey(), { mode: 0o600 });
  // Minimal valid config so createMcpServer boots cleanly.
  saveSecrets(
    { providers: { "faux-fusion": { apiKey: "k" }, "faux-judge": { apiKey: "k" } } },
    join(home, "secrets.enc"),
    join(home, "master.key"),
  );
  saveConfig({
    version: 2,
    candidates: [
      { id: "c1", provider: "faux-fusion", model: "w1", enabled: true },
      { id: "c2", provider: "faux-fusion", model: "w1", enabled: true },
    ],
    judges: [{ provider: "faux-judge", model: "j1", enabled: true }],
    settings: { workerTimeoutMs: 30_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false },
  });
});
afterEach(async () => {
  await drainTasks();
  _clearWaitersForTests();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

/** Boot a non-Tasks client against a fresh server (the startup sweep runs in createMcpServer). */
async function boot() {
  const server = await createMcpServer({ db, openBrowserOnNeedsConfig: false });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client({ name: "test-dur", version: "0.0.0" }, { capabilities: {} });
  await client.connect(cT);
  const close = async () => {
    await drainTasks();
    client.close();
    server.close();
  };
  return { server, client, close };
}

/** Write a processing fusion_jobs row simulating an in-flight fusion from a previous process. */
function seedOrphanProcessing(activityId: string, executionMode: "parallel" | "sequential" = "parallel"): void {
  recordActivity(db, { id: activityId, candidate_count: 2, survivor_count: 0, status: "running" });
  kickoffJob(db, { activityId, executionMode, etaMs: null });
  // Force created_at into the past so the startup sweep (created_at < bootTime) reliably catches
  // it even if bootTime resolves to the same millisecond (ISO string `<` is exact-match false).
  const past = new Date(Date.now() - 60_000).toISOString();
  db.prepare("UPDATE fusion_jobs SET created_at = ? WHERE activity_id = ?").run(past, activityId);
}

describe("T015/T10 — startup sweep reclassifies orphans; retrieval surfaces interrupted (FR-009)", () => {
  it("a processing row from a previous process is interrupted after boot; retrieval returns the interrupted shape", async () => {
    // Simulate a previous process that started a fusion then died.
    seedOrphanProcessing("orphan-1");
    expect(db.prepare("SELECT status FROM fusion_jobs WHERE activity_id = ?").get("orphan-1")).toEqual({ status: "processing" });

    // Boot a fresh server — the startup sweep fires in createMcpServer.
    const { client, close } = await boot();
    try {
      // The orphan is now interrupted.
      expect(db.prepare("SELECT status FROM fusion_jobs WHERE activity_id = ?").get("orphan-1")).toEqual({ status: "interrupted" });

      // Retrieval returns the interrupted shape (NOT processing, NOT a hang).
      const res = (await client.callTool({ name: "fusion", arguments: { _resume_from: "orphan-1" } })) as {
        content: { text: string }[];
      };
      expect(res.content[0].text).toMatch(/interrupted by a server restart/i);
      expect(res.content[0].text).toMatch(/re-run fusion/i);
    } finally {
      await close();
    }
  });

  it("the sweep is safe on a fresh DB (no rows → 0 interrupted; no error)", async () => {
    const { close } = await boot();
    try {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM fusion_jobs WHERE status = 'interrupted'").get() as { n: number }).n;
      expect(n).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("T016/T11 — stalled circuit reclassifies a hung fusion (FR-012)", () => {
  it("a processing row whose last_progress_at is stale returns error/stalled on retrieval", async () => {
    // Boot FIRST, then seed the hung row. If we seed before boot, the startup sweep
    // (created_at < bootTime) reclassifies the row to interrupted before the stalled circuit
    // gets a chance to fire. Seeding after boot means created_at > bootTime → sweep skips it,
    // and the stalled circuit (last_progress_at stale beyond stall_threshold_ms) fires on read.
    const { client, close } = await boot();
    try {
      recordActivity(db, { id: "hung-1", candidate_count: 2, survivor_count: 0, status: "running" });
      // stall_threshold_ms defaults to RESUME_STALL_MS (5min) when omitted.
      kickoffJob(db, { activityId: "hung-1", executionMode: "parallel", etaMs: null });
      const stale = new Date(Date.now() - (RESUME_STALL_MS + 5_000)).toISOString();
      db.prepare("UPDATE fusion_jobs SET last_progress_at = ? WHERE activity_id = ?").run(stale, "hung-1");

      const res = (await client.callTool({ name: "fusion", arguments: { _resume_from: "hung-1" } })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      // The stalled circuit fired on read → error/stalled shape.
      expect(res.content[0].text).toMatch(/stalled|did not complete/i);
      // The row was reclassified through to error.
      const job = db.prepare("SELECT status, error_kind FROM fusion_jobs WHERE activity_id = ?").get("hung-1") as
        | { status: string; error_kind: string | null }
        | undefined;
      expect(job?.status).toBe("error");
      expect(job?.error_kind).toBe("stalled");
    } finally {
      await close();
    }
  });
});

describe("T017/T12 — write-late guard stores a late completion (FR-011)", () => {
  it("a processing row near expiry, when markTerminal fires, lands as completed (NOT expired)", async () => {
    seedOrphanProcessing("late-1");
    // Push the row to the edge of TTL eviction.
    const edge = new Date(Date.now() + 1_000).toISOString();
    db.prepare("UPDATE fusion_jobs SET expires_at = ? WHERE activity_id = ?").run(edge, "late-1");

    // A late completion arrives (the runner finally calls markTerminal).
    markTerminal(db, "late-1", { ok: true, result: "late but stored" });

    // The write-late guard extended expires_at before the terminal write, so the row is
    // completed — NOT expired by a concurrent TTL read.
    const job = db.prepare("SELECT status, result, expires_at FROM fusion_jobs WHERE activity_id = ?").get("late-1") as
      | { status: string; result: string | null; expires_at: string }
      | undefined;
    expect(job?.status).toBe("completed");
    expect(job?.result).toBe("late but stored");
    // expires_at was pushed out beyond the edge.
    expect(Date.parse(job!.expires_at)).toBeGreaterThan(Date.now());
  });

  it("a completed row past expires_at is expired by the TTL sweep (FR-008)", async () => {
    seedOrphanProcessing("aged-1");
    markTerminal(db, "aged-1", { ok: true, result: "old answer" });
    // Force the completed row past its TTL.
    db.prepare("UPDATE fusion_jobs SET expires_at = ? WHERE activity_id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      "aged-1",
    );
    const { sweepExpired } = await import("../src/fusion/resume-store.js");
    const n = sweepExpired(db);
    expect(n).toBe(1);
    const job = db.prepare("SELECT status FROM fusion_jobs WHERE activity_id = ?").get("aged-1") as { status: string };
    expect(job.status).toBe("expired");
  });
});

describe("T017 — TTL window sanity (RESUME_TTL_MS)", () => {
  it("RESUME_TTL_MS is 30 minutes (generous for sequential/benchmark jobs; research R-006)", () => {
    expect(RESUME_TTL_MS).toBe(1_800_000);
  });
  it("RESUME_STALL_MS is 5 minutes (worst-case stall ≈ workerTimeoutMs × (retries+1))", () => {
    expect(RESUME_STALL_MS).toBe(300_000);
  });
});
