// Judge: two steps on the SAME provider/model (Constitution II).
// Step 1 = analysis via a forced record_analysis tool call.
// Step 2 = synthesis text from candidates + analysis only.
import { Type, type Tool, type Context } from "@earendil-works/pi-ai";
import { runComplete, extractText, extractToolCall, totalCost, type AnyModel } from "../providers/pi-ai-bridge.js";
import { ANALYSIS_PROMPT, SYNTHESIS_PROMPT } from "./prompts.js";

export interface AnalysisShape {
  consensus: string[];
  contradictions: string[];
  partialCoverage: string[];
  uniqueInsights: string[];
  blindSpots: string[];
}

/** The forced tool the analysis step MUST call to emit its structured output. */
export const analysisTool: Tool = {
  name: "record_analysis",
  description:
    "Record your structured analysis of the candidate answers. Do NOT answer the prompt yourself.",
  parameters: Type.Object({
    consensus: Type.Array(Type.String(), { description: "Points where candidates substantially agree" }),
    contradictions: Type.Array(Type.String(), { description: "Points where candidates disagree or conflict" }),
    partialCoverage: Type.Array(Type.String(), { description: "Aspects only some candidates addressed" }),
    uniqueInsights: Type.Array(Type.String(), { description: "Valuable points raised by only one/few candidates" }),
    blindSpots: Type.Array(Type.String(), { description: "Important aspects no candidate addressed well" }),
  }),
};

export interface CandidateView {
  index: number; // 1-based, used in prompts ("Candidate 1")
  provider: string;
  model: string;
  content: string;
}

export interface JudgeStepResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  usage?: { input: number; output: number; cost: number };
}

/** Step 1: analysis. Forces the record_analysis tool call. */
export async function runAnalysis(
  model: AnyModel,
  prompt: string,
  candidates: CandidateView[],
  apiKey: string,
): Promise<JudgeStepResult<AnalysisShape>> {
  const ctx: Context = {
    systemPrompt: ANALYSIS_PROMPT,
    messages: [{ role: "user", content: analysisUserContent(prompt, candidates), timestamp: Date.now() }],
    tools: [analysisTool],
  };
  try {
    const msg = await runComplete(model, ctx, apiKey);
    const call = extractToolCall<AnalysisShape>(msg, "record_analysis");
    if (!call) {
      return {
        ok: false,
        error: "analysis step did not emit a record_analysis tool call",
        usage: { input: msg.usage.input, output: msg.usage.output, cost: totalCost(msg.usage) },
      };
    }
    return {
      ok: true,
      value: call.arguments,
      usage: { input: msg.usage.input, output: msg.usage.output, cost: totalCost(msg.usage) },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Step 2: synthesis. Writes the final answer from candidates + analysis only. */
export async function runSynthesis(
  model: AnyModel,
  prompt: string,
  candidates: CandidateView[],
  analysis: AnalysisShape,
  apiKey: string,
): Promise<JudgeStepResult<string>> {
  const ctx: Context = {
    systemPrompt: SYNTHESIS_PROMPT,
    messages: [{ role: "user", content: synthesisUserContent(prompt, candidates, analysis), timestamp: Date.now() }],
  };
  try {
    const msg = await runComplete(model, ctx, apiKey);
    const text = extractText(msg);
    if (!text) return { ok: false, error: "synthesis produced no text" };
    return {
      ok: true,
      value: text,
      usage: { input: msg.usage.input, output: msg.usage.output, cost: totalCost(msg.usage) },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function analysisUserContent(prompt: string, candidates: CandidateView[]): string {
  const blocks = candidates
    .map((c) => `### Candidate ${c.index} (${c.provider}/${c.model})\n${c.content}`)
    .join("\n\n");
  return `## User Prompt\n${prompt}\n\n## Candidate Answers\n${blocks}\n\nAnalyze these candidates now via the record_analysis tool.`;
}

function synthesisUserContent(prompt: string, candidates: CandidateView[], analysis: AnalysisShape): string {
  const blocks = candidates
    .map((c) => `### Candidate ${c.index} (${c.provider}/${c.model})\n${c.content}`)
    .join("\n\n");
  const a = analysis;
  const analysisBlock = `## Structured Analysis
- Consensus: ${a.consensus.join(" | ") || "(none)"}
- Contradictions: ${a.contradictions.join(" | ") || "(none)"}
- Partial coverage: ${a.partialCoverage.join(" | ") || "(none)"}
- Unique insights: ${a.uniqueInsights.join(" | ") || "(none)"}
- Blind spots: ${a.blindSpots.join(" | ") || "(none)"}`;
  return `## User Prompt\n${prompt}\n\n## Candidate Answers\n${blocks}\n\n${analysisBlock}\n\nWrite the final consolidated answer now.`;
}
