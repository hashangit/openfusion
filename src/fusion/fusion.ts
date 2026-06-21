// The fusion orchestrator. Implements the state machine in data-model.md:
// gate -> parallel fan-out -> >=2 survivor check -> judge step 1 (analysis)
// -> judge step 2 (synthesis) -> log -> return.
import { randomUUID } from "node:crypto";
import type { RawConfig } from "../config/schema.js";
import { isConfigured } from "../config/completeness.js";
import { getKey } from "../config/secrets.js";
import { resolveModel, type AnyModel } from "../providers/pi-ai-bridge.js";
import { runParallelFanout, runSequentialFanout } from "./fanout.js";
import type { WorkerResult } from "./worker.js";
import { fusionStatusRegistry } from "./status.js";
import { resolvePersona } from "./personas.js";
import { resolvePersonaWithPolicy, shouldEmitEvent, type PersonaEvent, type PersonaEventResult } from "./persona-policy.js";
import { runAnalysis, runSynthesis, type CandidateView } from "./judge.js";
import { paths } from "../util/paths.js";
import type { DB } from "../store/db.js";
import { recordActivity, recordSubCall, updateActivity } from "../store/activity.js";

export const PROMPT_EXCERPT_LEN = 500;

export type ProgressFn = (progress: number, total: number, message: string) => void;

export interface FusionInput {
  prompt: string;
  context?: string;
  config: RawConfig;
  /** Optional per-call persona override (id or name); defaults to the active persona. */
  persona?: string;
  /**
   * Where this call originated (feature 006). "ui" bypasses the persona policy entirely
   * (the user is the picker) → persona_source is always "active". "mcp" (default) is
   * subject to config.settings.personaPolicy.
   */
  source?: "mcp" | "ui";
  /**
   * Optional engine→transport callback for persona-policy events (feature 006). The MCP
   * layer wires this to emit notifications/message warnings + (when supported) a
   * relax-strict elicitation. Absent on UI calls (no policy to enforce).
   */
  onPersonaEvent?: (e: PersonaEvent) => Promise<PersonaEventResult>;
  /** Injected so tests can swap a temp DB. */
  db: DB;
  /** Injected so tests can point secrets/master.key elsewhere. */
  secretsPath?: string;
  keyPath?: string;
  /** Optional progress callback (MCP tool wires it to notifications/progress). */
  onProgress?: ProgressFn;
  /**
   * Pre-allocated activity row id (task path). When provided, runFusion skips its own
   * activity insert and writes sub_calls / terminal updates against this id. When absent,
   * runFusion allocates the row itself (legacy blocking behavior). Either way the row
   * exists before fan-out, so the FK on sub_calls is satisfied.
   */
  activityId?: string;
}

export interface FusionResult {
  ok: boolean;
  /** The consolidated answer (only when ok). */
  answer?: string;
  /** Human-readable error reason (only when !ok). */
  error?: string;
  /** Whether this fusion is recoverable as a config problem (so callers can direct to setup). */
  needsConfig?: boolean;
  activityId?: string;
  status: "success" | "partial" | "error";
}

