import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RingAuth } from "./client.ts";

/** The newest refresh token saved on disk, or null when none has been saved. Ring rotates the token on every exchange, so the file wins over .env. */
export function loadRefreshToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const t = readFileSync(path, "utf8").trim();
  return t.length > 0 ? t : null;
}

/** Writes the token to a 0600 file by temp-file rename, so a crash mid-write leaves the previous token intact. */
export function saveRefreshToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** For a registered app: start from the saved refresh token when there is one, and save every rotated token. Playground tokens pass through unchanged. */
export function withPersistedRefreshToken(auth: RingAuth, path: string): RingAuth {
  if (auth.kind !== "refresh") return auth;
  const saved = loadRefreshToken(path);
  return { ...auth, refreshToken: saved ?? auth.refreshToken, onRefreshToken: (t) => { saveRefreshToken(path, t); auth.onRefreshToken?.(t); } };
}
