import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RingClient } from "../src/ring/client.ts";
import { formatPreflight, preflightOk, runPreflight } from "../src/ring/preflight.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);

// Shaped per the Ring reference; it is not Ring.
async function ring(o: { devices?: number; snapshot?: number } = {}) {
  const srv = createServer((req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const j = (s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url?.startsWith("/v1/devices?include=")) return o.devices ? j(o.devices, { errors: [{ status: String(o.devices), code: "UNAUTHORIZED", detail: "token rejected" }] }) : j(200, { data: [{ id: "ava1.ring.device.A", attributes: { name: "Front Door" } }], included: [] });
    if (req.url?.includes("/events?")) return j(200, { data: [{ id: "e1", attributes: { event_type: "motion", start: 1_800_000_000_000, end: 1_800_000_020_000 } }] });
    if (req.method === "POST" && req.url?.endsWith("/media/image/download")) {
      if (o.snapshot) return j(o.snapshot, { errors: [{ status: String(o.snapshot), code: "MEDIA_NOT_FOUND", detail: "no recording" }] });
      res.writeHead(303, { location: `${base}/i.jpg` }); return void res.end();
    }
    if (req.url === "/i.jpg") { res.writeHead(200, { "content-type": "image/jpeg", "x-media-timestamp": "1800000000000", "x-media-origin": "recording" }); return void res.end(Buffer.from(JPEG)); }
    j(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => srv.close(), client: new RingClient({ auth: { kind: "token", token: "t" }, apiBase: base }) };
}
const whepOk = { name: "whep", async frameAt() { return { jpeg: JPEG, mediaTimestampMs: 1, origin: "whep-live" }; } };

test("preflight: every surface passes with its timing, and the report is one screen", async () => {
  const r = await ring();
  try {
    const steps = await runPreflight(r.client, { whep: whepOk });
    assert.deepEqual(steps.map((s) => [s.name, s.status]), [["auth", "pass"], ["devices", "pass"], ["history", "pass"], ["snapshot", "pass"], ["whep", "pass"]]);
    assert.ok(steps.every((s) => Number.isInteger(s.ms) && s.ms >= 0));
    assert.equal(steps[1].detail, "1 device: Front Door");
    assert.match(steps[3].detail, /64x32 jpeg, 23 bytes, origin recording/);
    assert.equal(preflightOk(steps), true);
    const report = formatPreflight(steps, r.base);
    assert.ok(report.split("\n").length <= 12, "fits one screen");
    assert.match(report, /RESULT: 5 passed, 0 failed, 0 skipped/);
  } finally { r.close(); }
});

test("must-fail: a refused snapshot fails that step with Ring's code, the rest still report, and the result is not ok", async () => {
  const r = await ring({ snapshot: 416 });
  try {
    const steps = await runPreflight(r.client, { whep: whepOk });
    const snap = steps.find((s) => s.name === "snapshot")!;
    assert.equal(snap.status, "fail");
    assert.match(snap.detail, /Ring 416 MEDIA_NOT_FOUND/);
    assert.equal(steps.find((s) => s.name === "whep")!.status, "skip", "later steps are skipped with the reason, not passed");
    assert.match(steps.find((s) => s.name === "whep")!.detail, /blocked: snapshot failed/);
    assert.equal(preflightOk(steps), false);
    assert.match(formatPreflight(steps, r.base), /FAIL\s+snapshot/);
  } finally { r.close(); }
});

test("must-fail: a rejected token stops at devices, and nothing downstream claims to have passed", async () => {
  const r = await ring({ devices: 401 });
  try {
    const steps = await runPreflight(r.client, { whep: whepOk });
    assert.deepEqual(steps.map((s) => s.status), ["pass", "fail", "skip", "skip", "skip"]);
    assert.match(steps[1].detail, /Ring 401 UNAUTHORIZED/);
    assert.equal(preflightOk(steps), false);
  } finally { r.close(); }
});

test("a WHEP failure fails the run, and --skip-whep is reported as skipped rather than passed", async () => {
  const r = await ring();
  try {
    const broken = { name: "whep", async frameAt(): Promise<never> { throw new Error("aiortc is not installed"); } };
    const failed = await runPreflight(r.client, { whep: broken });
    assert.equal(failed.at(-1)!.status, "fail");
    assert.equal(preflightOk(failed), false);
    const skipped = await runPreflight(r.client, { whep: null });
    assert.deepEqual([skipped.at(-1)!.status, skipped.at(-1)!.detail], ["skip", "skipped on request (--skip-whep)"]);
    assert.equal(preflightOk(skipped), true);
  } finally { r.close(); }
});

const script = join(import.meta.dirname, "..", "scripts", "ring-preflight.ts");
const run = (env: Record<string, string>, ...args: string[]) =>
  promisify(execFile)(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" }).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test("npm run ring:preflight: exit 0 when all pass, 1 on a failing surface, 2 with no credentials and no call made", async () => {
  const none = await run({ RING_REFRESH_TOKEN_FILE: join(import.meta.dirname, "no-such-token-file") });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /No Ring call made/);

  const good = await ring();
  const bad = await ring({ snapshot: 403 });
  try {
    const ok = await run({ RING_PLAYGROUND_TOKEN: "t", RING_API_BASE: good.base }, "--skip-whep");
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /PASS\s+snapshot/);
    assert.match(ok.stdout, /SKIP\s+whep/);
    const fail = await run({ RING_PLAYGROUND_TOKEN: "t", RING_API_BASE: bad.base }, "--skip-whep");
    assert.equal(fail.code, 1);
    assert.match(fail.stdout, /FAIL\s+snapshot\s+\d+ ms\s+Ring 403/);
    assert.match(fail.stdout, /RESULT: 3 passed, 1 failed, 1 skipped/);
  } finally { good.close(); bad.close(); }
});
