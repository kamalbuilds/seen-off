import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";

const T0 = 1_800_000_000_000;

test("the stream pushes a change when a frame, verdict or scan is written, coalesces a burst, stays quiet otherwise, and detaches on close", async () => {
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({
    ledger, clock: () => T0, frames: [{ name: "f", async frameAt(_d, atMs) { return { jpeg: new TextEncoder().encode("2"), mediaTimestampMs: atMs, origin: "t" }; } }],
    vision: { name: "s", model: "s", readPorch: async () => ({ present: true, count: 2, raw: "" }) },
    tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} },
  });
  const srv = createApp({ signingKey: "k", ledger, runner });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const ctl = new AbortController();
  try {
    const res = await fetch(`${base}/api/stream`, { signal: ctl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    const read = async (ms: number) => {
      const t = Date.now() + ms;
      while (Date.now() < t) {
        pendingRead ??= reader.read();
        const r = await Promise.race([pendingRead, new Promise<null>((ok) => setTimeout(() => ok(null), Math.max(1, t - Date.now())))]);
        if (r === null) break;
        pendingRead = null;
        if (r.done) break;
        buf += dec.decode(r.value);
      }
      const out = buf; buf = ""; return out;
    };
    assert.match(await read(150), /: connected/);
    assert.equal(ledger.changes.listenerCount("change"), 1);

    assert.doesNotMatch(await read(300), /event: change/, "no write, no event");

    await runner.arm({ dayId: "d1", deviceId: "ava1.ring.device.X", windowStartMs: T0, windowEndMs: T0 + 3600_000, labels: [{ trackingNumber: "A", carrier: "usps" }] });
    const got = await read(400);
    assert.equal((got.match(/event: change/g) ?? []).length, 1, "the arm, its baseline frame and baseline count arrive as one coalesced change");
    assert.match(got, /"dayIds":\["d1"\]/);

    const obs = { dayId: "d1", kind: "motion" as const, atMs: T0 + 5, count: 1, frameSha256: "x", framePath: null, error: null, source: "f", provenance: "replay" as const };
    for (const [name, write] of [
      ["a stored frame", () => ledger.addObservation(obs)],
      ["a verdict", () => ledger.setWindowResult("d1", 1, "partial", null)],
      ["an alert", () => ledger.setAlerted("d1", T0, "partial", "t")],
      ["a carrier scan", () => ledger.addTrackingReading("d1", { trackingNumber: "A", status: "TRANSIT", readAtMs: T0, provenance: "replay" })],
    ] as [string, () => void][]) {
      write();
      assert.equal(((await read(300)).match(/event: change/g) ?? []).length, 1, `${name} reaches the page`);
    }

    ctl.abort();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ledger.changes.listenerCount("change"), 0, "a closed page leaves no listener behind");
  } finally { ctl.abort(); srv.close(); }
});
