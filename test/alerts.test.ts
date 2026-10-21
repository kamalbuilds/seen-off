import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fanoutAlerter, fileAlerter, webhookAlerter } from "../src/alerts.ts";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";

async function phone(status: number) {
  const got: { method?: string; body: unknown }[] = [];
  const srv = createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    got.push({ method: req.method, body: JSON.parse(b) });
    res.writeHead(status); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, got, close: () => srv.close() };
}

const alert = { dayId: "d1", kind: "missed" as const, text: "3 parcels still on the porch at 17:00 UTC: the carrier did not take them." };

test("a missed pickup reaches the phone webhook and the file, and the day packet records both deliveries", async () => {
  const p = await phone(200);
  const file = join(mkdtempSync(join(tmpdir(), "al-")), "alerts.jsonl");
  const T0 = 1_800_000_000_000;
  try {
    const ledger = new Ledger(":memory:");
    const runner = new PickupRunner({
      ledger, clock: () => T0,
      frames: [{ name: "f", async frameAt(_d, atMs) { return { jpeg: new TextEncoder().encode("3"), mediaTimestampMs: atMs, origin: "t" }; } }],
      vision: { name: "s", model: "s", readPorch: async (j) => ({ present: true, count: Number(new TextDecoder().decode(j)), raw: "" }) },
      tracking: { statusOf: async () => "PRE_TRANSIT" },
      alerter: fanoutAlerter([{ name: "file", alerter: fileAlerter(file) }, { name: "phone", alerter: webhookAlerter(p.url, "phone") }]),
    });
    await runner.arm({ dayId: "d1", deviceId: "ava1.ring.device.X", windowStartMs: T0, windowEndMs: T0 + 3600_000, labels: [{ trackingNumber: "A", carrier: "usps" }] });
    await runner.closeWindow("d1");
    const packet = runner.packetOf("d1");
    assert.deepEqual(packet.alert?.delivery?.channels.map((c) => [c.name, c.ok]), [["file", true], ["phone", true]]);
    assert.equal(p.got.length, 1);
    assert.equal(p.got[0].method, "POST");
    assert.match((p.got[0].body as { text: string }).text, /^Outbox missed: 3 parcels still on the porch/);
    assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).dayId, "d1");
  } finally { p.close(); }
});

test("one channel failing is recorded and the others still deliver; every channel failing throws so the alert is retried", async () => {
  const bad = await phone(500);
  const file = join(mkdtempSync(join(tmpdir(), "al-")), "alerts.jsonl");
  try {
    const partial = await fanoutAlerter([{ name: "file", alerter: fileAlerter(file) }, { name: "phone", alerter: webhookAlerter(bad.url, "phone") }]).send(alert);
    assert.deepEqual(partial?.channels.map((c) => [c.name, c.ok]), [["file", true], ["phone", false]]);
    assert.match(partial!.channels[1].error!, /phone answered 500/);
    await assert.rejects(fanoutAlerter([{ name: "phone", alerter: webhookAlerter(bad.url, "phone") }]).send(alert), /every alert channel failed/);
  } finally { bad.close(); }
});
