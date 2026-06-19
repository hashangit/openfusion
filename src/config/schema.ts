// Zod schemas for config.json (plaintext model choices — no secrets).
// See data-model.md E1 and contracts/config-schema.md.
//
// v2 (0.1.1): candidates carry `enabled`; `judge` → `judges[]`; benchmarkMode.
// v3 (0.1.1): personas (worker/analysis/synthesis prompt bundles) + activePersona.
// v4 (0.3.0): personaPolicy — gates whether MCP clients may override the active persona.
// v5 (0.3.0): executionMode — parallel (default) vs sequential (opt-in for low-VRAM local).
import { z } from "zod";

export const CONFIG_VERSION = 5 as const;

/** Whether MCP clients may override the dashboard's active persona per fusion (feature 006). */
export const PersonaPolicySchema = z.enum(["strict", "allow-override"]).default("allow-override");
export type PersonaPolicy = z.infer<typeof PersonaPolicySchema>;

/**
 * How candidate fan-out is scheduled (feature 007).
 *  - `parallel` (default): all enabled candidates dispatched concurrently — optimal for cloud.
 *  - `sequential`: candidates run one at a time in slot order — opt-in for low-VRAM local setups.
 */
export const ExecutionModeSchema = z.enum(["parallel", "sequential"]).default("parallel");
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

const LOOPBACK = /^(127\.|localhost$|::1$|0:0:0:0:0:0:0:1$)/;

export const CandidateSlotSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type CandidateSlot = z.infer<typeof CandidateSlotSchema>;

export const JudgeConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

export const PersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  builtin: z.boolean().optional(),
  workerPrompt: z.string().min(1),
  analysisPrompt: z.string().min(1),
  synthesisPrompt: z.string().min(1),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const SettingsSchema = z
  .object({
    workerTimeoutMs: z.number().int().min(5_000).max(600_000).default(300_000),
    uiPort: z.number().int().min(1).max(65535).default(9077),
    bind: z.string().regex(LOOPBACK, "must be a loopback address").default("127.0.0.1"),
    benchmarkMode: z.boolean().default(false),
    activePersona: z.string().default("generalist"),
    /** Gates MCP-client persona overrides per fusion (feature 006). UI fusions are exempt. */
    personaPolicy: PersonaPolicySchema,
    /** How candidate fan-out is scheduled (feature 007). Default parallel. */
    executionMode: ExecutionModeSchema,
  })
  .default({ workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false, activePersona: "generalist", personaPolicy: "allow-override", executionMode: "parallel" });
export type Settings = z.infer<typeof SettingsSchema>;

/** Strict, fully-configured config (what isConfigured() ultimately wants). */
export const AppConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  candidates: z.array(CandidateSlotSchema),
  judges: z.array(JudgeConfigSchema).min(1, "need at least 1 judge configured"),
  personas: z.array(PersonaSchema),
  settings: SettingsSchema,
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Lenient schema for parsing a saved/partial file (may be empty or mid-setup).
 * `personas`/`activePersona` optional with defaults so older files parse cleanly;
 * isConfigured() enforces the real rules (>=2 enabled candidates, >=1 enabled judge).
 */
export const RawConfigSchema = z
  .object({
    version: z.number().optional(),
    candidates: z.array(CandidateSlotSchema).optional().default([]),
    judges: z.array(JudgeConfigSchema).optional().default([]),
    personas: z.array(PersonaSchema).optional().default([]),
    settings: SettingsSchema,
  })
  .default({ settings: { workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false, activePersona: "generalist", personaPolicy: "allow-override", executionMode: "parallel" } });
export type RawConfig = z.infer<typeof RawConfigSchema>;
