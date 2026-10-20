// Porch spike runner. Usage:
//   VISION_PROVIDER=openrouter node spikes/porch/run.ts main                 headline run on the 60 labelled frames
//   node spikes/porch/run.ts main --always-present                              must-fail 1: always answers "parcels present"
//   VISION_PROVIDER=openrouter node spikes/porch/run.ts painted-out           must-fail 2: parcels painted out, truth is "gone"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { visionFromEnv, type PorchReading, type VisionProvider } from "../../src/vision/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const [set = "main", ...flags] = process.argv.slice(2);
const alwaysPresentRun = flags.includes("--always-present");

interface Label { id: string; kind?: string; source: string; present: boolean; count: number | null }
const labelsFile = set === "painted-out" ? "labels_painted_out.json" : "labels.json";
const framesDir = set === "painted-out" ? "frames_painted_out" : "frames";
const labels: Label[] = JSON.parse(readFileSync(join(here, labelsFile), "utf8"));
if (labels.length === 0) throw new Error("no labels: refusing to score an empty set");

const alwaysPresent: VisionProvider = {
  name: "always-present", model: "always-present",
  readPorch: async (): Promise<PorchReading> => ({ present: true, count: 1, raw: "always-present" }),
};
const provider = alwaysPresentRun ? alwaysPresent : visionFromEnv();

interface Row { id: string; kind: string; truth: Label["present"]; truthCount: number | null; pred?: boolean; predCount?: number; ms?: number; error?: string }
const rows: Row[] = new Array(labels.length);
let next = 0;
async function worker() {
  while (next < labels.length) {
    const i = next++;
    const l = labels[i];
    const row: Row = { id: l.id, kind: l.kind ?? "painted-out", truth: l.present, truthCount: l.count };
    const t0 = performance.now();
    try {
      const r = await provider.readPorch(readFileSync(join(here, framesDir, `${l.id}.jpg`)));
      row.pred = r.present; row.predCount = r.count;
    } catch (e) { row.error = String((e as Error).message).slice(0, 200); }
    row.ms = Math.round(performance.now() - t0);
    rows[i] = row;
  }
}
await Promise.all(Array.from({ length: alwaysPresentRun ? 1 : 4 }, worker));

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : "n/a");
const presentOk = (r: Row) => r.pred === r.truth;
const countOk = (r: Row) => r.truthCount !== null && r.predCount === r.truthCount;
const countRows = rows.filter((r) => r.truthCount !== null);
const summary: Record<string, string | number> = {
  set, provider: provider.name, model: provider.model, frames: rows.length,
  errors: rows.filter((r) => r.error).length,
  present_absent_accuracy: pct(rows.filter(presentOk).length, rows.length),
  count_exact_accuracy_on_labelled: pct(countRows.filter(countOk).length, countRows.length),
  median_ms: [...rows].map((r) => r.ms ?? 0).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
};
for (const kind of [...new Set(rows.map((r) => r.kind))]) {
  const k = rows.filter((r) => r.kind === kind);
  summary[`present_absent_${kind}`] = pct(k.filter(presentOk).length, k.length);
}
for (const truth of [true, false]) {
  const k = rows.filter((r) => r.truth === truth);
  if (k.length) summary[`truth_${truth ? "present" : "gone"}_correct`] = pct(k.filter(presentOk).length, k.length);
}
console.log(JSON.stringify(summary, null, 2));
for (const r of rows.filter((x) => !presentOk(x))) console.log("WRONG", r.id, r.kind, "truth", r.truth, "pred", r.pred ?? r.error);

mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `${set}${alwaysPresentRun ? "-always-present" : `-${provider.name}`}.json`);
writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
console.log("wrote", out);
