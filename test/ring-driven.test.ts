import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { computeNonce, maskEmail } from "../src/ring/oneway.ts";
import { RingSession } from "../src/ring/session.ts";
import { consoleSettings, ringIntegrationFromEnv, SETUP_NOTE } from "../src/ring/integration.ts";
import { loadRefreshToken } from "../src/ring/token-store.ts";
import { formatPreflight, preflightOk, runPreflight } from "../src/ring/preflight.ts";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";

// A local Ring shaped per the docs (Token Exchange URL push, users/me, App-Integrations POST then PATCH, devices, snapshots). It is not Ring.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const APP = { id: "app-id", secret: "app-secret", hmac: "hmac-signing-key-from-portal", signIn: "correct-horse" };
const ACCOUNT = "ava1.ring.account.AAAA", OTHER = "ava1.ring.account.BBBB";

async function text(req: IncomingMessage) { let s = ""; for await (const c of req) s += c; return s; }

async function ring(o: { hmac?: string } = {}) {
  const codes = new Map<string, { account: string; linkStart: number }>();
  const integ = new Map<string, "awaiting" | "completed">(); // by account
  const calls = { post: [] as { account: string; body: Record<string, string> }[], patch: 0, refresh: 0, exchange: [] as URLSearchParams[] };
  const srv = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const j = (s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const account = (req.headers.authorization ?? "").replace("Bearer access-", "");
    if (req.method === "POST" && req.url === "/oauth/token") {
      const f = new URLSearchParams(await text(req)); calls.exchange.push(f);
      if (f.get("client_id") !== APP.id || f.get("client_secret") !== APP.secret) return j(401, { error: "invalid_client" });
      if (f.get("grant_type") === "refresh_token") { calls.refresh++; return j(200, { access_token: `access-${f.get("refresh_token")!.replace("refresh-", "")}`, refresh_token: `${f.get("refresh_token")}x`, expires_in: 14400 }); }
      const c = codes.get(f.get("code") ?? "");
      if (!c) return j(400, { error: "invalid_grant" });
      codes.delete(f.get("code")!); // single use
      return j(200, { access_token: `access-${c.account}`, refresh_token: `refresh-${c.account}`, expires_in: 14400, token_type: "Bearer" });
    }
    if (req.url === "/v1/users/me") return j(200, { data: { id: account } });
    if (req.method === "POST" && req.url === "/v1/accounts/me/app-integrations") {
      const b = JSON.parse(await text(req)) as Record<string, string>;
      calls.post.push({ account, body: b });
      const start = [...codes.values()].find((c) => c.account === account)?.linkStart ?? linkStarts.get(account)!;
      if (b.nonce !== computeNonce(o.hmac ?? APP.hmac, start, account)) return j(400, { errors: [{ title: "Invalid Nonce" }] });
      integ.set(account, "awaiting"); return j(200, { status: "awaiting" });
    }
    if (req.method === "PATCH" && req.url === "/v1/accounts/me/app-integrations") {
      if (integ.get(account) !== "awaiting") return j(409, { errors: [{ title: "not awaiting" }] });
      calls.patch++; integ.set(account, "completed"); return j(200, { status: "completed" });
    }
    if (req.url?.startsWith("/v1/devices?include=")) return j(200, { data: [{ id: "ava1.ring.device.A", attributes: { name: "Front Door" } }], included: [] });
    if (req.url?.includes("/events?")) return j(200, { data: [] });
    if (req.method === "POST" && req.url?.endsWith("/media/image/download")) { res.writeHead(303, { location: `${base}/i.jpg` }); return void res.end(); }
    if (req.url === "/i.jpg") { res.writeHead(200, { "content-type": "image/jpeg", "x-media-timestamp": "1800000000000", "x-media-origin": "recording" }); return void res.end(Buffer.from(JPEG)); }
    j(404, {});
  });
  const linkStarts = new Map<string, number>();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    base, calls, close: () => srv.close(),
    /** The user taps Connect in the Ring app: Ring mints a code, pushes it to the Token Exchange URL, then sends the user to the Account Link URL. */
    async confirmInRingApp(app: string, account: string, now = Date.now()): Promise<{ push: Response; linkUrl: string }> {
      const code = `code-${account}-${now}`;
      codes.set(code, { account, linkStart: now }); linkStarts.set(account, now);
      const push = await fetch(`${app}/ring/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code }) });
      return { push, linkUrl: `${app}/ring/link?nonce=${computeNonce(o.hmac ?? APP.hmac, now, account)}&time=${now}` };
    },
  };
}

async function app(r: { base: string }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "driven-"));
  const tokenFile = join(dir, "tok");
  const full = { RING_CLIENT_ID: APP.id, RING_CLIENT_SECRET: APP.secret, RING_WEBHOOK_SIGNING_KEY: APP.hmac, OUTBOX_SIGN_IN_CODE: APP.signIn, RING_API_BASE: r.base, RING_OAUTH_BASE: r.base, OUTBOX_PUBLIC_URL: "https://outbox.example.com", ...env };
  const vision = { name: "v", model: "m", readPorch: async () => ({ present: true, count: 1, raw: "" }) };
  const session = new RingSession({ env: full, tokenFile });
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({ ledger, clock: () => 0, frames: [], vision, tracking: { statusOf: async () => "TRANSIT" }, alerter: { send: async () => {} } });
  const srv = createApp({ signingKey: "k", ledger, runner, ring: ringIntegrationFromEnv(full, { session, vision, port: 8787, tokenFile, photoDir: join(dir, "p") }) });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, tokenFile, session, env: full, close: () => srv.close() };
}
const signIn = (base: string, linkUrl: string, f: { email?: string; passcode?: string } = {}) => {
  const u = new URL(linkUrl);
  return fetch(`${base}/ring/link`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nonce: u.searchParams.get("nonce")!, time: u.searchParams.get("time")!, email: f.email ?? "seller@example.com", passcode: f.passcode ?? APP.signIn }) });
};
const link = (app: string, linkUrl: string) => linkUrl.replace(app, "");

test("Ring-driven link end to end: Ring pushes the code, the user lands on the Account Link URL, signs in, the nonce matches, POST then PATCH confirm, the token is sealed on disk", async () => {
  const r = await ring();
  const a = await app(r);
  try {
    const st0 = await (await fetch(`${a.base}/api/ring`)).json() as Record<string, unknown>;
    assert.deepEqual([st0.configured, st0.connected, st0.method, st0.waiting], [true, false, "ring-driven", 0]);
    assert.match(st0.steps as string, /Ring app, go to Appstore, choose Outbox and tap Connect/);

    const { push, linkUrl } = await r.confirmInRingApp(a.base, ACCOUNT);
    assert.equal(push.status, 200);
    assert.equal(((await (await fetch(`${a.base}/api/ring`)).json()) as { waiting: number }).waiting, 1, "one confirmation waits for the seller");
    assert.equal(r.calls.exchange[0].get("grant_type"), "authorization_code");

    const page = await fetch(linkUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Link your Ring account/);
    assert.match(html, /name="passcode"/);

    const done = await signIn(a.base, linkUrl, { email: "seller@example.com" });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/?ring=connected");
    assert.deepEqual(r.calls.post.map((p) => [p.account, p.body.account_identifier, p.body.nonce === new URL(linkUrl).searchParams.get("nonce")]), [[ACCOUNT, maskEmail("seller@example.com"), true]]);
    assert.equal(maskEmail("seller@example.com"), "s***r@example.com");
    assert.equal(r.calls.patch, 1, "PATCH completed follows the POST");
    assert.equal(loadRefreshToken(a.tokenFile), `refresh-${ACCOUNT}`);
    assert.ok(!readFileSync(a.tokenFile, "utf8").includes("refresh-ava1"), "sealed on disk");
    const st1 = await (await fetch(`${a.base}/api/ring`)).json() as Record<string, unknown>;
    assert.deepEqual([st1.connected, st1.waiting], [true, 0]);

    // ring:preflight works after this link path, by session and by the real script
    const steps = await runPreflight(a.session, { whep: null });
    assert.equal(preflightOk(steps), true, formatPreflight(steps, r.base));
    assert.ok(r.calls.refresh >= 1, "the saved refresh token was used");
    const script = join(import.meta.dirname, "..", "scripts", "ring-preflight.ts");
    const out = await promisify(execFile)(process.execPath, [script, "--skip-whep"], { env: { PATH: process.env.PATH ?? "", RING_CLIENT_ID: APP.id, RING_CLIENT_SECRET: APP.secret, RING_API_BASE: r.base, RING_OAUTH_BASE: r.base, RING_REFRESH_TOKEN_FILE: a.tokenFile }, encoding: "utf8" });
    assert.match(out.stdout, /PASS\s+snapshot/);
    assert.match(out.stdout, /RESULT: 4 passed, 0 failed, 1 skipped/);
  } finally { a.close(); r.close(); }
});

test("must-fail: a tampered or made-up nonce is not recognised, Ring is never asked to confirm, nothing is saved", async () => {
  const r = await ring();
  const a = await app(r);
  try {
    const { linkUrl } = await r.confirmInRingApp(a.base, ACCOUNT);
    const u = new URL(linkUrl);
    const nonce = u.searchParams.get("nonce")!;
    const flipped = `${nonce.slice(0, -1)}${nonce.endsWith("A") ? "B" : "A"}`;
    const bad = await signIn(a.base, linkUrl.replace(nonce, flipped));
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /not recognised, or was already used/);
    const madeUp = await signIn(a.base, linkUrl.replace(nonce, "A".repeat(43)));
    assert.equal(madeUp.status, 400);
    const malformed = await fetch(`${a.base}/ring/link?nonce=%3Cscript%3E&time=${u.searchParams.get("time")}`);
    assert.equal(malformed.status, 400);
    assert.match(await malformed.text(), /missing what Ring sends/);
    assert.equal(r.calls.post.length, 0);
    assert.equal(loadRefreshToken(a.tokenFile), null);
  } finally { a.close(); r.close(); }
});

test("must-fail: a nonce cannot be replayed after the link finished", async () => {
  const r = await ring();
  const a = await app(r);
  try {
    const { linkUrl } = await r.confirmInRingApp(a.base, ACCOUNT);
    assert.equal((await signIn(a.base, linkUrl)).status, 302);
    const again = await signIn(a.base, linkUrl);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /already used/);
    assert.equal(r.calls.post.length, 1, "no second confirmation reached Ring");
  } finally { a.close(); r.close(); }
});

test("must-fail: a nonce signed with the wrong HMAC key matches no token, so Ring is never asked to confirm", async () => {
  const r = await ring({ hmac: "some-other-apps-key" });
  const a = await app(r);
  try {
    const { linkUrl } = await r.confirmInRingApp(a.base, ACCOUNT);
    const res = await signIn(a.base, linkUrl);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /not recognised/);
    assert.equal(r.calls.post.length, 0);
    assert.equal(loadRefreshToken(a.tokenFile), null);
  } finally { a.close(); r.close(); }
});

test("must-fail: a wrong client secret means Ring refuses the code, the Token Exchange URL answers 502, and no token waits to be claimed", async () => {
  const r = await ring();
  const a = await app(r, { RING_CLIENT_SECRET: "wrong-secret" });
  try {
    const { push, linkUrl } = await r.confirmInRingApp(a.base, ACCOUNT);
    assert.equal(push.status, 502);
    assert.equal(((await (await fetch(`${a.base}/api/ring`)).json()) as { waiting: number }).waiting, 0);
    assert.equal((await signIn(a.base, linkUrl)).status, 400);
    assert.equal(r.calls.post.length, 0);
    assert.equal((await fetch(`${a.base}/ring/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "nothing=1" })).status, 400, "no code at all");
  } finally { a.close(); r.close(); }
});

