import { createHash, randomBytes } from "node:crypto";
import { saveRefreshToken } from "./token-store.ts";

/** An error whose message is written for the seller looking at the page. `code` is stable for tests and logs. */
export class RingLinkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface RingLinkConfig {
  clientId: string;
  clientSecret: string;
  /** One of the redirect URIs registered for the app in the Ring Developer Portal, matched exactly by Ring. */
  redirectUri: string;
  tokenFile: string;
  /** Shown to Ring in masked form as the integration's account_identifier. */
  accountLabel?: string;
  authorizeUrl?: string;
  oauthBase?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Pending { verifier: string; createdAtMs: number }

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
const b64 = (b: Buffer) => b.toString("base64url");

/** `u***r`: the first and last character with the middle hidden, the shape Ring's docs show for account_identifier. */
export const maskIdentifier = (s: string) => (s.length <= 2 ? "***" : `${s[0]}***${s[s.length - 1]}`);

/**
 * Partner-initiated OAuth 2.0 account linking with PKCE S256, as the Ring docs lay it out:
 * redirect to account.ring.com/account/integrations/partner-link/authorize, validate `state` on the callback,
 * exchange the single-use code at oauth.ring.com/oauth/token with the code_verifier, then PATCH /v1/accounts/me/app-integrations to completed.
 */
export class RingLink {
  readonly #c: Required<Omit<RingLinkConfig, "fetchImpl" | "now">> & { fetchImpl: typeof fetch; now: () => number };
  readonly #pending = new Map<string, Pending>();

  constructor(c: RingLinkConfig) {
    this.#c = {
      clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri, tokenFile: c.tokenFile,
      accountLabel: c.accountLabel ?? "seen-off",
      authorizeUrl: c.authorizeUrl ?? "https://account.ring.com/account/integrations/partner-link/authorize",
      oauthBase: c.oauthBase ?? "https://oauth.ring.com", apiBase: c.apiBase ?? "https://api.amazonvision.com",
      fetchImpl: c.fetchImpl ?? fetch, now: c.now ?? Date.now,
    };
  }

  /** The Ring sign-in URL for this attempt. The verifier and state stay on the server, keyed by the state. */
  begin(): string {
    const now = this.#c.now();
    for (const [k, v] of this.#pending) if (now - v.createdAtMs > STATE_TTL_MS) this.#pending.delete(k);
    while (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value!);
    const state = b64(randomBytes(32));
    const verifier = b64(randomBytes(32));
    this.#pending.set(state, { verifier, createdAtMs: now });
    const u = new URL(this.#c.authorizeUrl);
    u.search = new URLSearchParams({
      client_id: this.#c.clientId, redirect_uri: this.#c.redirectUri, response_type: "code", scope: "ava.v1:read", state,
      code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    }).toString();
    return u.toString();
  }

  /** Handles Ring's redirect back. A state that was not issued here, was already used or has expired is refused before any request to Ring. */
  async complete(q: URLSearchParams): Promise<void> {
    const state = q.get("state") ?? "";
    const pending = this.#pending.get(state);
    this.#pending.delete(state); // single use, whatever happens next
    if (!pending) throw new RingLinkError("bad_state", "This sign-in did not start here, or it was already used. Start Connect Ring again.");
    if (this.#c.now() - pending.createdAtMs > STATE_TTL_MS) throw new RingLinkError("state_expired", "The sign-in took too long and expired. Start Connect Ring again.");

    const err = q.get("error");
    if (err) {
      const why = q.get("error_description");
      throw new RingLinkError(err, err === "access_denied"
        ? why === "ring_base_plan_required" ? "None of your Ring devices has an active Ring plan, so Ring cannot share them. Add a plan in the Ring app and try again."
          : "Ring was not given access, so nothing was linked. Connect Ring again when you are ready."
        : `Ring could not finish the sign-in (${err}). Try again in a moment.`);
    }
    const code = q.get("code");
    if (!code) throw new RingLinkError("no_code", "Ring did not send back a sign-in code. Start Connect Ring again.");

    const res = await this.#c.fetchImpl(`${this.#c.oauthBase}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: pending.verifier, client_id: this.#c.clientId, client_secret: this.#c.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 400) throw new RingLinkError("code_expired", "The sign-in code expired or was already used. Start Connect Ring again.");
    if (res.status === 401) throw new RingLinkError("bad_client", "Ring did not accept this app's client ID and secret. Check RING_CLIENT_ID and RING_CLIENT_SECRET.");
    if (!res.ok) throw new RingLinkError("token_failed", `Ring answered ${res.status} when the sign-in code was exchanged. Try again in a moment.`);
    const tokens = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!tokens.access_token || !tokens.refresh_token) throw new RingLinkError("token_failed", "Ring's answer held no tokens. Try again in a moment.");

    const confirm = await this.#c.fetchImpl(`${this.#c.apiBase}/v1/accounts/me/app-integrations`, {
      method: "PATCH", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", account_identifier: maskIdentifier(this.#c.accountLabel) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!confirm.ok) throw new RingLinkError("confirm_failed", `Ring signed you in but did not confirm the link (${confirm.status}), so it was not saved. Start Connect Ring again.`);
    saveRefreshToken(this.#c.tokenFile, tokens.refresh_token);
  }
}
