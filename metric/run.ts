// Replays 30 pickup days through the real receiver, runner, ledger and vision stage, and scores the verdicts against the truth
// the days were built with. SIMULATOR: webhooks are signed by simulator/webhook-simulator.ts, frames come from simulator/days.
//
//   VISION_PROVIDER=openrouter node metric/run.ts                    headline run
//   node metric/run.ts --always-present                                must-fail: vision always says "1 parcel present"
//   ... --tracking shippo                                            read tracking from Shippo test mode (needs SHIPPO_API_KEY)
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner, type Alerter, type TrackingSource } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { ShippoTracking } from "../src/shippo/client.ts";
import { visionFromEnv, type PorchReading, type VisionProvider } from "../src/vision/index.ts";
import { signBody } from "../src/ring/signature.ts";
import { deliver, motionEnvelope } from "../simulator/webhook-simulator.ts";
import { SETTLE_MS, SIM_KEY as KEY, fixtureTracking, loadDays, playDay, replayFrameSource, root, type DaySpec } from "../simulator/replay.ts";

const args = process.argv.slice(2);
const alwaysPresentRun = args.includes("--always-present");
const trackingMode = args.includes("--tracking") ? args[args.indexOf("--tracking") + 1] : "fixture";

const days: DaySpec[] = loadDays();
const replayFrames = replayFrameSource(days);
let tracking: TrackingSource = fixtureTracking;
if (trackingMode === "shippo") {
  if (!process.env.SHIPPO_API_KEY) throw new Error("--tracking shippo needs SHIPPO_API_KEY");
  tracking = new ShippoTracking(process.env.SHIPPO_API_KEY);
}

const alwaysPresent: VisionProvider = { name: "always-present", model: "always-present", readPorch: async (): Promise<PorchReading> => ({ present: true, count: 1, raw: "always-present" }) };
const vision = alwaysPresentRun ? alwaysPresent : visionFromEnv();

let now = 0;
const alertAt = new Map<string, number>();
const alerter: Alerter = { async send(a) { alertAt.set(a.dayId, performance.now()); } };
const ledger = new Ledger(":memory:");
const runner = new PickupRunner({ ledger, vision, frames: [replayFrames], tracking, alerter, clock: () => now, settleMs: SETTLE_MS });
const server = createApp({ signingKey: KEY, ledger, runner });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const acks: number[] = [];
const rows: { dayId: string; truth: string; verdict: string | null; baseline: number | null; close: number | null; truthBase: number; truthClose: number; alertMs: number | null; error?: string }[] = [];
let badSignatureRejected = 0, duplicateAcked = 0, webhooksSent = 0;

for (const d of days) {
  const row: (typeof rows)[number] = { dayId: d.dayId, truth: d.truth, verdict: null, baseline: null, close: null, truthBase: d.truthCounts.baseline, truthClose: d.truthCounts.close, alertMs: null };
  try {
    const r = await playDay(base, runner, d, (ms) => { now = ms; }, { alertAt });
    row.verdict = r.verdict;
    row.alertMs = r.stats.alertMs;
    acks.push(...r.stats.acks); webhooksSent += r.stats.webhooksSent; duplicateAcked += r.stats.duplicateAcked; badSignatureRejected += r.stats.badSignatureRejected;
    const day = ledger.getDay(d.dayId);
    row.baseline = day.baselineCount;
    row.close = day.closeCount;
  } catch (e) {
    row.error = (e as Error).message;
  }
  rows.push(row);
  console.log(d.dayId, d.truth.padEnd(9), "->", String(row.verdict).padEnd(10), `counts ${row.baseline}/${row.close} (truth ${row.truthBase}/${row.truthClose})`, row.error ?? "");
}

// Ack latency under load: 100 distinct signed deliveries, then the same 100 again (all must be duplicates), then 10 forged.
const loadAcks: number[] = [];
let loadOk = 0, loadDup = 0, loadForged = 0;
const loadBodies = Array.from({ length: 100 }, (_, i) => motionEnvelope({ deviceId: "ava1.ring.device.LOADTEST", timestampMs: 1_000 + i, subType: "motion", requestId: `load-${i}` }));
for (const b of loadBodies) { const r = await deliver(`${base}/ring/webhook`, KEY, b); loadAcks.push(r.ms); if (r.status === 200) loadOk++; }
for (const b of loadBodies) { const r = await deliver(`${base}/ring/webhook`, KEY, b); if (r.status === 200 && JSON.parse(r.body).status === "already_processed") loadDup++; }
for (const b of loadBodies.slice(0, 10)) { if ((await deliver(`${base}/ring/webhook`, KEY, b + " ", { signature: signBody(KEY, b) })).status === 401) loadForged++; }
server.close();

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
const correct = rows.filter((r) => r.verdict === r.truth).length;
const byScenario: Record<string, string> = {};
for (const s of ["taken", "missed", "partial", "unscanned"]) {
  const k = rows.filter((r) => r.truth === s);
  byScenario[s] = `${k.filter((r) => r.verdict === r.truth).length}/${k.length}`;
}
const confusion: Record<string, number> = {};
for (const r of rows) { const k = `${r.truth} -> ${r.verdict}`; confusion[k] = (confusion[k] ?? 0) + 1; }
const missedAlerts = rows.filter((r) => r.truth === "missed" && r.alertMs !== null).map((r) => r.alertMs!);
const countOk = rows.filter((r) => r.baseline === r.truthBase && r.close === r.truthClose).length;

const summary = {
  vision: `${vision.name}/${vision.model}`, tracking: trackingMode === "shippo" ? "shippo-test-mode" : "fixture (Shippo test-number convention)",
  days: rows.length, correct_verdicts: `${correct}/${rows.length}`, by_scenario: byScenario, confusion,
  day_count_readings_exact: `${countOk}/${rows.length} days with both counts exact`,
  seconds_window_close_to_missed_alert: missedAlerts.length ? { n: missedAlerts.length, median: pct(missedAlerts, 50) / 1000, max: Math.max(...missedAlerts) / 1000 } : null,
  webhook_ack_ms_replay: { n: acks.length, p50: Math.round(pct(acks, 50)), p95: Math.round(pct(acks, 95)) },
  webhook_ack_ms_load_100: { n: loadAcks.length, ok: loadOk, p50: Math.round(pct(loadAcks, 50)), p95: Math.round(pct(loadAcks, 95)), max: Math.round(Math.max(...loadAcks)) },
  idempotency: { replay_duplicates_acked: duplicateAcked, load_duplicates_acked: `${loadDup}/100` },
  forged_signatures_rejected: { replay: `${badSignatureRejected}/${days.reduce((n, d) => n + d.motion.length, 0)}`, load: `${loadForged}/10` },
  errors: rows.filter((r) => r.error).length,
};
console.log(JSON.stringify(summary, null, 2));
for (const r of rows.filter((x) => x.verdict !== x.truth)) console.log("WRONG", r.dayId, "truth", r.truth, "got", r.verdict, `counts ${r.baseline}/${r.close} truth ${r.truthBase}/${r.truthClose}`, r.error ?? "");
mkdirSync(join(root, "metric/results"), { recursive: true });
writeFileSync(join(root, "metric/results", alwaysPresentRun ? "replay-always-present.json" : `replay-${vision.name}.json`), JSON.stringify({ summary, rows }, null, 1));
void webhooksSent;