test("must-fail: a link older than ten minutes, or dated in the future, shows no sign-in and cannot be submitted", async () => {
  const r = await ring();
  const a = await app(r);
  try {
    const old = Date.now() - 11 * 60_000;
    const { linkUrl } = await r.confirmInRingApp(a.base, ACCOUNT, old);
    const page = await fetch(linkUrl);
    assert.equal(page.status, 400);
    const html = await page.text();
    assert.match(html, /expired after ten minutes/);
    assert.ok(!html.includes('name="passcode"'), "no sign-in form for an expired link");
    assert.equal((await signIn(a.base, linkUrl)).status, 400, "submitting it directly is refused too");
    const future = await r.confirmInRingApp(a.base, OTHER, Date.now() + 10 * 60_000);
    assert.equal((await fetch(future.linkUrl)).status, 400);
    assert.equal(r.calls.post.length, 0);
    // the edge: just inside the window still works
    const fresh = await r.confirmInRingApp(a.base, ACCOUNT, Date.now() - 9 * 60_000);
    assert.equal((await signIn(a.base, fresh.linkUrl)).status, 302);
  } finally { a.close(); r.close(); }
});

test("must-fail: the sign-in is mandatory. A wrong code or a malformed email is refused with the form back, five misses lock it, and nothing is confirmed", async () => {
  const r = await ring();
  const a = await app(r);
  try {
    const { linkUrl } = await r.confirmInRingApp(a.base, ACCOUNT);
    const wrong = await signIn(a.base, linkUrl, { passcode: "nope" });
    assert.equal(wrong.status, 401);
    const html = await wrong.text();
    assert.match(html, /That sign-in did not match/);
    assert.match(html, /name="passcode"/, "the form is shown again");
    assert.equal((await signIn(a.base, linkUrl, { email: "not-an-email" })).status, 401);
    for (let i = 0; i < 3; i++) await signIn(a.base, linkUrl, { passcode: "nope" });
    assert.equal(r.calls.post.length, 0);
    const locked = await signIn(a.base, linkUrl, { passcode: APP.signIn });
    assert.equal(locked.status, 429, "even the right code waits out the lock");
    assert.match(await locked.text(), /Too many wrong sign-in attempts/);
    assert.equal(r.calls.post.length, 0);
  } finally { a.close(); r.close(); }
});

