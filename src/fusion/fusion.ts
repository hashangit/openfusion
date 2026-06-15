// The fusion orchestrator. Implements the state machine in data-model.md:
// gate -> parallel fan-out -> >=2 survivor check -> judge step 1 (analysis)
// -> judge step 2 (synthesis) -> log -> return.
import { randomUUID } from "node:crypto";
import type { RawConfig } from "../config/schema.js";
import { isConfigured } from "../config/completeness.js";
import { getKey } from "../config/secrets.js";
import { resolveModel, type AnyModel } from "../providers/pi-ai-bridge.js";
import { runWorker, type WorkerResult } from "./worker.js";
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
  /** Injected so tests can swap a temp DB. */
  db: DB;
  /** Injected so tests can point secrets/master.key elsewhere. */
  secretsPath?: string;
  keyPath?: string;
  /** Optional progress callback (MCP tool wires it to notifications/progress). */
  onProgress?: ProgressFn;
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
  const candidates = input.config.candidates!;
  const judge = input.config.judge!;
  const timeoutMs = input.config.settings.workerTimeoutMs;
  const activityId = randomUUID();
  const startedAt = Date.now();

  report(0, 3, `Fanning out to ${candidates.length} models…`);

  // Insert the activity row up-front so sub_calls can reference it (FK). It is finalized
  // (status + aggregates) once the fusion resolves — success, partial, or error.
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
    status: "error", // pessimistic default; updated on success/partial
    error: "in-progress",
  });

  // --- Fan-out (Constitution III): parallel, per-worker timeout, Promise.allSettled ---
  const workerResults = await Promise.all(
    candidates.map((c) =>
      runWorker({
        slotId: c.id,
        provider: c.provider,
        modelId: c.model,
        model: safeResolve(c.provider, c.model),
        prompt: input.prompt,
        context: input.context,
        apiKey: getKey(c.provider, secretsPath, keyPath) ?? "",
        timeoutMs,
      }),
    ),
  );

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

  const analysis = await runAnalysis(judgeModel, input.prompt, candidateViews, judgeApiKey);
  recordSubCall(input.db, {
    activity_id: activityId,
    role: "judge_analysis",
    provider: judge.provider,
    model: judge.model,
    input_tokens: analysis.usage?.input ?? 0,
    output_tokens: analysis.usage?.output ?? 0,
    cost: analysis.usage?.cost ?? 0,
    latency_ms: 0,
    status: analysis.ok ? "ok" : "error",
    error: analysis.error ?? null,
  });
  if (!analysis.ok) {
    return failWithJudgeError(input, activityId, startedAt, survivorCount, workerResults, "analysis", analysis.error);
  }

  report(2, 3, "Analysis complete; synthesizing…");

  // --- Judge step 2: synthesis ---
  const synth = await runSynthesis(judgeModel, input.prompt, candidateViews, analysis.value!, judgeApiKey);
  recordSubCall(input.db, {
    activity_id: activityId,
    role: "judge_synthesis",
    provider: judge.provider,
    model: judge.model,
    input_tokens: synth.usage?.input ?? 0,
    output_tokens: synth.usage?.output ?? 0,
    cost: synth.usage?.cost ?? 0,
    latency_ms: 0,
    status: synth.ok ? "ok" : "error",
    error: synth.error ?? null,
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
