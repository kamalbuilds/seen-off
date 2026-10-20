import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { ShippoClient, ShippoError } from "../src/shippo/client.ts";

// A local server shaped per the Shippo REST reference (shipments -> rates -> transactions, GET /tracks/{carrier}/{number}). It is not Shippo.
async function fake(routes: Record<string, (body: Record<string, unknown>, req: IncomingMessage) => [number, unknown]>) {
  const calls: string[] = [];
  const srv = createServer(async (req, res) => {
    let s = ""; for await (const c of req) s += c;
    const key = `${req.method} ${req.url}`; calls.push(key);
    const h = routes[key];
    const [status, body] = h ? h(s ? JSON.parse(s) : {}, req) : [404, {}];
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, calls, close: () => srv.close() };
}

const addr = { name: "A", street1: "1 Main", city: "SF", state: "CA", zip: "94103", country: "US" };
const parcel = { length: "10", width: "8", height: "4", distance_unit: "in" as const, weight: "2", mass_unit: "lb" as const };

test("createLabel buys the cheapest rate and returns tracking only for a SUCCESS transaction", async () => {
  let authSeen = "";
  const f = await fake({
    "POST /shipments/": (b, req) => { authSeen = String(req.headers.authorization); assert.equal(b.async, false); return [201, { rates: [{ object_id: "r2", amount: "9.10", provider: "UPS" }, { object_id: "r1", amount: "5.40", provider: "USPS" }] }]; },
    "POST /transactions/": (b) => { assert.equal(b.rate, "r1"); return [201, { object_id: "t1", status: "SUCCESS", tracking_number: "9400111", label_url: "https://labels/x.pdf" }]; },
  });
  const label = await new ShippoClient("shippo_test_key", f.base).createLabel(addr, addr, parcel);
  assert.deepEqual(label, { trackingNumber: "9400111", carrier: "usps", labelUrl: "https://labels/x.pdf", transactionId: "t1" });
  assert.equal(authSeen, "ShippoToken shippo_test_key");
  f.close();
});

test("createLabel does not accept a 201 whose transaction is not SUCCESS", async () => {
  const f = await fake({
    "POST /shipments/": () => [201, { rates: [{ object_id: "r1", amount: "5", provider: "USPS" }] }],
    "POST /transactions/": () => [201, { object_id: "t1", status: "ERROR", messages: [{ text: "bad address" }] }],
  });
  await assert.rejects(new ShippoClient("k", f.base).createLabel(addr, addr, parcel), (e: unknown) => e instanceof ShippoError && /ERROR/.test(e.message));
  f.close();
});

test("trackingStatus reads tracking_status.status, UNKNOWN when absent, rejects an unrecognised value", async () => {
  const f = await fake({
    "GET /tracks/shippo/SHIPPO_TRANSIT": () => [200, { tracking_status: { status: "TRANSIT" } }],
    "GET /tracks/usps/NEW": () => [200, { tracking_status: null }],
    "GET /tracks/usps/ODD": () => [200, { tracking_status: { status: "TELEPORTED" } }],
  });
  const c = new ShippoClient("k", f.base);
  assert.equal(await c.trackingStatus("shippo", "SHIPPO_TRANSIT"), "TRANSIT");
  assert.equal(await c.trackingStatus("usps", "NEW"), "UNKNOWN");
  await assert.rejects(c.trackingStatus("usps", "ODD"), ShippoError);
  f.close();
});

test("schedulePickup requires CONFIRMED", async () => {
  const f = await fake({
    "POST /pickups/": (b) => { assert.equal(b.is_test, true); return [201, { status: "CONFIRMED", confirmation_code: "WTC123" }]; },
  });
  const r = await new ShippoClient("k", f.base).schedulePickup({ carrierAccount: "ca", transactionIds: ["t1"], address: addr, startIso: "2026-10-22T17:00:00Z", endIso: "2026-10-23T00:00:00Z", testMode: true });
  assert.deepEqual(r, { confirmationCode: "WTC123", status: "CONFIRMED" });
  f.close();
  const g = await fake({ "POST /pickups/": () => [201, { status: "ERROR", messages: [{ text: "x" }] }] });
  await assert.rejects(new ShippoClient("k", g.base).schedulePickup({ carrierAccount: "ca", transactionIds: [], address: addr, startIso: "a", endIso: "b", testMode: true }), ShippoError);
  g.close();
});
