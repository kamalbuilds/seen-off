import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VisionProvider } from "../vision/types.ts";
import type { DayRow, LabelRow, Ledger } from "../store/ledger.ts";
import { decideDayVerdict, decideWindowVerdict, type DayVerdict, type TrackingReading, type TrackingStatus } from "./verdict.ts";
import { buildPacket } from "./packet.ts";
import type { Provenance } from "../provenance.ts";

export interface Frame {
  jpeg: Uint8Array;
  mediaTimestampMs: number;
  origin: string;
}

/** Where porch frames come from: Ring snapshot download, a WHEP grab, or a labelled replay. Tried in order. */
export interface FrameSource {
  readonly name: string;
  /** live: the real Ring API. replay: labelled recorded frames. Unlabelled sources read as simulated. */
  readonly provenance?: Provenance;
  frameAt(deviceId: string, atMs: number): Promise<Frame>;
}

export interface TrackingSource {
  /** live: a carrier or Shippo call. Unlabelled sources read as simulated. */
  readonly provenance?: Provenance;
  statusOf(label: LabelRow): Promise<TrackingStatus>;
}

export type AlertKind = "missed" | "partial" | "unverified" | "unscanned";

/** Which channels an alert reached. A channel that failed is recorded with its error. */
export interface AlertDelivery {
  channels: { name: string; ok: boolean; status?: number; error?: string }[];
}

export interface Alerter {
  send(alert: { dayId: string; kind: AlertKind; text: string }): Promise<AlertDelivery | void>;
}

export interface RunnerDeps {
  ledger: Ledger;
  vision: VisionProvider;
  frames: FrameSource[];
  tracking: TrackingSource;
  alerter: Alerter;
  clock: () => number;
  /** A motion event is looked at this long after it fired, so the carrier has left the frame. */
  settleMs?: number;
  evidenceDir?: string;
}

export interface DayPlan {
  dayId: string;
  deviceId: string;
  windowStartMs: number;
  windowEndMs: number;
  labels: LabelRow[];
}

const ZERO_REREADS = 2;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";

export class PickupRunner {
  readonly d: RunnerDeps;
  readonly settleMs: number;

  constructor(deps: RunnerDeps) {
    this.d = deps;
    this.settleMs = deps.settleMs ?? 30_000;
  }

  /**
   * Stores the day with its scheduled checks. When the window is already open the baseline is read now;
   * otherwise a stored job reads it when the window opens.
   */
  async arm(plan: DayPlan): Promise<number | null> {
    const { baselineDeferred } = this.d.ledger.createDay(plan, this.d.clock());
    return baselineDeferred ? null : this.takeBaseline(plan.dayId);
  }

  /** Window opens: count the parcels on the porch. */
  async takeBaseline(dayId: string): Promise<number | null> {
    const day = this.d.ledger.getDay(dayId);
    // A day with labels and an empty porch at window open is implausible, and the vision stage is not perfectly repeatable on one frame: read again before accepting zero.
    const count = await this.observe(dayId, day.deviceId, "baseline", day.windowStartMs, day.labels.length > 0 ? ZERO_REREADS : 0);
    this.d.ledger.setBaseline(dayId, count);
    return count;
  }

  #draining: Promise<number> | null = null;

  /** Looks at pending webhook events whose settle time has passed. Returns how many were handled. One pass at a time, so a pending event is never observed twice. */
  drain(): Promise<number> {
    this.#draining ??= this.#drain().finally(() => { this.#draining = null; });
    return this.#draining;
  }

