import type { Packet } from "./packet.ts";
import { clockTime, shortDate } from "./time.ts";
import { BedrockMantleVision } from "../vision/bedrock-mantle.ts";

/** Writes one claim from a prompt. The live writer is Qwen3-VL on Bedrock, the same endpoint and model that read the porch. */
export interface ClaimWriter {
  readonly model: string;
  write(prompt: string): Promise<string>;
}

export function claimWriterFromEnv(env: NodeJS.ProcessEnv = process.env): ClaimWriter | undefined {
  if (!env.AWS_BEARER_TOKEN_BEDROCK) return undefined;
  const m = new BedrockMantleVision(env.AWS_BEARER_TOKEN_BEDROCK, env.BEDROCK_MANTLE_MODEL || undefined, env.AWS_REGION || "us-east-1");
  return { model: m.model, write: (prompt) => m.chat([{ type: "text", text: prompt }], 700, 0.2) };
}

export type ClaimKind = "carrier-trace" | "missed-pickup";
const unscannedCount = (p: Packet) => p.labels.filter((l) => l.scanned === false).length;

/** Only days with something to dispute get a claim: a handoff the carrier never scanned, or a pickup that never came. */
export function claimKind(p: Packet): ClaimKind | null {
  if (p.verdict === "unscanned" || (p.windowVerdict === "partial" && unscannedCount(p) > (p.closeCount ?? 0))) return "carrier-trace";
  if (p.windowVerdict === "missed" || p.windowVerdict === "partial") return "missed-pickup";
  return null;
}

/** Every time stamp in the packet, as minutes after midnight in the seller's zone. A claim may cite these and no others. */
function packetMinutes(p: Packet): Set<number> {
  const ms = [p.window.startMs, p.window.endMs, p.handoffMs, p.alert?.atMs, ...p.frames.map((f) => f.atMs), ...p.timeline.map((t) => t.atMs), ...(p.tracking ?? []).map((t) => t.readAtMs)];
  const out = new Set<number>();
  for (const x of ms) {
    if (x == null) continue;
    const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: p.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(x).split(":").map(Number);
    out.add(h * 60 + m);
  }
  return out;
}

/** The facts a claim is built from, in the words the claim should use. */
export function claimFacts(p: Packet): string[] {
  const t = (ms: number) => `${shortDate(ms, p.timeZone)} at ${clockTime(ms, p.timeZone)}`;
  const facts = [
    `Scheduled carrier pickup window: ${t(p.window.startMs)} to ${clockTime(p.window.endMs, p.timeZone)} (${p.timeZone.replace(/_/g, " ")} time).`,
    `Parcels on the porch when the window opened (Ring doorbell frame): ${p.baselineCount ?? "unknown"}.`,
    `Parcels on the porch when the window closed (Ring doorbell frame): ${p.closeCount ?? "unknown"}.`,
  ];
  if (p.handoffMs) facts.push(`Ring doorbell frame after motion at the door shows ${p.takenCount} ${p.takenCount === 1 ? "parcel" : "parcels"} gone: ${t(p.handoffMs)}.`);
  if (p.alert) facts.push(`Seen Off alert sent ${t(p.alert.atMs)}: "${p.alert.text}"`);
  for (const l of p.labels) facts.push(`Label: ${l.name ? `${l.name}, ` : ""}carrier ${l.carrier}, tracking number ${traceable(l.trackingNumber)}, tracking state ${l.status ?? "not read"}${l.scanned === false ? " (no carrier scan)" : ""}.`);
  if (p.tracking?.length) facts.push(`Tracking read ${t(p.tracking[0].readAtMs)}, 24 h after the window closed: ${unscannedCount(p)} of ${p.labels.length} labels show no carrier scan.`);
  for (const f of p.frames) if (f.sha256) facts.push(`Evidence frame (${f.kind}) ${t(f.atMs)}, sha256 ${f.sha256}.`);
  return facts;
}

// Shippo test-mode numbers (SHIPPO_TRANSIT, SHIPPO_PRE_TRANSIT) drive the replay's tracking states; no carrier can trace one, so the letter leaves a slot.
const traceable = (n: string) => (/^SHIPPO_[A-Z_]+$/.test(n) ? "[tracking number]" : n);

