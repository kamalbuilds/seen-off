import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Frame, FrameSource } from "../pickup/runner.ts";
import type { VisionProvider } from "../vision/types.ts";
import type { RingClient } from "./client.ts";
import { RingSnapshotSource } from "./client.ts";

export interface ProbeOptions {
  /** Device to capture from; the first device the account lists when omitted. */
  deviceId?: string;
  outDir: string;
  now?: () => number;
  /** How far back the snapshot is requested. Ring needs the recording to exist, so a minute ago, not now. */
  snapshotLagMs?: number;
  /** Extra live-view grab through the WHEP worker. */
  whep?: FrameSource;
  vision?: VisionProvider;
}

export interface CapturedFrame {
  file: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  mediaTimestamp: string;
  mediaOrigin: string;
  requestedForMs: number;
  latencyMs: number;
}

export interface ProbeReport {
  ranAt: string;
  devices: { id: string; name: string }[];
  includedTypes: Record<string, number>;
  device: { id: string; name: string };
  snapshot: CapturedFrame;
  whep: CapturedFrame | null;
  history: { events: number; newest: { eventType: string; start: string; end: string } | null };
  porch: { provider: string; model: string; count: number } | { error: string } | null;
  reportFile: string;
}

/** Width and height from the first JPEG start-of-frame marker, or null when the bytes are not a JPEG with one. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

function describe(f: Frame, outDir: string, name: string, requestedForMs: number, latencyMs: number): CapturedFrame {
  const file = join(outDir, name);
  writeFileSync(file, f.jpeg);
  const size = jpegSize(f.jpeg);
  return {
    file, bytes: f.jpeg.length, sha256: createHash("sha256").update(f.jpeg).digest("hex"), width: size?.width ?? null, height: size?.height ?? null,
    mediaTimestamp: new Date(f.mediaTimestampMs).toISOString(), mediaOrigin: f.origin, requestedForMs, latencyMs,
  };
}

/**
 * One real discovery plus one real frame capture against the Ring Partner API: list devices, read recent history,
 * download a snapshot (and, if given, a live WHEP frame), and write the frames and a JSON report of what Ring returned.
 * Every step throws on a Ring error. Nothing is filled in when a call fails, and no token is ever written to the report.
 */
export async function runProbe(client: RingClient, o: ProbeOptions): Promise<ProbeReport> {
  const now = o.now ?? Date.now;
  mkdirSync(o.outDir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");

  const devices = await client.listDevices();
  if (devices.length === 0) throw new Error("Ring returned no devices for this account");
  const device = o.deviceId ? devices.find((d) => d.id === o.deviceId) : devices[0];
  if (!device) throw new Error(`device ${o.deviceId} is not in the ${devices.length} devices this account lists: ${devices.map((d) => d.id).join(", ")}`);
  const includedTypes: Record<string, number> = {};
  for (const inc of devices[0].included as { type?: string }[]) includedTypes[inc.type ?? "unknown"] = (includedTypes[inc.type ?? "unknown"] ?? 0) + 1;

  const events = await client.history(device.id, ["ding", "on_demand", "motion.human", "motion.other_motion", "motion"], 1);

  const forMs = now() - (o.snapshotLagMs ?? 60_000);
  const t0 = performance.now();
  const snap = await new RingSnapshotSource(client).frameAt(device.id, forMs);
  const snapshot = describe(snap, o.outDir, `${stamp}-snapshot.jpg`, forMs, Math.round(performance.now() - t0));

  let whep: CapturedFrame | null = null;
  if (o.whep) {
    const t1 = performance.now();
    const f = await o.whep.frameAt(device.id, now());
    whep = describe(f, o.outDir, `${stamp}-whep.jpg`, now(), Math.round(performance.now() - t1));
  }

  let porch: ProbeReport["porch"] = null;
  if (o.vision) {
    try { porch = { provider: o.vision.name, model: o.vision.model, count: (await o.vision.readPorch(snap.jpeg)).count }; } catch (e) { porch = { error: (e as Error).message }; }
  }

  const newest = events[0];
  const reportFile = join(o.outDir, `${stamp}-probe.json`);
  const report: ProbeReport = {
    ranAt: new Date(now()).toISOString(),
    devices: devices.map((d) => ({ id: d.id, name: d.name })), includedTypes, device: { id: device.id, name: device.name },
    snapshot, whep,
    history: { events: events.length, newest: newest ? { eventType: newest.eventType, start: new Date(newest.startMs).toISOString(), end: new Date(newest.endMs).toISOString() } : null },
    porch, reportFile,
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  return report;
}
