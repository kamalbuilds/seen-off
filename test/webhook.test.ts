import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebhookReceiver, type IdempotencyStore, type RingEvent } from "../src/ring/webhook.ts";
import { signBody, verifySignature } from "../src/ring/signature.ts";
import { KEY, bytes, motionBody, signed } from "./fixtures.ts";

function memoryStore(): IdempotencyStore & { done: Set<string> } {
  const done = new Set<string>();
  return { done, isDone: (id) => done.has(id), markDone: (id) => void done.add(id) };
}

function setup(handle: (e: RingEvent) => Promise<void> | void = () => {}, ackBudgetMs?: number) {
  const store = memoryStore();
  const seen: RingEvent[] = [];
  const receive = createWebhookReceiver({ signingKey: KEY, store, ackBudgetMs, handle: async (e) => { seen.push(e); await handle(e); } });
  return { store, seen, receive };
}

test("signature: valid, tampered, wrong key, missing, malformed header", () => {
  const body = bytes(motionBody());
  assert.equal(verifySignature(KEY, body, signBody(KEY, body)), true);
  assert.equal(verifySignature(KEY, body, signBody(KEY, body).replace("sha256=", "")), true, "bare hex is accepted like the docs' removeprefix");
  assert.equal(verifySignature(KEY, bytes(motionBody({ requestId: "other" })), signBody(KEY, body)), false, "tampered body");
  assert.equal(verifySignature("other-key", body, signBody(KEY, body)), false, "wrong key");
  assert.equal(verifySignature(KEY, body, undefined), false, "missing header");
  assert.equal(verifySignature(KEY, body, "sha256=zz"), false, "malformed header");
  assert.equal(verifySignature("", body, signBody("", body)), false, "empty key never verifies");
});

test("webhook: signed delivery is processed once and acked", async () => {
  const { receive, seen, store } = setup();
  const body = motionBody();
  const r = await receive(bytes(body), signed(body));
  assert.deepEqual([r.status, r.body.status], [200, "processed"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "motion_detected");
  assert.equal(seen[0].subType, "human");
  assert.equal(seen[0].deviceId, "ava1.ring.device.TESTFIXTURE");
  assert.equal(store.isDone("req-1"), true);
});

test("webhook: tampered body, wrong key, missing header and re-serialised JSON are rejected before any handling", async () => {
  const { receive, seen } = setup();
  const body = motionBody();
  const good = signed(body);
  assert.equal((await receive(bytes(body.replace("human", "vehicle")), good)).status, 401, "tampered body");
  assert.equal((await receive(bytes(body), signed(body, "wrong-key"))).status, 401, "wrong key");
  assert.equal((await receive(bytes(body), {})).status, 401, "missing header");
  const reserialised = JSON.stringify(JSON.parse(body), null, 2);
  assert.notEqual(reserialised, body);
  assert.equal((await receive(bytes(reserialised), good)).status, 401, "same JSON, different bytes");
  assert.equal(seen.length, 0);
});

test("webhook: signed but malformed payload is a 400, not a crash", async () => {
  const { receive } = setup();
  const notJson = "not json";
  assert.equal((await receive(bytes(notJson), signed(notJson))).status, 400);
  const noRequestId = JSON.stringify({ meta: { version: "1.1", account_id: "a" }, data: { type: "motion_detected" } });
  assert.equal((await receive(bytes(noRequestId), signed(noRequestId))).status, 400);
});

test("webhook: duplicate request_id after success is acked without a second handling", async () => {
  const { receive, seen } = setup();
  const body = motionBody();
  await receive(bytes(body), signed(body));
  const again = await receive(bytes(body), signed(body));
  assert.deepEqual([again.status, again.body.status], [200, "already_processed"]);
  assert.equal(seen.length, 1);
});

test("webhook: handler throws, Ring retries the same request_id, the retry is processed (idempotency marked after success)", async () => {
  let calls = 0;
  const { receive, store } = setup(() => { if (++calls === 1) throw new Error("db down"); });
  const body = motionBody({ requestId: "req-retry" });
  const first = await receive(bytes(body), signed(body));
  assert.equal(first.status, 500, "failure is reported so Ring retries");
  assert.equal(store.isDone("req-retry"), false, "a failed delivery must not be marked done");
  const retry = await receive(bytes(body), signed(body));
  assert.deepEqual([retry.status, retry.body.status], [200, "processed"]);
  assert.equal(calls, 2, "the retry was handled, not swallowed");
  assert.equal(store.isDone("req-retry"), true);
});

test("webhook: a handler slower than the ack budget gets 503 so Ring retries; late success still marks the id", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { receive, store } = setup(() => gate, 30);
  const body = motionBody({ requestId: "req-slow" });
  const t0 = performance.now();
  const r = await receive(bytes(body), signed(body));
  assert.equal(r.status, 503);
  assert.ok(performance.now() - t0 < 1000, "answered at the budget, not when the handler finished");
  assert.equal((await receive(bytes(body), signed(body))).body.status, "in_flight");
  release();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(store.isDone("req-slow"), true);
});

test("webhook: unknown event types are acked, not 4xx'd into an endpoint disable", async () => {
  const { receive } = setup();
  const body = JSON.stringify({ meta: { version: "1.1", request_id: "r9", account_id: "a" }, data: { type: "future_event", attributes: {} } });
  assert.equal((await receive(bytes(body), signed(body))).status, 200);
});

test("webhook: 50 concurrent deliveries of one request_id run the handler once; every caller ends at 200 or a retryable 503", async () => {
  let handled = 0;
  const { receive } = setup(async () => { handled++; await new Promise((r) => setTimeout(r, 20)); });
  const body = motionBody({ requestId: "burst" });
  const results = await Promise.all(Array.from({ length: 50 }, () => receive(bytes(body), signed(body))));
  assert.equal(handled, 1);
  assert.ok(results.every((r) => r.status === 200 || r.status === 503), results.map((r) => r.status).join());
  assert.equal(results.filter((r) => r.status === 200 && r.body.status === "processed").length, 1);
  const retry = await receive(bytes(body), signed(body));
  assert.deepEqual([retry.status, retry.body.status], [200, "already_processed"]);
});