export function claimPrompt(p: Packet, kind: ClaimKind): string {
  const ask = kind === "carrier-trace"
    ? "Write a USPS Missing Mail search request (or the equivalent carrier trace request) asking the carrier to locate parcels that left the seller's porch during the scheduled pickup window but carry no acceptance scan, and to add the acceptance scan."
    : "Write a message to the marketplace's seller support asking for late-shipment protection: the scheduled carrier pickup did not collect the parcels, so the late scan is the carrier's fault, not the seller's.";
  return [
    "You write dispute letters for a small online seller who ships from home and schedules carrier pickups.",
    ask,
    "Use ONLY the facts below. Copy times, tracking numbers and parcel counts exactly as written, with digits. Do not invent any time, date, tracking number, address, name or count. Where the seller must add something you do not have, write [Your name] or [Your address].",
    "Say only what the frames show: the parcels were on the porch, and then they were gone. Do not say who took them, and do not say anyone collected, picked up or scanned them.",
    "Mention that the timestamped Ring doorbell frames and their sha256 hashes are attached. Plain text, a subject line first, at most 220 words, no em dashes.",
    "Facts:",
    ...claimFacts(p).map((f) => `- ${f}`),
  ].join("\n");
}

export interface Grounding { ok: boolean; problems: string[] }

/**
 * A drafted claim is sent to a carrier or a marketplace in the seller's name, so every time, tracking number and parcel count in it
 * must come from the packet. Anything else is reported and the draft is refused.
 */
export function checkGrounding(draft: string, p: Packet): Grounding {
  const problems: string[] = [];

  const minutes = packetMinutes(p);
  for (const m of draft.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s?[Mm]\.?(?![A-Za-z])|\b(\d{1,2}):(\d{2})\b(?!\s*[AaPp]\.?\s?[Mm])/g)) {
    let h = Number(m[1] ?? m[4]);
    const min = Number(m[2] ?? m[5] ?? 0);
    if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
    if (h > 23 || min > 59 || !minutes.has(h * 60 + min)) problems.push(`time "${m[0].trim()}" is not in the packet`);
  }

  const known = new Set(p.labels.map((l) => l.trackingNumber.replace(/\s/g, "")));
  const statusWords = new Set(["PRE_TRANSIT", "TRANSIT", "DELIVERED", "RETURNED", "FAILURE", "UNKNOWN"]);
  for (const m of draft.matchAll(/\b(?=[A-Z0-9_]*[\d_])[A-Z0-9][A-Z0-9_]{7,}\b|\b\d[\d ]{10,}\d\b/g)) {
    const token = m[0].replace(/\s/g, "");
    if (/^[0-9a-f]{64}$/i.test(token) || statusWords.has(token) || known.has(token)) continue;
    if (p.frames.some((f) => f.sha256.toUpperCase().includes(token))) continue;
    problems.push(`tracking number "${m[0]}" is not on any label`);
  }

  const counts = new Set([p.baselineCount, p.closeCount, p.takenCount, p.labels.length, unscannedCount(p), p.labels.length - unscannedCount(p)].filter((n): n is number => n !== null));
  for (const m of draft.matchAll(/\b(\d+)\s+(?:of\s+(?:the\s+)?(\d+)\s+)?(?:\w+\s+)?(parcels?|packages?|labels?|boxes|orders?|items?)\b/gi)) {
    for (const n of [m[1], m[2]]) if (n !== undefined && !counts.has(Number(n))) problems.push(`count "${m[0]}" does not match the packet`);
  }
  return { ok: problems.length === 0, problems };
}

/** Drafts the claim and refuses any draft that cites a fact the packet does not hold. One redraft, then the problems are returned. */
export async function draftClaim(p: Packet, writer: ClaimWriter) {
  const kind = claimKind(p);
  if (!kind) return null;
  const prompt = claimPrompt(p, kind);
  let last: { draft: string; grounding: Grounding } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const draft = (await writer.write(prompt)).replace(/^\s*word count:.*$/gim, "").replace(/^[ \t]*\u2014[ \t]*/gm, "").replace(/[ \t]*\u2014[ \t]*/g, ", ").trim();
    const grounding = checkGrounding(draft, p);
    last = { draft, grounding };
    if (grounding.ok) return { kind, model: writer.model, attempts: attempt, draft, grounding };
  }
  return { kind, model: writer.model, attempts: 2, draft: null, grounding: last!.grounding };
}
