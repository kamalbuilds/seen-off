import { existsSync } from "node:fs";
import { RingClient, type RingApi, type RingAuth } from "./client.ts";
import { loadRefreshToken, withPersistedRefreshToken } from "./token-store.ts";

export class RingNotConnected extends Error {
  constructor() { super("Ring is not connected yet. Use Connect Ring on the seller page."); }
}

export interface RingSessionOptions {
  env?: NodeJS.ProcessEnv;
  tokenFile: string;
  fetchImpl?: typeof fetch;
}

/**
 * The Ring API for whoever is signed in right now. Credentials come from the Connect Ring link (the encrypted refresh token file) or,
 * for a registered app run headless, from RING_* env; a Playground token works too. The client is built on first use and rebuilt after a link.
 */
export class RingSession implements RingApi {
  readonly #o: Required<Pick<RingSessionOptions, "env" | "tokenFile">> & Pick<RingSessionOptions, "fetchImpl">;
  #client: RingClient | null = null;

  constructor(o: RingSessionOptions) { this.#o = { env: process.env, ...o }; }

  get configured(): boolean { return Boolean(this.#o.env.RING_PLAYGROUND_TOKEN || (this.#o.env.RING_CLIENT_ID && this.#o.env.RING_CLIENT_SECRET)); }

  get connected(): boolean {
    const e = this.#o.env;
    if (e.RING_PLAYGROUND_TOKEN) return true;
    return Boolean(e.RING_CLIENT_ID && e.RING_CLIENT_SECRET && (existsSync(this.#o.tokenFile) || e.RING_REFRESH_TOKEN));
  }

  /** Call after a link completes so the next request uses the new token. */
  reset(): void { this.#client = null; }

  #get(): RingClient {
    if (this.#client) return this.#client;
    const e = this.#o.env;
    let auth: RingAuth;
    if (e.RING_PLAYGROUND_TOKEN) auth = { kind: "token", token: e.RING_PLAYGROUND_TOKEN };
    else {
      const saved = e.RING_CLIENT_ID && e.RING_CLIENT_SECRET ? loadRefreshToken(this.#o.tokenFile) ?? e.RING_REFRESH_TOKEN : undefined;
      if (!saved) throw new RingNotConnected();
      auth = withPersistedRefreshToken({ kind: "refresh", clientId: e.RING_CLIENT_ID!, clientSecret: e.RING_CLIENT_SECRET!, refreshToken: saved }, this.#o.tokenFile);
    }
    return (this.#client = new RingClient({ auth, apiBase: e.RING_API_BASE, oauthBase: e.RING_OAUTH_BASE, fetchImpl: this.#o.fetchImpl }));
  }

  accessToken() { return this.#get().accessToken(); }
  listDevices() { return this.#get().listDevices(); }
  history(...a: Parameters<RingClient["history"]>) { return this.#get().history(...a); }
  snapshotAt(...a: Parameters<RingClient["snapshotAt"]>) { return this.#get().snapshotAt(...a); }
  whepStart(...a: Parameters<RingClient["whepStart"]>) { return this.#get().whepStart(...a); }
  whepStop(...a: Parameters<RingClient["whepStop"]>) { return this.#get().whepStop(...a); }
}
