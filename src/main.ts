import { mkdirSync } from "node:fs";
import { fanoutAlerter, fileAlerter, webhookAlerter } from "./alerts.ts";
import { Ledger } from "./store/ledger.ts";
import { PickupRunner } from "./pickup/runner.ts";
import { RingSnapshotSource } from "./ring/client.ts";
import { ringIntegrationFromEnv } from "./ring/integration.ts";
import { RingSession } from "./ring/session.ts";
import { WhepFrameSource } from "./ring/whep.ts";
import { ShippoTracking } from "./shippo/client.ts";
import { visionFromEnv, type VisionProvider } from "./vision/index.ts";
import type { TrackingSource } from "./pickup/runner.ts";
import { createOperatorAuth } from "./operator.ts";
import { Scheduler } from "./pickup/scheduler.ts";
import { createApp } from "./server.ts";
import { claimWriterFromEnv } from "./pickup/claim.ts";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

mkdirSync("data", { recursive: true });
const channels = [{ name: "file", alerter: fileAlerter("data/alerts.jsonl") }];
if (process.env.ALERT_WEBHOOK_URL) channels.push({ name: "phone", alerter: webhookAlerter(process.env.ALERT_WEBHOOK_URL, "phone") });
const alerter = fanoutAlerter(channels);

const ledger = new Ledger(process.env.LEDGER_PATH ?? "data/outbox.sqlite");
const tokenFile = process.env.RING_REFRESH_TOKEN_FILE ?? "data/ring-refresh-token";
const port = Number(process.env.PORT ?? 8787);
// Ring credentials come from the Connect Ring link on the seller page (or RING_* env); the server starts either way.
const ring = new RingSession({ tokenFile });
// A missing vision or Shippo key does not stop the server: Ring linking and the console work, and the stage that needs the key fails with the reason.
const unconfigured = (what: string, why: string): (() => never) => {
  console.warn(`${what} is not configured: ${why}`);
  return () => { throw new Error(`${what} is not configured: ${why}`); };
};
const vision: VisionProvider = (() => {
  try { return visionFromEnv(); } catch (e) { const fail = unconfigured("vision", (e as Error).message); return { name: "unconfigured", model: "none", readPorch: async () => fail() }; }
})();
const tracking: TrackingSource = process.env.SHIPPO_API_KEY
  ? new ShippoTracking(process.env.SHIPPO_API_KEY)
  : { statusOf: async () => unconfigured("tracking", "SHIPPO_API_KEY is not set")() };
const runner = new PickupRunner({
  ledger,
  vision,
  frames: [new RingSnapshotSource(ring), new WhepFrameSource(ring)],
  tracking,
  alerter,
  clock: Date.now,
  evidenceDir: "data/evidence",
});

const scheduler = new Scheduler({ ledger, runner, onError: (job, e) => console.error(`job ${job.kind} ${job.dayId} failed (attempt ${job.attempts + 1}): ${e.message}`) });

const signInCode = process.env.OUTBOX_SIGN_IN_CODE;
if (!signInCode) console.warn("OUTBOX_SIGN_IN_CODE is not set: the console is open, so the server listens on 127.0.0.1 only.");
const operator = signInCode ? createOperatorAuth({ code: signInCode, secure: process.env.OUTBOX_PUBLIC_URL?.startsWith("https://") ?? false }) : undefined;

createApp({
  signingKey: need("RING_WEBHOOK_SIGNING_KEY"), ledger, runner, operator, claims: claimWriterFromEnv(),
  devices: async () => (ring.connected ? (await ring.listDevices()).map((d) => ({ id: d.id, name: d.name, provenance: "live" as const })) : []),
  ring: ringIntegrationFromEnv(process.env, { session: ring, vision, port, tokenFile, photoDir: "data/ring-photos" }),
}).listen(port, signInCode ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`seen off listening on :${port}`);
  scheduler.start();
});
setInterval(() => void runner.drain().catch((e) => console.error("drain failed", e)), 10_000).unref();
