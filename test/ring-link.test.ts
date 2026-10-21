import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RingLink, RingLinkError, maskIdentifier } from "../src/ring/oauth.ts";
import { RingSession } from "../src/ring/session.ts";
import { ringIntegrationFromEnv, SETUP_NOTE } from "../src/ring/integration.ts";
import { loadRefreshToken } from "../src/ring/token-store.ts";
import { preflightOk, runPreflight } from "../src/ring/preflight.ts";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";

// A local server shaped per the Ring docs (partner-initiated OAuth 2.0 with PKCE, App Integrations, devices, image download). It is not Ring.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const CLIENT = { id: "client-abc", secret: "client-secret-xyz" };

async function text(req: IncomingMessage) { let s = ""; for await (const c of req) s += c; return s; }

async function ring(opts: { denyImage?: boolean } = {}) {
  const calls = { token: [] as URLSearchParams[], patch: [] as { auth: string | undefined; body: Record<string, unknown> }[], refresh: 0, snapshot: 0 };
  let challenge = "";
  const issued = new Set<string>();
  const srv = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const j = (s: number, o: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && req.url === "/oauth/token") {
      const f = new URLSearchParams(await text(req));
      calls.token.push(f);
      if (f.get("client_id") !== CLIENT.id || f.get("client_secret") !== CLIENT.secret) return j(401, { error: "invalid_client" });
      if (f.get("grant_type") === "refresh_token") { calls.refresh++; return j(200, { access_token: `access-r${calls.refresh}`, refresh_token: `refresh-r${calls.refresh}`, expires_in: 14400, token_type: "Bearer" }); }
      const code = f.get("code")!;
      const verifierOk = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === challenge;
      if (!issued.has(code) || !verifierOk) return j(400, { error: "invalid_grant" });
      issued.delete(code); // single use
      return j(200, { access_token: "access-1", refresh_token: "refresh-1", scope: "ava", expires_in: 14400, token_type: "Bearer" });
    }
    if (req.method === "PATCH" && req.url === "/v1/accounts/me/app-integrations") {
      calls.patch.push({ auth: req.headers.authorization, body: JSON.parse(await text(req)) });
      return j(200, { status: "completed" });
    }
    if (req.url?.includes("/events?")) return j(200, { data: [] });
    if (req.url?.startsWith("/v1/devices?include=")) return j(200, { data: [{ id: "ava1.ring.device.A", attributes: { name: "Front Door" } }], included: [] });
    if (req.method === "POST" && req.url?.endsWith("/media/image/download")) {
      if (opts.denyImage) return j(403, { errors: [{ status: "403", code: "FORBIDDEN", detail: "no consent for this device" }] });
      calls.snapshot++; res.writeHead(303, { location: `${base}/signed.jpg` }); return void res.end(); }
    if (req.url === "/signed.jpg") { res.writeHead(200, { "content-type": "image/jpeg", "x-media-timestamp": "1800000000000", "x-media-origin": "recording" }); return void res.end(Buffer.from(JPEG)); }
    j(404, { errors: [{ status: "404", code: "NOT_FOUND", detail: req.url }] });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    base, calls, close: () => srv.close(),
    /** What Ring would do after the user approves: remember the challenge, mint a code. */
    approve(authorizeUrl: string, code = "code-1") { challenge = new URL(authorizeUrl).searchParams.get("code_challenge")!; issued.add(code); return code; },
  };
}

const newLink = (r: { base: string }, over: Partial<ConstructorParameters<typeof RingLink>[0]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ringlink-"));
  const tokenFile = join(dir, "tok");
  return { tokenFile, link: new RingLink({ clientId: CLIENT.id, clientSecret: CLIENT.secret, redirectUri: "http://localhost:8787/ring/callback", tokenFile, oauthBase: r.base, apiBase: r.base, ...over }) };
};
const cb = (state: string, code: string) => new URLSearchParams({ code, state });

