// Secrets store: read/write secrets.enc (AES-256-GCM encrypted JSON).
// One key per provider, shared across all candidate slots + judge that reference it.
// Refuses to regenerate master.key if missing (treats secrets as unconfigured) —
// regenerating would orphan previously-encrypted secrets.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths, ensureHome } from "../util/paths.js";
import { encrypt, decrypt, loadOrCreateMasterKey, mask } from "./crypto.js";
import type { RawConfig } from "./schema.js";

export interface SecretsFile {
  providers: Record<string, { apiKey: string }>;
}

const EMPTY: SecretsFile = { providers: {} };

/** Load + decrypt the secrets file. Missing secrets.enc OR missing master.key => empty (unconfigured). */
export function loadSecrets(secretsPath = paths.secrets(), keyPath = paths.masterKey()): SecretsFile {
  // If master.key is missing, do NOT regenerate — that would be misleading. Treat as unconfigured.
  if (!existsSync(keyPath)) return { ...EMPTY };
  if (!existsSync(secretsPath)) return { ...EMPTY };
  const key = readFileSync(keyPath);
  const blob = readFileSync(secretsPath);
  try {
    const json = decrypt(blob, key);
    const parsed = JSON.parse(json) as SecretsFile;
    if (!parsed || typeof parsed !== "object" || !parsed.providers) return { ...EMPTY };
    return parsed;
  } catch {
    // Corrupt blob or wrong key — surface as unconfigured rather than crashing the server.
    return { ...EMPTY };
  }
}

/** Encrypt + persist the secrets file, generating master.key on first write. */
export function saveSecrets(secrets: SecretsFile, secretsPath = paths.secrets(), keyPath = paths.masterKey()): void {
  ensureHome();
  const key = loadOrCreateMasterKey(keyPath);
  const blob = encrypt(JSON.stringify(secrets), key);
  writeFileSync(secretsPath, blob, { mode: 0o600 });
}

/** Set (or clear with null) a single provider's key, persisting immediately. */
export function setProviderKey(
  provider: string,
  apiKey: string | null,
  secretsPath = paths.secrets(),
  keyPath = paths.masterKey(),
): SecretsFile {
  const current = loadSecrets(secretsPath, keyPath);
  if (apiKey === null || apiKey.trim() === "") {
    delete current.providers[provider];
  } else {
    current.providers[provider] = { apiKey };
  }
  saveSecrets(current, secretsPath, keyPath);
  return current;
}

/** Look up a provider's key, or undefined if none stored. */
export function getKey(provider: string, secretsPath = paths.secrets(), keyPath = paths.masterKey()): string | undefined {
  return loadSecrets(secretsPath, keyPath).providers[provider]?.apiKey;
}

/** Masked presence only (never the raw key) for the REST endpoint — Constitution IV. */
export function maskedPresence(
  config: RawConfig,
  secretsPath = paths.secrets(),
  keyPath = paths.masterKey(),
): { providers: Record<string, { present: boolean; hint: string | null }>; referenced: string[] } {
  const secrets = loadSecrets(secretsPath, keyPath);
  const referenced = referencedProviders(config);
  const providers: Record<string, { present: boolean; hint: string | null }> = {};
  for (const p of referenced) {
    const key = secrets.providers[p]?.apiKey;
    providers[p] = key ? { present: true, hint: mask(key) } : { present: false, hint: null };
  }
  return { providers, referenced };
}

/** The unique set of provider ids referenced by the current config (candidates + judge). */
export function referencedProviders(config: RawConfig): string[] {
  const set = new Set<string>();
  for (const c of config.candidates ?? []) set.add(c.provider);
  if (config.judge) set.add(config.judge.provider);
  return [...set].sort();
}
