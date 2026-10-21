import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { parseEnvelope } from "../src/ring/webhook.ts";
import { motionBody } from "./fixtures.ts";

const DEVICE = "ava1.ring.device.TESTFIXTURE";
const T0 = 1_800_000_000_000;
const H = 3_600_000;

async function boot() {
  const evidence = mkdtempSync(join(tmpdir(), "evid-"));
  const ledger = new Ledger(":memory:");
  let now = T0;
  const runner = new PickupRunner({
    ledger, clock: () => now, settleMs: 30_000, evidenceDir: evidence,
    frames: [{ name: "ring-snapshot", provenance: "live", async frameAt(_d, atMs) { return { jpeg: new TextEncoder().encode(`frame-${atMs}-${atMs === T0 ? 2 : 1}`), mediaTimestampMs: atMs, origin: "recording" }; } }],
    vision: { name: "s", model: "s", readPorch: async (j) => { const c = Number(new TextDecoder().decode(j).split("-").pop()); return { present: c > 0, count: c, raw: "" }; } },
    tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} },
  });
  const srv = createApp({ signingKey: "k", ledger, runner });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  await runner.arm({ dayId: "d1", deviceId: DEVICE, windowStartMs: T0, windowEndMs: T0 + 6 * H, labels: [{ trackingNumber: "A", carrier: "usps" }] });
  ledger.insertEvent(parseEnvelope(JSON.parse(motionBody({ requestId: "req-77", deviceId: DEVICE, timestamp: T0 + 2 * H }))));
  now = T0 + 2 * H + 30_000;
  await runner.drain();
  now = T0 + 6 * H;
  await runner.closeWindow("d1");
  return { evidence, ledger, runner, srv, base };
}

test("packet manifest lists each frame hash, the triggering webhook request ids and the tracking reads, and the served frame matches its hash", async () => {
  const { srv, base, runner } = await boot();
  try {
    const p = runner.packetOf("d1");
    assert.equal(p.manifest.version, 1);
    assert.deepEqual(p.manifest.webhookRequestIds, ["req-77"]);
    assert.equal(p.manifest.frames.length, 3);
    for (const f of p.frames) {
      const body = Buffer.from(await (await fetch(`${base}${f.image}`)).arrayBuffer());
      assert.equal(createHash("sha256").update(body).digest("hex"), p.manifest.frames[f.index].sha256, "served bytes hash to the manifest entry");
    }
  } finally { srv.close(); }
});

test("a frame file changed on disk is refused with 409, never served as evidence", async () => {
  const { srv, base, runner, ledger } = await boot();
  try {
    const path = ledger.observations("d1")[0].framePath!;
    assert.equal((await fetch(`${base}${runner.packetOf("d1").frames[0].image}`)).status, 200);
    writeFileSync(path, "tampered");
    const r = await fetch(`${base}${runner.packetOf("d1").frames[0].image}`);
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /recorded hash/);
  } finally { srv.close(); }
});

test("deleting a pickup day removes its rows, jobs and stored frames, and nothing else", async () => {
  const { srv, base, ledger, evidence } = await boot();
  try {
    ledger.createDay({ dayId: "keep", deviceId: DEVICE, windowStartMs: T0, windowEndMs: T0 + H, labels: [] }, T0);
    assert.ok(existsSync(join(evidence, "d1")));
    assert.equal((await fetch(`${base}/days/nope`, { method: "DELETE" })).status, 404);
    const r = await fetch(`${base}/days/d1`, { method: "DELETE" });
    assert.deepEqual([r.status, await r.json()], [200, { deleted: "d1" }]);
    assert.equal(ledger.hasDay("d1"), false);
    assert.equal(ledger.observations("d1").length, 0);
    assert.equal(ledger.jobsFor("d1").length, 0);
    assert.equal(existsSync(join(evidence, "d1")), false, "stored frames are gone from disk");
    assert.equal(ledger.hasDay("keep"), true);
    assert.equal(ledger.jobsFor("keep").length, 2, "another day's schedule is untouched");
    assert.equal((await fetch(`${base}/days/d1`)).status, 404);
  } finally { srv.close(); }
});
