import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { createOperatorAuth } from "../src/operator.ts";
import { RingSession } from "../src/ring/session.ts";
import { ringIntegrationFromEnv } from "../src/ring/integration.ts";
import { KEY, motionBody, signed } from "./fixtures.ts";

const CODE = "operator-code-for-tests";
const DEVICE = "ava1.ring.device.TESTFIXTURE";

async function console_(o: { secure?: boolean; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "operator-"));
  const vision = { name: "s", model: "s", readPorch: async () => ({ present: false, count: 0, raw: "" }) };
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({
    ledger, clock: () => 0, vision,
    frames: [{ name: "one", frameAt: async () => ({ jpeg: new Uint8Array([1]), mediaTimestampMs: 0, origin: "test" }) }],
    tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} },
  });
  let demoRunning = false;
  const env = { RING_CLIENT_ID: "id", RING_CLIENT_SECRET: "secret", RING_WEBHOOK_SIGNING_KEY: KEY, OUTBOX_SIGN_IN_CODE: CODE, OUTBOX_PUBLIC_URL: "https://seenoff.example.com" } as NodeJS.ProcessEnv;
  const srv = createApp({
    signingKey: KEY, ledger, runner,
    operator: createOperatorAuth({ code: CODE, secure: o.secure ?? false, now: o.now }),
    ring: ringIntegrationFromEnv(env, { session: new RingSession({ env, tokenFile: join(dir, "token") }), vision, port: 0, tokenFile: join(dir, "token"), photoDir: join(dir, "p") }),
    replay: {
      days: () => [{ dayId: "day01", labels: 3, startMs: 1_000 }],
      start: (id) => `${id}-replay-2`,
      demo: { status: () => ({ running: demoRunning, current: null, steps: [] }), start() { demoRunning = true; } },
    },
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const login = (code: string) => fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code }) });
  const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];
  return { base, login, cookieOf, close: () => srv.close() };
}

const planBody = JSON.stringify({ dayId: "d1", deviceId: DEVICE, windowStartMs: 1_000, windowEndMs: 3_600_000, labels: [{ trackingNumber: "A", carrier: "usps" }] });

// [method, path, body]: every seller and operator route, including the ones that move or delete evidence.
const SELLER: [string, string, string?][] = [
  ["POST", "/days", planBody],
  ["GET", "/days/d1"],
  ["GET", "/days/d1/frames/0"],
  ["DELETE", "/days/d1"],
  ["GET", "/api/days"],
  ["GET", "/api/devices"],
  ["GET", "/api/stream"],
  ["GET", "/api/replay"],
  ["POST", "/api/replay", JSON.stringify({ dayId: "day01" })],
  ["POST", "/api/demo"],
  ["GET", "/api/ring"],
  ["GET", "/api/ring/devices"],
  ["POST", "/api/ring/snapshot", JSON.stringify({ deviceId: DEVICE })],
  ["GET", "/api/ring/photos/x.jpg"],
  ["GET", "/ring/connect"],
  ["GET", "/ring/callback"],
  ["GET", "/index.html.map"],
];

test("every seller and operator route is 401 without a session, and the one-click demo is among them", async () => {
  const c = await console_();
  try {
    assert.ok(SELLER.length > 10, "the matrix is not empty");
    for (const [method, path, body] of SELLER) {
      const r = await fetch(`${c.base}${path}`, { method, body, headers: body ? { "content-type": "application/json" } : {} });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.deepEqual(await r.json(), { error: "sign in required" }, `${method} ${path}`);
    }
    const demo = await fetch(`${c.base}/api/demo`, { method: "POST", headers: { cookie: "seenoff_operator=1.forged" } });
    assert.equal(demo.status, 401, "a forged cookie is not a session");
  } finally { c.close(); }
});

test("after sign-in the same routes answer, including the one-click demo", async () => {
  const c = await console_();
  try {
    const r = await c.login(CODE);
    assert.equal(r.status, 302);
    const headers = { cookie: c.cookieOf(r), "content-type": "application/json" };
    assert.equal((await fetch(`${c.base}/days`, { method: "POST", headers, body: planBody })).status, 201);
    assert.equal((await fetch(`${c.base}/days/d1`, { headers })).status, 200);
    assert.equal((await fetch(`${c.base}/api/days`, { headers })).status, 200);
    assert.equal((await fetch(`${c.base}/api/ring`, { headers })).status, 200);
    assert.equal((await fetch(`${c.base}/api/demo`, { method: "POST", headers })).status, 202);
    assert.equal((await fetch(`${c.base}/api/replay`, { method: "POST", headers, body: JSON.stringify({ dayId: "day01" }) })).status, 202);
    assert.equal((await fetch(`${c.base}/days/d1`, { method: "DELETE", headers })).status, 200);
    const page = await (await fetch(`${c.base}/`, { headers })).text();
    assert.match(page, /New pickup day/, "the seller console loads once signed in");
  } finally { c.close(); }
});

