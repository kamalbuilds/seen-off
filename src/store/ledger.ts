import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { IdempotencyStore, RingEvent } from "../ring/webhook.ts";
import type { DayVerdict, TrackingStatus, WindowVerdict } from "../pickup/verdict.ts";
import type { AlertDelivery } from "../pickup/runner.ts";
import { eventProvenance, type Provenance } from "../provenance.ts";

export interface LabelRow {
  trackingNumber: string;
  carrier: string;
  labelUrl?: string;
}

export interface DayRow {
  dayId: string;
  deviceId: string;
  windowStartMs: number;
  windowEndMs: number;
  labels: LabelRow[];
  baselineCount: number | null;
  closeCount: number | null;
  windowVerdict: WindowVerdict | null;
  handoffMs: number | null;
  finalVerdict: DayVerdict | null;
  alertedAtMs: number | null;
  alertKind: string | null;
  alertText: string | null;
  alertDelivery: AlertDelivery | null;
  createdAtMs: number | null;
}

export interface Observation {
  dayId: string;
  kind: "baseline" | "motion" | "close";
  atMs: number;
  count: number | null;
  frameSha256: string;
  framePath: string | null;
  error: string | null;
  /** Name of the frame source that produced the frame (ring-snapshot, ring-whep, replay). Null when no source answered. */
  source: string | null;
  provenance: Provenance;
}

export type JobKind = "baseline" | "close" | "tracking";

export interface JobRow {
  id: number;
  dayId: string;
  kind: JobKind;
  dueMs: number;
  state: "pending" | "done" | "dead";
  attempts: number;
  lastError: string | null;
}

export interface TrackingRow {
  trackingNumber: string;
  status: TrackingStatus;
  readAtMs: number;
  provenance: Provenance;
}

export interface StoredEvent {
  requestId: string;
  type: string;
  subType: string | null;
  deviceId: string | null;
  tsMs: number | null;
  provenance: Provenance;
}

const SCHEMA = `
create table if not exists processed (request_id text primary key, done_at integer not null);
create table if not exists events (
  request_id text primary key, type text not null, account_id text not null, device_id text, ts_ms integer,
  sub_type text, received_at integer not null, handled_at integer);
create table if not exists days (
  day_id text primary key, device_id text not null, window_start integer not null, window_end integer not null,
  labels text not null, baseline_count integer, close_count integer, window_verdict text, handoff_ms integer,
  final_verdict text, alerted_at integer);
create table if not exists observations (
  id integer primary key autoincrement, day_id text not null, kind text not null, at_ms integer not null,
  count integer, frame_sha256 text not null, frame_path text, error text);
create table if not exists packets (day_id text primary key, json text not null);
create table if not exists jobs (
  id integer primary key autoincrement, day_id text not null, kind text not null, due_ms integer not null,
  state text not null default 'pending', attempts integer not null default 0, last_error text, done_at integer,
  unique (day_id, kind));
create table if not exists tracking_readings (
  id integer primary key autoincrement, day_id text not null, tracking_number text not null, status text not null,
  read_at integer not null, provenance text not null);
`;

/** Columns added after the first release. Old ledger files gain them on open; new ones already have them from SCHEMA_V2. */
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ["days", "created_at", "integer"],
  ["days", "alert_kind", "text"],
  ["days", "alert_text", "text"],
  ["days", "alert_delivery", "text"],
  ["observations", "source", "text"],
  ["observations", "provenance", "text not null default 'simulated'"],
  ["events", "provenance", "text not null default 'simulated'"],
];

/** One SQLite file holds idempotency marks, received events, pickup days and evidence. ":memory:" for tests. */
export class Ledger implements IdempotencyStore {
  readonly db: DatabaseSync;
  /** Emits "change" with the day id (or undefined for a doorbell event) after every write that a page showing a day would care about. */
  readonly changes = new EventEmitter();

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    for (const [table, column, decl] of ADDED_COLUMNS) {
      const have = (this.db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
      if (!have) this.db.exec(`alter table ${table} add column ${column} ${decl}`);
    }
  }

  isDone(requestId: string): boolean {
    return this.db.prepare("select 1 from processed where request_id = ?").get(requestId) !== undefined;
  }

  markDone(requestId: string): void {
    this.db.prepare("insert or ignore into processed (request_id, done_at) values (?, ?)").run(requestId, Date.now());
  }

