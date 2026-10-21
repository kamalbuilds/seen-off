import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner, type Alerter, type DayPlan } from "../src/pickup/runner.ts";
import { Scheduler } from "../src/pickup/scheduler.ts";
import { parseEnvelope } from "../src/ring/webhook.ts";
import { motionBody } from "./fixtures.ts";

const DEVICE = "ava1.ring.device.TESTFIXTURE";
const T0 = 1_800_000_000_000;
const H = 3_600_000;
const END = T0 + 7 * H;
const plan: DayPlan = { dayId: "d1", deviceId: DEVICE, windowStartMs: T0, windowEndMs: END, labels: [{ trackingNumber: "A", carrier: "usps" }, { trackingNumber: "B", carrier: "usps" }] };

/** One "process": a runner and scheduler over whatever ledger file is given, with its own clock and alert sink. Frames are keyed by time. */
function boot(path: string, nowMs: number, opts: { alerter?: Alerter; script?: Record<number, number> } = {}) {
  let now = nowMs;
  const alerts: { dayId: string; kind: string }[] = [];
  const script = opts.script ?? { [T0]: 2, [T0 + 3 * H + 30_000]: 1, [END]: 1 };
  const ledger = new Ledger(path);
  const runner = new PickupRunner({
    ledger, clock: () => now, settleMs: 30_000,
    frames: [{ name: "scripted", async frameAt(_d, atMs) { if (!(atMs in script)) throw new Error(`no frame at ${atMs}`); return { jpeg: new TextEncoder().encode(String(script[atMs])), mediaTimestampMs: atMs, origin: "t" }; } }],
    vision: { name: "s", model: "s", readPorch: async (j) => { const c = Number(new TextDecoder().decode(j)); return { present: c > 0, count: c, raw: "" }; } },
    tracking: { statusOf: async () => "PRE_TRANSIT" },
    alerter: opts.alerter ?? { async send(a) { alerts.push({ dayId: a.dayId, kind: a.kind }); } },
  });
  const scheduler = new Scheduler({ ledger, runner, clock: () => now, retryBaseMs: 1_000 });
  return { ledger, runner, scheduler, alerts, setNow: (t: number) => { now = t; } };
}
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "outbox-")), "ledger.sqlite");

test("restart mid-window: the verdict still fires at window close, with the motion event that arrived before the crash", async () => {
  const db = tmpDb();
  const a = boot(db, T0);
  await a.runner.arm(plan);
  a.ledger.insertEvent(parseEnvelope(JSON.parse(motionBody({ requestId: "m1", deviceId: DEVICE, timestamp: T0 + 3 * H }))));
  a.setNow(T0 + H);
  assert.equal(await a.scheduler.tick(), 0, "nothing is due an hour into the window");
  a.ledger.close(); // the process dies here, holding no timers

  const b = boot(db, T0 + 2 * H);
  assert.equal(await b.scheduler.tick(), 0, "after restart, still mid-window: nothing fires early");
  assert.equal(b.ledger.getDay("d1").windowVerdict, null);
  b.setNow(END + 60_000);
  assert.equal(await b.scheduler.tick(), 1, "the close job survived the restart and fires");
  const day = b.ledger.getDay("d1");
  assert.equal(day.windowVerdict, "partial");
  assert.equal(b.ledger.observations("d1").filter((o) => o.kind === "motion").length, 1, "the pre-crash webhook was drained before the verdict");
  assert.deepEqual(b.alerts, [{ dayId: "d1", kind: "partial" }]);

  assert.equal(await b.scheduler.tick(), 0, "a finished job does not run again");
  b.setNow(END + 24 * H + 1);
  assert.equal(await b.scheduler.tick(), 1, "the 24 h tracking check also survives");
  assert.equal(b.ledger.getDay("d1").finalVerdict, "partial");
  assert.equal(b.runner.packetOf("d1").status, "settled");
  assert.deepEqual(b.ledger.jobsFor("d1").map((j) => [j.kind, j.state]), [["close", "done"], ["tracking", "done"]]);
});

test("restart long after the window: every overdue job runs on the first tick, in order", async () => {
  const db = tmpDb();
  const a = boot(db, T0);
  await a.runner.arm(plan);
  a.ledger.close();
  const b = boot(db, END + 3 * 24 * H);
  assert.equal(await b.scheduler.tick(), 2);
  assert.equal(b.runner.packetOf("d1").status, "settled");
});

test("a window that opens in the future gets its baseline from a stored job, not a read of the future", async () => {
  const db = tmpDb();
  const a = boot(db, T0 - 5 * H);
  assert.equal(await a.runner.arm(plan), null, "no frame exists before the window opens");
  assert.equal(a.ledger.getDay("d1").baselineCount, null);
  a.ledger.close();
  const b = boot(db, T0 + 1_000);
  assert.equal(await b.scheduler.tick(), 1);
  assert.equal(b.ledger.getDay("d1").baselineCount, 2);
});

test("a failing alert is retried after a backoff and is delivered once, with one close observation", async () => {
  const db = tmpDb();
  let calls = 0;
  const sent: string[] = [];
  const flaky: Alerter = { async send(a) { if (++calls === 1) throw new Error("smtp down"); sent.push(a.kind); } };
  const a = boot(db, T0, { alerter: flaky });
  await a.runner.arm(plan);
  a.setNow(END);
  assert.equal(await a.scheduler.tick(), 0, "the first attempt fails");
  assert.equal(a.ledger.jobsFor("d1")[0].lastError, "smtp down");
  assert.equal(a.ledger.getDay("d1").windowVerdict, "partial", "the verdict was stored before the alert failed");
  assert.equal(await a.scheduler.tick(), 0, "backoff: not retried at the same instant");
  a.setNow(END + 2_000);
  assert.equal(await a.scheduler.tick(), 1);
  assert.deepEqual(sent, ["partial"]);
  assert.equal(a.ledger.observations("d1").filter((o) => o.kind === "close").length, 1, "retry reused the stored verdict");
});

test("a job that always fails is parked as dead after maxAttempts instead of retrying forever", async () => {
  const db = tmpDb();
  const ledger = new Ledger(db);
  const runner = new PickupRunner({ ledger, clock: () => END, frames: [], vision: { name: "s", model: "s", readPorch: async () => { throw new Error("x"); } }, tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => { throw new Error("always down"); } } });
  ledger.createDay(plan, T0);
  ledger.setBaseline("d1", 2);
  let t = END;
  const scheduler = new Scheduler({ ledger, runner, clock: () => t, retryBaseMs: 1, maxAttempts: 3 });
  for (let i = 0; i < 6; i++) { await scheduler.tick(); t += 10; }
  const close = ledger.jobsFor("d1").find((j) => j.kind === "close")!;
  assert.equal(close.state, "dead");
  assert.equal(close.attempts, 3);
  assert.equal(close.lastError, "always down");
});
