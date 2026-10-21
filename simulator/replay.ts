// Shared by metric/run.ts and scripts/replay-serve.ts: the 30 labelled replay days, the replay frame source,
// Shippo's test-number tracking convention, and one function that plays a day through the real HTTP receiver and runner.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, FrameSource, PickupRunner, TrackingSource } from "../src/pickup/runner.ts";
import type { TrackingStatus } from "../src/pickup/verdict.ts";
import { signBody } from "../src/ring/signature.ts";
import { deliver, motionEnvelope } from "./webhook-simulator.ts";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SIM_KEY = "simulator-signing-key-not-a-secret";
export const SETTLE_MS = 30_000;
export const REPLAY_DEVICE = "ava1.ring.device.FRONTDOOR01";

export interface DaySpec {
  dayId: string; scenario: string; truth: string; deviceId: string; windowStartMs: number; windowEndMs: number;
  labels: { trackingNumber: string; carrier: string }[];
  frames: { atMs: number; file: string; parcels: number; kind: string }[];
  motion: { atMs: number; subType: string }[];
  truthCounts: { baseline: number; close: number; taken: number };
}

export function loadDays(file = "simulator/days.json", expected = 30): DaySpec[] {
  const days: DaySpec[] = JSON.parse(readFileSync(join(root, file), "utf8"));
  if (days.length !== expected) throw new Error(`expected ${expected} replay days in ${file}, found ${days.length}`);
  return days;
}

export function replayFrameSource(days: DaySpec[], dir = "simulator/days"): FrameSource {
  return {
    name: "replay",
    provenance: "replay",
    async frameAt(deviceId, atMs): Promise<Frame> {
      for (const d of days) {
        const f = d.deviceId === deviceId ? d.frames.find((x) => x.atMs === atMs) : undefined;
        if (f) return { jpeg: new Uint8Array(readFileSync(join(root, dir, f.file))), mediaTimestampMs: atMs, origin: "replay" };
      }
      throw new Error(`no replay frame for ${deviceId} at ${atMs}`);
    },
  };
}

/** Shippo test-mode tracking numbers carry their own status ("SHIPPO_TRANSIT"); this reads that documented convention locally. */
export const fixtureTracking: TrackingSource = {
  provenance: "simulated",
  async statusOf(l) {
    const s = l.trackingNumber.replace(/^SHIPPO_/, "");
    if (!["PRE_TRANSIT", "TRANSIT", "DELIVERED", "RETURNED", "FAILURE", "UNKNOWN"].includes(s)) throw new Error(`not a Shippo test number: ${l.trackingNumber}`);
    return s as TrackingStatus;
  },
};

export interface PlayStats { webhooksSent: number; duplicateAcked: number; badSignatureRejected: number; acks: number[]; alertMs: number | null }

/**
 * Arms one replay day over HTTP, delivers its signed motion webhooks (each also redelivered once and once forged),
 * drains, closes the window and runs the 24 h tracking check. `setNow` moves the runner's virtual clock.
 * `pause` lets a live demo spread the steps out so the page timeline visibly fills.
 */
export async function playDay(base: string, runner: PickupRunner, d: DaySpec, setNow: (ms: number) => void, hooks: { pause?: () => Promise<void>; alertAt?: Map<string, number> } = {}): Promise<{ verdict: string; stats: PlayStats }> {
  const stats: PlayStats = { webhooksSent: 0, duplicateAcked: 0, badSignatureRejected: 0, acks: [], alertMs: null };
  setNow(d.windowStartMs);
  const armed = await fetch(`${base}/days`, { method: "POST", body: JSON.stringify({ dayId: d.dayId, deviceId: d.deviceId, windowStartMs: d.windowStartMs, windowEndMs: d.windowEndMs, labels: d.labels }) });
  if (armed.status !== 201) throw new Error(`arm failed ${armed.status} ${await armed.text()}`);
  await hooks.pause?.();
  for (const m of d.motion) {
    const body = motionEnvelope({ deviceId: d.deviceId, timestampMs: m.atMs, subType: m.subType });
    const first = await deliver(`${base}/ring/webhook`, SIM_KEY, body);
    const again = await deliver(`${base}/ring/webhook`, SIM_KEY, body);
    const forged = await deliver(`${base}/ring/webhook`, SIM_KEY, body.replace(m.subType, "vehicle"), { signature: signBody(SIM_KEY, body) });
    stats.webhooksSent += 3;
    stats.acks.push(first.ms, again.ms);
    if (first.status !== 200) throw new Error(`webhook not acked: ${first.status} ${first.body}`);
    if (again.status === 200 && JSON.parse(again.body).status === "already_processed") stats.duplicateAcked++;
    if (forged.status === 401) stats.badSignatureRejected++;
    setNow(m.atMs + SETTLE_MS);
    await runner.drain();
    await hooks.pause?.();
  }
  setNow(d.windowEndMs);
  const t0 = performance.now();
  let verdict: string = await runner.closeWindow(d.dayId);
  if (hooks.alertAt?.has(d.dayId)) stats.alertMs = Math.round(hooks.alertAt.get(d.dayId)! - t0);
  await hooks.pause?.();
  setNow(d.windowEndMs + 24 * 3600_000);
  verdict = await runner.checkTracking(d.dayId);
  return { verdict, stats };
}
