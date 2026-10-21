export type TrackingStatus = "PRE_TRANSIT" | "TRANSIT" | "DELIVERED" | "RETURNED" | "FAILURE" | "UNKNOWN";
export type WindowVerdict = "taken" | "missed" | "partial" | "unverified";
export type DayVerdict = WindowVerdict | "unscanned";

/** A carrier acceptance scan exists once tracking has left PRE_TRANSIT. UNKNOWN is not evidence of a scan. */
const SCANNED: ReadonlySet<TrackingStatus> = new Set(["TRANSIT", "DELIVERED", "RETURNED", "FAILURE"]);

export interface WindowReading {
  /** Parcels counted on the porch when the window opened. */
  baselineCount: number | null;
  /** Parcels counted when the window closed. */
  closeCount: number | null;
  /** Readable counts from the frames taken after motion events during the window, in time order. */
  midCounts?: number[];
}

/**
 * Window-close verdict from the porch counts across the window.
 * Anything that cannot be concluded (a count is missing, negative or fractional, nothing was on the porch at arming,
 * or the readings contradict each other) is "unverified": the product never claims a pickup it did not see.
 *
 * Wrongly saying "taken" is the costly error (the parcels sit on the porch and no alert fires), so departure needs positive evidence:
 * a close count below the baseline. A close count ABOVE the baseline is a counting error, not a delivery of more parcels to the carrier.
 * If no frame in the window ever showed fewer parcels than the baseline, nothing was seen leaving: "missed".
 * If some frame did show a decrease and the close count is higher again, the readings contradict each other: "unverified".
 */
export function decideWindowVerdict(r: WindowReading): { verdict: WindowVerdict; takenCount: number } {
  const { baselineCount: b, closeCount: c } = r;
  const bad = (n: number | null) => n !== null && (!Number.isInteger(n) || n < 0);
  if (bad(b) || bad(c) || b === null || c === null || b <= 0) return { verdict: "unverified", takenCount: 0 };
  if (c > b) {
    const seenLeaving = (r.midCounts ?? []).some((m) => Number.isInteger(m) && m >= 0 && m < b);
    return seenLeaving ? { verdict: "unverified", takenCount: 0 } : { verdict: "missed", takenCount: 0 };
  }
  if (c === b) return { verdict: "missed", takenCount: 0 };
  if (c === 0) return { verdict: "taken", takenCount: b };
  return { verdict: "partial", takenCount: b - c };
}

export interface TrackingReading {
  trackingNumber: string;
  status: TrackingStatus;
}

/**
 * 24 h after the handoff: a taken day whose labels do not all show a carrier scan becomes "unscanned"
 * (the evidence-packet case). Other verdicts are unchanged; partial days list their scan state in the packet instead.
 */
export function decideDayVerdict(window: WindowVerdict, tracking: TrackingReading[] | null): DayVerdict {
  if (window !== "taken" || tracking === null) return window;
  if (tracking.length === 0) return "unscanned";
  return tracking.every((t) => SCANNED.has(t.status)) ? "taken" : "unscanned";
}