test("two unclaimed Ring accounts: the nonce claims only the account it was minted for, and the page escapes what the seller typed", async () => {
  const r = await ring();
  const a = await app(r);
  try {
    await r.confirmInRingApp(a.base, OTHER);
    const mine = await r.confirmInRingApp(a.base, ACCOUNT);
    assert.equal(((await (await fetch(`${a.base}/api/ring`)).json()) as { waiting: number }).waiting, 2);
    const wrong = await signIn(a.base, mine.linkUrl, { passcode: "nope", email: '"><script>alert(1)</script>@x.io' });
    assert.ok(!(await wrong.text()).includes("<script>alert(1)"), "typed email is escaped in the page");
    assert.equal((await signIn(a.base, mine.linkUrl)).status, 302);
    assert.equal(loadRefreshToken(a.tokenFile), `refresh-${ACCOUNT}`, "not the other account's token");
    assert.equal(((await (await fetch(`${a.base}/api/ring`)).json()) as { waiting: number }).waiting, 1, "the other confirmation still waits");
  } finally { a.close(); r.close(); }
});

test("Ring answering 400 Invalid Nonce at confirmation is explained and stores nothing; without the app's HMAC key and sign-in code the page asks for the one setup step", async () => {
  const r = await ring({ hmac: APP.hmac });
  const a = await app(r);
  try {
    const { linkUrl } = await r.confirmInRingApp(a.base, ACCOUNT);
    // Ring's own stored link start differs from the time in the URL it sent: its confirmation rejects the nonce
    const u = new URL(linkUrl);
    const skewed = `${a.base}/ring/link?nonce=${computeNonce(APP.hmac, Number(u.searchParams.get("time")) + 1, ACCOUNT)}&time=${Number(u.searchParams.get("time")) + 1}`;
    const res = await signIn(a.base, skewed);
    assert.equal(res.status, 400);
    assert.equal(r.calls.post.length, 1, "the match was found locally and Ring was asked");
    assert.match(await res.text(), /Ring did not accept the link request/);
    assert.equal(loadRefreshToken(a.tokenFile), null);
  } finally { a.close(); r.close(); }

  const none = await ring();
  const bare = await app(none, { RING_WEBHOOK_SIGNING_KEY: "", OUTBOX_SIGN_IN_CODE: "" });
  try {
    const st = await (await fetch(`${bare.base}/api/ring`)).json() as { configured: boolean; setup: string };
    assert.equal(st.configured, false);
    assert.equal(st.setup, SETUP_NOTE);
    assert.match(SETUP_NOTE, /OUTBOX_SIGN_IN_CODE/);
    assert.equal((await fetch(`${bare.base}/ring/link?nonce=${"A".repeat(43)}&time=${Date.now()}`)).status, 400);
    assert.equal((await fetch(`${bare.base}/ring/oauth/token`, { method: "POST", body: "code=x" })).status, 400);
  } finally { bare.close(); none.close(); }
});

