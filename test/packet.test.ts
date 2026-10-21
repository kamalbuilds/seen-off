import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner, type FrameSource, type TrackingSource } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { weakest, eventProvenance } from "../src/provenance.ts";
import { parseEnvelope } from "../src/ring/webhook.ts";
import { motionBody } from "./fixtures.ts";

const DEVICE = "ava1.ring.device.TESTFIXTURE";
const T0 = 1_800_000_000_000;
const H = 3_600_000;

function rig(opts: { frames?: FrameSource["provenance"]; tracking?: TrackingSource["provenance"]; evidence?: boolean } = {}) {
  let clock = T0;
  const script: Record<number, number> = { [T0]: 2, [T0 + 3 * H + 30_000]: 1, [T0 + 7 * H]: 0 };
  const frames: FrameSource = {
    name: "scripted", provenance: opts.frames,
    async frameAt(_d, atMs) { return { jpeg: new TextEncoder().encode(String(script[atMs])), mediaTimestampMs: atMs, origin: "t" }; },
  };
  const tracking: TrackingSource = { provenance: opts.tracking, statusOf: async (l) => (l.trackingNumber === "A" ? "TRANSIT" : "PRE_TRANSIT") };
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({
    ledger, frames: [frames], tracking, clock: () => clock, settleMs: 30_000,
    evidenceDir: opts.evidence ? mkdtempSync(join(tmpdir(), "ev-")) : undefined,
    vision: { name: "s", model: "s", readPorch: async (j) => { const c = Number(new TextDecoder().decode(j)); return { present: c > 0, count: c, raw: "" }; } },
    alerter: { send: async () => {} },
  });
  return { ledger, runner, setClock: (t: number) => { clock = t; } };
}
const plan = { dayId: "d1", deviceId: DEVICE, windowStartMs: T0, windowEndMs: T0 + 7 * H, labels: [{ trackingNumber: "A", carrier: "usps" }, { trackingNumber: "B", carrier: "usps" }] };

test("provenance: weakest input wins, no inputs is never live, simulator accounts are simulated", () => {
  assert.equal(weakest(["live", "live"]), "live");
  assert.equal(weakest(["live", "replay"]), "replay");
  assert.equal(weakest(["replay", "simulated", "live"]), "simulated");
  assert.equal(weakest([]), "simulated");
  assert.equal(eventProvenance("ava1.ring.account.SIMULATOR"), "simulated");
  assert.equal(eventProvenance("ava1.ring.account.8f3a21"), "live");
});

test("packet timeline: every day stage is present, ordered, and each external input carries its own provenance", async () => {
  const r = rig({ frames: "replay", tracking: "simulated" });
  await r.runner.arm(plan);
  const early = r.runner.packetOf("d1");
  assert.equal(early.status, "watching");
  assert.equal(early.verdict, null);
  assert.deepEqual(early.timeline.map((t) => t.kind), ["label", "window_open", "frame"]);

  r.ledger.insertEvent(parseEnvelope(JSON.parse(motionBody({ requestId: "m1", deviceId: DEVICE, timestamp: T0 + 3 * H }))));
  r.setClock(T0 + 3 * H + 30_000);
  await r.runner.drain();
  r.setClock(T0 + 7 * H);
  await r.runner.closeWindow("d1");
  assert.equal(r.runner.packetOf("d1").status, "awaiting_tracking");
  r.setClock(T0 + 31 * H);
  await r.runner.checkTracking("d1");
  const p = r.runner.packetOf("d1");

  assert.equal(p.status, "settled");
  assert.equal(p.verdict, "unscanned");
  assert.deepEqual(p.timeline.map((t) => t.kind), [
    "label", "window_open", "frame", "motion_event", "frame", "frame", "window_verdict", "tracking", "tracking", "final_verdict", "alert",
  ]);
  const at = p.timeline.map((t) => t.atMs);
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  const by = (k: string) => p.timeline.filter((t) => t.kind === k).map((t) => t.provenance);
  assert.deepEqual(by("frame"), ["replay", "replay", "replay"]);
  assert.deepEqual(by("motion_event"), ["simulated"], "the fixture account id marks the webhook simulated");
  assert.deepEqual(by("tracking"), ["simulated", "simulated"]);
  assert.deepEqual(by("alert"), [null]);
  assert.equal(p.provenance.verdict, "simulated", "a verdict is as live as its weakest input");
  assert.deepEqual(p.labels.map((l) => l.status), ["TRANSIT", "PRE_TRANSIT"]);
  assert.equal(p.alert?.kind, "unscanned");
});

