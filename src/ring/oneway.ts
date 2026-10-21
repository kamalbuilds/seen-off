import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { RingLinkError } from "./oauth.ts";
import { loadRefreshToken, loadSecret, saveRefreshToken, saveSecret } from "./token-store.ts";

/** Ring's nonce: HMAC-SHA256(K_hmac, "<timestamp_ms>:<account_id>"), URL-safe Base64 without padding. */
export const computeNonce = (hmacKey: string, timeMs: string | number, accountId: string): string =>
  createHmac("sha256", Buffer.from(hmacKey, "utf8")).update(`${timeMs}:${accountId}`, "utf8").digest("base64url");

export interface RingDrivenConfig {
  clientId: string;
  clientSecret: string;
  /** The app's HMAC Signature Key from the Ring Developer Portal: signs nonces, and webhook bodies. */
  hmacKey: string;
  /** What the seller types at the mandatory partner sign-in, set by the operator in .env. */
  signInCode: string;
  tokenFile: string;
  oauthBase?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Unclaimed { accountId: string; accessToken: string; refreshToken: string; receivedAtMs: number }

const WINDOW_MS = 600_000;
const SKEW_MS = 60_000;
const POOL_TTL_MS = 24 * 3600_000;
const MAX_FAILURES = 5;
const sha = (s: string) => createHash("sha256").update(s).digest();
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** `u***r@partner.example.com`: first and last character of the name kept, the rest hidden. */
export const maskEmail = (email: string) => {
  const [name, domain] = email.split("@");
  return `${name.length <= 2 ? "*" : `${name[0]}***${name[name.length - 1]}`}@${domain}`;
};

/**
 * One-way (Ring-driven) account linking, as a registered Ring app uses it:
 * Ring POSTs a single-use authorization code to the Token Exchange URL (exchanged here within Ring's 60 s, held as an unclaimed token with its Ring account id),
 * then sends the user to the Account Link URL with `nonce` and `time`. The user signs in here (mandatory), the nonce is matched to exactly one unclaimed token
 * by recomputing the HMAC, and the link is confirmed with POST (nonce) then PATCH (completed) on /v1/accounts/me/app-integrations.
 */
export class RingDrivenLink {
  readonly #c: Required<Omit<RingDrivenConfig, "fetchImpl" | "now">> & { fetchImpl: typeof fetch; now: () => number };
  readonly #poolFile: string;
  #failures: number[] = [];

  constructor(c: RingDrivenConfig) {
    this.#c = { ...c, oauthBase: c.oauthBase ?? "https://oauth.ring.com", apiBase: c.apiBase ?? "https://api.amazonvision.com", fetchImpl: c.fetchImpl ?? fetch, now: c.now ?? Date.now };
    this.#poolFile = `${c.tokenFile}.unclaimed`;
  }

  #pool(): Unclaimed[] {
    const raw = loadSecret(this.#poolFile, this.#c.tokenFile);
    const now = this.#c.now();
    return raw ? (JSON.parse(raw) as Unclaimed[]).filter((t) => now - t.receivedAtMs < POOL_TTL_MS) : [];
  }
  #savePool(p: Unclaimed[]) { saveSecret(this.#poolFile, JSON.stringify(p), this.#c.tokenFile); }

