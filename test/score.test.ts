import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { score } from "../metric/score.ts";

const rows = (...pairs: [string, string | null][]) => pairs.map(([truth, verdict]) => ({ truth, verdict }));

test("score: matrix, precision, recall and false reassurance on a known set", () => {
  const s = score(rows(["taken", "taken"], ["taken", "taken"], ["missed", "missed"], ["missed", "taken"], ["partial", "unverified"], ["unscanned", "unscanned"]));
  assert.equal(s.matrix.missed.taken, 1);
  assert.equal(s.matrix.partial.unverified, 1);
  assert.deepEqual(s.perClass.taken, { support: 2, recall: 1, precision: 2 / 3 });
  assert.deepEqual(s.perClass.missed, { support: 2, recall: 0.5, precision: 1 });
  assert.deepEqual(s.falseReassurance, { count: 1, of: 3 });
});

test("score: a class nothing was predicted as has null precision, and an empty list scores zero false reassurances over zero days", () => {
  assert.equal(score(rows(["partial", "missed"])).perClass.partial.precision, null);
  assert.deepEqual(score([]).falseReassurance, { count: 0, of: 0 });
});

test("score over the stored Bedrock replay results: 29/30 correct and zero false reassurances", () => {
  const r = JSON.parse(readFileSync(join(import.meta.dirname, "..", "metric", "results", "replay-bedrock-mantle.json"), "utf8")) as { rows: { truth: string; verdict: string | null }[] };
  assert.equal(r.rows.length, 30, "a non-empty result set");
  const s = score(r.rows);
  assert.equal(r.rows.filter((x) => x.truth === x.verdict).length, 29);
  assert.deepEqual(s.falseReassurance, { count: 0, of: 15 });
  assert.equal(s.perClass.missed.recall, 1);
});

test("score must-fail: a mutated verdict set (missed read as taken) reports false reassurances", () => {
  const r = JSON.parse(readFileSync(join(import.meta.dirname, "..", "metric", "results", "replay-bedrock-mantle.json"), "utf8")) as { rows: { truth: string; verdict: string | null }[] };
  const mutated = r.rows.map((x) => (x.truth === "missed" ? { ...x, verdict: "taken" } : x));
  assert.equal(score(mutated).falseReassurance.count, 10);
});