  async #drain(): Promise<number> {
    let n = 0;
    for (const e of this.d.ledger.pendingEvents()) {
      const watches = (e.type === "motion_detected" || e.type === "button_press") && e.deviceId && e.tsMs !== null;
      if (!watches) { this.d.ledger.markEventHandled(e.requestId); continue; }
      if (e.tsMs! + this.settleMs > this.d.clock()) continue;
      for (const day of this.d.ledger.openDaysFor(e.deviceId!, e.tsMs!)) {
        await this.observe(day.dayId, day.deviceId, "motion", e.tsMs! + this.settleMs);
      }
      this.d.ledger.markEventHandled(e.requestId);
      n++;
    }
    return n;
  }

  /** Window closes: final count, verdict, alert if the parcels did not all leave. */
  async closeWindow(dayId: string): Promise<DayVerdict> {
    const day = this.d.ledger.getDay(dayId);
    // Re-entry after a crash or a failed alert: the verdict is already stored, so only a missing alert is still owed.
    if (day.windowVerdict !== null) return this.settleAlert(day);
    const closeCount = await this.observe(dayId, day.deviceId, "close", day.windowEndMs);
    const midCounts = this.d.ledger.observations(dayId).filter((o) => o.kind === "motion" && o.count !== null).map((o) => o.count!);
    const { verdict, takenCount } = decideWindowVerdict({ baselineCount: day.baselineCount, closeCount, midCounts });
    const handoff = verdict === "taken" || verdict === "partial"
      ? this.d.ledger.observations(dayId).find((o) => o.kind === "motion" && o.count !== null && day.baselineCount !== null && o.count < day.baselineCount)?.atMs ?? null
      : null;
    this.d.ledger.setWindowResult(dayId, closeCount, verdict, handoff === null ? null : handoff - this.settleMs);
    this.d.ledger.setFinal(dayId, verdict);
    return this.settleAlert(this.d.ledger.getDay(dayId));
  }

  /** Sends the window-close alert once: only for a verdict that needs one, and only if none was recorded yet. */
  private async settleAlert(day: DayRow): Promise<DayVerdict> {
    const verdict = day.windowVerdict!;
    if ((verdict === "missed" || verdict === "partial" || verdict === "unverified") && day.alertedAtMs === null) {
      // When the close count exceeds the baseline the two readings disagree; the lower one is the claim the evidence supports.
      const left = day.closeCount !== null && day.baselineCount !== null ? Math.min(day.closeCount, day.baselineCount) : day.closeCount ?? 0;
      const taken = day.baselineCount !== null ? Math.max(0, day.baselineCount - left) : 0;
      const text = verdict === "missed"
        ? `${left} parcel${left === 1 ? "" : "s"} still on the porch at ${hhmm(day.windowEndMs)}: the carrier did not take them.`
        : verdict === "partial"
          ? `${taken} of ${day.baselineCount} parcels taken, ${left} still on the porch at ${hhmm(day.windowEndMs)}.`
          : `Could not read the porch at ${hhmm(day.windowEndMs)}. Check the Ring app before the carrier cut-off.`;
      const delivery = await this.d.alerter.send({ dayId: day.dayId, kind: verdict, text });
      this.d.ledger.setAlerted(day.dayId, this.d.clock(), verdict, text, delivery ?? null);
    }
    this.d.ledger.savePacket(day.dayId, this.packetOf(day.dayId));
    return verdict;
  }

  /** 24 h after the handoff: read carrier tracking and settle the day. */
  async checkTracking(dayId: string): Promise<DayVerdict> {
    const day = this.d.ledger.getDay(dayId);
    if (day.windowVerdict === null) throw new Error(`day ${dayId} window not closed`);
    const tracking: TrackingReading[] = [];
    for (const l of day.labels) tracking.push({ trackingNumber: l.trackingNumber, status: await this.d.tracking.statusOf(l) });
    const readAtMs = this.d.clock();
    const provenance = this.d.tracking.provenance ?? "simulated";
    for (const t of tracking) this.d.ledger.addTrackingReading(dayId, { ...t, readAtMs, provenance });
    const verdict = decideDayVerdict(day.windowVerdict, tracking);
    this.d.ledger.setFinal(dayId, verdict);
    this.d.ledger.savePacket(dayId, this.packetOf(dayId));
    if (verdict === "unscanned" && day.alertKind !== "unscanned") {
      const text = `Parcels left the porch but ${tracking.filter((t) => t.status === "PRE_TRANSIT" || t.status === "UNKNOWN").length} of ${tracking.length} labels show no carrier scan after 24 h. Evidence packet ready.`;
      const delivery = await this.d.alerter.send({ dayId, kind: "unscanned", text });
      this.d.ledger.setAlerted(dayId, this.d.clock(), "unscanned", text, delivery ?? null);
      this.d.ledger.savePacket(dayId, this.packetOf(dayId));
    }
    return verdict;
  }

  /** The evidence packet as the ledger stands now: valid before the window closes, after it, and after the 24 h tracking check. */
  packetOf(dayId: string) {
    return buildPacket(this.d.ledger, dayId, this.d.tracking.provenance ?? "simulated", { provider: this.d.vision.name, model: this.d.vision.model });
  }

  /** One frame, one count. A failure is recorded as a null count, never guessed. */
  private async observe(dayId: string, deviceId: string, kind: "baseline" | "motion" | "close", atMs: number, zeroRereads = 0): Promise<number | null> {
    const errors: string[] = [];
    for (const src of this.d.frames) {
      let frame: Frame;
      try { frame = await src.frameAt(deviceId, atMs); } catch (e) { errors.push(`${src.name}: ${(e as Error).message}`); continue; }
      const sha = createHash("sha256").update(frame.jpeg).digest("hex");
      let path: string | null = null;
      if (this.d.evidenceDir) {
        const dir = join(this.d.evidenceDir, dayId);
        mkdirSync(dir, { recursive: true });
        path = join(dir, `${kind}-${atMs}.jpg`);
        writeFileSync(path, frame.jpeg);
      }
      try {
        let r = await this.d.vision.readPorch(frame.jpeg);
        for (let i = 0; i < zeroRereads && r.count === 0; i++) r = await this.d.vision.readPorch(frame.jpeg);
        this.d.ledger.addObservation({ dayId, kind, atMs, count: r.count, frameSha256: sha, framePath: path, error: null, source: src.name, provenance: src.provenance ?? "simulated" });
        return r.count;
      } catch (e) {
        this.d.ledger.addObservation({ dayId, kind, atMs, count: null, frameSha256: sha, framePath: path, error: `vision: ${(e as Error).message}`, source: src.name, provenance: src.provenance ?? "simulated" });
        return null;
      }
    }
    this.d.ledger.addObservation({ dayId, kind, atMs, count: null, frameSha256: "", framePath: null, error: errors.join("; "), source: null, provenance: "simulated" });
    return null;
  }
}
