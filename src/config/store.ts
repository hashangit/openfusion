// Config store: read/write config.json (plaintext, no secrets).
// Missing file => unconfigured (not an error). Writes are atomic (temp+rename).
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppConfigSchema, RawConfigSchema, CONFIG_VERSION, type AppConfig, type RawConfig } from "./schema.js";
import { ensureHome, paths } from "../util/paths.js";

/** Build an empty RawConfig using schema defaults. */
export function emptyConfig(): RawConfig {
  return RawConfigSchema.parse({});
}

/** Load the raw (leniently-parsed) config. Missing/empty file => empty RawConfig. */
export function loadConfig(path = paths.config()): RawConfig {
  if (!existsSync(path)) return emptyConfig();
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return emptyConfig();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError("CONFIG_PARSE", `config.json is not valid JSON: ${(e as Error).message}`);
  }
  return RawConfigSchema.parse(migrate(json));
}

/**
 * v1 -> v2 migration: map the old single `judge` object to `judges: [{...judge, enabled}]`,
 * and backfill `enabled: true` on any candidates missing it. Runs on every load;
 * idempotent for v2 files (no `judge` key => no-op). Also tolerated: a v2 file
 * that still has a stray `judge` key from a downgrade — ignored.
 */
export function migrate(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  let migrated = false;
  // judge (singular, v1) -> judges (plural, v2)
  if (!Array.isArray(out.judges) && obj.judge && typeof obj.judge === "object") {
    out.judges = [{ ...(obj.judge as object), enabled: true }];
    delete out.judge;
    migrated = true;
  }
  // backfill candidate.enabled (v1 candidates had no enabled flag)
  if (Array.isArray(out.candidates)) {
    const before = out.candidates as Array<Record<string, unknown>>;
    let backfilled = false;
    const after = before.map((c) => {
      if (c && typeof c === "object" && !("enabled" in c)) {
        backfilled = true;
        return { ...c, enabled: true };
      }
      return c;
    });
    if (backfilled) migrated = true;
    out.candidates = after;
  }
  if (migrated) {
    out.version = 2;
    console.error("OpenFusion: config upgraded from v1 → v2 (judge→judges, enabled flags). Re-save via the dashboard to persist.");
  }
  return out;
}

/** Validate a candidate config strictly (throws on <2 candidates, unknown fields, etc.). */
export function validateConfig(cfg: unknown): AppConfig {
  return AppConfigSchema.parse(cfg);
}

/**
 * Merge a partial config patch onto a base config and validate leniently
 * (RawConfigSchema). Used by the PUT /api/config endpoint so incremental
 * setup works — e.g. saving Candidates before a Judge is chosen, or vice versa.
 * Completeness (>=2 candidates + judge + keys) is gated by isConfigured() at
 * fusion time, NOT here (Constitution VI).
 *
 * Candidate/judge are replaced wholesale when supplied (not deep-merged per
 * field); settings are deep-merged. Omitted fields fall back to the base.
 */
export function mergeAndValidate(base: RawConfig, patch: unknown): RawConfig {
  const p = (patch ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };
  if (Array.isArray(p.candidates)) merged.candidates = p.candidates;
  if (Array.isArray(p.judges)) merged.judges = p.judges;
  if (p.settings && typeof p.settings === "object") {
    merged.settings = { ...(base.settings as object), ...(p.settings as object) };
  }
  // RawConfigSchema validates + applies defaults; throws ZodError on bad shapes.
  return RawConfigSchema.parse(merged);
}

/** Persist config atomically. Writes a .bak of the previous version first. */
export function saveConfig(cfg: AppConfig | RawConfig, path = paths.config()): void {
  ensureHome();
  const out = { ...cfg, version: CONFIG_VERSION };
  const json = JSON.stringify(out, null, 2);
  // Backup existing file before overwriting.
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
  }
  // Atomic write: temp file in same dir, then rename.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export const __test__ = { dirname: (p: string) => dirname(p), join };