test("console settings: exactly the URLs to enter in the Ring Developer Portal, built from the public HTTPS address, and nothing for an http address", () => {
  assert.deepEqual(consoleSettings("https://outbox.example.com/"), {
    accountLinkUrl: "https://outbox.example.com/ring/link", tokenExchangeUrl: "https://outbox.example.com/ring/oauth/token",
    webhookUrl: "https://outbox.example.com/ring/webhook", appHomepageUrl: "https://outbox.example.com/", oauthRedirectUri: "https://outbox.example.com/ring/callback", scopes: "Cameras and Doorbells",
  });
  assert.equal(consoleSettings("http://localhost:8787"), null);
  assert.equal(consoleSettings(undefined), null);
});

test("npm run ring:setup prints the portal settings from the public address, and refuses without one", async () => {
  const script = join(import.meta.dirname, "..", "scripts", "ring-setup.ts");
  const ok = await promisify(execFile)(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", OUTBOX_PUBLIC_URL: "https://outbox.example.com" }, encoding: "utf8" });
  for (const line of ["Account Link URL     https://outbox.example.com/ring/link", "Token Exchange URL   https://outbox.example.com/ring/oauth/token", "Webhook URL          https://outbox.example.com/ring/webhook", "Cameras and Doorbells"]) assert.ok(ok.stdout.includes(line), line);
  const none = await promisify(execFile)(process.execPath, [script], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" }).then(() => 0, (e: { code: number }) => e.code);
  assert.equal(none, 2);
});
