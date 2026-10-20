import type { Frame, FrameSource } from "../pickup/runner.ts";

export class RingApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail: string) {
    super(`ring ${status} ${code}: ${detail}`);
    this.status = status;
    this.code = code;
  }
  /** RECORDING_NOT_READY (425) and SERVER_BUSY (503) clear on their own; MEDIA_NOT_FOUND (416) and 403 do not. */
  get retryable(): boolean {
    return this.status === 425 || this.status === 503 || this.status === 429;
  }
}

export interface RingDevice {
  id: string;
  name: string;
  included: unknown[];
}

export interface HistoryEvent {
  id: string;
  eventType: string;
  startMs: number;
  endMs: number;
  deviceId: string;
}

export type RingAuth =
  | { kind: "refresh"; clientId: string; clientSecret: string; refreshToken: string; onRefreshToken?: (t: string) => void }
  | { kind: "token"; token: string };

export interface RingClientOptions {
  auth: RingAuth;
  apiBase?: string;
  oauthBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** RING_CLIENT_ID, RING_CLIENT_SECRET, RING_REFRESH_TOKEN for a registered app; RING_PLAYGROUND_TOKEN for the 30 minute Playground token. */
export function ringAuthFromEnv(env: NodeJS.ProcessEnv = process.env): RingAuth {
  if (env.RING_PLAYGROUND_TOKEN) return { kind: "token", token: env.RING_PLAYGROUND_TOKEN };
  const { RING_CLIENT_ID: clientId, RING_CLIENT_SECRET: clientSecret, RING_REFRESH_TOKEN: refreshToken } = env;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("set RING_PLAYGROUND_TOKEN, or RING_CLIENT_ID + RING_CLIENT_SECRET + RING_REFRESH_TOKEN");
  }
  return { kind: "refresh", clientId, clientSecret, refreshToken };
}

export class RingClient {
  readonly #auth: RingAuth;
  readonly #api: string;
  readonly #oauth: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #access: { token: string; expiresAtMs: number } | null = null;

  constructor(o: RingClientOptions) {
    this.#auth = o.auth;
    this.#api = o.apiBase ?? "https://api.amazonvision.com";
    this.#oauth = o.oauthBase ?? "https://oauth.ring.com";
    this.#fetch = o.fetchImpl ?? fetch;
    this.#now = o.now ?? Date.now;
  }

