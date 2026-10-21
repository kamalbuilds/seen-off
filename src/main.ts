import { mkdirSync } from "node:fs";
import { fanoutAlerter, fileAlerter, webhookAlerter } from "./alerts.ts";
import { Ledger } from "./store/ledger.ts";
import { PickupRunner } from "./pickup/runner.ts";
import { RingSnapshotSource } from "./ring/client.ts";
import { ringIntegrationFromEnv } from "./ring/integration.ts";
import { RingSession } from "./ring/session.ts";
import { WhepFrameSource } from "./ring/whep.ts";
import { ShippoTracking } from "./shippo/client.ts";
import { visionFromEnv } from "./vision/index.ts";
import { Scheduler } from "./pickup/scheduler.ts";
import { createApp } from "./server.ts";

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
const vision = visionFromEnv();
const runner = new PickupRunner({
  ledger,
  vision,
  frames: [new RingSnapshotSource(ring), new WhepFrameSource(ring)],
  tracking: new ShippoTracking(need("SHIPPO_API_KEY")),
  alerter,
  clock: Date.now,
  evidenceDir: "data/evidence",
});

const scheduler = new Scheduler({ ledger, runner, onError: (job, e) => console.error(`job ${job.kind} ${job.dayId} failed (attempt ${job.attempts + 1}): ${e.message}`) });

createApp({
  signingKey: need("RING_WEBHOOK_SIGNING_KEY"), ledger, runner,
  devices: async () => (ring.connected ? (await ring.listDevices()).map((d) => ({ id: d.id, name: d.name, provenance: "live" as const })) : []),
  ring: ringIntegrationFromEnv(process.env, { session: ring, vision, port, tokenFile, photoDir: "data/ring-photos" }),
}).listen(port, () => {
  console.log(`outbox listening on :${port}`);
  scheduler.start();
});
setInterval(() => void runner.drain().catch((e) => console.error("drain failed", e)), 10_000).unref();