  /** Keyed by request_id, so a redelivery after a crash between insert and mark cannot double-record. */
  insertEvent(e: RingEvent): void {
    this.db.prepare(
      "insert or ignore into events (request_id, type, account_id, device_id, ts_ms, sub_type, received_at, provenance) values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(e.requestId, e.type, e.accountId, e.deviceId ?? null, e.timestampMs ?? null, e.subType ?? null, Date.now(), eventProvenance(e.accountId));
    this.changes.emit("change", undefined);
  }

  pendingEvents(): { requestId: string; type: string; deviceId: string | null; tsMs: number | null; subType: string | null }[] {
    return this.db.prepare(
      "select request_id as requestId, type, device_id as deviceId, ts_ms as tsMs, sub_type as subType from events where handled_at is null order by received_at, rowid",
    ).all() as never;
  }

  markEventHandled(requestId: string): void {
    this.db.prepare("update events set handled_at = ? where request_id = ?").run(Date.now(), requestId);
  }

  /**
   * Stores the day and its scheduled work in one transaction: the window-close check, the 24 h tracking check, and the baseline
   * read when the window opens in the future. A restart finds them here, so an armed day cannot be lost with the process.
   */
  createDay(d: Pick<DayRow, "dayId" | "deviceId" | "windowStartMs" | "windowEndMs" | "labels">, createdAtMs: number): { baselineDeferred: boolean } {
    const baselineDeferred = d.windowStartMs > createdAtMs;
    this.db.exec("begin");
    try {
      this.db.prepare("insert into days (day_id, device_id, window_start, window_end, labels, created_at) values (?, ?, ?, ?, ?, ?)")
        .run(d.dayId, d.deviceId, d.windowStartMs, d.windowEndMs, JSON.stringify(d.labels), createdAtMs);
      const job = this.db.prepare("insert into jobs (day_id, kind, due_ms) values (?, ?, ?)");
      if (baselineDeferred) job.run(d.dayId, "baseline", d.windowStartMs);
      job.run(d.dayId, "close", d.windowEndMs);
      job.run(d.dayId, "tracking", d.windowEndMs + 24 * 3600_000);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
    this.changes.emit("change", d.dayId);
    return { baselineDeferred };
  }

  /** Pending jobs whose time has come, oldest due first. */
  dueJobs(nowMs: number): JobRow[] {
    return (this.db.prepare("select id, day_id, kind, due_ms, state, attempts, last_error from jobs where state = 'pending' and due_ms <= ? order by due_ms, id").all(nowMs) as Record<string, unknown>[])
      .map(toJob);
  }

  jobsFor(dayId: string): JobRow[] {
    return (this.db.prepare("select id, day_id, kind, due_ms, state, attempts, last_error from jobs where day_id = ? order by due_ms, id").all(dayId) as Record<string, unknown>[]).map(toJob);
  }

  completeJob(id: number, atMs: number): void {
    this.db.prepare("update jobs set state = 'done', done_at = ?, last_error = null where id = ?").run(atMs, id);
  }

  /** A failed job is retried at retryAtMs; after maxAttempts it is parked as dead with its error kept. */
  failJob(id: number, error: string, retryAtMs: number, maxAttempts: number): void {
    this.db.prepare("update jobs set attempts = attempts + 1, last_error = ?, due_ms = ?, state = case when attempts + 1 >= ? then 'dead' else 'pending' end where id = ?")
      .run(error, retryAtMs, maxAttempts, id);
  }

  /** Removes a pickup day and everything stored for it: observations, jobs, tracking reads, the saved packet. Webhook events stay, they belong to the doorbell. */
  deleteDay(dayId: string): void {
    this.db.exec("begin");
    try {
      for (const t of ["observations", "jobs", "tracking_readings", "packets"]) this.db.prepare(`delete from ${t} where day_id = ?`).run(dayId);
      this.db.prepare("delete from days where day_id = ?").run(dayId);
      this.db.exec("commit");
    } catch (e) { this.db.exec("rollback"); throw e; }
    this.changes.emit("change", dayId);
  }

  close(): void {
    this.db.close();
  }

  hasDay(dayId: string): boolean {
    return this.db.prepare("select 1 from days where day_id = ?").get(dayId) !== undefined;
  }

  /** Newest window first. */
  listDays(): DayRow[] {
    const ids = this.db.prepare("select day_id from days order by window_start desc, day_id").all() as { day_id: string }[];
    return ids.map((i) => this.getDay(i.day_id));
  }

  getDay(dayId: string): DayRow {
    const r = this.db.prepare("select * from days where day_id = ?").get(dayId) as Record<string, unknown> | undefined;
    if (!r) throw new Error(`unknown day ${dayId}`);
    return {
      dayId: r.day_id as string, deviceId: r.device_id as string, windowStartMs: r.window_start as number,
      windowEndMs: r.window_end as number, labels: JSON.parse(r.labels as string) as LabelRow[],
      baselineCount: r.baseline_count as number | null, closeCount: r.close_count as number | null,
      windowVerdict: r.window_verdict as WindowVerdict | null, handoffMs: r.handoff_ms as number | null,
      finalVerdict: r.final_verdict as DayVerdict | null, alertedAtMs: r.alerted_at as number | null,
      alertKind: r.alert_kind as string | null, alertText: r.alert_text as string | null,
      alertDelivery: r.alert_delivery ? (JSON.parse(r.alert_delivery as string) as AlertDelivery) : null, createdAtMs: r.created_at as number | null,
    };
  }

  openDaysFor(deviceId: string, atMs: number): DayRow[] {
    const ids = this.db.prepare(
      "select day_id from days where device_id = ? and window_start <= ? and window_end >= ? and window_verdict is null",
    ).all(deviceId, atMs, atMs) as { day_id: string }[];
    return ids.map((i) => this.getDay(i.day_id));
  }

  addObservation(o: Observation): void {
    this.db.prepare("insert into observations (day_id, kind, at_ms, count, frame_sha256, frame_path, error, source, provenance) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(o.dayId, o.kind, o.atMs, o.count, o.frameSha256, o.framePath, o.error, o.source, o.provenance);
    this.changes.emit("change", o.dayId);
  }

  observations(dayId: string): Observation[] {
    return (this.db.prepare("select day_id, kind, at_ms, count, frame_sha256, frame_path, error, source, provenance from observations where day_id = ? order by at_ms, id").all(dayId) as Record<string, unknown>[])
      .map((r) => ({
        dayId: r.day_id as string, kind: r.kind as Observation["kind"], atMs: r.at_ms as number, count: r.count as number | null,
        frameSha256: r.frame_sha256 as string, framePath: r.frame_path as string | null, error: r.error as string | null,
        source: r.source as string | null, provenance: r.provenance as Provenance,
      }));
  }

  setBaseline(dayId: string, count: number | null): void {
    this.db.prepare("update days set baseline_count = ? where day_id = ?").run(count, dayId);
    this.changes.emit("change", dayId);
  }

  setWindowResult(dayId: string, closeCount: number | null, verdict: WindowVerdict, handoffMs: number | null): void {
    this.db.prepare("update days set close_count = ?, window_verdict = ?, handoff_ms = ? where day_id = ?").run(closeCount, verdict, handoffMs, dayId);
    this.changes.emit("change", dayId);
  }

  setFinal(dayId: string, verdict: DayVerdict): void {
    this.db.prepare("update days set final_verdict = ? where day_id = ?").run(verdict, dayId);
    this.changes.emit("change", dayId);
  }

  setAlerted(dayId: string, atMs: number, kind: string, text: string, delivery: AlertDelivery | null = null): void {
    this.db.prepare("update days set alerted_at = ?, alert_kind = ?, alert_text = ?, alert_delivery = ? where day_id = ?")
      .run(atMs, kind, text, delivery ? JSON.stringify(delivery) : null, dayId);
    this.changes.emit("change", dayId);
  }

  /** Motion and button events Ring delivered for a device inside [fromMs, toMs]. */
  eventsFor(deviceId: string, fromMs: number, toMs: number): StoredEvent[] {
    return (this.db.prepare(
      "select request_id, type, sub_type, device_id, ts_ms, provenance from events where device_id = ? and ts_ms >= ? and ts_ms <= ? and type in ('motion_detected', 'button_press') order by ts_ms, rowid",
    ).all(deviceId, fromMs, toMs) as Record<string, unknown>[]).map((r) => ({
      requestId: r.request_id as string, type: r.type as string, subType: r.sub_type as string | null,
      deviceId: r.device_id as string | null, tsMs: r.ts_ms as number | null, provenance: r.provenance as Provenance,
    }));
  }

  addTrackingReading(dayId: string, r: TrackingRow): void {
    this.db.prepare("insert into tracking_readings (day_id, tracking_number, status, read_at, provenance) values (?, ?, ?, ?, ?)")
      .run(dayId, r.trackingNumber, r.status, r.readAtMs, r.provenance);
    this.changes.emit("change", dayId);
  }

  /** Readings from the latest tracking check only, in label order. Empty before the first check. */
  latestTracking(dayId: string): TrackingRow[] {
    const rows = this.db.prepare("select tracking_number, status, read_at, provenance from tracking_readings where day_id = ? order by id").all(dayId) as Record<string, unknown>[];
    if (rows.length === 0) return [];
    const last = Math.max(...rows.map((r) => r.read_at as number));
    return rows.filter((r) => r.read_at === last).map((r) => ({
      trackingNumber: r.tracking_number as string, status: r.status as TrackingStatus, readAtMs: r.read_at as number, provenance: r.provenance as Provenance,
    }));
  }

  savePacket(dayId: string, packet: unknown): void {
    this.db.prepare("insert or replace into packets (day_id, json) values (?, ?)").run(dayId, JSON.stringify(packet));
  }

  getPacket(dayId: string): unknown {
    const r = this.db.prepare("select json from packets where day_id = ?").get(dayId) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
}

function toJob(r: Record<string, unknown>): JobRow {
  return { id: r.id as number, dayId: r.day_id as string, kind: r.kind as JobKind, dueMs: r.due_ms as number, state: r.state as JobRow["state"], attempts: r.attempts as number, lastError: r.last_error as string | null };
}
