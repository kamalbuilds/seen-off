import { appendFileSync, mkdirSync } from "node:fs";
import { Ledger } from "./store/ledger.ts";
import { PickupRunner, type Alerter } from "./pickup/runner.ts";
import { RingClient, RingSnapshotSource, ringAuthFromEnv } from "./ring/client.ts";
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
const alerter: Alerter = {
  async send(a) {
    appendFileSync("data/alerts.jsonl", JSON.stringify({ at: new Date().toISOString(), ...a }) + "\n");
    console.log(`ALERT ${a.kind} ${a.dayId}: ${a.text}`);
  },
};

const ledger = new Ledger(process.env.LEDGER_PATH ?? "data/outbox.sqlite");
const ring = new RingClient({ auth: ringAuthFromEnv() });
const runner = new PickupRunner({
  ledger,
  vision: visionFromEnv(),
  frames: [new RingSnapshotSource(ring), new WhepFrameSource(ring)],
  tracking: new ShippoTracking(need("SHIPPO_API_KEY")),
  alerter,
  clock: Date.now,
  evidenceDir: "data/evidence",
});

const scheduler = new Scheduler({ ledger, runner, onError: (job, e) => console.error(`job ${job.kind} ${job.dayId} failed (attempt ${job.attempts + 1}): ${e.message}`) });

const port = Number(process.env.PORT ?? 8787);
createApp({
  signingKey: need("RING_WEBHOOK_SIGNING_KEY"), ledger, runner,
  devices: async () => (await ring.listDevices()).map((d) => ({ id: d.id, name: d.name, provenance: "live" as const })),
}).listen(port, () => {
  console.log(`outbox listening on :${port}`);
  scheduler.start();
});
setInterval(() => void runner.drain().catch((e) => console.error("drain failed", e)), 10_000).unref();
