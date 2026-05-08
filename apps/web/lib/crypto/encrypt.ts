import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES-256-GCM helpers for at-rest credential encryption.
 *
 * Plaintext: WP application passwords + GitHub fine-grained PATs. These are
 * not just secret in the conventional sense — they are agency-customer
 * credentials we are stewards of. RLS keeps tenants from reading each other's
 * rows; this layer protects against the row content itself leaking via a
 * service-role exposure (debug logs, operator query, support escalation,
 * Postgres backup file).
 *
 * Wire format (Buffer): iv(12) || authTag(16) || ciphertext(N)
 *   - 12-byte IV is the canonical GCM size; randomly generated per encrypt
 *   - 16-byte auth tag is appended next so we can decrypt without out-of-band
 *     metadata
 *
 * Key source: env var JAB_ENCRYPTION_KEY (64 hex chars = 32 bytes). NEVER
 * commit; rotate by re-encrypting all rows with a key-id schema (out of
 * scope for v0 — single-key for now).
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ALGO = "aes-256-gcm" as const;

let _key: Buffer | null = null;

function loadKey(): Buffer {
  if (_key) return _key;
  const hex = process.env.JAB_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "JAB_ENCRYPTION_KEY not set. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" and add to apps/web/.env.local",
    );
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `JAB_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex chars (${KEY_BYTES} bytes). Got ${buf.length} bytes.`,
    );
  }
  _key = buf;
  return _key;
}

export function encryptString(plaintext: string): Buffer {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

export function decryptToString(blob: Buffer): string {
  const key = loadKey();
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error(
      `Ciphertext too short (${blob.length} bytes). Expected at least ${IV_BYTES + TAG_BYTES}.`,
    );
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
