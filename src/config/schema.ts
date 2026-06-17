// Zod schemas for config.json (plaintext model choices — no secrets).
// See data-model.md E1 and contracts/config-schema.md.
import { z } from "zod";

export const CONFIG_VERSION = 1 as const;

const LOOPBACK = /^(127\.|localhost$|::1$|0:0:0:0:0:0:0:1$)/;

export const CandidateSlotSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type CandidateSlot = z.infer<typeof CandidateSlotSchema>;

export const JudgeConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

export const SettingsSchema = z
  .object({
    // Per-call timeout, reset on each retry. Default 5 min so slow providers
    // have room; users hitting a client tool-call ceiling can lower this.
    workerTimeoutMs: z.number().int().min(5_000).max(600_000).default(300_000),
    uiPort: z.number().int().min(1).max(65535).default(9077),
    bind: z.string().regex(LOOPBACK, "must be a loopback address").default("127.0.0.1"),
  })
  .default({ workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1" });
export type Settings = z.infer<typeof SettingsSchema>;

export const AppConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  candidates: z.array(CandidateSlotSchema).min(2, "need at least 2 candidates").max(5, "at most 5 candidates"),
  judge: JudgeConfigSchema,
  settings: SettingsSchema,
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * A looser schema for parsing a saved file that may be empty/partial.
 * Used by loadConfig() so an incomplete file is treated as "unconfigured",
 * not a hard error. isConfigured() still enforces the strict rules at fusion time.
 * Candidates still capped at 5 even when lenient (a UI bug shouldn't write 6).
 */
export const RawConfigSchema = z
  .object({
    version: z.number().optional(),
    candidates: z.array(CandidateSlotSchema).max(5, "at most 5 candidates").optional().default([]),
    judge: JudgeConfigSchema.optional(),
    settings: SettingsSchema,
  })
  .default({ settings: { workerTimeoutMs: 300_000, uiPort: 9077, bind: "127.0.0.1" } });
export type RawConfig = z.infer<typeof RawConfigSchema>;
