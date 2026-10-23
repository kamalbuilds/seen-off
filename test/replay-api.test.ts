import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";

function app(withReplay: boolean) {
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({
    ledger, clock: () => 0, frames: [], vision: { name: "s", model: "s", readPorch: async () => ({ present: false, count: 0, raw: "" }) },
    tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} },
  });
  const started: string[] = [];
  let busy = false;
  let demoRunning = false;
  let demoStarts = 0;
  const srv = createApp({
    signingKey: "k", ledger, runner,
    replay: withReplay ? {
      demo: {
        status: () => ({ running: demoRunning, current: null, steps: [{ title: "T", blurb: "B", dayId: null }] }),
        start() { if (demoRunning) throw new Error("busy"); demoRunning = true; demoStarts++; },
      },
      days: () => [{ dayId: "day01", labels: 3, startMs: 1_000 }],
      start(id) { if (busy) throw new Error("another pickup day is still replaying"); busy = true; started.push(id); return `${id}-replay-2`; },
    } : undefined,
  });
  return new Promise<{ base: string; started: string[]; demoStarts: () => number; close: () => void }>((ok) => srv.listen(0, "127.0.0.1", () => ok({ base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, started, demoStarts: () => demoStarts, close: () => srv.close() })));
}

test("Replay a pickup day: listed, started under a fresh name, one at a time, only for recorded days", async () => {
  const a = await app(true);
  try {
    assert.deepEqual(await (await fetch(`${a.base}/api/replay`)).json(), { days: [{ dayId: "day01", labels: 3, startMs: 1_000 }], demo: { running: false, current: null, steps: [{ title: "T", blurb: "B", dayId: null }] } });
    const post = (body: string) => fetch(`${a.base}/api/replay`, { method: "POST", body });
    const ok = await post(JSON.stringify({ dayId: "day01" }));
    assert.equal(ok.status, 202);
    assert.deepEqual(await ok.json(), { dayId: "day01-replay-2" });
    assert.equal((await post(JSON.stringify({ dayId: "day01" }))).status, 409, "a second replay while one is playing");
    assert.equal((await post(JSON.stringify({ dayId: "day99" }))).status, 400, "not a recorded day");
    assert.equal((await post(JSON.stringify({ dayId: "../x" }))).status, 400);
    assert.equal((await post("nope")).status, 400);
    assert.deepEqual(a.started, ["day01"], "only the one valid request started anything");

    const demo = await fetch(`${a.base}/api/demo`, { method: "POST" });
    assert.equal(demo.status, 202);
    assert.equal(((await demo.json()) as { running: boolean }).running, true);
    assert.equal((await fetch(`${a.base}/api/demo`, { method: "POST" })).status, 409, "the demo cannot be started twice at once");
    assert.equal(a.demoStarts(), 1);
  } finally { a.close(); }
});

test("a server without recorded days lists none and refuses a replay", async () => {
  const a = await app(false);
  try {
    assert.deepEqual(await (await fetch(`${a.base}/api/replay`)).json(), { days: [], demo: null });
    assert.equal((await fetch(`${a.base}/api/demo`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${a.base}/api/replay`, { method: "POST", body: "{}" })).status, 404);
  } finally { a.close(); }
});

test("the public demo refuses arming, deleting and every Ring route, and says it is public", async () => {
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({ ledger, clock: () => 0, frames: [], vision: { name: "s", model: "s", readPorch: async () => ({ present: false, count: 0, raw: "" }) }, tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} } });
  const replay = { days: () => [], start: () => "x", demo: { start() {}, status: () => ({ running: false, current: null, steps: [] }) } };
  const plan = { dayId: "d1", deviceId: "dev", windowStartMs: 1_000, windowEndMs: 2_000, labels: [{ trackingNumber: "T1", carrier: "usps" }] };
  const listen = (srv: ReturnType<typeof createApp>) => new Promise<string>((ok) => srv.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)));
  const pipe = createApp({ signingKey: "k", ledger, runner, replay });
  const open = createApp({ signingKey: "k", ledger, runner, replay, readOnly: true });
  const [inner, outer] = [await listen(pipe), await listen(open)];
  try {
    assert.equal((await fetch(`${outer}/days`, { method: "POST", body: JSON.stringify(plan) })).status, 403);
    assert.equal((await fetch(`${inner}/days`, { method: "POST", body: JSON.stringify(plan) })).status, 201, "the loopback twin still arms");
    assert.equal((await fetch(`${outer}/days/d1`)).status, 200, "the packet stays readable");
    assert.equal((await fetch(`${outer}/days/d1`, { method: "DELETE" })).status, 403);
    for (const [m, path] of [["POST", "/ring/webhook"], ["GET", "/api/ring"], ["GET", "/ring/connect"], ["POST", "/api/ring/snapshot"]]) {
      assert.equal((await fetch(`${outer}${path}`, { method: m })).status, 403, `${m} ${path}`);
    }
    assert.equal(((await (await fetch(`${outer}/api/replay`)).json()) as { public?: boolean }).public, true);
    assert.equal(((await (await fetch(`${inner}/api/replay`)).json()) as { public?: boolean }).public, undefined);
    assert.equal((await fetch(`${inner}/days/d1`, { method: "DELETE" })).status, 200, "without readOnly the same delete succeeds");
  } finally { pipe.close(); open.close(); }
});