test("authorize URL carries every parameter Ring's docs require, with a real S256 challenge", async () => {
  const r = await ring();
  try {
    const { link } = newLink(r);
    const u = new URL(link.begin());
    assert.equal(`${u.origin}${u.pathname}`, "https://account.ring.com/account/integrations/partner-link/authorize");
    const p = u.searchParams;
    assert.deepEqual([p.get("client_id"), p.get("redirect_uri"), p.get("response_type"), p.get("scope"), p.get("code_challenge_method")], [CLIENT.id, "http://localhost:8787/ring/callback", "code", "ava.v1:read", "S256"]);
    assert.ok((p.get("state") ?? "").length >= 40, "unguessable state");
    assert.match(p.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/, "base64url SHA-256");
    assert.notEqual(new URL(link.begin()).searchParams.get("state"), p.get("state"), "a fresh state every time");
  } finally { r.close(); }
});

test("callback: state checked, code exchanged with the verifier and client credentials, link confirmed with PATCH, token saved sealed", async () => {
  const r = await ring();
  try {
    const { link, tokenFile } = newLink(r);
    const url = link.begin();
    const code = r.approve(url);
    await link.complete(cb(new URL(url).searchParams.get("state")!, code));

    assert.equal(r.calls.token.length, 1);
    const f = r.calls.token[0];
    assert.deepEqual([f.get("grant_type"), f.get("code"), f.get("client_id"), f.get("client_secret")], ["authorization_code", code, CLIENT.id, CLIENT.secret]);
    assert.ok((f.get("code_verifier") ?? "").length >= 43, "the PKCE verifier was sent");
    assert.deepEqual(r.calls.patch, [{ auth: "Bearer access-1", body: { status: "completed", account_identifier: maskIdentifier("outbox") } }]);
    assert.equal(loadRefreshToken(tokenFile), "refresh-1");
    assert.ok(!readFileSync(tokenFile, "utf8").includes("refresh-1"), "sealed on disk");
  } finally { r.close(); }
});

test("must-fail: a state that was never issued is refused before any call to Ring, and nothing is stored", async () => {
  const r = await ring();
  try {
    const { link, tokenFile } = newLink(r);
    link.begin();
    await assert.rejects(link.complete(cb("forged-state", "code-1")), (e: unknown) => e instanceof RingLinkError && e.code === "bad_state");
    await assert.rejects(link.complete(new URLSearchParams({ code: "code-1" })), (e: unknown) => e instanceof RingLinkError && e.code === "bad_state", "missing state");
    assert.equal(r.calls.token.length, 0, "Ring was never asked to exchange anything");
    assert.equal(r.calls.patch.length, 0);
    assert.equal(loadRefreshToken(tokenFile), null);
  } finally { r.close(); }
});

test("must-fail: a state is single use, so replaying a finished callback does nothing", async () => {
  const r = await ring();
  try {
    const { link } = newLink(r);
    const url = link.begin();
    const state = new URL(url).searchParams.get("state")!;
    await link.complete(cb(state, r.approve(url)));
    await assert.rejects(link.complete(cb(state, r.approve(url, "code-2"))), (e: unknown) => e instanceof RingLinkError && e.code === "bad_state");
    assert.equal(r.calls.token.length, 1);
  } finally { r.close(); }
});

test("must-fail: a sign-in left open past ten minutes expires, and Ring's own expired or used code (400) is explained", async () => {
  const r = await ring();
  try {
    let now = 1_000_000;
    const { link, tokenFile } = newLink(r, { now: () => now });
    const url = link.begin();
    const code = r.approve(url);
    now += 10 * 60_000 + 1;
    await assert.rejects(link.complete(cb(new URL(url).searchParams.get("state")!, code)), (e: unknown) => e instanceof RingLinkError && e.code === "state_expired" && /took too long/.test(e.message));
    assert.equal(r.calls.token.length, 0);

    const url2 = link.begin();
    r.approve(url2, "good-code");
    await assert.rejects(link.complete(cb(new URL(url2).searchParams.get("state")!, "stale-code")), (e: unknown) => e instanceof RingLinkError && e.code === "code_expired" && /expired or was already used/.test(e.message));
    assert.equal(r.calls.token.length, 1, "Ring was asked once and refused");
    assert.equal(r.calls.patch.length, 0);
    assert.equal(loadRefreshToken(tokenFile), null, "a failed exchange stores nothing");
  } finally { r.close(); }
});

