import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDayVerdict, decideWindowVerdict } from "../src/pickup/verdict.ts";

const w = (baselineCount: number | null, closeCount: number | null) => decideWindowVerdict({ baselineCount, closeCount });

test("window verdict: every outcome with its taken count", () => {
  assert.deepEqual(w(3, 0), { verdict: "taken", takenCount: 3 });
  assert.deepEqual(w(1, 0), { verdict: "taken", takenCount: 1 });
  assert.deepEqual(w(3, 3), { verdict: "missed", takenCount: 0 });
  assert.deepEqual(w(1, 1), { verdict: "missed", takenCount: 0 });
  assert.deepEqual(w(3, 1), { verdict: "partial", takenCount: 2 });
  assert.deepEqual(w(3, 2), { verdict: "partial", takenCount: 1 });
  assert.deepEqual(w(2, 1), { verdict: "partial", takenCount: 1 });
});

test("window verdict: unreadable or contradictory evidence is unverified, never a guess", () => {
  assert.equal(w(null, 0).verdict, "unverified", "no baseline");
  assert.equal(w(3, null).verdict, "unverified", "no close reading");
  assert.equal(w(0, 0).verdict, "unverified", "nothing was on the porch at arming, so nothing can have been taken");
});

test("window verdict: a close count above the baseline is a counting error. Nothing seen leaving means missed; a seen decrease that then reverses is a contradiction", () => {
  assert.deepEqual(w(1, 2), { verdict: "missed", takenCount: 0 }, "no frame ever showed fewer parcels than at open");
  assert.deepEqual(decideWindowVerdict({ baselineCount: 3, closeCount: 4, midCounts: [3, 4] }), { verdict: "missed", takenCount: 0 });
  assert.deepEqual(decideWindowVerdict({ baselineCount: 3, closeCount: 4, midCounts: [2] }), { verdict: "unverified", takenCount: 0 }, "a frame showed 2, then the close frame 4");
  assert.deepEqual(decideWindowVerdict({ baselineCount: 3, closeCount: 4, midCounts: [] }), { verdict: "missed", takenCount: 0 });
});

const t = (...s: ("PRE_TRANSIT" | "TRANSIT" | "DELIVERED" | "UNKNOWN" | "FAILURE" | "RETURNED")[]) => s.map((status, i) => ({ trackingNumber: `T${i}`, status }));

test("day verdict: a taken day with every label scanned stays taken", () => {
  assert.equal(decideDayVerdict("taken", t("TRANSIT", "DELIVERED", "TRANSIT")), "taken");
  assert.equal(decideDayVerdict("taken", t("RETURNED")), "taken");
});

test("day verdict: a taken day with any label unscanned at 24 h is unscanned", () => {
  assert.equal(decideDayVerdict("taken", t("PRE_TRANSIT")), "unscanned");
  assert.equal(decideDayVerdict("taken", t("TRANSIT", "PRE_TRANSIT")), "unscanned");
  assert.equal(decideDayVerdict("taken", t("UNKNOWN")), "unscanned", "UNKNOWN is not evidence of a scan");
  assert.equal(decideDayVerdict("taken", []), "unscanned", "no labels to show a scan");
});

test("day verdict: tracking only reclassifies taken days", () => {
  assert.equal(decideDayVerdict("taken", null), "taken", "before the 24 h read");
  assert.equal(decideDayVerdict("missed", t("PRE_TRANSIT")), "missed");
  assert.equal(decideDayVerdict("partial", t("PRE_TRANSIT", "TRANSIT")), "partial");
  assert.equal(decideDayVerdict("unverified", t("TRANSIT")), "unverified");
});
