import type { PorchReading } from "./types.ts";

export const PORCH_PROMPT = [
  "This is one frame from a Ring doorbell camera that watches a front porch or doorstep.",
  "A Ring watermark (logo, device id, app name, timestamp) is drawn over the top corners. Ignore it.",
  "Count every separate parcel resting on the ground or porch: cardboard boxes, shipping packages, padded mailers, bags of goods.",
  "A person walking past or standing at the door is not a parcel. Mats, plants, shoes and furniture are not parcels.",
  'Reply with JSON only, no prose: {"parcels_present": <true|false>, "count": <integer>}',
].join(" ");

/** Strict parse. Anything that is not the requested JSON throws, so a bad answer can never pass as "gone". */
export function parseReading(text: string): PorchReading {
  const m = text.match(/\{[^{}]*\}/);
  if (!m) throw new Error(`vision reply has no JSON object: ${text.slice(0, 120)}`);
  const j = JSON.parse(m[0]) as { parcels_present?: unknown; count?: unknown };
  if (typeof j.parcels_present !== "boolean" || typeof j.count !== "number" || !Number.isInteger(j.count) || j.count < 0) {
    throw new Error(`vision reply has wrong shape: ${m[0].slice(0, 120)}`);
  }
  if (j.parcels_present !== j.count > 0) throw new Error(`vision reply contradicts itself: ${m[0]}`);
  return { present: j.parcels_present, count: j.count, raw: text };
}
