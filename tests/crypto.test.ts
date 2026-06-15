// T007 — crypto tests (written first, must fail until T008 lands).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMasterKey, encrypt, decrypt, mask, loadOrCreateMasterKey } from "../src/config/crypto.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "of-crypto-"));
  process.env.OPENFUSION_HOME = home;
});

describe("crypto: AES-256-GCM round-trip", () => {
  it("encrypts then decrypts back to the original JSON", () => {
    const key = generateMasterKey();
    const payload = JSON.stringify({ providers: { openai: { apiKey: "sk-test-1234567890" } } });
    const blob = encrypt(payload, key);
    // Layout: iv(12) + authTag(16) + ciphertext
    expect(blob.length).toBeGreaterThan(12 + 16);
    expect(decrypt(blob, key)).toBe(payload);
  });

  it("produces ciphertext that does NOT contain the plaintext key", () => {
    const key = generateMasterKey();
    const secret = "sk-super-secret-key-value";
    const blob = encrypt(JSON.stringify({ k: secret }), key);
    expect(Buffer.from(blob).includes(secret)).toBe(false);
  });

  it("fails to decrypt with tampered ciphertext (auth tag check)", () => {
    const key = generateMasterKey();
    const blob = encrypt("hello world", key);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01; // flip a bit
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("fails to decrypt with the wrong key", () => {
    const blob = encrypt("hello", generateMasterKey());
    expect(() => decrypt(blob, generateMasterKey())).toThrow();
  });
});

describe("crypto: mask()", () => {
  it("masks keys >= 8 chars as first 3 … last 4", () => {
    expect(mask("sk-1234567890abcd")).toBe("sk-…abcd");
    expect(mask("sk-ant-api03-XYZ")).toBe("sk-…-XYZ");
  });
  it("fully masks short keys", () => {
    expect(mask("short")).toBe("******");
    expect(mask("")).toBe("******");
  });
});

describe("crypto: loadOrCreateMasterKey", () => {
  it("generates a 32-byte key written with chmod 600 on first run", () => {
    const keyPath = join(home, "master.key");
    expect(existsSync(keyPath)).toBe(false);
    const key = loadOrCreateMasterKey(keyPath);
    expect(key.length).toBe(32);
    expect(existsSync(keyPath)).toBe(true);
    // file mode 0o600 (owner read/write only)
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reuses the existing key on subsequent loads (does not regenerate)", () => {
    const keyPath = join(home, "master.key");
    const first = loadOrCreateMasterKey(keyPath);
    // rewrite an unrelated secrets file in between — key must stay stable
    writeFileSync(join(home, "secrets.enc"), encrypt("x", first));
    const second = loadOrCreateMasterKey(keyPath);
    expect(Buffer.compare(first, second)).toBe(0);
  });

  it("round-trips a real secrets file via the key it generated", () => {
    const keyPath = join(home, "master.key");
    const key = loadOrCreateMasterKey(keyPath);
    const payload = '{"providers":{"openai":{"apiKey":"sk-round-trip-1234567890"}}}';
    const blob = encrypt(payload, key);
    // Persist to disk as the real store would, then read back and decrypt.
    writeFileSync(join(home, "secrets.enc"), blob);
    const decrypted = decrypt(readFileSync(join(home, "secrets.enc")), key);
    expect(decrypted).toBe(payload);
  });
});
