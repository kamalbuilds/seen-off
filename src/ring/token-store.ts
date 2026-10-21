import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RingAuth } from "./client.ts";

const PREFIX = "v1.";

/**
 * The AES-256-GCM key for the token file: RING_TOKEN_KEY (32 bytes as hex or base64) when set, otherwise a random key generated once
 * into `<token file>.key` (0600). The token never sits on disk in the clear, and a copied token file is useless without the key.
 */
function keyFor(path: string): Buffer {
  const env = process.env.RING_TOKEN_KEY;
  if (env) {
    const k = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("RING_TOKEN_KEY must be 32 bytes, given as 64 hex characters or base64");
    return k;
  }
  const keyPath = `${path}.key`;
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  const k = randomBytes(32);
  writeAtomic(keyPath, `${k.toString("base64")}\n`);
  return k;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const b64 = (b: Buffer) => b.toString("base64url");

function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${b64(iv)}.${b64(c.getAuthTag())}.${b64(ct)}`;
}

function decrypt(blob: string, key: Buffer): string {
  const [iv, tag, ct] = blob.slice(PREFIX.length).split(".").map((p) => Buffer.from(p, "base64url"));
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    throw new Error("the saved Ring token cannot be decrypted: wrong key or a changed file. Connect Ring again to replace it.");
  }
}

/**
 * The newest refresh token saved on disk, or null when none has been saved. Ring rotates the token on every exchange, so the file wins over .env.
 * A file written before encryption existed (a bare token) is still read, and is encrypted on the next save.
 */
export function loadRefreshToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) return null;
  return raw.startsWith(PREFIX) ? decrypt(raw, keyFor(path)) : raw;
}

/** Encrypts the token and writes it 0600 by temp-file rename, so a crash mid-write leaves the previous token intact. */
export function saveRefreshToken(path: string, token: string): void {
  writeAtomic(path, `${encrypt(token, keyFor(path))}\n`);
}

/** For a registered app: start from the saved refresh token when there is one, and save every rotated token. Playground tokens pass through unchanged. */
export function withPersistedRefreshToken(auth: RingAuth, path: string): RingAuth {
  if (auth.kind !== "refresh") return auth;
  const saved = loadRefreshToken(path);
  return { ...auth, refreshToken: saved ?? auth.refreshToken, onRefreshToken: (t) => { saveRefreshToken(path, t); auth.onRefreshToken?.(t); } };
}
