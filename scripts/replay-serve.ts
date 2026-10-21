// Serves the seller page over the 30 recorded pickup days with no Ring credentials: "Replay a pickup day" plays one through the
// production receiver (HMAC-signed v1.1 deliveries), runner, ledger, vision stage and evidence packet while the timeline fills in.
//
//   node scripts/replay-serve.ts                       plays day04,day05,day06,day02 then serves on :8788
//   node scripts/replay-serve.ts --days day01,day13    pick the days played at start
//   node scripts/replay-serve.ts --pace-ms 1500        pause between steps of a replay started from the page (900 ms minimum)
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
let playing = false;
let base = "";
const pace = () => new Promise<void>((r) => setTimeout(r, Math.max(paceMs, 900)));
const server = createApp({
  signingKey: SIM_KEY, ledger, runner,
  devices: async () => [{ id: REPLAY_DEVICE, name: "Front door", provenance: "replay" }],
  replay: {
    days: () => days.map((d) => ({ dayId: d.dayId, labels: d.labels.length, startMs: d.windowStartMs })),
    start(dayId) {
      if (playing) throw new Error("another pickup day is still replaying");
      const spec = days.find((x) => x.dayId === dayId)!;
      let name = dayId, n = 1;
      while (ledger.hasDay(name)) name = `${dayId}-replay-${++n}`;
      playing = true;
      void playDay(base, runner, { ...spec, dayId: name }, (ms) => { now = ms; }, { pause: pace })
        .catch((e) => console.error(`replay ${name} failed`, e))
        .finally(() => { playing = false; });
      return name;
    },
  },
});
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
console.log(`outbox replay console on ${base}`);

const pause = paceMs > 0 ? () => new Promise<void>((r) => setTimeout(r, paceMs)) : undefined;
for (const id of picked) {
  const d = days.find((x) => x.dayId === id)!;
  const r = await playDay(base, runner, d, (ms) => { now = ms; }, { pause });
  console.log(`${id} truth ${d.truth} -> ${r.verdict}`);
}
console.log(`replayed ${picked.length} days, serving on ${base}`);