  /** Access tokens last about 4 hours. Refresh tokens rotate on every exchange, so the new one is handed to onRefreshToken. */
  async accessToken(): Promise<string> {
    const a = this.#auth;
    if (a.kind === "token") return a.token;
    if (this.#access && this.#access.expiresAtMs - 60_000 > this.#now()) return this.#access.token;
    const res = await this.#fetch(`${this.#oauth}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refreshToken, client_id: a.clientId, client_secret: a.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new RingApiError(res.status, "OAUTH_REFRESH_FAILED", (await res.text()).slice(0, 200));
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (j.refresh_token && j.refresh_token !== a.refreshToken) {
      a.refreshToken = j.refresh_token;
      a.onRefreshToken?.(j.refresh_token);
    }
    this.#access = { token: j.access_token, expiresAtMs: this.#now() + j.expires_in * 1000 };
    return j.access_token;
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.#fetch(path.startsWith("http") ? path : `${this.#api}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    if (res.status >= 400 && res.status !== 303) throw await toApiError(res);
    return res;
  }

  /** GET /v1/devices with status, capabilities and configurations included. */
  async listDevices(): Promise<RingDevice[]> {
    const res = await this.#call("/v1/devices?include=status,capabilities,configurations");
    const j = (await res.json()) as { data: { id: string; attributes?: { name?: string } }[]; included?: unknown[] };
    return j.data.map((d) => ({ id: d.id, name: d.attributes?.name ?? d.id, included: j.included ?? [] }));
  }

  /** GET /v1/history/devices/{id}/events?event_types=..., following links.next up to maxPages. Newest first. */
  async history(deviceId: string, eventTypes: string[], maxPages = 3): Promise<HistoryEvent[]> {
    const out: HistoryEvent[] = [];
    let next: string | undefined = `/v1/history/devices/${encodeURIComponent(deviceId)}/events?event_types=${encodeURIComponent(eventTypes.join(","))}`;
    for (let page = 0; next && page < maxPages; page++) {
      const j = (await (await this.#call(next)).json()) as {
        data: { id: string; attributes: { event_type: string; start: number | string; end: number | string }; relationships?: { source?: { data?: { id?: string } } } }[];
        links?: { next?: string };
      };
      for (const e of j.data) {
        out.push({ id: e.id, eventType: e.attributes.event_type, startMs: Number(e.attributes.start), endMs: Number(e.attributes.end), deviceId: e.relationships?.source?.data?.id ?? deviceId });
      }
      next = j.links?.next;
    }
    return out;
  }

  /** POST media/image/download, then follow the 303 to the signed download URL (without the bearer). Watermark is always applied by Ring. */
  async snapshotAt(deviceId: string, atMs: number, componentId?: string): Promise<Frame> {
    const body: Record<string, unknown> = { type: "at_timestamp", timestamp: atMs, image_options: { format: "jpeg" } };
    if (componentId !== undefined) body.components = [{ component_id: componentId }];
    const first = await this.#call(`/v1/devices/${encodeURIComponent(deviceId)}/media/image/download`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual",
    });
    const loc = first.status === 303 ? first.headers.get("location") : null;
    if (!loc) throw new RingApiError(first.status, "NO_REDIRECT", "image/download did not answer 303 with a Location");
    const img = await this.#fetch(loc, { signal: AbortSignal.timeout(20_000) });
    if (!img.ok) throw await toApiError(img);
    return {
      jpeg: new Uint8Array(await img.arrayBuffer()),
      mediaTimestampMs: Number(img.headers.get("x-media-timestamp") ?? atMs),
      origin: img.headers.get("x-media-origin") ?? "unknown",
    };
  }

  /** POST the SDP offer (fully gathered, recvonly) to the WHEP endpoint. 201 returns the answer and the session URL. */
  async whepStart(deviceId: string, sdpOffer: string, componentId?: string): Promise<{ answerSdp: string; sessionUrl: string }> {
    const q = componentId === undefined ? "" : `?component_id=${encodeURIComponent(componentId)}`;
    const res = await this.#call(`/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions${q}`, {
      method: "POST", headers: { "content-type": "application/sdp" }, body: sdpOffer,
    });
    const sessionUrl = res.headers.get("location");
    if (res.status !== 201 || !sessionUrl) throw new RingApiError(res.status, "WHEP_NOT_CREATED", "expected 201 with a Location header");
    return { answerSdp: await res.text(), sessionUrl };
  }

  /** Close the session so a battery camera stops streaming. */
  async whepStop(sessionUrl: string): Promise<void> {
    await this.#call(sessionUrl, { method: "DELETE" });
  }
}

async function toApiError(res: Response): Promise<RingApiError> {
  const text = await res.text();
  try {
    const e = (JSON.parse(text) as { errors?: { code?: string; detail?: string }[] }).errors?.[0];
    if (e) return new RingApiError(res.status, e.code ?? "UNKNOWN", e.detail ?? "");
  } catch { /* not JSON:API, fall through */ }
  return new RingApiError(res.status, "UNKNOWN", text.slice(0, 200));
}

/** Snapshot with a short wait for RECORDING_NOT_READY, which Ring documents as a transient state right after an event. */
export class RingSnapshotSource implements FrameSource {
  readonly name = "ring-snapshot";
  readonly #client: RingClient;
  readonly #attempts: number;
  readonly #waitMs: number;

  constructor(client: RingClient, attempts = 4, waitMs = 3000) {
    this.#client = client;
    this.#attempts = attempts;
    this.#waitMs = waitMs;
  }

  async frameAt(deviceId: string, atMs: number): Promise<Frame> {
    for (let i = 1; ; i++) {
      try {
        return await this.#client.snapshotAt(deviceId, atMs);
      } catch (e) {
        if (!(e instanceof RingApiError) || !e.retryable || i >= this.#attempts) throw e;
        await new Promise((r) => setTimeout(r, this.#waitMs * i));
      }
    }
  }
}
