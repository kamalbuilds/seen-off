// Serves the seller page over the 30 labelled replay days with no Ring credentials. Every source on the page is labelled
// REPLAY (recorded frames) or SIMULATED (signed test webhooks, Shippo test-number tracking); nothing here is presented as live.
// The receiver, runner, ledger, vision stage and evidence packet are the production code.
//
//   node scripts/replay-serve.ts                       plays day04,day05,day06,day02 then serves on :8788
//   node scripts/replay-serve.ts --days day01,day13    pick days
//   node scripts/replay-serve.ts --pace-ms 1500        pause between steps so the timeline fills in front of you
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner, type Alerter } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { visionFromEnv } from "../src/vision/index.ts";
import { REPLAY_DEVICE, SETTLE_MS, SIM_KEY, fixtureTracking, loadDays, playDay, replayFrameSource } from "../simulator/replay.ts";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const picked = flag("--days", "day04,day05,day06,day02").split(",");
const paceMs = Number(flag("--pace-ms", "0"));
const port = Number(flag("--port", process.env.PORT ?? "8788"));

const days = loadDays();
const unknown = picked.filter((id) => !days.some((d) => d.dayId === id));
if (unknown.length) throw new Error(`unknown replay days: ${unknown.join(", ")}`);

mkdirSync("data/replay-evidence", { recursive: true });
let now = 0;
const alerts: string[] = [];
const alerter: Alerter = { async send(a) { alerts.push(`${a.dayId} ${a.kind}`); console.log(`ALERT ${a.kind} ${a.dayId}: ${a.text}`); } };
const ledger = new Ledger(":memory:");
const runner = new PickupRunner({ ledger, vision: visionFromEnv(), frames: [replayFrameSource(days)], tracking: fixtureTracking, alerter, clock: () => now, settleMs: SETTLE_MS, evidenceDir: "data/replay-evidence" });
const server = createApp({
  signingKey: SIM_KEY, ledger, runner,
  devices: async () => [{ id: REPLAY_DEVICE, name: "Replay doorbell (recorded frames)", provenance: "replay" }],
});
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
console.log(`outbox replay console on ${base}`);

const pause = paceMs > 0 ? () => new Promise<void>((r) => setTimeout(r, paceMs)) : undefined;
for (const id of picked) {
  const d = days.find((x) => x.dayId === id)!;
  const r = await playDay(base, runner, d, (ms) => { now = ms; }, { pause });
  console.log(`${id} truth ${d.truth} -> ${r.verdict}`);
}
console.log(`replayed ${picked.length} days, serving on ${base}`);
