import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { decideWindowVerdict } from "../src/pickup/verdict.ts";
import { validatePlan } from "../src/pickup/plan.ts";

const T0 = 1_800_000_000_000;
const good = () => ({ dayId: "pickup-1", deviceId: "ava1.ring.device.X", windowStartMs: T0, windowEndMs: T0 + 6 * 3600_000, labels: [{ trackingNumber: "9400111", carrier: "usps" }] });

async function boot() {
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({
    ledger, clock: () => T0,
    vision: { name: "s", model: "s", readPorch: async () => ({ present: true, count: 2, raw: "" }) },
    frames: [{ name: "one", frameAt: async () => ({ jpeg: new Uint8Array([1]), mediaTimestampMs: T0, origin: "t" }) }],
    tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} },
  });
  const srv = createApp({ signingKey: "k", ledger, runner });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (body: string) => fetch(`${base}/days`, { method: "POST", body });
  return { ledger, srv, base, post };
}

const bad: [string, (p: Record<string, unknown>) => void, RegExp][] = [
  ["window ends before it starts", (p) => { p.windowEndMs = T0 - 1; }, /windowEndMs must be after/],
  ["window of zero length", (p) => { p.windowEndMs = T0; }, /windowEndMs must be after/],
  ["window longer than 24 h", (p) => { p.windowEndMs = T0 + 25 * 3600_000; }, /longer than 24 hours/],
  ["start is a string", (p) => { p.windowStartMs = "1800000000000"; }, /windowStartMs must be a positive integer/],
  ["start is negative", (p) => { p.windowStartMs = -5; }, /windowStartMs must be a positive integer/],
  ["end is fractional", (p) => { p.windowEndMs = T0 + 1.5; }, /windowEndMs must be a positive integer/],
  ["end is null", (p) => { p.windowEndMs = null; }, /windowEndMs must be a positive integer/],
  ["no labels", (p) => { p.labels = []; }, /labels must be a non-empty array/],
  ["labels missing", (p) => { delete p.labels; }, /labels must be a non-empty array/],
  ["labels not an array", (p) => { p.labels = "A"; }, /labels must be a non-empty array/],
  ["label without tracking number", (p) => { p.labels = [{ carrier: "usps" }]; }, /labels\[0\]\.trackingNumber/],
  ["label with blank carrier", (p) => { p.labels = [{ trackingNumber: "1", carrier: "  " }]; }, /labels\[0\]\.carrier/],
  ["51 labels", (p) => { p.labels = Array.from({ length: 51 }, (_, i) => ({ trackingNumber: `T${i}`, carrier: "usps" })); }, /more than 50/],
  ["path traversal in dayId", (p) => { p.dayId = "../../etc"; }, /dayId must be/],
  ["slash in dayId", (p) => { p.dayId = "a/b"; }, /dayId must be/],
  ["empty dayId", (p) => { p.dayId = ""; }, /dayId must be/],
  ["missing deviceId", (p) => { delete p.deviceId; }, /deviceId must be/],
];

test("POST /days answers 400 with the reason for every kind of bad plan, and arms nothing", async () => {
  const { ledger, srv, post } = await boot();
  try {
    assert.ok(bad.length >= 15, "the table is not empty");
    for (const [name, mutate, re] of bad) {
      const p = good() as Record<string, unknown>;
      mutate(p);
      const res = await post(JSON.stringify(p));
      const j = await res.json() as { errors: string[] };
      assert.equal(res.status, 400, name);
      assert.ok(j.errors.some((e) => re.test(e)), `${name}: ${j.errors.join(" | ")}`);
    }
    assert.equal(ledger.listDays().length, 0, "no rejected plan reached the ledger");
  } finally { srv.close(); }
});

test("POST /days: a valid plan arms (201), a repeat is 409, bad JSON is 400, an oversize body is 413, errors come back together", async () => {
  const { ledger, srv, post, base } = await boot();
  try {
    const ok = await post(JSON.stringify(good()));
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { dayId: "pickup-1", baselineCount: 2 });
    assert.equal(ledger.getDay("pickup-1").baselineCount, 2);
    assert.equal((await post(JSON.stringify(good()))).status, 409);
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post("[]")).status, 400);
    assert.equal((await post(" ".repeat(1_000_001))).status, 413);
    const many = await (await post(JSON.stringify({ dayId: "", labels: [] }))).json() as { errors: string[] };
    assert.ok(many.errors.length >= 4, `all problems reported together: ${many.errors.length}`);
    assert.equal((await fetch(`${base}/days`, { method: "POST", body: JSON.stringify({ ...good(), dayId: "ok-2", labels: [{ trackingNumber: " 12 ", carrier: " usps " }] }) })).status, 201);
    assert.deepEqual(ledger.getDay("ok-2").labels, [{ trackingNumber: "12", carrier: "usps" }], "stored values are trimmed");
  } finally { srv.close(); }
});

test("validatePlan accepts the plan the replay simulator and the page send", () => {
  assert.equal(validatePlan(good()).ok, true);
  assert.equal(validatePlan({ ...good(), labels: [{ trackingNumber: "SHIPPO_TRANSIT", carrier: "shippo", labelUrl: "https://x.test/l.pdf" }] }).ok, true);
});

test("a negative or fractional parcel count is unverified, never a taken or partial claim", () => {
  assert.deepEqual(decideWindowVerdict({ baselineCount: 3, closeCount: -1 }), { verdict: "unverified", takenCount: 0 });
  assert.deepEqual(decideWindowVerdict({ baselineCount: -2, closeCount: 0 }), { verdict: "unverified", takenCount: 0 });
  assert.deepEqual(decideWindowVerdict({ baselineCount: 3, closeCount: 1.5 }), { verdict: "unverified", takenCount: 0 });
  assert.deepEqual(decideWindowVerdict({ baselineCount: 3, closeCount: 1 }), { verdict: "partial", takenCount: 2 });
});