test("the front page is the sign-in form until you sign in", async () => {
  const c = await console_();
  try {
    const r = await fetch(`${c.base}/`);
    const page = await r.text();
    assert.equal(r.status, 200);
    assert.match(page, /action="\/login"/);
    assert.doesNotMatch(page, /New pickup day/, "the console itself is not served to a visitor");
    assert.equal((await fetch(`${c.base}/index.html`)).status, 200);
  } finally { c.close(); }
});

test("Ring's routes and /health stay open and keep their own checks", async () => {
  const c = await console_();
  try {
    assert.equal((await fetch(`${c.base}/health`)).status, 200);
    const body = motionBody({ requestId: "op-1" });
    const hook = (b: string, h: Record<string, string>) => fetch(`${c.base}/ring/webhook`, { method: "POST", body: b, headers: { "content-type": "application/json", ...h } });
    assert.equal((await hook(body, signed(body))).status, 200, "a signed delivery needs no session");
    const forged = await hook(body.replace("human", "vehicle"), signed(body));
    assert.equal(forged.status, 401);
    assert.notDeepEqual(await forged.json(), { error: "sign in required" }, "the 401 is the HMAC check, not the sign-in gate");
    const link = await fetch(`${c.base}/ring/link`);
    assert.equal(link.status, 400, "Account Link URL answers without a session; with no nonce it says so");
    assert.match(await link.text(), /missing what Ring sends/);
    const tx = await fetch(`${c.base}/ring/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
    assert.equal(tx.status, 400, "Token Exchange URL answers without a session; with no code it refuses");
    const sub = await fetch(`${c.base}/ring/link`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "nonce=short&time=1" });
    assert.equal(sub.status, 400);
  } finally { c.close(); }
});

test("sign-in: wrong code is refused with no cookie, five misses lock the form, a session cookie is HttpOnly and SameSite", async () => {
  const c = await console_();
  try {
    const bad = await c.login("nope");
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("set-cookie"), null);
    assert.equal((await c.login("")).status, 401);
    const good = await c.login(CODE);
    assert.equal(good.status, 302);
    const sc = good.headers.get("set-cookie")!;
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    assert.match(sc, /Path=\//);
    assert.doesNotMatch(sc, /Secure/, "http test server: plain cookie");
    for (let i = 0; i < 5; i++) await c.login("wrong");
    const locked = await c.login(CODE);
    assert.equal(locked.status, 429, "the right code is also refused while locked");
    assert.equal(locked.headers.get("set-cookie"), null);
  } finally { c.close(); }
});

test("on an https deployment the cookie is Secure and __Host- prefixed", async () => {
  const c = await console_({ secure: true });
  try {
    const sc = (await c.login(CODE)).headers.get("set-cookie")!;
    assert.match(sc, /^__Host-seenoff_operator=/);
    assert.match(sc, /; Secure/);
    assert.match(sc, /HttpOnly/);
    assert.doesNotMatch(sc, /Domain=/);
  } finally { c.close(); }
});

test("a tampered, expired or signed-out cookie is not a session", async () => {
  let now = 1_800_000_000_000;
  const c = await console_({ now: () => now });
  try {
    const cookie = c.cookieOf(await c.login(CODE));
    const get = (ck: string) => fetch(`${c.base}/api/days`, { headers: { cookie: ck } });
    assert.equal((await get(cookie)).status, 200);
    const [name, val] = cookie.split("=");
    const [exp, mac] = val.split(".");
    assert.equal((await get(`${name}=${Number(exp) + 1}.${mac}`)).status, 401, "moved expiry");
    assert.equal((await get(`${name}=${exp}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`)).status, 401, "changed signature");
    now += 12 * 3600_000 + 1;
    assert.equal((await get(cookie)).status, 401, "after twelve hours");
    now = 1_800_000_000_000;
    const out = await fetch(`${c.base}/logout`, { method: "POST", redirect: "manual" });
    assert.equal(out.status, 302);
    assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
  } finally { c.close(); }
});

test("a cookie signed under a different sign-in code is refused", async () => {
  const a = await console_();
  const other = createOperatorAuth({ code: "another-code", secure: false });
  try {
    const mine = other.login("another-code") as { cookie: string };
    const r = await fetch(`${a.base}/api/days`, { headers: { cookie: mine.cookie.split(";")[0] } });
    assert.equal(r.status, 401);
  } finally { a.close(); }
});
