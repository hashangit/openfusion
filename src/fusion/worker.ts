// Worker: a single-shot candidate generation. No tools (Constitution I).
import { runComplete, extractText, totalCost, type AnyModel } from "../providers/pi-ai-bridge.js";
import { withRetryTimeout, TimeoutError } from "../util/timeout.js";
import { WORKER_PROMPT } from "./prompts.js";

export interface WorkerInput {
  slotId: string;
  provider: string;
  modelId: string;
  /** The resolved pi-ai model object; undefined if it could not be resolved. */
  model: AnyModel | undefined;
  prompt: string;
  context?: string;
  apiKey: string;
  timeoutMs: number;
}

export interface WorkerResult {
  slotId: string;
  provider: string;
  model: string;
  content?: string;
  usage?: { input: number; output: number; cost: number };
  latencyMs: number;
  status: "ok" | "timeout" | "error";
  error?: string;
}

/** Run one candidate. Returns a structured result; never throws (errors -> status error/timeout). */
export async function runWorker(input: WorkerInput): Promise<WorkerResult> {
  const startedAt = Date.now();
  const base: WorkerResult = {
    slotId: input.slotId,
    provider: input.provider,
    model: input.modelId,
    latencyMs: 0,
    status: "error",
  };
  const userContent = input.context
    ? `Background context:\n${input.context}\n\n---\n\nPrompt:\n${input.prompt}`
    : input.prompt;
  const finish = (r: Partial<WorkerResult>): WorkerResult => ({ ...base, ...r, latencyMs: Date.now() - startedAt });

  try {
    if (!input.model) {
      return finish({ status: "error", error: `could not resolve model ${input.provider}/${input.modelId}` });
    }
    // Retry on failure (timeout OR error), resetting the timeout each attempt.
    const msg = await withRetryTimeout(
      () =>
        runComplete(input.model!, {
          systemPrompt: WORKER_PROMPT,
          messages: [{ role: "user", content: userContent, timestamp: startedAt }],
        }, input.apiKey),
      { timeoutMs: input.timeoutMs, label: `worker ${input.slotId}`, attempts: 3 },
    );
    const text = extractText(msg);
    if (!text) return finish({ status: "error", error: "empty response" });
    return finish({
      status: "ok",
      content: text,
      usage: {
        input: msg.usage.input,
        output: msg.usage.output,
        cost: totalCost(msg.usage),
      },
    });
  } catch (e) {
    if (e instanceof TimeoutError) {
      return finish({ status: "timeout", error: e.message });
    }
    return finish({ status: "error", error: (e as Error).message });
  }
}