/** Run a fusion end-to-end. Never throws; failures are returned as FusionResult. */
export async function runFusion(input: FusionInput): Promise<FusionResult> {
  const report = (p: number, t: number, m: string) => input.onProgress?.(p, t, m);
  const secretsPath = input.secretsPath ?? paths.secrets();
  const keyPath = input.keyPath ?? paths.masterKey();

  // --- Gate (Constitution VI) ---
  const gate = isConfigured(input.config, secretsPath, keyPath);
  if (!gate.configured) {
    return {
      ok: false,
      error: `OpenFusion isn't configured: ${gate.reasons.join("; ")}. Open http://localhost:9077 (or run \`openfusion configure\`) to set up candidates, a judge, and API keys.`,
      needsConfig: true,
      status: "error",
    };
  }

  // Snapshot the config at fusion start (in-flight fusions use their starting config — F5).
  // Only ENABLED candidates fan out; the first ENABLED judge is used.
  const candidates = (input.config.candidates ?? []).filter((c) => c.enabled !== false);
  const judge = (input.config.judges ?? []).find((j) => j.enabled !== false);
  const benchmark = input.config.settings.benchmarkMode === true;
  // Benchmark mode forces a 10-min candidate timeout; the judge always uses the
  // user's configured workerTimeoutMs (a judge is one call, not benchmarked).
  const candidateTimeoutMs = benchmark ? 600_000 : input.config.settings.workerTimeoutMs;
  const judgeTimeoutMs = input.config.settings.workerTimeoutMs;

  // --- Persona resolution with policy (feature 006; FR-009) ---
  // resolvePersonaWithPolicy classifies the resolution (active/override/strict-enforced/
  // invalid-fallback). When strict-enforced, the transport may elicit a relax opt-in from
  // the user; if granted, we re-resolve to the requested persona (source flips to override).
  // This is the SINGLE enforcement site — both the plain fusion tool + the task path go
  // through runFusion (FR-009). UI calls pass source:"ui" and skip the policy entirely.
  const policy = input.config.settings.personaPolicy ?? "allow-override";
  let resolved = resolvePersonaWithPolicy({
    requested: input.persona,
    personas: input.config.personas ?? [],
    activeId: input.config.settings.activePersona,
    policy,
    source: input.source ?? "mcp",
  });

  // If strict-enforced AND the transport provided a callback, emit the event. The callback
  // may trigger an elicitation (mcp-server.ts) and return "relax" — in which case we honor
  // the requested persona this call (audit flips to "override").
  const event = shouldEmitEvent(resolved);
  if (event && input.onPersonaEvent) {
    try {
      const answer = await input.onPersonaEvent(event);
      if (event.kind === "elicitation-request" && answer === "relax") {
        // User relaxed for this session — run the requested persona (audit: "override").
        resolved = {
          persona: resolvePersona({ override: resolved.requestedId, personas: input.config.personas ?? [], activeId: input.config.settings.activePersona }),
          personaSource: "override",
          requestedId: resolved.requestedId,
        };
      }
    } catch {
      // Best-effort: elicitation failures fall through to the strict-enforced resolution.
      // The fusion must still complete (Constitution III — never block on policy).
    }
  }

  const persona = resolved.persona;
  const personaSource = resolved.personaSource;
  const personaPrompts = {
    worker: persona.workerPrompt,
    analysis: persona.analysisPrompt,
    synthesis: persona.synthesisPrompt,
  };
  if (!judge) {
    // isConfigured() should have caught this, but guard anyway.
    return {
      ok: false,
      error: "No enabled judge. Open http://localhost:9077 and enable one judge.",
      needsConfig: true,
      status: "error",
    };
  }
  const activityId = input.activityId ?? randomUUID();
  const startedAt = Date.now();

  // Enter the live-status registry (feature 007). The try/finally below guarantees
  // `leave` runs on EVERY terminal path — success, partial, error, or thrown exception
  // (INV-3 — a stuck "in-progress" is the one bug that makes the status surface useless).
  const executionMode = input.config.settings.executionMode ?? "parallel";
  fusionStatusRegistry.enter(activityId, executionMode, candidates.length);
  try {
  report(0, 3, `Fanning out to ${candidates.length} models…`);

  // Insert the activity row up-front so sub_calls can reference it (FK). It is finalized
  // (status + aggregates) once the fusion resolves — success, partial, or error.
  // When input.activityId is provided (task path), the caller already allocated a
  // 'running' row, so we must NOT re-insert — only the terminal updateActivity applies.
  if (!input.activityId) {
    recordActivity(input.db, {
      id: activityId,
      prompt_excerpt: excerpt(input.prompt),
      has_context: input.context ? 1 : 0,
      candidate_count: candidates.length,
      survivor_count: 0,
      judge_provider: judge.provider,
      judge_model: judge.model,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
      total_latency_ms: 0,
      persona: persona.id,
      persona_source: personaSource,
      // While in flight: status 'running' (matches task-path allocateActivity convention)
      // so the dashboard + the cross-process /api/runtime query (WHERE status='running') see
      // the fusion as in-progress. Updated to success/partial/error on completion below.
      status: "running",
    });
  } else {
    // Pre-allocated row exists (task path); align candidate_count + judge/persona fields so
    // the dashboard shows correct metadata even if fan-out never completes. allocateActivity
    // (task-runner) doesn't resolve the judge/persona, so we fill them here — matching the
    // blocking path's recordActivity above (symptom 1 fix: judge was missing for ZCode runs).
    updateActivity(input.db, activityId, {
      candidate_count: candidates.length,
      judge_provider: judge.provider,
      judge_model: judge.model,
      persona: persona.id,
      persona_source: personaSource,
    });
  }

  // --- Fan-out (Constitution III): parallel default; sequential opt-in (feature 007) ---
  // Both modes build the same per-candidate worker inputs; only scheduling differs.
  // Sequential is a user-opted alternative (Constitution III amendment) — the survivor
  // gate + per-worker timeout/retry are identical in both modes. `executionMode` was read
  // above (for the registry enter); reused here for the dispatch.
  const workerCalls = candidates.map((c) => ({
    slotId: c.id,
    provider: c.provider,
    modelId: c.model,
    model: safeResolve(c.provider, c.model),
    prompt: input.prompt,
    context: input.context,
    apiKey: getKey(c.provider, secretsPath, keyPath) ?? "",
    timeoutMs: candidateTimeoutMs,
    workerPrompt: personaPrompts.worker,
  }));
  const workerResults =
    executionMode === "sequential"
      ? await runSequentialFanout(workerCalls, {
          report,
          onUpdate: (candidateIndex, candidatesDone) =>
            fusionStatusRegistry.update(activityId, { candidateIndex, candidatesDone }),
        })
      : await runParallelFanout(workerCalls, {
          // Parallel: no candidateIndex (all race concurrently); just count responders as
          // they land, in completion order, so the widget shows "X of N responding" rising.
          onUpdate: (candidatesDone) => fusionStatusRegistry.update(activityId, { candidatesDone }),
        });

  // Log each worker sub_call regardless of outcome (Constitution V).
  for (const w of workerResults) {
    recordSubCall(input.db, {
      activity_id: activityId,
      role: "worker",
      slot_id: w.slotId,
      provider: w.provider,
      model: w.model,
      input_tokens: w.usage?.input ?? 0,
      output_tokens: w.usage?.output ?? 0,
      cost: w.usage?.cost ?? 0,
      latency_ms: w.latencyMs,
      status: w.status === "ok" ? "ok" : w.status === "timeout" ? "timeout" : "error",
      error: w.error ?? null,
      generated_text: w.content ?? null,
      analysis_json: null,
    });
  }

  const survivors = workerResults.filter((w) => w.status === "ok" && w.content);
  const survivorCount = survivors.length;

  if (survivorCount < 2) {
    report(1, 3, `Only ${survivorCount} of ${candidates.length} candidates succeeded.`);
    const failed = workerResults
      .filter((w) => w.status !== "ok")
      .map((w) => `${w.slotId} (${w.status})`)
      .join(", ");
    updateActivity(input.db, activityId, {
      survivor_count: survivorCount,
      total_input_tokens: sum(workerResults, "input"),
      total_output_tokens: sum(workerResults, "output"),
      total_cost: sumCost(workerResults),
      total_latency_ms: Date.now() - startedAt,
      status: "error",
      error: `only ${survivorCount} of ${candidates.length} candidates succeeded (min 2). Failed: ${failed || "(none)"}`,
    });
    return {
      ok: false,
      error: `Only ${survivorCount} of ${candidates.length} candidates succeeded (minimum 2 required). Failed: ${failed || "(none)"}. Configure more/faster candidates or raise the timeout.`,
      status: "error",
      activityId,
    };
  }

  report(1, 3, `${survivorCount} of ${candidates.length} candidates responded; analyzing…`);
  fusionStatusRegistry.update(activityId, { phase: "analysis" });

  // --- Judge step 1: analysis ---
  const judgeModel = safeResolve(judge.provider, judge.model);
  const judgeApiKey = getKey(judge.provider, secretsPath, keyPath) ?? "";
  const candidateViews: CandidateView[] = survivors.map((w, i) => ({
    index: i + 1,
    provider: w.provider,
    model: w.model,
    content: w.content!,
  }));

  if (!judgeModel) {
    return failWithJudgeError(input, activityId, startedAt, survivorCount, workerResults, "analysis", `could not resolve judge model ${judge.provider}/${judge.model}`);
  }

  const analysis = await runAnalysis(judgeModel, input.prompt, candidateViews, judgeApiKey, judgeTimeoutMs, personaPrompts.analysis);
  recordSubCall(input.db, {
    activity_id: activityId,
    role: "judge_analysis",
    provider: judge.provider,
    model: judge.model,
    input_tokens: analysis.usage?.input ?? 0,
    output_tokens: analysis.usage?.output ?? 0,
    cost: analysis.usage?.cost ?? 0,
    latency_ms: analysis.latencyMs,
    status: analysis.ok ? "ok" : "error",
    error: analysis.error ?? null,
    generated_text: null,
    analysis_json: analysis.ok && analysis.value ? JSON.stringify(analysis.value) : null,
  });
  if (!analysis.ok) {
    return failWithJudgeError(input, activityId, startedAt, survivorCount, workerResults, "analysis", analysis.error);
  }

  report(2, 3, "Analysis complete; synthesizing…");
  fusionStatusRegistry.update(activityId, { phase: "synthesis" });

  // --- Judge step 2: synthesis ---
  const synth = await runSynthesis(judgeModel, input.prompt, candidateViews, analysis.value!, judgeApiKey, judgeTimeoutMs, personaPrompts.synthesis);
  recordSubCall(input.db, {
    activity_id: activityId,
    role: "judge_synthesis",
    provider: judge.provider,
    model: judge.model,
    input_tokens: synth.usage?.input ?? 0,
    output_tokens: synth.usage?.output ?? 0,
    cost: synth.usage?.cost ?? 0,
    latency_ms: synth.latencyMs,
    status: synth.ok ? "ok" : "error",
    error: synth.error ?? null,
    generated_text: synth.value ?? null,
    analysis_json: null,
  });
  if (!synth.ok || !synth.value) {
    return failWithJudgeError(input, activityId, startedAt, survivorCount, workerResults, "synthesis", synth.error);
  }

  report(3, 3, "Done");

  // --- Log the activity (success/partial) ---
  const status: FusionResult["status"] = survivorCount < candidates.length ? "partial" : "success";
  updateActivity(input.db, activityId, {
    survivor_count: survivorCount,
    total_input_tokens: sum(workerResults, "input") + (analysis.usage?.input ?? 0) + (synth.usage?.input ?? 0),
    total_output_tokens: sum(workerResults, "output") + (analysis.usage?.output ?? 0) + (synth.usage?.output ?? 0),
    total_cost: sumCost(workerResults) + (analysis.usage?.cost ?? 0) + (synth.usage?.cost ?? 0),
    total_latency_ms: Date.now() - startedAt,
    status,
    error: null,
  });

  return { ok: true, answer: synth.value, activityId, status };
  } finally {
    // INV-3: every terminal path (the returns above + failWithJudgeError + any throw)
    // flows through here. Idempotent — safe even if enter never matched.
    fusionStatusRegistry.leave(activityId);
  }
}

