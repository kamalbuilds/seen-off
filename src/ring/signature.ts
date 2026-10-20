import { createHmac, timingSafeEqual } from "node:crypto";

/** "sha256=<hex>" over the exact bytes sent, keyed with the UTF-8 HMAC signing key (Ring docs, Notifications). */
export function signBody(signingKey: string, rawBody: Uint8Array | string): string {
  return `sha256=${createHmac("sha256", signingKey).update(rawBody).digest("hex")}`;
}

/** Verify first, parse second: this takes raw bytes, never re-serialised JSON. Fails closed on anything malformed. */
export function verifySignature(signingKey: string, rawBody: Uint8Array, header: string | undefined): boolean {
  if (!signingKey || !header) return false;
  const received = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  if (!/^[0-9a-f]{64}$/i.test(received)) return false;
  const expected = createHmac("sha256", signingKey).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}
