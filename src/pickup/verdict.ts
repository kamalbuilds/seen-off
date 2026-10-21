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
}

/**
 * Window-close verdict from two porch counts.
 * Anything that cannot be concluded (a count is missing, negative or fractional, nothing was on the porch at arming, more parcels at close than at arming)
 * is "unverified": the product never claims a pickup it did not see.
 */
export function decideWindowVerdict(r: WindowReading): { verdict: WindowVerdict; takenCount: number } {
  const { baselineCount: b, closeCount: c } = r;
  const bad = (n: number | null) => n !== null && (!Number.isInteger(n) || n < 0);
  if (bad(b) || bad(c) || b === null || c === null || b <= 0 || c > b) return { verdict: "unverified", takenCount: 0 };
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
