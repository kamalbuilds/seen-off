// Serves the seller page over the 30 recorded pickup days with no Ring credentials: "Replay a pickup day" plays one through the
// production receiver (HMAC-signed v1.1 deliveries), runner, ledger, vision stage and evidence packet while the timeline fills in.
//
//   node scripts/replay-serve.ts                       serves on :8788; the page plays the three-day demo on load
//   node scripts/replay-serve.ts --days day01,day13    also replay these days before serving
//   node scripts/replay-serve.ts --demo day05,day06,day15   the three demo days: a missed day, a part-taken day, an unscanned day
//   node scripts/replay-serve.ts --pace-ms 1500        pause between steps of a replay started from the page (800 ms minimum)
//   node scripts/replay-serve.ts --public              public read-only demo on 0.0.0.0: plays and shows recorded days, refuses arm, delete and Ring routes
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner, type Alerter } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { RingSession } from "../src/ring/session.ts";
import { ringIntegrationFromEnv } from "../src/ring/integration.ts";
import { visionFromEnv } from "../src/vision/index.ts";
import { DEFAULT_TIME_ZONE, dayTitle } from "../src/pickup/time.ts";
import { REPLAY_DEVICE, SETTLE_MS, SIM_KEY, fixtureTracking, loadDays, playDay, replayFrameSource, root } from "../simulator/replay.ts";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const picked = flag("--days", "").split(",").filter(Boolean);
const demoIds = flag("--demo", "day05,day06,day15").split(",");
const paceMs = Number(flag("--pace-ms", "0"));
const port = Number(flag("--port", process.env.PORT ?? "8788"));
const isPublic = args.includes("--public");

const days = loadDays();
const unknown = picked.filter((id) => !days.some((d) => d.dayId === id));
for (const id of demoIds) if (!days.some((d) => d.dayId === id)) unknown.push(id);
if (unknown.length) throw new Error(`unknown replay days: ${unknown.join(", ")}`);

mkdirSync("data/replay-evidence", { recursive: true });
let now = 0;
const alerts: string[] = [];
const alerter: Alerter = { async send(a) { alerts.push(`${a.dayId} ${a.kind}`); console.log(`ALERT ${a.kind} ${a.dayId}: ${a.text}`); } };
const ledger = new Ledger(":memory:");
// Live Qwen3-VL on Bedrock when a key is set; otherwise the readings that model gave on these exact frames, keyed by frame sha256.
const vision = visionFromEnv(process.env, join(root, "simulator/qwen3-vl-reads.json"));
console.log(`vision: ${vision.name}/${vision.model}`);
const runner = new PickupRunner({ ledger, vision, frames: [replayFrameSource(days)], tracking: fixtureTracking, alerter, clock: () => now, settleMs: SETTLE_MS, evidenceDir: "data/replay-evidence" });
let playing = false;
// One seller, three scheduled parcels, three days back to back: nobody collects them, one leaves, all leave and nothing is scanned.
// Each step carries the seller post it answers (docs/xsignals-ring/signals.md), quoted verbatim.
const DEMO_STEPS = [
  { name: "demo-missed", title: "The carrier never comes", blurb: "Three parcels wait on the porch. The window closes with all three still there, and the alert goes out while there is time to drop them off.",
    quote: { text: "Why am I still looking at the package by my door ???", by: "Nydollxo__", url: "https://x.com/Nydollxo__/status/2104719305418084376" } },
  { name: "demo-partial", title: "One parcel leaves", blurb: "Motion at the door, then one parcel gone and two left behind. The alert counts them: 1 of 3 taken, 2 still on the porch.",
    quote: { text: "it shows the UPS man picking up one of the three packages and then leaving", by: "Violetsvanity7", url: "https://x.com/Violetsvanity7/status/2001482225116754149" } },
  { name: "demo-unscanned", title: "Everything leaves, nothing is scanned", blurb: "The porch is empty at close, but 24 h later the labels still read label created. The evidence packet proves the handoff.",
    quote: { text: "I literally have ring camera footage of the mailman taking them and they never arrived", by: "AQualityMess", url: "https://x.com/AQualityMess/status/2018955222945832974" } },
];
const demo: { running: boolean; current: string | null; names: string[] } = { running: false, current: null, names: [] };
if (demoIds.length !== DEMO_STEPS.length) throw new Error(`--demo needs ${DEMO_STEPS.length} recorded day ids`);
let base = "";
const pace = () => new Promise<void>((r) => setTimeout(r, Math.max(paceMs, 800)));
const options: Parameters<typeof createApp>[0] = {
  signingKey: SIM_KEY, ledger, runner,
  ring: isPublic ? undefined : ringIntegrationFromEnv(process.env, { session: new RingSession({ tokenFile: "data/ring-refresh-token" }), vision, port, tokenFile: "data/ring-refresh-token", photoDir: "data/ring-photos" }),
  devices: async () => [{ id: REPLAY_DEVICE, name: "Front door", provenance: "replay" }],
  replay: {
    days: () => days.map((d) => ({ dayId: d.dayId, labels: d.labels.length, startMs: d.windowStartMs, title: dayTitle(d.windowStartMs, d.windowEndMs, DEFAULT_TIME_ZONE), timeZone: DEFAULT_TIME_ZONE })),
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
    demo: {
      status: () => ({ running: demo.running, current: demo.current, steps: DEMO_STEPS.map((s, i) => ({ title: s.title, blurb: s.blurb, quote: s.quote, dayId: demo.names[i] ?? null })) }),
      start() {
        if (playing) throw new Error("a pickup day is still replaying");
        playing = true;
        demo.running = true; demo.names = []; demo.current = null;
        void (async () => {
          for (const [i, id] of demoIds.entries()) {
            const spec = days.find((x) => x.dayId === id)!;
            let name = DEMO_STEPS[i].name, n = 1;
            while (ledger.hasDay(name)) name = `${DEMO_STEPS[i].name}-${++n}`;
            demo.names[i] = name; demo.current = name;
            await playDay(base, runner, { ...spec, dayId: name }, (ms) => { now = ms; }, { pause: pace });
          }
        })().catch((e) => console.error("demo failed", e)).finally(() => { demo.running = false; playing = false; });
      },
    },
  },
};
// The replay arms days and signs webhooks over HTTP. In public mode it talks to a loopback-only twin over the same ledger,
// so the internet-facing app can refuse every write.
const server = createApp(options);
await new Promise<void>((r) => server.listen(isPublic ? 0 : port, "127.0.0.1", r));
base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
if (isPublic) {
  const open = createApp({ ...options, readOnly: true });
  await new Promise<void>((r) => open.listen(port, "0.0.0.0", r));
  console.log(`seen off public demo on http://0.0.0.0:${port} (read-only), pipeline on ${base}`);
  // A visitor arriving later finds the three demo days already settled, with "Play it again" to watch them land.
  options.replay!.demo!.start();
} else console.log(`seen off replay console on ${base}`);

const pause = paceMs > 0 ? () => new Promise<void>((r) => setTimeout(r, paceMs)) : undefined;
for (const id of picked) {
  const d = days.find((x) => x.dayId === id)!;
  const r = await playDay(base, runner, d, (ms) => { now = ms; }, { pause });
  console.log(`${id} truth ${d.truth} -> ${r.verdict}`);
}
console.log(`replayed ${picked.length} days, serving on ${isPublic ? `0.0.0.0:${port}` : base}`);
