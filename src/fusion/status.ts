// In-memory live fusion-engine status registry (feature 007, research R-004).
//
// The process-singleton the dashboard polls via GET /api/runtime to show idle /
// in-progress (mode-aware) / queued state. runFusion enters on start, updates per
// candidate (serial mode), and leaves in a `finally` on EVERY terminal path (INV-3 —
// a stuck "in-progress" is the one bug that makes the surface worse than useless).
//
// Ephemeral by design: nothing persisted (lost on restart is fine — it describes the
// present moment; the activity log is the durable record). Never exposes content —
// only counts, indices, ids, startedAt.
import type { ExecutionMode } from "../config/schema.js";

export type RuntimeState = "idle" | "in-progress" | "queued";

export interface ActiveFusion {
  activityId: string;
  mode: ExecutionMode;
  candidateCount: number;
  /** Sequential only: which candidate is currently running (1-indexed). Omitted in parallel. */
  candidateIndex?: number;
  /** Sequential: how many resolved. Parallel: how many responding so far. */
  candidatesDone?: number;
  /** Epoch ms — when the fusion entered the registry. */
  startedAt: number;
}

export interface FusionRuntimeStatus {
  state: RuntimeState;
  /** Always present (possibly empty). One entry per entered-but-not-yet-left fusion. */
  fusions: ActiveFusion[];
}

interface RegistryEntry extends ActiveFusion {}

/**
 * Process-singleton. Module-level state is appropriate here (one Node process,
// Constitution VII); the entry set is small (one per in-flight fusion).
 */
class FusionStatusRegistry {
  private entries = new Map<string, RegistryEntry>();

  /** Called at the top of runFusion, after the gate + activity row allocation. */
  enter(activityId: string, mode: ExecutionMode, candidateCount: number): void {
    this.entries.set(activityId, { activityId, mode, candidateCount, startedAt: Date.now() });
  }

  /** Per-candidate (serial) or once at fan-out start (parallel). No-op if unknown id. */
  update(activityId: string, patch: Partial<Pick<RegistryEntry, "candidateIndex" | "candidatesDone">>): void {
    const e = this.entries.get(activityId);
    if (!e) return;
    if (patch.candidateIndex !== undefined) e.candidateIndex = patch.candidateIndex;
    if (patch.candidatesDone !== undefined) e.candidatesDone = patch.candidatesDone;
  }

  /**
   * Called in a `finally` wrapping runFusion's body — EVERY terminal path (success,
   * partial, error, throw) must reach here. Idempotent (safe to call twice / for an
   * unknown id) so a double-clear on an edge path can't throw.
   */
  leave(activityId: string): void {
    this.entries.delete(activityId);
  }

  /** Derives `state`: idle if empty; queued if >1 active (R-005 — no real queue); else in-progress. */
  getSnapshot(): FusionRuntimeStatus {
    const fusions = [...this.entries.values()];
    const state: RuntimeState =
      fusions.length === 0 ? "idle" : fusions.length > 1 ? "queued" : "in-progress";
    return { state, fusions };
  }
}

export const fusionStatusRegistry = new FusionStatusRegistry();