test("packet: an unlabelled frame source reads as simulated, and an all-live day is live", async () => {
  const unlabelled = rig();
  await unlabelled.runner.arm(plan);
  assert.equal(unlabelled.runner.packetOf("d1").provenance.frames, "simulated");

  const live = rig({ frames: "live", tracking: "live" });
  await live.runner.arm(plan);
  live.setClock(T0 + 7 * H);
  await live.runner.closeWindow("d1");
  live.setClock(T0 + 31 * H);
  await live.runner.checkTracking("d1");
  assert.equal(live.runner.packetOf("d1").provenance.verdict, "live");
});

test("server: seller page, day list, fresh packet before close, stored frame bytes, 404s", async () => {
  const r = rig({ frames: "replay", tracking: "simulated", evidence: true });
  const srv = createApp({ signingKey: "k", ledger: r.ledger, runner: r.runner, devices: async () => [{ id: DEVICE, name: "Porch", provenance: "replay" }] });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    for (const needle of ["<title>Outbox: pickup days</title>", "badge live", "badge replay", "badge simulated", "/api/days", "New pickup day"]) assert.ok(html.includes(needle), needle);

    assert.deepEqual((await (await fetch(`${base}/api/days`)).json() as { days: unknown[] }).days, [], "empty ledger lists no days");
    assert.deepEqual(await (await fetch(`${base}/api/devices`)).json(), { devices: [{ id: DEVICE, name: "Porch", provenance: "replay" }] });

    await r.runner.arm(plan);
    const list = (await (await fetch(`${base}/api/days`)).json() as { days: { dayId: string; status: string; provenance: string }[] }).days;
    assert.deepEqual(list.map((d) => [d.dayId, d.status, d.provenance]), [["d1", "watching", "replay"]]);
    const packet = await (await fetch(`${base}/days/d1`)).json() as { frames: { image: string | null }[]; status: string };
    assert.equal(packet.status, "watching");
    const img = await fetch(`${base}${packet.frames[0].image}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.equal(new TextDecoder().decode(await img.arrayBuffer()), "2", "the stored frame is the exact bytes the vision stage read");
    assert.equal((await fetch(`${base}/days/d1/frames/9`)).status, 404);
    assert.equal((await fetch(`${base}/days/nope/frames/0`)).status, 404);
    assert.equal((await fetch(`${base}/days/nope`)).status, 404);
  } finally { srv.close(); }
});

test("ledger migrates a file created before provenance existed", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(mkdtempSync(join(tmpdir(), "led-")), "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec("create table days (day_id text primary key, device_id text not null, window_start integer not null, window_end integer not null, labels text not null, baseline_count integer, close_count integer, window_verdict text, handoff_ms integer, final_verdict text, alerted_at integer);" +
    "create table observations (id integer primary key autoincrement, day_id text not null, kind text not null, at_ms integer not null, count integer, frame_sha256 text not null, frame_path text, error text);" +
    "create table events (request_id text primary key, type text not null, account_id text not null, device_id text, ts_ms integer, sub_type text, received_at integer not null, handled_at integer);");
  old.close();
  const ledger = new Ledger(path);
  ledger.createDay({ dayId: "x", deviceId: "d", windowStartMs: 1, windowEndMs: 2, labels: [] }, 5);
  assert.equal(ledger.getDay("x").createdAtMs, 5);
  ledger.addObservation({ dayId: "x", kind: "baseline", atMs: 1, count: 1, frameSha256: "s", framePath: null, error: null, source: "replay", provenance: "replay" });
  assert.equal(ledger.observations("x")[0].provenance, "replay");
});
