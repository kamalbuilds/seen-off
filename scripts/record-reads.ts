// One live Qwen3-VL pass over every replay frame (dev set and holdout), saved to simulator/qwen3-vl-reads.json keyed by
// frame sha256, so the replay console runs with no credentials on the readings the model actually gave.
//
//   node scripts/record-reads.ts        needs AWS_BEARER_TOKEN_BEDROCK
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visionFromEnv } from "../src/vision/index.ts";
import type { RecordedReads } from "../src/vision/recorded.ts";
import { loadDays, root } from "../simulator/replay.ts";

const vision = visionFromEnv({ ...process.env, VISION_PROVIDER: "bedrock-mantle" });
const jobs = [["simulator/days.json", "simulator/days"], ["simulator/holdout.json", "simulator/holdout"]].flatMap(([file, dir]) =>
  loadDays(file).flatMap((d) => d.frames.map((f) => ({ path: join(dir, f.file), rereads: f.kind === "open" && d.labels.length > 0 ? 2 : 0 }))));
const out: RecordedReads = { provider: vision.name, model: vision.model, recordedAt: new Date().toISOString(), reads: {} };

async function read(jpeg: Uint8Array) {
  for (let attempt = 0; ; attempt++) {
    try { const r = await vision.readPorch(jpeg); return { present: r.present, count: r.count, raw: r.raw }; }
    catch (e) { if (attempt === 2) throw e; await new Promise((ok) => setTimeout(ok, 2000)); }
  }
}

let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    const jpeg = new Uint8Array(readFileSync(join(root, job.path)));
    const replies = [await read(jpeg)];
    // The same re-read the runner makes on an empty baseline, so the recording holds what live answered.
    for (let i = 0; i < job.rereads && replies.at(-1)!.count === 0; i++) replies.push(await read(jpeg));
    out.reads[createHash("sha256").update(jpeg).digest("hex")] = { file: job.path, replies };
    console.log(job.path, replies.map((r) => r.count).join(","));
  }
}));
if (Object.keys(out.reads).length !== jobs.length) throw new Error(`recorded ${Object.keys(out.reads).length} of ${jobs.length} frames`);
writeFileSync(join(root, "simulator/qwen3-vl-reads.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`recorded ${jobs.length} frames with ${vision.name}/${vision.model}`);
