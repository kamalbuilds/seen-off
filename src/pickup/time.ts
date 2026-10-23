/** A seller's pickup window is read in their own zone. Days armed without one are read in Pacific time. */
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// ICU puts a narrow no-break space before AM/PM; alerts and SMS read better with a plain one.
const plainSpace = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

/** "5:00 PM" */
export const clockTime = (ms: number, tz: string): string =>
  plainSpace(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms));

/** "Thu 30 Oct" */
export const shortDate = (ms: number, tz: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(ms).replace(",", "");

/** "Thu 30 Oct pickup, 10:00 AM to 5:00 PM" */
export const dayTitle = (startMs: number, endMs: number, tz: string): string =>
  `${shortDate(startMs, tz)} pickup, ${clockTime(startMs, tz)} to ${clockTime(endMs, tz)}`;
