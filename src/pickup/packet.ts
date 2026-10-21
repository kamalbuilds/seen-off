import type { Ledger, Observation } from "../store/ledger.ts";
import { weakest, type Provenance } from "../provenance.ts";

export type TimelineKind = "label" | "window_open" | "motion_event" | "frame" | "window_verdict" | "alert" | "tracking" | "final_verdict";

export interface TimelineEntry {
  atMs: number;
  kind: TimelineKind;
  text: string;
  /** Null for entries Outbox computes itself (window open, alert). */
  provenance: Provenance | null;
  /** Index into packet.frames when the entry has a stored frame. */
  frame?: number;
}

export type DayStatus = "watching" | "awaiting_tracking" | "settled";

const KIND_TEXT: Record<Observation["kind"], string> = { baseline: "Window open frame", motion: "Frame after motion", close: "Window close frame" };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * The evidence packet, built from the ledger alone so it is valid at every stage of a day:
 * watching (window open), awaiting_tracking (window closed, verdict out), settled (24 h tracking read).
 * Every external input carries a provenance; the verdict is as live as its weakest input.
 */
export function buildPacket(ledger: Ledger, dayId: string, trackingProvenance: Provenance) {
  const day = ledger.getDay(dayId);
  const obs = ledger.observations(dayId);
  const events = ledger.eventsFor(day.deviceId, day.windowStartMs, day.windowEndMs);
  const tracking = ledger.latestTracking(dayId);
  const status: DayStatus = tracking.length > 0 ? "settled" : day.windowVerdict !== null ? "awaiting_tracking" : "watching";
  const frames = obs.map((o, i) => ({
    index: i, kind: o.kind, atMs: o.atMs, count: o.count, error: o.error, source: o.source, provenance: o.provenance,
    sha256: o.frameSha256, image: o.framePath ? `/days/${encodeURIComponent(dayId)}/frames/${i}` : null,
  }));
  const frameProvenance = obs.length === 0 ? null : weakest(obs.map((o) => o.provenance));
  const takenCount = day.baselineCount !== null && day.closeCount !== null ? Math.max(0, day.baselineCount - day.closeCount) : 0;

  const timeline: TimelineEntry[] = [];
  if (day.createdAtMs !== null) {
    timeline.push({
      atMs: day.createdAtMs, kind: "label", provenance: trackingProvenance,
      text: `${plural(day.labels.length, "label")} registered: ${day.labels.map((l) => `${l.carrier} ${l.trackingNumber}`).join(", ")}`,
    });
  }
  timeline.push({ atMs: day.windowStartMs, kind: "window_open", provenance: null, text: "Pickup window opens. Outbox watches the porch." });
  for (const e of events) {
    timeline.push({ atMs: e.tsMs!, kind: "motion_event", provenance: e.provenance, text: `${e.type === "button_press" ? "Doorbell button pressed" : "Motion at the door"}${e.subType ? ` (${e.subType})` : ""}` });
  }
  frames.forEach((f) => {
    timeline.push({
      atMs: f.atMs, kind: "frame", provenance: f.provenance, frame: f.index,
      text: f.error !== null
        ? `${KIND_TEXT[f.kind]}: could not read (${f.error})`
        : `${KIND_TEXT[f.kind]}: ${plural(f.count ?? 0, "parcel")} on the porch`,
    });
  });
  if (day.windowVerdict !== null) {
    const left = day.closeCount;
    timeline.push({
      atMs: day.windowEndMs, kind: "window_verdict", provenance: frameProvenance,
      text: `Window closed: ${day.windowVerdict}${day.windowVerdict === "partial" ? `, ${takenCount} of ${day.baselineCount} taken` : day.windowVerdict === "missed" && left !== null ? `, ${plural(left, "parcel")} still there` : ""}`,
    });
  }
  if (day.alertedAtMs !== null && day.windowVerdict !== null && day.alertKind !== "unscanned") {
    timeline.push({ atMs: day.alertedAtMs, kind: "alert", provenance: null, text: `Alert sent: ${day.alertText}` });
  }
  for (const t of tracking) {
    timeline.push({ atMs: t.readAtMs, kind: "tracking", provenance: t.provenance, text: `${t.trackingNumber}: ${t.status}` });
  }
  if (status === "settled") {
    timeline.push({
      atMs: tracking[0].readAtMs, kind: "final_verdict", provenance: weakest([...(frameProvenance ? [frameProvenance] : []), ...tracking.map((t) => t.provenance)]),
      text: `Final: ${day.finalVerdict}`,
    });
  }
  if (day.alertedAtMs !== null && day.alertKind === "unscanned") {
    timeline.push({ atMs: day.alertedAtMs, kind: "alert", provenance: null, text: `Alert sent: ${day.alertText}` });
  }
  timeline.sort((a, b) => a.atMs - b.atMs);

  return {
    dayId: day.dayId, deviceId: day.deviceId, status,
    window: { startMs: day.windowStartMs, endMs: day.windowEndMs },
    createdAtMs: day.createdAtMs,
    verdict: day.finalVerdict, windowVerdict: day.windowVerdict,
    baselineCount: day.baselineCount, closeCount: day.closeCount, takenCount, handoffMs: day.handoffMs,
    alert: day.alertedAtMs === null ? null : { atMs: day.alertedAtMs, kind: day.alertKind, text: day.alertText },
    labels: day.labels.map((l) => ({ ...l, status: tracking.find((t) => t.trackingNumber === l.trackingNumber)?.status ?? null })),
    tracking: tracking.length === 0 ? null : tracking.map((t) => ({ trackingNumber: t.trackingNumber, status: t.status, readAtMs: t.readAtMs, provenance: t.provenance })),
    frames, timeline,
    provenance: { frames: frameProvenance, tracking: trackingProvenance, verdict: day.windowVerdict === null ? null : weakest([...(frameProvenance ? [frameProvenance] : []), ...(tracking.length ? [trackingProvenance] : [])]) },
  };
}

export type Packet = ReturnType<typeof buildPacket>;
