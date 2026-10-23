import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VisionProvider } from "../vision/types.ts";
import { RingSnapshotSource } from "./client.ts";
import { RingLink, RingLinkError } from "./oauth.ts";
import { RingDrivenLink } from "./oneway.ts";
import { jpegSize } from "./probe.ts";
import type { RingSession } from "./session.ts";

export const SETUP_NOTE = "Connect Ring needs one setup step: add this app's Ring client ID, client secret and HMAC key as RING_CLIENT_ID, RING_CLIENT_SECRET and RING_WEBHOOK_SIGNING_KEY, plus a sign-in code as SEEN_OFF_SIGN_IN_CODE and this server's public https address as SEEN_OFF_PUBLIC_URL, in .env, then restart.";
/** SEEN_OFF_PUBLIC_URL or SEEN_OFF_SIGN_IN_CODE, honouring the OUTBOX_* names that servers deployed before the rename still carry. */
export const seenOffEnv = (env: NodeJS.ProcessEnv, k: "PUBLIC_URL" | "SIGN_IN_CODE"): string | undefined => env[`SEEN_OFF_${k}`] || env[`OUTBOX_${k}`] || undefined;

export const SETUP_NOTE_PARTNER = "Connect Ring signs you in on Ring's own page. One step first: add this app's Ring client ID and secret as RING_CLIENT_ID and RING_CLIENT_SECRET in .env, then restart.";
export const RING_DRIVEN_STEPS = "Open the Ring app, go to Appstore, choose Seen Off and tap Connect. Ring brings you back here for a quick sign-in, and this panel updates when the link is done.";

/** The values to enter under Account linking, Webhook and scopes in the Ring Developer Portal, from the public HTTPS address of this server. */
export interface ConsoleSettings {
  accountLinkUrl: string;
  tokenExchangeUrl: string;
  webhookUrl: string;
  appHomepageUrl: string;
  oauthRedirectUri: string;
  scopes: string;
}

