// The no-credentials replay: recorded Qwen3-VL readings keyed by frame sha256 drive the real receiver, runner and verdicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Ledger } from "../src/store/ledger.ts";
import { PickupRunner } from "../src/pickup/runner.ts";
import { createApp } from "../src/server.ts";
import { visionFromEnv } from "../src/vision/index.ts";
import { RecordedVision, type RecordedReads } from "../src/vision/recorded.ts";
import { SETTLE_MS, SIM_KEY, fixtureTracking, loadDays, playDay, replayFrameSource, root } from "../simulator/replay.ts";

const READS = join(root, "simulator/qwen3-vl-reads.json");
const days = loadDays();

async function replay(dayId: string, rec: RecordedReads) {
  let now = 0;
  const ledger = new Ledger(":memory:");
  const vision = new RecordedVision(rec);
  const runner = new PickupRunner({ ledger, vision, frames: [replayFrameSource(days)], tracking: fixtureTracking, alerter: { send: async () => {} }, clock: () => now, settleMs: SETTLE_MS });
  const srv = createApp({ signingKey: SIM_KEY, ledger, runner });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await playDay(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, runner, days.find((d) => d.dayId === dayId)!, (ms) => { now = ms; });
    return { verdict: r.verdict, packet: runner.packetOf(dayId) };
  } finally { srv.close(); }
}

test("no key and an empty VISION_PROVIDER fall through to the recorded readings, a key still selects live Bedrock", () => {
  assert.equal(visionFromEnv({}, READS).name, "bedrock-mantle (recorded)");
  assert.equal(visionFromEnv({ VISION_PROVIDER: "" }, READS).model, "qwen.qwen3-vl-235b-a22b-instruct");
  assert.equal(visionFromEnv({ VISION_PROVIDER: "", AWS_BEARER_TOKEN_BEDROCK: "x" }, READS).name, "bedrock-mantle");
  assert.throws(() => visionFromEnv({ VISION_PROVIDER: "" }), /VISION_PROVIDER must be/);
});

test("the recorded readings replay the three demo days to their true verdicts, and a missing frame reads as null, never a guess", async () => {
  const rec = JSON.parse(readFileSync(READS, "utf8")) as RecordedReads;
  const day05 = await replay("day05", rec);
  assert.equal(day05.verdict, "missed");
  assert.equal(day05.packet.provenance.vision?.model, "qwen.qwen3-vl-235b-a22b-instruct");
  assert.equal((await replay("day06", rec)).verdict, "partial");
  assert.equal((await replay("day15", rec)).verdict, "unscanned");

  const close = days.find((d) => d.dayId === "day05")!.frames.find((f) => f.kind === "close")!;
  const sha = createHash("sha256").update(readFileSync(join(root, "simulator/days", close.file))).digest("hex");
  const { [sha]: dropped, ...rest } = rec.reads;
  assert.ok(dropped, "the day05 close frame is in the recording");
  const gap = await replay("day05", { ...rec, reads: rest });
  const closeFrame = gap.packet.frames.find((f) => f.kind === "close")!;
  assert.equal(closeFrame.count, null);
  assert.match(closeFrame.error ?? "", /no recorded reading/);
  assert.equal(gap.verdict, "unverified");
});
