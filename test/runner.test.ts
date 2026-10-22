import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner, type Alerter, type FrameSource, type TrackingSource, type DayPlan } from "../src/pickup/runner.ts";
import type { PorchReading, VisionProvider } from "../src/vision/types.ts";
import type { TrackingStatus } from "../src/pickup/verdict.ts";
import { motionBody } from "./fixtures.ts";
import { parseEnvelope } from "../src/ring/webhook.ts";

// Scripted collaborators: a frame is the UTF-8 text of its parcel count, so every verdict path is exercised without a model.
const DEVICE = "ava1.ring.device.TESTFIXTURE";
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const plan = (labels = 3): DayPlan => ({
  dayId: "d1", deviceId: DEVICE, windowStartMs: T0, windowEndMs: T0 + 7 * HOUR,
  labels: Array.from({ length: labels }, (_, i) => ({ trackingNumber: `TRK${i}`, carrier: "usps" })),
});

function rig(script: Record<number, number | "fail">, trackingStatuses: TrackingStatus[] = []) {
  const alerts: { kind: string; text: string }[] = [];
  let clock = T0;
  const frames: FrameSource = {
    name: "scripted",
    async frameAt(_d, atMs) {
      if (!(atMs in script)) throw new Error(`no frame at ${atMs}`);
      return { jpeg: new TextEncoder().encode(String(script[atMs])), mediaTimestampMs: atMs, origin: "test" };
    },
  };
  const vision: VisionProvider = {
    name: "scripted", model: "scripted",
    async readPorch(jpeg): Promise<PorchReading> {
      const s = new TextDecoder().decode(jpeg);
      if (s === "fail") throw new Error("vision down");
      const count = Number(s);
      return { present: count > 0, count, raw: s };
    },
  };
  const tracking: TrackingSource = { statusOf: async (l) => trackingStatuses[Number(l.trackingNumber.slice(3))] ?? "PRE_TRANSIT" };
  const alerter: Alerter = { send: async (a) => void alerts.push({ kind: a.kind, text: a.text }) };
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({ ledger, vision, frames: [frames], tracking, alerter, clock: () => clock, settleMs: 30_000 });
  return { ledger, runner, alerts, setClock: (t: number) => { clock = t; } };
}

const end = T0 + 7 * HOUR;

test("taken: 3 parcels at open, none at close, handoff time from the motion event, all labels scanned", async () => {
  const motionAt = T0 + 3 * HOUR;
  const r = rig({ [T0]: 3, [motionAt + 30_000]: 0, [end]: 0 }, ["TRANSIT", "TRANSIT", "DELIVERED"]);
  assert.equal(await r.runner.arm(plan()), 3);
  const ev = parseEnvelope(JSON.parse(motionBody({ requestId: "m1", deviceId: DEVICE, timestamp: motionAt })));
  r.ledger.insertEvent(ev);
  r.setClock(motionAt + 10_000);
  assert.equal(await r.runner.drain(), 0, "settle time has not passed, the event stays pending");
  r.setClock(motionAt + 30_000);
  assert.equal(await r.runner.drain(), 1);
  assert.equal(await r.runner.closeWindow("d1"), "taken");
  assert.equal(r.ledger.getDay("d1").handoffMs, motionAt);
  assert.equal(await r.runner.checkTracking("d1"), "taken");
  assert.equal(r.alerts.length, 0, "a clean pickup raises no alert");
});

test("missed: parcels still there at close, alert names the count", async () => {
  const r = rig({ [T0]: 3, [end]: 3 });
  await r.runner.arm(plan());
  assert.equal(await r.runner.closeWindow("d1"), "missed");
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].kind, "missed");
  assert.match(r.alerts[0].text, /3 parcels still on the porch/);
  assert.notEqual(r.ledger.getDay("d1").alertedAtMs, null);
});

test("partial: 1 of 3 taken, alert says so", async () => {
  const motionAt = T0 + 2 * HOUR;
  const r = rig({ [T0]: 3, [motionAt + 30_000]: 2, [end]: 2 });
  await r.runner.arm(plan());
  r.ledger.insertEvent(parseEnvelope(JSON.parse(motionBody({ requestId: "m1", deviceId: DEVICE, timestamp: motionAt }))));
  r.setClock(motionAt + 30_000);
  await r.runner.drain();
  assert.equal(await r.runner.closeWindow("d1"), "partial");
  assert.match(r.alerts[0].text, /1 of 3 parcels taken, 2 still on the porch/);
});

