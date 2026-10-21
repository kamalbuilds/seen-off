// One named regression per replay day the Bedrock Qwen3-VL run got wrong (metric/results/replay-bedrock-mantle.json, 25/30).
// The readings are the counts the vision stage actually returned for that day's frames (open / after motion / close);
// the truth is how the day was built. Frames are scripted by count so the verdict logic is what is under test.
// The logic fixes are general (see runner.ts and verdict.ts), checked on a held-out batch built with another seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner, type DayPlan } from "../src/pickup/runner.ts";
import { parseEnvelope } from "../src/ring/webhook.ts";
import { motionBody } from "./fixtures.ts";
import type { TrackingStatus } from "../src/pickup/verdict.ts";

const DEVICE = "ava1.ring.device.TESTFIXTURE";
const T0 = 1_800_000_000_000;
const H = 3_600_000;
const END = T0 + 7 * H;
const MOTION = T0 + 3 * H;

interface Day { labels: TrackingStatus[]; reads: { open: number[]; after?: number; close: number } }

/** Runs one day. `open` lists successive readings of the open frame (the vision stage is not perfectly repeatable on one frame). */
async function play(d: Day) {
  let now = T0;
  let openReads = [...d.reads.open];
  const alerts: { kind: string; text: string }[] = [];
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({
    ledger, clock: () => now, settleMs: 30_000,
    frames: [{ name: "scripted", async frameAt(_x, atMs) { return { jpeg: new TextEncoder().encode(atMs === T0 ? "open" : atMs === END ? "close" : "after"), mediaTimestampMs: atMs, origin: "t" }; } }],
    vision: { name: "s", model: "s", async readPorch(j) {
      const k = new TextDecoder().decode(j);
      const c = k === "open" ? (openReads.length > 1 ? openReads.shift()! : openReads[0]) : k === "close" ? d.reads.close : d.reads.after!;
      return { present: c > 0, count: c, raw: "" };
    } },
    tracking: { statusOf: async (l) => d.labels[Number(l.trackingNumber.slice(1))] },
    alerter: { send: async (a) => void alerts.push({ kind: a.kind, text: a.text }) },
  });
  const plan: DayPlan = { dayId: "d", deviceId: DEVICE, windowStartMs: T0, windowEndMs: END, labels: d.labels.map((_, i) => ({ trackingNumber: `T${i}`, carrier: "shippo" })) };
  await runner.arm(plan);
  if (d.reads.after !== undefined) {
    ledger.insertEvent(parseEnvelope(JSON.parse(motionBody({ requestId: "m", deviceId: DEVICE, timestamp: MOTION }))));
    now = MOTION + 30_000;
    await runner.drain();
  }
  now = END;
  const window = await runner.closeWindow("d");
  now = END + 24 * H;
  const final = await runner.checkTracking("d");
  return { window, final, alerts, ledger };
}
const PRE: TrackingStatus[] = ["PRE_TRANSIT"];

test("day01 (truth missed): parcels overcounted at open, after motion and at close (4, 4, 6 for 3) is missed with an alert, not unverified", async () => {
  const r = await play({ labels: [...PRE, ...PRE, ...PRE], reads: { open: [4], after: 4, close: 6 } });
  assert.equal(r.final, "missed");
  assert.equal(r.alerts[0].kind, "missed");
  assert.match(r.alerts[0].text, /^4 parcels still on the porch/, "the lower of the two disagreeing counts, never the 6");
});

test("day20 (truth missed): 3, 3, 4 for 2 parcels is missed with an alert", async () => {
  const r = await play({ labels: [...PRE, ...PRE], reads: { open: [3], after: 3, close: 4 } });
  assert.equal(r.final, "missed");
  assert.equal(r.alerts.length, 1);
});

test("day28 (truth missed): 1 at open, 2 at close, no motion at all, is missed with an alert", async () => {
  const r = await play({ labels: [...PRE], reads: { open: [1], close: 2 } });
  assert.equal(r.final, "missed");
  assert.match(r.alerts[0].text, /^1 parcel still on the porch/);
});

test("day13 (truth unscanned): an open frame read as 0 once is read again before zero is accepted; 2 then close 0 settles as unscanned", async () => {
  const r = await play({ labels: [...PRE, ...PRE], reads: { open: [0, 2], close: 0 } });
  assert.equal(r.ledger.getDay("d").baselineCount, 2);
  assert.equal(r.final, "unscanned");
  assert.equal(r.alerts.at(-1)?.kind, "unscanned");
  assert.equal(r.ledger.observations("d").filter((o) => o.kind === "baseline").length, 1, "one stored baseline observation, not one per re-read");
});

test("day13 control: an open frame that reads 0 every time stays unverified, the re-read never invents a parcel", async () => {
  const r = await play({ labels: [...PRE, ...PRE], reads: { open: [0, 0, 0], close: 0 } });
  assert.equal(r.window, "unverified");
  assert.equal(r.alerts[0].kind, "unverified");
});

test("day18 (truth partial, a model miss): the close frame read 0 although one parcel was left. Tracking catches it: one label unscanned makes the day unscanned with an alert, never a silent taken", async () => {
  const r = await play({ labels: ["TRANSIT", "PRE_TRANSIT"], reads: { open: [2], after: 1, close: 0 } });
  assert.equal(r.window, "taken", "known limit: a single close frame that misses a parcel reads as taken");
  assert.equal(r.final, "unscanned");
  assert.equal(r.alerts.at(-1)?.kind, "unscanned");
});

test("guard: a taken day is not turned into missed by the overcount rule when a frame did show the parcels leave", async () => {
  const r = await play({ labels: ["TRANSIT", "TRANSIT"], reads: { open: [2], after: 0, close: 0 } });
  assert.equal(r.final, "taken");
  assert.equal(r.alerts.length, 0);
  const contradiction = await play({ labels: ["TRANSIT", "TRANSIT"], reads: { open: [2], after: 1, close: 3 } });
  assert.equal(contradiction.window, "unverified", "a frame showed one leave, then the close frame shows more than at open");
});
