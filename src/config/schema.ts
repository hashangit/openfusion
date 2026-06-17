// Zod schemas for config.json (plaintext model choices — no secrets).
// See data-model.md E1 and contracts/config-schema.md.
//
// v2 (0.1.1): candidates carry an `enabled` flag; `judge` is now `judges[]`
// (each enabled); settings gained `benchmarkMode`. v1 files are migrated on
// load (see store.ts migrate()).
import { z } from "zod";

export const CONFIG_VERSION = 2 as const;

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

export const SettingsSchema = z
  .object({
    // Per-call timeout, reset on each retry. Default 5 min so slow providers
    // have room; users hitting a client tool-call ceiling can lower this.
    workerTimeoutMs: z.number().int().min(5_000).max(600_000).default(300_000),
    uiPort: z.number().int().min(1).max(65535).default(9077),
    bind: z.string().regex(LOOPBACK, "must be a loopback address").default("127.0.0.1"),
    // When true: no max-candidate limit, candidate timeout forced to 10 min.
    benchmarkMode: z.boolean().default(false),
  })
  .default({ workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false });
export type Settings = z.infer<typeof SettingsSchema>;

/** Strict, fully-configured config (what isConfigured() ultimately wants). */
export const AppConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  candidates: z.array(CandidateSlotSchema),
  judges: z.array(JudgeConfigSchema).min(1, "need at least 1 judge configured"),
  settings: SettingsSchema,
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Lenient schema for parsing a saved/partial file (may be empty or mid-setup).
 * `judges`/`enabled`/`benchmarkMode` are all optional with defaults so a v1
 * file or a fresh install parses without error. isConfigured() enforces the
 * real rules (>=2 enabled candidates, >=1 enabled judge) at fusion time.
 * Candidates capped at 5 even when lenient — except benchmark mode lifts it.
 */
export const RawConfigSchema = z
  .object({
    version: z.number().optional(),
    candidates: z.array(CandidateSlotSchema).optional().default([]),
    judges: z.array(JudgeConfigSchema).optional().default([]),
    settings: SettingsSchema,
  })
  .default({ settings: { workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1", benchmarkMode: false } });
export type RawConfig = z.infer<typeof RawConfigSchema>;
