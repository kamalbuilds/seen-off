import { DatabaseSync } from "node:sqlite";
import type { IdempotencyStore, RingEvent } from "../ring/webhook.ts";
import type { DayVerdict, TrackingStatus, WindowVerdict } from "../pickup/verdict.ts";
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
create table if not exists tracking_readings (
  id integer primary key autoincrement, day_id text not null, tracking_number text not null, status text not null,
  read_at integer not null, provenance text not null);
`;

/** Columns added after the first release. Old ledger files gain them on open; new ones already have them from SCHEMA_V2. */
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ["days", "created_at", "integer"],
  ["days", "alert_kind", "text"],
  ["days", "alert_text", "text"],
  ["observations", "source", "text"],
  ["observations", "provenance", "text not null default 'simulated'"],
  ["events", "provenance", "text not null default 'simulated'"],
];

/** One SQLite file holds idempotency marks, received events, pickup days and evidence. ":memory:" for tests. */
export class Ledger implements IdempotencyStore {
  readonly db: DatabaseSync;

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
  }

  pendingEvents(): { requestId: string; type: string; deviceId: string | null; tsMs: number | null; subType: string | null }[] {
    return this.db.prepare(
      "select request_id as requestId, type, device_id as deviceId, ts_ms as tsMs, sub_type as subType from events where handled_at is null order by received_at, rowid",
    ).all() as never;
  }

  markEventHandled(requestId: string): void {
    this.db.prepare("update events set handled_at = ? where request_id = ?").run(Date.now(), requestId);
  }

  createDay(d: Pick<DayRow, "dayId" | "deviceId" | "windowStartMs" | "windowEndMs" | "labels">, createdAtMs: number): void {
    this.db.prepare("insert into days (day_id, device_id, window_start, window_end, labels, created_at) values (?, ?, ?, ?, ?, ?)")
      .run(d.dayId, d.deviceId, d.windowStartMs, d.windowEndMs, JSON.stringify(d.labels), createdAtMs);
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
      alertKind: r.alert_kind as string | null, alertText: r.alert_text as string | null, createdAtMs: r.created_at as number | null,
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
  }

  setWindowResult(dayId: string, closeCount: number | null, verdict: WindowVerdict, handoffMs: number | null): void {
    this.db.prepare("update days set close_count = ?, window_verdict = ?, handoff_ms = ? where day_id = ?").run(closeCount, verdict, handoffMs, dayId);
  }

  setFinal(dayId: string, verdict: DayVerdict): void {
    this.db.prepare("update days set final_verdict = ? where day_id = ?").run(verdict, dayId);
  }

  setAlerted(dayId: string, atMs: number, kind: string, text: string): void {
    this.db.prepare("update days set alerted_at = ?, alert_kind = ?, alert_text = ? where day_id = ?").run(atMs, kind, text, dayId);
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
