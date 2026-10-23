// The dispute kit: the exported evidence file, and the grounding check that refuses a drafted claim citing anything the packet does not hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { RecordedVision, type RecordedReads } from "../src/vision/recorded.ts";
import { checkGrounding, claimKind, draftClaim, type ClaimWriter } from "../src/pickup/claim.ts";
import { SETTLE_MS, SIM_KEY, fixtureTracking, loadDays, playDay, replayFrameSource, root } from "../simulator/replay.ts";

const days = loadDays();
const rec = JSON.parse(readFileSync(join(root, "simulator/qwen3-vl-reads.json"), "utf8")) as RecordedReads;

async function served(dayId: string, claims?: ClaimWriter) {
  let now = 0;
  const ledger = new Ledger(":memory:");
  const runner = new PickupRunner({ ledger, vision: new RecordedVision(rec), frames: [replayFrameSource(days)], tracking: fixtureTracking, alerter: { send: async () => {} }, clock: () => now, settleMs: SETTLE_MS, evidenceDir: join(root, "data/test-evidence", `${process.pid}`) });
  const srv = createApp({ signingKey: SIM_KEY, ledger, runner, claims });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  await playDay(base, runner, days.find((d) => d.dayId === dayId)!, (ms) => { now = ms; });
  return { base, packet: runner.packetOf(dayId), close: () => srv.close() };
}

test("the dispute kit is one HTML file with every frame embedded beside its sha256", async () => {
  const s = await served("day15");
  try {
    const res = await fetch(`${s.base}/days/day15/export`);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    const html = await res.text();
    assert.ok(s.packet.frames.length >= 2);
    assert.equal(html.match(/data:image\/jpeg;base64/g)?.length, s.packet.frames.length);
    for (const f of s.packet.frames) assert.ok(html.includes(f.sha256), f.sha256);
    assert.ok(html.includes(s.packet.labels[0].name!), "the seller's order names are in the kit");
  } finally { s.close(); }
});

test("grounding refuses an invented time or tracking number and passes a draft built from packet facts", async () => {
  const s = await served("day15");
  s.close();
  const p = s.packet;
  assert.equal(claimKind(p), "carrier-trace");
  const handoff = new Intl.DateTimeFormat("en-US", { timeZone: p.timeZone, hour: "numeric", minute: "2-digit" }).format(p.handoffMs!).replace(/\s/g, " ");
  const grounded = `Subject: Missing Mail search for 3 parcels\nAll 3 parcels left the porch by ${handoff}. 3 of 3 labels (${p.labels[0].trackingNumber}) show no scan. The pickup window closed at 4:00 PM.`;
  assert.deepEqual(checkGrounding(grounded, p), { ok: true, problems: [] });

  const invented = checkGrounding(`The driver took them at 3:15 PM. Tracking 9400111899223344556677.`, p);
  assert.equal(invented.ok, false);
  assert.ok(invented.problems.some((x) => x.includes("3:15 PM")), invented.problems.join("; "));
  assert.ok(invented.problems.some((x) => x.includes("9400111899223344556677")), invented.problems.join("; "));
  assert.equal(checkGrounding("The driver took them at 3:15 PM.", p).ok, false, "a time alone is enough to refuse");
  assert.equal(checkGrounding("Please trace 5 parcels.", p).ok, false, "so is a wrong count");
});

test("a claim server returns only a grounded draft; a writer that keeps inventing gets 422 with the reasons", async () => {
  let calls = 0;
  const liar: ClaimWriter = { model: "test", write: async () => { calls++; return "Picked up at 3:15 PM."; } };
  const s = await served("day15", liar);
  try {
    const r = await fetch(`${s.base}/days/day15/claim`, { method: "POST" });
    assert.equal(r.status, 422);
    const body = (await r.json()) as { draft: string | null; grounding: { problems: string[] } };
    assert.equal(body.draft, null);
    assert.equal(calls, 2, "one redraft, then refuse");
    assert.equal((await draftClaim(s.packet, { model: "t", write: async () => "Subject: trace\n3 parcels left the porch." }))?.draft, "Subject: trace\n3 parcels left the porch.");
  } finally { s.close(); }
});

test("live: Qwen3-VL on Bedrock drafts a grounded carrier claim that cites the handoff time", { skip: !process.env.AWS_BEARER_TOKEN_BEDROCK }, async () => {
  const { claimWriterFromEnv } = await import("../src/pickup/claim.ts");
  const s = await served("day15");
  s.close();
  const r = await draftClaim(s.packet, claimWriterFromEnv()!);
  assert.ok(r?.draft, JSON.stringify(r?.grounding));
  const handoff = new Intl.DateTimeFormat("en-US", { timeZone: s.packet.timeZone, hour: "numeric", minute: "2-digit" }).format(s.packet.handoffMs!).replace(/\s/g, " ");
  assert.ok(r.draft.includes(handoff), `draft cites ${handoff}`);
});