export function consoleSettings(publicUrl: string | undefined): ConsoleSettings | null {
  if (!publicUrl) return null;
  const u = publicUrl.replace(/\/+$/, "");
  if (!/^https:\/\//.test(u)) return null;
  return { accountLinkUrl: `${u}/ring/link`, tokenExchangeUrl: `${u}/ring/oauth/token`, webhookUrl: `${u}/ring/webhook`, appHomepageUrl: `${u}/`, oauthRedirectUri: `${u}/ring/callback`, scopes: "Cameras and Doorbells" };
}

export interface PorchPhoto {
  deviceId: string;
  name: string;
  image: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  mediaTimestamp: string;
  mediaOrigin: string;
  latencyMs: number;
  porch: { provider: string; model: string; present: boolean; count: number } | { error: string };
}

export type LinkMethod = "ring-driven" | "partner-initiated";

export interface RingIntegration {
  status(): { configured: boolean; connected: boolean; method: LinkMethod; setup: string | null; steps: string | null; console: ConsoleSettings | null; waiting: number };
  /** Partner-initiated: the Ring sign-in URL. Ring-driven: throws the steps to take in the Ring app. Throws the setup note when not configured. */
  connect(): string;
  callback(q: URLSearchParams): Promise<void>;
  /** Ring-driven: Token Exchange URL (Ring posts the authorization code here). */
  tokenExchange(code: unknown): Promise<void>;
  /** Ring-driven: Account Link URL entry. Throws RingLinkError for an expired or malformed link. */
  linkEntry(nonce: string | null, time: string | null): { nonce: string; time: string };
  /** Ring-driven: the seller's sign-in, nonce match and confirmation. */
  linkSubmit(f: { nonce: string | null; time: string | null; email: string; passcode: string }): Promise<void>;
  devices(): Promise<{ id: string; name: string }[]>;
  photo(deviceId: string): Promise<PorchPhoto>;
  photoFile(name: string): Buffer | null;
}

export interface RingIntegrationOptions {
  session: RingSession;
  vision: VisionProvider;
  photoDir: string;
  method?: LinkMethod;
  /** Partner-initiated OAuth: present only for an allowlisted app with RING_CLIENT_ID and RING_CLIENT_SECRET. */
  link?: RingLink;
  /** Ring-driven account linking: present with the client id, secret, HMAC key and a sign-in code. */
  driven?: RingDrivenLink;
  console?: ConsoleSettings | null;
  now?: () => number;
}

export function createRingIntegration(o: RingIntegrationOptions): RingIntegration {
  const now = o.now ?? Date.now;
  const PHOTO = /^[A-Za-z0-9_-]{1,80}\.jpg$/;
  const method = o.method ?? "ring-driven";
  const ready = method === "ring-driven" ? Boolean(o.driven) : Boolean(o.link);
  const setup = method === "ring-driven" ? SETUP_NOTE : SETUP_NOTE_PARTNER;
  return {
    status: () => ({
      configured: ready, connected: o.session.connected, method,
      setup: ready || o.session.connected ? null : setup,
      steps: method === "ring-driven" && ready ? RING_DRIVEN_STEPS : null,
      console: o.console ?? null, waiting: o.driven?.pending() ?? 0,
    }),
    connect() {
      if (!ready) throw new RingLinkError("not_configured", setup);
      if (method === "ring-driven") throw new RingLinkError("ring_driven", RING_DRIVEN_STEPS);
      return o.link!.begin();
    },
    async callback(q) {
      if (!o.link) throw new RingLinkError("not_configured", SETUP_NOTE_PARTNER);
      await o.link.complete(q);
      o.session.reset();
    },
    async tokenExchange(code) {
      if (!o.driven) throw new RingLinkError("not_configured", SETUP_NOTE);
      await o.driven.receiveCode(code);
    },
    linkEntry(nonce, time) {
      if (!o.driven) throw new RingLinkError("not_configured", SETUP_NOTE);
      return o.driven.check(nonce, time);
    },
    async linkSubmit(f) {
      if (!o.driven) throw new RingLinkError("not_configured", SETUP_NOTE);
      await o.driven.link(f);
      o.session.reset();
    },
    async devices() {
      return (await o.session.listDevices()).map((d) => ({ id: d.id, name: d.name }));
    },
    async photo(deviceId) {
      const devices = await o.session.listDevices();
      const dev = devices.find((d) => d.id === deviceId);
      if (!dev) throw new RingLinkError("unknown_device", "That doorbell is not on this Ring account.");
      const t0 = performance.now();
      const frame = await new RingSnapshotSource(o.session).frameAt(deviceId, now() - 60_000);
      const latencyMs = Math.round(performance.now() - t0);
      const sha256 = createHash("sha256").update(frame.jpeg).digest("hex");
      mkdirSync(o.photoDir, { recursive: true });
      const file = `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${sha256.slice(0, 8)}.jpg`;
      writeFileSync(join(o.photoDir, file), frame.jpeg);
      const size = jpegSize(frame.jpeg);
      let porch: PorchPhoto["porch"];
      try { const r = await o.vision.readPorch(frame.jpeg); porch = { provider: o.vision.name, model: o.vision.model, present: r.present, count: r.count }; }
      catch (e) { porch = { error: (e as Error).message }; }
      return {
        deviceId, name: dev.name, image: `/api/ring/photos/${file}`, bytes: frame.jpeg.length, sha256, width: size?.width ?? null, height: size?.height ?? null,
        mediaTimestamp: new Date(frame.mediaTimestampMs).toISOString(), mediaOrigin: frame.origin, latencyMs, porch,
      };
    },
    photoFile(name) {
      if (!PHOTO.test(name)) return null;
      const p = join(o.photoDir, name);
      return existsSync(p) ? readFileSync(p) : null;
    },
  };
}

/**
 * Builds the integration from env. RING_LINK_METHOD picks the link: ring-driven (default, any registered app) or partner-initiated (allowlisted apps).
 * Ring-driven needs RING_CLIENT_ID, RING_CLIENT_SECRET, RING_WEBHOOK_SIGNING_KEY (the app's HMAC key) and SEEN_OFF_SIGN_IN_CODE.
 */
export function ringIntegrationFromEnv(env: NodeJS.ProcessEnv, deps: { session: RingSession; vision: VisionProvider; port: number; tokenFile: string; photoDir: string; fetchImpl?: typeof fetch }): RingIntegration {
  const method: LinkMethod = env.RING_LINK_METHOD === "partner-initiated" ? "partner-initiated" : "ring-driven";
  const hasApp = Boolean(env.RING_CLIENT_ID && env.RING_CLIENT_SECRET);
  const publicUrl = seenOffEnv(env, "PUBLIC_URL")?.replace(/\/+$/, "");
  const signInCode = seenOffEnv(env, "SIGN_IN_CODE");
  const link = method === "partner-initiated" && hasApp
    ? new RingLink({
      clientId: env.RING_CLIENT_ID!, clientSecret: env.RING_CLIENT_SECRET!, tokenFile: deps.tokenFile, fetchImpl: deps.fetchImpl,
      redirectUri: env.RING_REDIRECT_URI ?? `${publicUrl ?? `http://localhost:${deps.port}`}/ring/callback`,
      authorizeUrl: env.RING_AUTHORIZE_URL, oauthBase: env.RING_OAUTH_BASE, apiBase: env.RING_API_BASE,
    })
    : undefined;
  const driven = method === "ring-driven" && hasApp && env.RING_WEBHOOK_SIGNING_KEY && signInCode
    ? new RingDrivenLink({
      clientId: env.RING_CLIENT_ID!, clientSecret: env.RING_CLIENT_SECRET!, hmacKey: env.RING_WEBHOOK_SIGNING_KEY, signInCode,
      tokenFile: deps.tokenFile, fetchImpl: deps.fetchImpl, oauthBase: env.RING_OAUTH_BASE, apiBase: env.RING_API_BASE,
    })
    : undefined;
  return createRingIntegration({ session: deps.session, vision: deps.vision, photoDir: deps.photoDir, method, link, driven, console: consoleSettings(publicUrl) });
}
