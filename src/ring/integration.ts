import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VisionProvider } from "../vision/types.ts";
import { RingSnapshotSource } from "./client.ts";
import { RingLink, RingLinkError } from "./oauth.ts";
import { jpegSize } from "./probe.ts";
import type { RingSession } from "./session.ts";

export const SETUP_NOTE = "Connect Ring signs you in on Ring's own page. One step first: add this app's Ring client ID and secret as RING_CLIENT_ID and RING_CLIENT_SECRET in .env, then restart.";

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

export interface RingIntegration {
  status(): { configured: boolean; connected: boolean; setup: string | null };
  /** The Ring sign-in URL. Throws RingLinkError with the setup note when no client id is configured. */
  connect(): string;
  callback(q: URLSearchParams): Promise<void>;
  devices(): Promise<{ id: string; name: string }[]>;
  photo(deviceId: string): Promise<PorchPhoto>;
  photoFile(name: string): Buffer | null;
}

export interface RingIntegrationOptions {
  session: RingSession;
  vision: VisionProvider;
  photoDir: string;
  /** Present only when RING_CLIENT_ID and RING_CLIENT_SECRET are configured. */
  link?: RingLink;
  now?: () => number;
}

export function createRingIntegration(o: RingIntegrationOptions): RingIntegration {
  const now = o.now ?? Date.now;
  const PHOTO = /^[A-Za-z0-9_-]{1,80}\.jpg$/;
  return {
    status: () => ({ configured: o.session.configured || Boolean(o.link), connected: o.session.connected, setup: o.link || o.session.configured ? null : SETUP_NOTE }),
    connect() {
      if (!o.link) throw new RingLinkError("not_configured", SETUP_NOTE);
      return o.link.begin();
    },
    async callback(q) {
      if (!o.link) throw new RingLinkError("not_configured", SETUP_NOTE);
      await o.link.complete(q);
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

/** Builds the integration from env: a link only when the app's client id and secret are present. */
export function ringIntegrationFromEnv(env: NodeJS.ProcessEnv, deps: { session: RingSession; vision: VisionProvider; port: number; tokenFile: string; photoDir: string; fetchImpl?: typeof fetch }): RingIntegration {
  const link = env.RING_CLIENT_ID && env.RING_CLIENT_SECRET
    ? new RingLink({
      clientId: env.RING_CLIENT_ID, clientSecret: env.RING_CLIENT_SECRET, tokenFile: deps.tokenFile, fetchImpl: deps.fetchImpl,
      redirectUri: env.RING_REDIRECT_URI ?? `http://localhost:${deps.port}/ring/callback`,
      authorizeUrl: env.RING_AUTHORIZE_URL, oauthBase: env.RING_OAUTH_BASE, apiBase: env.RING_API_BASE,
    })
    : undefined;
  return createRingIntegration({ session: deps.session, vision: deps.vision, photoDir: deps.photoDir, link });
}
