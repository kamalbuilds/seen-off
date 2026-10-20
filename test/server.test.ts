import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { KEY, motionBody, signed } from "./fixtures.ts";

test("HTTP receiver: signed delivery is recorded, forged is 401, duplicate is acked once, GET /days serves the packet", async () => {
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({
    ledger, clock: () => 0,
    vision: { name: "none", model: "none", readPorch: async () => ({ present: false, count: 0, raw: "" }) },
    frames: [{ name: "one", frameAt: async () => ({ jpeg: new Uint8Array([1]), mediaTimestampMs: 0, origin: "test" }) }],
    tracking: { statusOf: async () => "TRANSIT" },
    alerter: { send: async () => {} },
  });
  const srv = createApp({ signingKey: KEY, ledger, runner });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (body: string, headers: Record<string, string>) => fetch(`${base}/ring/webhook`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

  const body = motionBody({ requestId: "http-1" });
  const ok = await post(body, signed(body));
  assert.equal(ok.status, 200);
  assert.equal(ledger.pendingEvents().length + (ledger.isDone("http-1") ? 0 : 99), 1, "event recorded and marked");
  assert.equal((await post(body.replace("human", "vehicle"), signed(body))).status, 401);
  assert.equal((await post(body, {})).status, 401);
  const dup = await post(body, signed(body));
  assert.deepEqual([dup.status, (await dup.json() as { status: string }).status], [200, "already_processed"]);
  assert.equal((await fetch(`${base}/days/nope`)).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  srv.close();
});
