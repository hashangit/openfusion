// AES-256-GCM secrets at rest (Constitution IV). Node built-in crypto only.
//
// Envelope layout for secrets.enc: iv(12) | authTag(16) | ciphertext.
// Master key is a 32-byte random file (chmod 600), machine-bound.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** Generate a fresh 32-byte master key. */
export function generateMasterKey(): Buffer {
  return randomBytes(32);
}

/** Encrypt a UTF-8 string into the iv|authTag|ciphertext envelope. */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  assertKey(key);
  const iv = randomBytes(12); // 96-bit nonce is standard for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, enc]);
}

/** Decrypt an iv|authTag|ciphertext envelope back to the UTF-8 string. Throws on tamper/wrong key. */
export function decrypt(blob: Buffer, key: Buffer): string {
  assertKey(key);
  if (blob.length < 12 + 16) throw new Error("ciphertext too short");
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/**
 * Mask a key for display: first 3 + … + last 4 when length >= 8, else `******`.
 * Used by the secrets REST endpoint so raw keys are never returned (Constitution IV).
 */
export function mask(key: string): string {
  if (!key || key.length < 8) return "******";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/**
 * Load the master key from disk, generating + persisting it on first run (chmod 600).
 * If the file is missing it creates one. It never silently overwrites an existing key
 * (which would orphan previously-encrypted secrets).
 */
export function loadOrCreateMasterKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }
  const key = generateMasterKey();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  // Ensure mode is exactly 0600 even if the umask differed.
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best effort */
  }
  return key;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("AES-256 key must be a 32-byte Buffer");
  }
}

/** Re-export statSync for tests that inspect file modes. */
export { statSync };