test("must-fail: wrong client credentials, a denied sign-in and an unconfirmed link each say what happened and store nothing", async () => {
  const r = await ring();
  try {
    const bad = newLink(r, { clientSecret: "wrong" });
    const u = bad.link.begin();
    r.approve(u);
    await assert.rejects(bad.link.complete(cb(new URL(u).searchParams.get("state")!, "code-1")), (e: unknown) => e instanceof RingLinkError && e.code === "bad_client" && /RING_CLIENT_SECRET/.test(e.message));

    const { link, tokenFile } = newLink(r);
    const u2 = link.begin();
    await assert.rejects(link.complete(new URLSearchParams({ state: new URL(u2).searchParams.get("state")!, error: "access_denied", error_description: "ring_base_plan_required" })), /active Ring plan/);
    const u3 = link.begin();
    await assert.rejects(link.complete(new URLSearchParams({ state: new URL(u3).searchParams.get("state")!, error: "access_denied", error_description: "user_cancelled" })), /nothing was linked/);

    const failing = newLink({ base: r.base }, { apiBase: "http://127.0.0.1:1" });
    const u4 = failing.link.begin();
    r.approve(u4, "code-9");
    await assert.rejects(failing.link.complete(cb(new URL(u4).searchParams.get("state")!, "code-9")));
    assert.equal(loadRefreshToken(failing.tokenFile), null, "an unconfirmed link is not saved");
    assert.equal(loadRefreshToken(tokenFile), null);
  } finally { r.close(); }
});

async function app(env: NodeJS.ProcessEnv, r: { base: string }) {
  const dir = mkdtempSync(join(tmpdir(), "ringapp-"));
  const tokenFile = join(dir, "tok");
  const session = new RingSession({ env: { ...env, RING_API_BASE: r.base, RING_OAUTH_BASE: r.base }, tokenFile });
  const vision = { name: "stub-vision", model: "m", readPorch: async () => ({ present: true, count: 2, raw: "" }) };
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({ ledger, clock: () => 0, frames: [], vision, tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} } });
  const integration = ringIntegrationFromEnv({ ...env, RING_API_BASE: r.base, RING_OAUTH_BASE: r.base, RING_AUTHORIZE_URL: `${r.base}/authorize` }, { session, vision, port: 8787, tokenFile, photoDir: join(dir, "photos") });
  const srv = createApp({ signingKey: "k", ledger, runner, ring: integration });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, session, close: () => srv.close() };
}

test("without a client id the page gets the one setup step in plain words, Connect Ring does not redirect, and no device or photo is offered", async () => {
  const r = await ring();
  const a = await app({}, r);
  try {
    const st = await (await fetch(`${a.base}/api/ring`)).json() as { configured: boolean; connected: boolean; setup: string; method: string };
    assert.deepEqual([st.configured, st.connected, st.setup, st.method], [false, false, SETUP_NOTE, "ring-driven"]);
    assert.match(SETUP_NOTE, /RING_CLIENT_ID/);
    const c = await fetch(`${a.base}/ring/connect`, { redirect: "manual" });
    assert.equal(c.status, 400);
    assert.deepEqual(((await c.json()) as { errors: string[] }).errors, [SETUP_NOTE]);
    assert.equal((await fetch(`${a.base}/api/ring/devices`)).status, 409);
    assert.equal((await fetch(`${a.base}/api/ring/snapshot`, { method: "POST", body: JSON.stringify({ deviceId: "x" }) })).status, 409);
    assert.equal(r.calls.token.length + r.calls.snapshot, 0, "nothing reached Ring");
  } finally { a.close(); r.close(); }
});