test("taken but unscanned: tracking still PRE_TRANSIT 24 h later produces an alert and an evidence packet", async () => {
  const r = rig({ [T0]: 2, [end]: 0 }, ["PRE_TRANSIT", "TRANSIT"]);
  await r.runner.arm(plan(2));
  assert.equal(await r.runner.closeWindow("d1"), "taken");
  assert.equal(await r.runner.checkTracking("d1"), "unscanned");
  assert.equal(r.alerts.at(-1)?.kind, "unscanned");
  const packet = r.ledger.getPacket("d1") as { verdict: string; tracking: { status: string }[]; frames: unknown[]; labels: unknown[] };
  assert.equal(packet.verdict, "unscanned");
  assert.deepEqual(packet.tracking.map((t) => t.status), ["PRE_TRANSIT", "TRANSIT"]);
  assert.equal(packet.labels.length, 2);
  assert.equal(packet.frames.length, 2, "baseline and close frames are listed in the packet");
});

test("unverified: a vision failure is recorded as a null count and alerts the user instead of claiming a result", async () => {
  const r = rig({ [T0]: 3, [end]: "fail" });
  await r.runner.arm(plan());
  assert.equal(await r.runner.closeWindow("d1"), "unverified");
  assert.equal(r.alerts[0].kind, "unverified");
  const close = r.ledger.observations("d1").find((o) => o.kind === "close");
  assert.equal(close?.count, null);
  assert.match(close?.error ?? "", /vision down/);
});

test("unverified: no frame source can produce a frame", async () => {
  const r = rig({ [T0]: 3 });
  await r.runner.arm(plan());
  assert.equal(await r.runner.closeWindow("d1"), "unverified");
});

test("a motion event outside every open window is acknowledged and ignored", async () => {
  const r = rig({ [T0]: 3, [end]: 0 });
  await r.runner.arm(plan());
  r.ledger.insertEvent(parseEnvelope(JSON.parse(motionBody({ requestId: "late", deviceId: DEVICE, timestamp: end + 5 * HOUR }))));
  r.setClock(end + 6 * HOUR);
  assert.equal(await r.runner.drain(), 1);
  assert.equal(r.ledger.observations("d1").filter((o) => o.kind === "motion").length, 0);
  assert.equal(r.ledger.pendingEvents().length, 0);
});

test("a motion event from another doorbell, even inside the window, triggers no frame and no verdict for the armed day", async () => {
  const r = rig({ [T0]: 3, [end]: 3 });
  await r.runner.arm(plan());
  r.ledger.insertEvent(parseEnvelope(JSON.parse(motionBody({ requestId: "other-door", deviceId: "ava1.ring.device.NEIGHBOUR", timestamp: T0 + 3 * HOUR }))));
  r.setClock(T0 + 4 * HOUR);
  assert.equal(await r.runner.drain(), 1, "the event is consumed");
  assert.equal(r.ledger.observations("d1").filter((o) => o.kind === "motion").length, 0, "but it did not make Seen Off look at this porch");
  assert.equal(r.ledger.getDay("d1").windowVerdict, null);
  assert.equal(r.alerts.length, 0);
});

test("frame sources are tried in order: when the snapshot fails, the next source supplies the frame and is named in the evidence", async () => {
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({
    ledger, clock: () => T0,
    frames: [
      { name: "ring-snapshot", async frameAt() { throw new Error("RECORDING_NOT_READY"); } },
      { name: "ring-whep", provenance: "live", async frameAt(_d, atMs) { return { jpeg: new TextEncoder().encode("2"), mediaTimestampMs: atMs, origin: "whep-live" }; } },
    ],
    vision: { name: "s", model: "s", readPorch: async (j) => ({ present: true, count: Number(new TextDecoder().decode(j)), raw: "" }) },
    tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} },
  });
  assert.equal(await runner.arm(plan()), 2);
  const o = ledger.observations("d1")[0];
  assert.deepEqual([o.source, o.count, o.error], ["ring-whep", 2, null]);
});
