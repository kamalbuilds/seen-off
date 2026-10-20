import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RingApiError, RingClient, RingSnapshotSource } from "../src/ring/client.ts";

// A local server shaped per the Ring Partner API reference (paths, status codes, JSON:API errors). It is not Ring.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += c;
  return s;
}

async function fakeRing(handler: (req: IncomingMessage, res: ServerResponse, text: string, base: string) => void) {
  const srv = createServer(async (req, res) => handler(req, res, await body(req), `http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => srv.close() };
}

const json = (res: ServerResponse, status: number, o: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

test("oauth: refresh_token grant, access token cached, rotated refresh token handed back", async () => {
  let tokenCalls = 0;
  const forms: URLSearchParams[] = [];
  const f = await fakeRing((req, res, text) => {
    assert.equal(req.url, "/oauth/token");
    forms.push(new URLSearchParams(text));
    tokenCalls++;
    json(res, 200, { access_token: `access-${tokenCalls}`, refresh_token: `refresh-${tokenCalls + 1}`, expires_in: 14400, token_type: "Bearer", scope: "x" });
  });
  let rotated = "";
  let t = 1_000_000;
  const c = new RingClient({ auth: { kind: "refresh", clientId: "cid", clientSecret: "sec", refreshToken: "refresh-1", onRefreshToken: (r) => (rotated = r) }, oauthBase: f.base, now: () => t });
  assert.equal(await c.accessToken(), "access-1");
  assert.equal(await c.accessToken(), "access-1", "cached");
  assert.equal(tokenCalls, 1);
  assert.equal(forms[0].get("grant_type"), "refresh_token");
  assert.equal(forms[0].get("refresh_token"), "refresh-1");
  assert.equal(rotated, "refresh-2");
  t += 4 * 3600_000;
  assert.equal(await c.accessToken(), "access-2", "expired token is refreshed with the rotated refresh token");
  assert.equal(forms[1].get("refresh_token"), "refresh-2");
  f.close();
});

test("devices, history pagination and WHEP session against the documented shapes", async () => {
  const seen: string[] = [];
  const f = await fakeRing((req, res, text) => {
    seen.push(`${req.method} ${req.url} auth=${req.headers.authorization}`);
    if (req.url?.startsWith("/v1/devices?include=")) return json(res, 200, { meta: {}, data: [{ type: "devices", id: "ava1.ring.device.A", attributes: { name: "Front Door" } }], included: [{ type: "device-capabilities", id: "c" }] });
    if (req.url?.includes("/events?event_types=ding%2Cmotion.human") && !req.url.includes("page")) {
      return json(res, 200, { data: [{ type: "history-events", id: "e1", attributes: { event_type: "motion", start: 1699457200000, end: "1699457225000" }, relationships: { source: { data: { id: "ava1.ring.device.A" } } } }], links: { next: "/v1/history/devices/ava1.ring.device.A/events?event_types=ding%2Cmotion.human&page[key]=2025-07-06T11:11:00Z" } });
    }
    if (req.url?.includes("page[key]")) return json(res, 200, { data: [{ type: "history-events", id: "e2", attributes: { event_type: "ding", start: 5, end: 6 } }] });
    if (req.method === "POST" && req.url?.includes("/whep/sessions")) {
      assert.equal(req.headers["content-type"], "application/sdp");
      assert.equal(text, "v=0 offer");
      res.writeHead(201, { "content-type": "application/sdp", location: `/v1/devices/A/media/streaming/whep/sessions/s1` });
      return void res.end("v=0 answer");
    }
    json(res, 404, { errors: [{ status: "404", code: "DEVICE_NOT_FOUND", detail: "x" }] });
  });
  const c = new RingClient({ auth: { kind: "token", token: "tok" }, apiBase: f.base });
  const devices = await c.listDevices();
  assert.deepEqual(devices.map((d) => [d.id, d.name]), [["ava1.ring.device.A", "Front Door"]]);
  const hist = await c.history("ava1.ring.device.A", ["ding", "motion.human"]);
  assert.deepEqual(hist.map((h) => [h.id, h.eventType, h.startMs, h.endMs]), [["e1", "motion", 1699457200000, 1699457225000], ["e2", "ding", 5, 6]]);
  const w = await c.whepStart("A", "v=0 offer");
  assert.equal(w.answerSdp, "v=0 answer");
  assert.match(w.sessionUrl, /whep\/sessions\/s1$/);
  assert.ok(seen.every((l) => l.endsWith("auth=Bearer tok")));
  f.close();
});

test("snapshot: POST image/download answers 303, the signed URL is fetched without the bearer, headers are read", async () => {
  let posted: Record<string, unknown> = {};
  let downloadAuth: string | undefined = "unset";
  const f = await fakeRing((req, res, text, base) => {
    if (req.method === "POST" && req.url === "/v1/devices/ava1.ring.device.A/media/image/download") {
      posted = JSON.parse(text);
      res.writeHead(303, { location: `${base}/v1/download?security_token=abc&req_type=image_download` });
      return void res.end();
    }
    if (req.url?.startsWith("/v1/download")) {
      downloadAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "image/jpeg", "x-media-timestamp": "1699457230000", "x-media-origin": "recording" });
      return void res.end(Buffer.from(JPEG));
    }
    json(res, 500, {});
  });
  const c = new RingClient({ auth: { kind: "token", token: "tok" }, apiBase: f.base });
  const frame = await c.snapshotAt("ava1.ring.device.A", 1699457230000);
  assert.deepEqual(posted, { type: "at_timestamp", timestamp: 1699457230000, image_options: { format: "jpeg" } });
  assert.equal(downloadAuth, undefined, "the pre-signed URL must not receive the bearer token");
  assert.deepEqual([...frame.jpeg], [...JPEG]);
  assert.deepEqual([frame.mediaTimestampMs, frame.origin], [1699457230000, "recording"]);
  const multi = await c.snapshotAt("ava1.ring.device.A", 1, "1");
  assert.ok(multi);
  assert.deepEqual(posted.components, [{ component_id: "1" }]);
  f.close();
});

test("snapshot errors: RECORDING_NOT_READY (425) is retried, MEDIA_NOT_FOUND (416) is not", async () => {
  let calls = 0;
  let mode: "not_ready_then_ok" | "not_found" = "not_ready_then_ok";
  const f = await fakeRing((req, res, _t, base) => {
    if (req.method === "POST") {
      calls++;
      if (mode === "not_found") return json(res, 416, { errors: [{ status: "416", code: "MEDIA_NOT_FOUND", detail: "No media found in time range" }] });
      if (calls < 3) return json(res, 425, { errors: [{ status: "425", code: "RECORDING_NOT_READY", detail: "early" }] });
      res.writeHead(303, { location: `${base}/v1/download?t=1` });
      return void res.end();
    }
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(Buffer.from(JPEG));
  });
  const src = new RingSnapshotSource(new RingClient({ auth: { kind: "token", token: "t" }, apiBase: f.base }), 4, 5);
  const frame = await src.frameAt("D", 1);
  assert.equal(calls, 3, "two 425s then success");
  assert.equal(frame.jpeg.length, JPEG.length);

  mode = "not_found"; calls = 0;
  await assert.rejects(src.frameAt("D", 1), (e: unknown) => e instanceof RingApiError && e.code === "MEDIA_NOT_FOUND" && !e.retryable);
  assert.equal(calls, 1, "a 416 is not retried");
  f.close();
});

test("api errors keep the JSON:API code and status", async () => {
  const f = await fakeRing((_q, res) => json(res, 403, { errors: [{ status: "403", code: "REQUEST_FORBIDDEN", detail: "No access to device" }] }));
  const c = new RingClient({ auth: { kind: "token", token: "t" }, apiBase: f.base });
  await assert.rejects(c.listDevices(), (e: unknown) => e instanceof RingApiError && e.status === 403 && e.code === "REQUEST_FORBIDDEN");
  f.close();
});
