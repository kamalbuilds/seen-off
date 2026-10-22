import type { Ledger, Observation } from "../store/ledger.ts";
import { weakest, type Provenance } from "../provenance.ts";

export type TimelineKind = "label" | "window_open" | "motion_event" | "frame" | "window_verdict" | "alert" | "tracking" | "final_verdict";

export interface TimelineEntry {
  atMs: number;
  kind: TimelineKind;
  text: string;
  /** Null for entries Seen Off computes itself (window open, alert). */
  provenance: Provenance | null;
  /** porch: what the doorbell saw. carrier: what the carrier recorded. null: the day itself (labels, window, alert). */
  lane: "porch" | "carrier" | null;
  /** Index into packet.frames when the entry has a stored frame. */
  frame?: number;
}

export interface Track {
  /** waiting: nothing to report yet. done: the step happened. problem: it did not happen as it should. na: this step cannot apply. */
  state: "waiting" | "done" | "problem" | "na";
  headline: string;
  /** Plain-language reason a seller can act on. */
  reason: string;
  atMs: number | null;
}

export type DayStatus = "watching" | "awaiting_tracking" | "settled";

const LANE: Record<TimelineKind, TimelineEntry["lane"]> = { label: null, window_open: null, alert: null, motion_event: "porch", frame: "porch", window_verdict: "porch", tracking: "carrier", final_verdict: "carrier" };
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

  const timeline: Omit<TimelineEntry, "lane">[] = [];
  if (day.createdAtMs !== null) {
    timeline.push({
      atMs: day.createdAtMs, kind: "label", provenance: trackingProvenance,
      text: `${plural(day.labels.length, "label")} registered: ${day.labels.map((l) => `${l.carrier} ${l.trackingNumber}`).join(", ")}`,
    });
  }
  timeline.push({ atMs: day.windowStartMs, kind: "window_open", provenance: null, text: "Pickup window opens. Seen Off watches the porch." });
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
  const timelineOut: TimelineEntry[] = timeline.map((t) => ({ ...t, lane: LANE[t.kind] }));

  // Two separate questions: did the parcels leave the porch, and did the carrier scan them. "Unscanned" is the second answer disagreeing with the first.
  const hhmm = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
  const n = day.labels.length;
  const w = day.windowVerdict;
  const unscannedLabels = tracking.filter((t) => t.status === "PRE_TRANSIT" || t.status === "UNKNOWN").length;
  const porch: Track =
    w === null ? { state: "waiting", headline: "Watching the porch", reason: `The window closes at ${hhmm(day.windowEndMs)}. Seen Off reads the porch after each motion event and again at close.`, atMs: null }
    : w === "taken" ? { state: "done", headline: "Left the porch", reason: `All ${plural(day.baselineCount ?? n, "parcel")} gone by ${hhmm(day.windowEndMs)}${day.handoffMs ? `, handoff seen at ${hhmm(day.handoffMs)}` : ""}.`, atMs: day.handoffMs ?? day.windowEndMs }
    : w === "partial" ? { state: "problem", headline: `${takenCount} of ${day.baselineCount} left`, reason: `${plural(day.closeCount ?? 0, "parcel")} still on the porch at ${hhmm(day.windowEndMs)}. The alert asks the seller to drop them off.`, atMs: day.windowEndMs }
    : w === "missed" ? { state: "problem", headline: "Still on the porch", reason: `The carrier did not take the parcels. They were still there at ${hhmm(day.windowEndMs)}, and the alert went out while there was time to drop them off.`, atMs: day.windowEndMs }
    : { state: "problem", headline: "Could not read the porch", reason: "The frames were not clear enough to call a pickup, so Seen Off claims nothing. Check the Ring app.", atMs: day.windowEndMs };
  const scanDueMs = day.windowEndMs + 24 * 3600_000;
  const carrier: Track =
    w === null ? { state: "waiting", headline: "Not started", reason: `Carrier scans are read 24 h after the window closes, at ${hhmm(scanDueMs)}.`, atMs: null }
    : w === "missed" || w === "unverified" ? { state: "na", headline: "Nothing to scan yet", reason: w === "missed" ? "The parcels never left, so there is no handoff for the carrier to scan." : "No handoff was confirmed, so no scan is expected.", atMs: null }
    : tracking.length === 0 ? { state: "waiting", headline: "Pending", reason: `Waiting for the 24 h check at ${hhmm(scanDueMs)}. Carriers can take that long to post the first scan.`, atMs: null }
    : w === "partial" ? (n - unscannedLabels >= takenCount
        ? { state: "done", headline: `Scanned: the ${plural(takenCount, "parcel")} that left`, reason: `${plural(day.closeCount ?? 0, "parcel")} still on the porch, so no scan is expected for ${(day.closeCount ?? 0) === 1 ? "it" : "them"} yet.`, atMs: tracking[0].readAtMs }
        : { state: "problem", headline: `${plural(takenCount - (n - unscannedLabels), "departed parcel")} unscanned`, reason: `${plural(takenCount, "parcel")} left the porch but fewer labels show a carrier scan after 24 h. This packet is the proof of the handoff to send the carrier.`, atMs: tracking[0].readAtMs })
    : unscannedLabels === 0 ? { state: "done", headline: `Scanned: ${n} of ${n} labels`, reason: "Every label shows a carrier scan after the handoff.", atMs: tracking[0].readAtMs }
    : { state: "problem", headline: `${unscannedLabels} of ${n} labels unscanned`, reason: `${plural(unscannedLabels, "label")} still show only "label created" 24 h after the parcels left the porch. This packet is the proof of the handoff to send the carrier.`, atMs: tracking[0].readAtMs };

  return {
    dayId: day.dayId, deviceId: day.deviceId, status,
    tracks: { porch, carrier },
    window: { startMs: day.windowStartMs, endMs: day.windowEndMs },
    createdAtMs: day.createdAtMs,
    verdict: day.finalVerdict, windowVerdict: day.windowVerdict,
    baselineCount: day.baselineCount, closeCount: day.closeCount, takenCount, handoffMs: day.handoffMs,
    alert: day.alertedAtMs === null ? null : { atMs: day.alertedAtMs, kind: day.alertKind, text: day.alertText, delivery: day.alertDelivery },
    labels: day.labels.map((l) => {
      const status = tracking.find((t) => t.trackingNumber === l.trackingNumber)?.status ?? null;
      return { ...l, status, scanned: status === null ? null : status !== "PRE_TRANSIT" && status !== "UNKNOWN" };
    }),
    tracking: tracking.length === 0 ? null : tracking.map((t) => ({ trackingNumber: t.trackingNumber, status: t.status, readAtMs: t.readAtMs, provenance: t.provenance })),
    frames, timeline: timelineOut,
    // Everything a third party needs to check the packet: the frame hashes the files are verified against when served,
    // the webhook deliveries that triggered looks, and each tracking read with its time.
    manifest: {
      version: 1, deviceId: day.deviceId,
      frames: frames.map((f) => ({ index: f.index, kind: f.kind, sha256: f.sha256, source: f.source, capturedMs: f.atMs })),
      webhookRequestIds: events.map((e) => e.requestId),
      trackingReads: tracking.map((t) => ({ trackingNumber: t.trackingNumber, status: t.status, readAtMs: t.readAtMs })),
    },
    provenance: { frames: frameProvenance, tracking: trackingProvenance, verdict: day.windowVerdict === null ? null : weakest([...(frameProvenance ? [frameProvenance] : []), ...(tracking.length ? [trackingProvenance] : [])]) },
  };
}

export type Packet = ReturnType<typeof buildPacket>;
