import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RingApiError, RingClient } from "../src/ring/client.ts";
import { jpegSize, runProbe } from "../src/ring/probe.ts";

// A 64x32 JPEG header (SOI, APP0, SOF0 with height 32 and width 64, EOI). The server below is shaped per the Ring reference, it is not Ring.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

async function fake(devicesStatus = 200) {
  const srv = createServer((req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const j = (s: number, o: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url?.startsWith("/v1/devices?include=")) {
      if (devicesStatus !== 200) return j(devicesStatus, { errors: [{ status: String(devicesStatus), code: "FORBIDDEN", detail: "no access" }] });
      return j(200, { data: [{ id: "ava1.ring.device.A", attributes: { name: "Front Door" } }, { id: "ava1.ring.device.B", attributes: { name: "Driveway" } }], included: [{ type: "device-status" }, { type: "device-status" }, { type: "device-capabilities" }] });
    }
    if (req.url?.includes("/events?")) return j(200, { data: [{ id: "e1", attributes: { event_type: "motion", start: 1_800_000_000_000, end: 1_800_000_020_000 } }] });
    if (req.method === "POST" && req.url?.endsWith("/media/image/download")) { res.writeHead(303, { location: `${base}/signed/img.jpg` }); return void res.end(); }
    if (req.url === "/signed/img.jpg") { res.writeHead(200, { "content-type": "image/jpeg", "x-media-timestamp": "1800000000000", "x-media-origin": "recording" }); return void res.end(Buffer.from(JPEG)); }
    j(404, { errors: [{ status: "404", code: "NOT_FOUND", detail: req.url }] });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
}

test("jpegSize reads the frame header and refuses non-JPEG bytes", () => {
  assert.deepEqual(jpegSize(JPEG), { width: 64, height: 32 });
  assert.equal(jpegSize(new Uint8Array([1, 2, 3, 4, 5])), null);
});

test("probe: discovery and a snapshot come back as a report with device, frame metadata and a saved file", async () => {
  const f = await fake();
  const out = mkdtempSync(join(tmpdir(), "probe-"));
  try {
    const client = new RingClient({ auth: { kind: "token", token: "t" }, apiBase: f.base });
    const r = await runProbe(client, { outDir: out, now: () => 1_800_000_090_000, vision: { name: "stub-vision", model: "m", readPorch: async () => ({ present: true, count: 2, raw: "" }) } });
    assert.deepEqual(r.devices.map((d) => d.name), ["Front Door", "Driveway"]);
    assert.deepEqual(r.device, { id: "ava1.ring.device.A", name: "Front Door" });
    assert.deepEqual(r.includedTypes, { "device-status": 2, "device-capabilities": 1 });
    assert.equal(r.snapshot.width, 64);
    assert.equal(r.snapshot.height, 32);
    assert.equal(r.snapshot.mediaOrigin, "recording");
    assert.equal(r.snapshot.mediaTimestamp, "2027-01-15T08:00:00.000Z");
    assert.equal(readFileSync(r.snapshot.file).length, JPEG.length, "the saved file is the downloaded frame");
    assert.equal(r.history.events, 1);
    assert.deepEqual(r.porch, { provider: "stub-vision", model: "m", count: 2 });
    const saved = JSON.parse(readFileSync(r.reportFile, "utf8"));
    assert.equal(saved.snapshot.sha256, r.snapshot.sha256);
    assert.ok(!JSON.stringify(saved).includes('"t"'), "no token in the report");
    const second = await runProbe(client, { outDir: out, deviceId: "ava1.ring.device.B", now: () => 1_800_000_091_000 });
    assert.equal(second.device.name, "Driveway");
    await assert.rejects(runProbe(client, { outDir: out, deviceId: "nope" }), /not in the 2 devices/);
  } finally { f.close(); }
});

test("probe must-fail: a Ring 403 on device discovery is an error, not a report, and nothing is written", async () => {
  const f = await fake(403);
  const out = mkdtempSync(join(tmpdir(), "probe-"));
  try {
    const client = new RingClient({ auth: { kind: "token", token: "t" }, apiBase: f.base });
    await assert.rejects(runProbe(client, { outDir: out }), (e: unknown) => e instanceof RingApiError && e.status === 403);
    assert.deepEqual(execFileSync("ls", [out]).toString().trim(), "");
  } finally { f.close(); }
});

test("npm run ring:probe with no RING_* env makes no call, names what to set, and exits 2", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const r = spawnSync(process.execPath, ["scripts/ring-probe.ts"], { env, encoding: "utf8", cwd: join(import.meta.dirname, "..") });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No Ring call made/);
  assert.match(r.stderr, /RING_PLAYGROUND_TOKEN/);
  assert.match(r.stderr, /RING_REFRESH_TOKEN/);
  assert.match(r.stderr, /Connect Ring/);
});

test("npm run ring:probe with a token prints the returned devices and frame metadata and writes the frame", async () => {
  const f = await fake();
  const cwd = mkdtempSync(join(tmpdir(), "probe-cwd-"));
  try {
    const script = join(import.meta.dirname, "..", "scripts", "ring-probe.ts");
    const { stdout } = await promisify(execFile)(process.execPath, [script, "demo"], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", RING_PLAYGROUND_TOKEN: "t", RING_API_BASE: f.base } });
    assert.match(stdout, /Ring devices on this account: 2/);
    assert.match(stdout, /ava1\.ring\.device\.A\s+Front Door\s+<- capturing from this one/);
    assert.match(stdout, /Snapshot: 64x32 jpeg, 23 bytes, media time 2027-01-15T08:00:00\.000Z, origin recording/);
    assert.match(stdout, /History: 1 events, newest motion/);
    const files = readdirSync(join(cwd, "data", "probe"));
    assert.equal(files.filter((n) => n.endsWith("-snapshot.jpg")).length, 1);
    assert.equal(files.filter((n) => n.endsWith("-probe.json")).length, 1);
  } finally { f.close(); }
});
