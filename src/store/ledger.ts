import { DatabaseSync } from "node:sqlite";
import type { IdempotencyStore, RingEvent } from "../ring/webhook.ts";
import type { DayVerdict, TrackingStatus, WindowVerdict } from "../pickup/verdict.ts";

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
}

export interface Observation {
  dayId: string;
  kind: "baseline" | "motion" | "close";
  atMs: number;
  count: number | null;
  frameSha256: string;
  framePath: string | null;
  error: string | null;
}

export interface TrackingRow {
  trackingNumber: string;
  status: TrackingStatus;
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
`;

/** One SQLite file holds idempotency marks, received events, pickup days and evidence. ":memory:" for tests. */
export class Ledger implements IdempotencyStore {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
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
      "insert or ignore into events (request_id, type, account_id, device_id, ts_ms, sub_type, received_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).run(e.requestId, e.type, e.accountId, e.deviceId ?? null, e.timestampMs ?? null, e.subType ?? null, Date.now());
  }

  pendingEvents(): { requestId: string; type: string; deviceId: string | null; tsMs: number | null; subType: string | null }[] {
    return this.db.prepare(
      "select request_id as requestId, type, device_id as deviceId, ts_ms as tsMs, sub_type as subType from events where handled_at is null order by received_at, rowid",
    ).all() as never;
  }

  markEventHandled(requestId: string): void {
    this.db.prepare("update events set handled_at = ? where request_id = ?").run(Date.now(), requestId);
  }

  createDay(d: Pick<DayRow, "dayId" | "deviceId" | "windowStartMs" | "windowEndMs" | "labels">): void {
    this.db.prepare("insert into days (day_id, device_id, window_start, window_end, labels) values (?, ?, ?, ?, ?)")
      .run(d.dayId, d.deviceId, d.windowStartMs, d.windowEndMs, JSON.stringify(d.labels));
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
    };
  }

  openDaysFor(deviceId: string, atMs: number): DayRow[] {
    const ids = this.db.prepare(
      "select day_id from days where device_id = ? and window_start <= ? and window_end >= ? and window_verdict is null",
    ).all(deviceId, atMs, atMs) as { day_id: string }[];
    return ids.map((i) => this.getDay(i.day_id));
  }

  addObservation(o: Observation): void {
    this.db.prepare("insert into observations (day_id, kind, at_ms, count, frame_sha256, frame_path, error) values (?, ?, ?, ?, ?, ?, ?)")
      .run(o.dayId, o.kind, o.atMs, o.count, o.frameSha256, o.framePath, o.error);
  }

  observations(dayId: string): Observation[] {
    return (this.db.prepare("select day_id, kind, at_ms, count, frame_sha256, frame_path, error from observations where day_id = ? order by at_ms, id").all(dayId) as Record<string, unknown>[])
      .map((r) => ({ dayId: r.day_id as string, kind: r.kind as Observation["kind"], atMs: r.at_ms as number, count: r.count as number | null, frameSha256: r.frame_sha256 as string, framePath: r.frame_path as string | null, error: r.error as string | null }));
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

  setAlerted(dayId: string, atMs: number): void {
    this.db.prepare("update days set alerted_at = ? where day_id = ?").run(atMs, dayId);
  }

  savePacket(dayId: string, packet: unknown): void {
    this.db.prepare("insert or replace into packets (day_id, json) values (?, ?)").run(dayId, JSON.stringify(packet));
  }

  getPacket(dayId: string): unknown {
    const r = this.db.prepare("select json from packets where day_id = ?").get(dayId) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
}