// --- helpers ---

function safeResolve(provider: string, model: string): AnyModel | undefined {
  try {
    return resolveModel(provider, model);
  } catch {
    return undefined; // runWorker will surface an error when it tries to use it
  }
}

function excerpt(s: string): string {
  return s.length > PROMPT_EXCERPT_LEN ? `${s.slice(0, PROMPT_EXCERPT_LEN)}…` : s;
}

function sum(results: WorkerResult[], field: "input" | "output"): number {
  return results.reduce((acc, r) => acc + (r.usage?.[field] ?? 0), 0);
}
function sumCost(results: WorkerResult[]): number {
  return results.reduce((acc, r) => acc + (r.usage?.cost ?? 0), 0);
}

function failWithJudgeError(
  input: FusionInput,
  activityId: string,
  startedAt: number,
  survivorCount: number,
  workerResults: WorkerResult[],
  step: "analysis" | "synthesis",
  detail?: string,
): FusionResult {
  updateActivity(input.db, activityId, {
    survivor_count: survivorCount,
    total_input_tokens: sum(workerResults, "input"),
    total_output_tokens: sum(workerResults, "output"),
    total_cost: sumCost(workerResults),
    total_latency_ms: Date.now() - startedAt,
    status: "error",
    error: `judge ${step} failed: ${detail ?? "(no detail)"}`,
  });
  return {
    ok: false,
    error: `Judge failed during ${step}: ${detail ?? "(no detail)"}. ${survivorCount} candidate responses were collected; see the dashboard.`,
    status: "error",
    activityId,
  };
}
