import type { JobRow, Ledger } from "../store/ledger.ts";
import type { PickupRunner } from "./runner.ts";

export interface SchedulerOptions {
  ledger: Ledger;
  runner: PickupRunner;
  clock?: () => number;
  /** How often stored jobs are checked for being due. */
  tickMs?: number;
  /** A failed job is retried after retryBaseMs times the attempt count, capped at retryMaxMs. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  onError?: (job: JobRow, error: Error) => void;
}

/**
 * Runs the work a pickup day owes: baseline read at window open, verdict at window close, tracking check 24 h later.
 * The schedule is rows in the ledger, not timers, so a restart loses nothing: the next tick finds every overdue job and runs it.
 * Each job is safe to run twice (closeWindow and checkTracking do not repeat a stored verdict or alert).
 */
export class Scheduler {
  readonly #o: Required<Omit<SchedulerOptions, "onError">> & Pick<SchedulerOptions, "onError">;
  #running: Promise<number> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(o: SchedulerOptions) {
    this.#o = { clock: Date.now, tickMs: 5_000, retryBaseMs: 30_000, retryMaxMs: 600_000, maxAttempts: 10, ...o };
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick().catch((e) => console.error("scheduler tick failed", e)), this.#o.tickMs);
    this.#timer.unref();
    void this.tick().catch((e) => console.error("scheduler tick failed", e));
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Runs every due job once, in due order. Returns how many completed. One pass at a time. */
  tick(): Promise<number> {
    this.#running ??= this.#tick().finally(() => { this.#running = null; });
    return this.#running;
  }

  async #tick(): Promise<number> {
    const { ledger, runner, clock } = this.#o;
    let done = 0;
    for (const job of ledger.dueJobs(clock())) {
      try {
        if (job.kind === "baseline") await runner.takeBaseline(job.dayId);
        else if (job.kind === "close") { await runner.drain(); await runner.closeWindow(job.dayId); }
        else await runner.checkTracking(job.dayId);
        ledger.completeJob(job.id, clock());
        done++;
      } catch (e) {
        const err = e as Error;
        const wait = Math.min(this.#o.retryBaseMs * (job.attempts + 1), this.#o.retryMaxMs);
        ledger.failJob(job.id, err.message, clock() + wait, this.#o.maxAttempts);
        this.#o.onError?.(job, err);
      }
    }
    return done;
  }
}
