import type { DayPlan } from "./runner.ts";

export const MAX_WINDOW_MS = 24 * 3600_000;
export const MAX_LABELS = 50;
export const DAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);

export type PlanCheck = { ok: true; plan: DayPlan } | { ok: false; errors: string[] };

/**
 * Trust boundary for POST /days. Every problem is reported at once so a form can show them together.
 * dayId becomes a directory name for evidence frames, so it is restricted to a path-safe alphabet.
 */
export function validatePlan(body: unknown): PlanCheck {
  if (!isObj(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  const { dayId, deviceId, windowStartMs: start, windowEndMs: end, labels } = body;

  if (typeof dayId !== "string" || !DAY_ID.test(dayId)) errors.push("dayId must be 1 to 64 characters: letters, digits, dot, dash or underscore, starting with a letter or digit");
  if (!text(deviceId, 128)) errors.push("deviceId must be a non-empty string of at most 128 characters");

  const okStart = Number.isSafeInteger(start) && (start as number) > 0;
  const okEnd = Number.isSafeInteger(end) && (end as number) > 0;
  if (!okStart) errors.push("windowStartMs must be a positive integer (epoch milliseconds)");
  if (!okEnd) errors.push("windowEndMs must be a positive integer (epoch milliseconds)");
  if (okStart && okEnd) {
    if ((end as number) <= (start as number)) errors.push("windowEndMs must be after windowStartMs");
    else if ((end as number) - (start as number) > MAX_WINDOW_MS) errors.push("the pickup window must not be longer than 24 hours");
  }

  const checked: DayPlan["labels"] = [];
  if (!Array.isArray(labels) || labels.length === 0) errors.push("labels must be a non-empty array: one label per parcel");
  else if (labels.length > MAX_LABELS) errors.push(`labels must not hold more than ${MAX_LABELS} entries`);
  else labels.forEach((l, i) => {
    if (!isObj(l)) return void errors.push(`labels[${i}] must be an object`);
    if (!text(l.trackingNumber, 64)) errors.push(`labels[${i}].trackingNumber must be a non-empty string of at most 64 characters`);
    if (!text(l.carrier, 32)) errors.push(`labels[${i}].carrier must be a non-empty string of at most 32 characters`);
    if (l.labelUrl !== undefined && !text(l.labelUrl, 2048)) errors.push(`labels[${i}].labelUrl must be a string of at most 2048 characters when present`);
    if (text(l.trackingNumber, 64) && text(l.carrier, 32)) {
      checked.push({ trackingNumber: l.trackingNumber.trim(), carrier: l.carrier.trim(), ...(typeof l.labelUrl === "string" ? { labelUrl: l.labelUrl } : {}) });
    }
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: { dayId: dayId as string, deviceId: (deviceId as string).trim(), windowStartMs: start as number, windowEndMs: end as number, labels: checked } };
}
