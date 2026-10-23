import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { visionFromEnv } from "../src/vision/index.ts";

test("AWS_BEARER_TOKEN_BEDROCK alone selects bedrock-mantle with the Qwen3-VL model", () => {
  const v = visionFromEnv({ AWS_BEARER_TOKEN_BEDROCK: "x" });
  assert.equal(v.name, "bedrock-mantle");
  assert.equal(v.model, "qwen.qwen3-vl-235b-a22b-instruct");
});

test("an empty AWS_REGION or model name counts as unset: the request goes to us-east-1 with the default Qwen3-VL model", async (t) => {
  const v = visionFromEnv({ AWS_BEARER_TOKEN_BEDROCK: "x", AWS_REGION: "", BEDROCK_MANTLE_MODEL: "" });
  assert.equal(v.model, "qwen.qwen3-vl-235b-a22b-instruct");
  let url = "";
  t.mock.method(globalThis, "fetch", async (u: string) => { url = u; return new Response(JSON.stringify({ choices: [{ message: { content: '{"parcels_present":false,"count":0}' } }] })); });
  await v.readPorch(new Uint8Array([1]));
  assert.equal(url, "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions");
});

test("VISION_PROVIDER still forces another stage; no credentials and no provider throws", () => {
  assert.equal(visionFromEnv({ VISION_PROVIDER: "openrouter", OPENROUTER_API_KEY: "x", AWS_BEARER_TOKEN_BEDROCK: "x" }).name, "openrouter");
  assert.throws(() => visionFromEnv({}), /VISION_PROVIDER must be/);
});

test("live: bedrock-mantle reads a real porch frame with parcels and an empty one", { skip: !process.env.AWS_BEARER_TOKEN_BEDROCK }, async () => {
  const v = visionFromEnv();
  const labels = JSON.parse(readFileSync("spikes/porch/labels.json", "utf8")) as { id: string; present: boolean }[];
  const full = labels.find((l) => l.present)!, empty = labels.find((l) => !l.present)!;
  const read = (id: string) => v.readPorch(readFileSync(`spikes/porch/frames/${id}.jpg`));
  assert.equal((await read(full.id)).present, true);
  assert.equal((await read(empty.id)).present, false);
});