test("end to end over HTTP: Connect Ring redirects to Ring, the callback links, doorbells list from Ring, and Take a porch photo returns a real download with the porch read", async () => {
  const r = await ring();
  const a = await app({ RING_CLIENT_ID: CLIENT.id, RING_CLIENT_SECRET: CLIENT.secret, RING_LINK_METHOD: "partner-initiated" }, r);
  try {
    const before = await (await fetch(`${a.base}/api/ring`)).json() as Record<string, unknown>;
    assert.deepEqual([before.configured, before.connected, before.method, before.setup], [true, false, "partner-initiated", null]);
    const c = await fetch(`${a.base}/ring/connect`, { redirect: "manual" });
    assert.equal(c.status, 302);
    const authorize = c.headers.get("location")!;
    assert.ok(authorize.startsWith(`${r.base}/authorize?`));
    const code = r.approve(authorize);

    const forged = await fetch(`${a.base}/ring/callback?code=${code}&state=forged`, { redirect: "manual" });
    assert.equal(forged.status, 302);
    assert.match(decodeURIComponent(forged.headers.get("location")!), /^\/\?ring=error&reason=This sign-in did not start here/);
    assert.equal(r.calls.token.length, 0, "the forged callback never reached Ring");

    const ok = await fetch(`${a.base}/ring/callback?code=${code}&state=${new URL(authorize).searchParams.get("state")}`, { redirect: "manual" });
    assert.equal(ok.headers.get("location"), "/?ring=connected");
    const after = await (await fetch(`${a.base}/api/ring`)).json() as Record<string, unknown>;
    assert.deepEqual([after.configured, after.connected], [true, true]);

    const devices = await (await fetch(`${a.base}/api/ring/devices`)).json() as { devices: { id: string; name: string }[] };
    assert.deepEqual(devices.devices, [{ id: "ava1.ring.device.A", name: "Front Door" }]);
    assert.equal(r.calls.refresh >= 1, true, "the saved refresh token was exchanged for an access token");

    const snap = await fetch(`${a.base}/api/ring/snapshot`, { method: "POST", body: JSON.stringify({ deviceId: "ava1.ring.device.A" }) });
    assert.equal(snap.status, 200);
    const p = await snap.json() as { name: string; image: string; width: number; height: number; mediaOrigin: string; mediaTimestamp: string; sha256: string; porch: { count: number; provider: string } };
    assert.deepEqual([p.name, p.width, p.height, p.mediaOrigin, p.mediaTimestamp, p.porch.count, p.porch.provider], ["Front Door", 64, 32, "recording", "2027-01-15T08:00:00.000Z", 2, "stub-vision"]);
    assert.equal(r.calls.snapshot, 1);
    const img = Buffer.from(await (await fetch(`${a.base}${p.image}`)).arrayBuffer());
    assert.equal(createHash("sha256").update(img).digest("hex"), p.sha256, "the served photo is the downloaded frame");

    const unknown = await fetch(`${a.base}/api/ring/snapshot`, { method: "POST", body: JSON.stringify({ deviceId: "not-mine" }) });
    assert.equal(unknown.status, 404);
    assert.equal(r.calls.snapshot, 1, "no download for a doorbell that is not on the account");
    assert.equal((await fetch(`${a.base}/api/ring/photos/..%2Fsecret.jpg`)).status, 404);

    const steps = await runPreflight(a.session, { whep: null });
    assert.equal(preflightOk(steps), true, "ring:preflight passes after the partner-initiated link too");
  } finally { a.close(); r.close(); }
});

test("a Ring refusal while taking the photo reaches the page as a plain message with Ring's status, never a crash", async () => {
  const r = await ring({ denyImage: true });
  const a = await app({ RING_PLAYGROUND_TOKEN: "pg" }, r);
  try {
    assert.equal(((await (await fetch(`${a.base}/api/ring`)).json()) as { connected: boolean }).connected, true);
    const refused = await fetch(`${a.base}/api/ring/snapshot`, { method: "POST", body: JSON.stringify({ deviceId: "ava1.ring.device.A" }) });
    assert.equal(refused.status, 502);
    assert.deepEqual(((await refused.json()) as { errors: string[] }).errors, ["Ring answered 403 FORBIDDEN."]);
    assert.equal((await fetch(`${a.base}/api/ring/snapshot`, { method: "POST", body: "{}" })).status, 400, "a request with no doorbell is refused up front");
  } finally { a.close(); r.close(); }
});
