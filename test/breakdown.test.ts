import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "spikes", "porch", "results");
const b = JSON.parse(readFileSync(join(dir, "breakdown-main-bedrock-mantle.json"), "utf8")) as { groups: Record<string, { frames: number; present_ok: number; count_n: number; count_ok: number }> };
const run = JSON.parse(readFileSync(join(dir, "main-bedrock-mantle.json"), "utf8")) as { summary: { present_absent_accuracy: string; count_exact_accuracy_on_labelled: string } };

test("the by-condition table agrees with the run it was cut from, and its groups partition the 60 frames", () => {
  const g = b.groups;
  assert.match(run.summary.present_absent_accuracy, /59\/60/);
  assert.deepEqual([g["all frames"].frames, g["all frames"].present_ok], [60, 59]);
  assert.match(run.summary.count_exact_accuracy_on_labelled, /49\/53/);
  assert.deepEqual([g["all frames"].count_ok, g["all frames"].count_n], [49, 53]);
  assert.equal(g["parcels on the porch"].frames + g["porch empty"].frames, 60);
  assert.equal(g["daylight"].frames + g["night / infrared"].frames, 60);
  assert.equal(g["porch empty"].present_ok, 30, "no empty porch was called occupied");
  assert.ok(g["real footage"].frames > 0 && g["night / infrared"].frames > 0, "no empty group");
});