  /** How many Ring confirmations are waiting for the seller to finish signing in. */
  pending(): number { return this.#pool().length; }

  /** Token Exchange URL handler. The code is single use and Ring expects it exchanged within 60 s. */
  async receiveCode(code: unknown): Promise<void> {
    if (typeof code !== "string" || code.length === 0 || code.length > 2048) throw new RingLinkError("no_code", "Ring sent no authorization code.");
    const { fetchImpl, oauthBase, apiBase } = this.#c;
    const res = await fetchImpl(`${oauthBase}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: this.#c.clientId, client_secret: this.#c.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new RingLinkError("code_rejected", `Ring would not exchange the authorization code (${res.status}).`);
    const t = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!t.access_token || !t.refresh_token) throw new RingLinkError("token_failed", "Ring's answer held no tokens.");
    const me = await fetchImpl(`${apiBase}/v1/users/me`, { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15_000) });
    if (!me.ok) throw new RingLinkError("token_failed", `Ring would not name the account (${me.status}).`);
    const accountId = ((await me.json()) as { data?: { id?: string } }).data?.id;
    if (!accountId) throw new RingLinkError("token_failed", "Ring did not return an account id.");
    const pool = this.#pool().filter((u) => u.accountId !== accountId);
    pool.push({ accountId, accessToken: t.access_token, refreshToken: t.refresh_token, receivedAtMs: this.#c.now() });
    this.#savePool(pool);
  }

  /** Account Link URL entry check: well-formed nonce and a time inside Ring's 600 s window. Throws before any sign-in is offered. */
  check(nonce: string | null, time: string | null): { nonce: string; time: string } {
    if (!nonce || !/^[A-Za-z0-9_-]{20,64}$/.test(nonce) || !time || !/^\d{13}$/.test(time)) {
      throw new RingLinkError("bad_link", "This link is missing what Ring sends with it. Start again from the Ring app.");
    }
    const age = this.#c.now() - Number(time);
    if (age > WINDOW_MS || age < -SKEW_MS) throw new RingLinkError("link_expired", "This link from Ring expired after ten minutes. Start again from the Ring app.");
    return { nonce, time };
  }

  /** The mandatory partner sign-in, then nonce match, claim, POST and PATCH. */
  async link(f: { nonce: string | null; time: string | null; email: string; passcode: string }): Promise<void> {
    const { nonce, time } = this.check(f.nonce, f.time);
    const now = this.#c.now();
    this.#failures = this.#failures.filter((t) => now - t < WINDOW_MS);
    if (this.#failures.length >= MAX_FAILURES) throw new RingLinkError("locked", "Too many wrong sign-in attempts. Wait ten minutes, then try again.");
    const email = f.email.trim();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !sameBytes(sha(f.passcode), sha(this.#c.signInCode))) {
      this.#failures.push(now);
      throw new RingLinkError("bad_sign_in", "That sign-in did not match. Check your email and the sign-in code, then try again.");
    }

    // Recompute the nonce for every unclaimed token and compare in constant time, without stopping at the first hit.
    const pool = this.#pool();
    let matched: Unclaimed | null = null;
    for (const t of pool) if (sameBytes(Buffer.from(computeNonce(this.#c.hmacKey, time, t.accountId)), Buffer.from(nonce)) && !matched) matched = t;
    if (!matched) throw new RingLinkError("bad_nonce", "Ring's link request was not recognised, or was already used. Start again from the Ring app.");

    const { fetchImpl, apiBase } = this.#c;
    const headers = { authorization: `Bearer ${matched.accessToken}`, "content-type": "application/json" };
    const post = await fetchImpl(`${apiBase}/v1/accounts/me/app-integrations`, { method: "POST", headers, body: JSON.stringify({ account_identifier: maskEmail(email), nonce }), signal: AbortSignal.timeout(15_000) });
    if (post.status === 400) throw new RingLinkError("bad_nonce", "Ring did not accept the link request. Start again from the Ring app.");
    if (!post.ok) throw new RingLinkError("confirm_failed", `Ring did not verify the link (${post.status}). Try again in a moment.`);
    const patch = await fetchImpl(`${apiBase}/v1/accounts/me/app-integrations`, { method: "PATCH", headers, body: JSON.stringify({ status: "completed" }), signal: AbortSignal.timeout(15_000) });
    if (!patch.ok) throw new RingLinkError("confirm_failed", `Ring verified the link but did not mark it complete (${patch.status}). Try again in a moment.`);

    saveRefreshToken(this.#c.tokenFile, matched.refreshToken);
    this.#savePool(pool.filter((t) => t !== matched));
    this.#failures = [];
  }

  /** The saved refresh token, for callers that need to know a link finished. */
  linked(): boolean { return loadRefreshToken(this.#c.tokenFile) !== null; }
}
