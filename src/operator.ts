import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { esc, shell } from "./ring/link-page.ts";

const SESSION_MS = 12 * 3600_000;
const LOCK_WINDOW_MS = 600_000;
const MAX_FAILURES = 5;
const sha = (s: string) => createHash("sha256").update(s).digest();
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export interface OperatorOptions {
  /** OUTBOX_SIGN_IN_CODE: the one code that opens the seller console. Rotating it ends every session. */
  code: string;
  /** Set on every https deployment: adds Secure and the __Host- prefix to the session cookie. */
  secure: boolean;
  now?: () => number;
}

/**
 * Operator sign-in for the seller console. A session is `<expiry>.<HMAC>` in an HttpOnly, SameSite=Lax cookie, signed with a key derived from the sign-in code,
 * so there is no session table and a new code invalidates every cookie. Wrong codes lock the form for ten minutes after five misses.
 */
export function createOperatorAuth(o: OperatorOptions) {
  const now = o.now ?? Date.now;
  const key = sha(`seenoff-operator-session:${o.code}`);
  const name = o.secure ? "__Host-seenoff_operator" : "seenoff_operator";
  const sign = (exp: string) => createHmac("sha256", key).update(exp).digest("base64url");
  let failures: number[] = [];
  const attrs = (maxAge: number) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${o.secure ? "; Secure" : ""}`;

  return {
    authed(req: IncomingMessage): boolean {
      const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
      const m = raw?.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/);
      return Boolean(m) && Number(m![1]) > now() && sameBytes(Buffer.from(sign(m![1])), Buffer.from(m![2]));
    },
    /** Checks the typed code. Returns the Set-Cookie value on success, or the reason it failed. */
    login(code: string): { cookie: string } | { error: string; locked: boolean } {
      failures = failures.filter((t) => now() - t < LOCK_WINDOW_MS);
      if (failures.length >= MAX_FAILURES) return { error: "Too many wrong codes. Wait ten minutes, then try again.", locked: true };
      if (code.length === 0 || code.length > 256 || !sameBytes(sha(code), sha(o.code))) {
        failures.push(now());
        return { error: "That code did not match. Check OUTBOX_SIGN_IN_CODE and try again.", locked: false };
      }
      failures = [];
      const exp = String(now() + SESSION_MS);
      return { cookie: `${name}=${exp}.${sign(exp)}; ${attrs(SESSION_MS / 1000)}` };
    },
    logoutCookie: () => `${name}=; ${attrs(0)}`,
    page(error?: string): string {
      return shell("sign in", `
<h1>Sign in to your console</h1>
<p>Pickup days, evidence and the Ring link open after you sign in. Ring's own requests do not need this page.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/login">
<label>Sign-in code<input name="code" type="password" autocomplete="current-password" required autofocus></label>
<button type="submit">Sign in</button>
</form>`);
    },
  };
}

export type OperatorAuth = ReturnType<typeof createOperatorAuth>;

/** Routes that stay open to the internet because they carry their own proof: Ring's HMAC, nonce and code checks, and the sign-in form itself. */
export const isPublicRoute = (method: string | undefined, path: string): boolean =>
  (method === "GET" && path === "/health") ||
  (method === "POST" && (path === "/ring/webhook" || path === "/ring/oauth/token" || path === "/login" || path === "/logout")) ||
  ((method === "GET" || method === "POST") && path === "/ring/link");
