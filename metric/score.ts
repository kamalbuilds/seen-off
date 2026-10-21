export const CLASSES = ["taken", "missed", "partial", "unscanned"] as const;
export type Verdict = (typeof CLASSES)[number] | "unverified";

export interface Scored {
  /** matrix[truth][verdict] */
  matrix: Record<string, Record<string, number>>;
  perClass: Record<string, { precision: number | null; recall: number | null; support: number }>;
  /**
   * A day with parcels still on the porch (truth missed or partial) that was reported as taken: the seller is told everything is fine and no alert fires.
   */
  falseReassurance: { count: number; of: number };
}

/** Confusion matrix, per-class precision and recall, and the false-reassurance count from (truth, verdict) pairs. */
export function score(rows: { truth: string; verdict: string | null }[]): Scored {
  const labels = [...CLASSES, "unverified", "none"];
  const matrix: Scored["matrix"] = {};
  for (const t of CLASSES) { matrix[t] = {}; for (const v of labels) matrix[t][v] = 0; }
  for (const r of rows) matrix[r.truth][r.verdict ?? "none"] = (matrix[r.truth][r.verdict ?? "none"] ?? 0) + 1;
  const perClass: Scored["perClass"] = {};
  for (const c of CLASSES) {
    const support = Object.values(matrix[c]).reduce((a, b) => a + b, 0);
    const predicted = CLASSES.reduce((n, t) => n + matrix[t][c], 0);
    perClass[c] = { support, recall: support ? matrix[c][c] / support : null, precision: predicted ? matrix[c][c] / predicted : null };
  }
  const stillThere = rows.filter((r) => r.truth === "missed" || r.truth === "partial");
  return { matrix, perClass, falseReassurance: { count: stillThere.filter((r) => r.verdict === "taken").length, of: stillThere.length } };
}
