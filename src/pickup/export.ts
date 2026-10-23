import type { Packet } from "./packet.ts";
import { clockTime, shortDate } from "./time.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const WORD: Record<string, string> = { taken: "taken", missed: "missed", partial: "part-taken", unverified: "check the porch", unscanned: "unscanned" };
const KIND: Record<string, string> = { baseline: "Window open frame", motion: "Frame after motion", close: "Window close frame" };

/**
 * The dispute kit: one self-contained HTML file a seller can attach to a carrier or marketplace claim.
 * Frames are embedded as data URLs next to the sha256 each was recorded with; `frames` holds the verified bytes by packet frame index.
 */
export function exportKit(p: Packet, frames: Map<number, Uint8Array>, generatedAtMs: number): string {
  const tz = p.timeZone;
  const at = (ms: number | null | undefined) => (ms == null ? "not observed" : `${shortDate(ms, tz)}, ${clockTime(ms, tz)}`);
  const verdict = p.status === "watching" ? "watching" : WORD[p.verdict ?? ""] ?? p.verdict;
  const rows = (cells: string[][]) => cells.map((c) => `<tr>${c.map((x) => `<td>${x}</td>`).join("")}</tr>`).join("");
  const figures = p.frames.map((f) => {
    const bytes = frames.get(f.index);
    const img = bytes ? `<img src="data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}" alt="${esc(KIND[f.kind])} at ${esc(at(f.atMs))}">` : `<p class="none">Frame file not embedded.</p>`;
    return `<figure>${img}<figcaption><b>${esc(KIND[f.kind])}, ${esc(at(f.atMs))}</b><span>${f.count === null ? "unreadable" : `${f.count} ${f.count === 1 ? "parcel" : "parcels"} on the porch`}</span><code>sha256 ${esc(f.sha256)}</code></figcaption></figure>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seen Off evidence: ${esc(p.title)}</title>
<style>
body { margin: 0; background: #fbfcfd; color: #15181c; font: 16px/1.5 Archivo, ui-sans-serif, sans-serif; font-variant-numeric: tabular-nums; }
main { max-width: 960px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 32px; letter-spacing: -0.03em; line-height: 1.1; margin: 0 0 8px; }
h2 { font-size: 22px; letter-spacing: -0.02em; margin: 40px 0 12px; }
.verdict { background: #e8c547; padding: 16px 24px; margin: 16px 0; }
.verdict b { display: block; font-size: 48px; letter-spacing: -0.045em; line-height: 1; text-transform: lowercase; }
.verdict p { margin: 8px 0 0; font-size: 18px; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
td, th { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e3e6ea; vertical-align: top; overflow-wrap: anywhere; }
th { font-size: 13px; color: #5b636d; }
.frames { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
figure { margin: 0; } img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #eef0f2; }
figcaption { display: grid; gap: 2px; padding-top: 6px; font-size: 14px; }
code { font-size: 12px; overflow-wrap: anywhere; color: #5b636d; }
.meta { color: #5b636d; font-size: 14px; }
</style></head>
<body><main>
<p class="meta">Seen Off evidence kit, generated ${esc(at(generatedAtMs))} (${esc(tz.replace(/_/g, " "))} time)</p>
<h1>${esc(p.title)}</h1>
<p class="meta">Doorbell ${esc(p.deviceId)}. Pickup day ${esc(p.dayId)}.</p>
<section class="verdict"><b>${esc(verdict)}</b><p>${esc(p.tracks.porch.headline)}: ${esc(p.tracks.porch.reason)}</p><p>${esc(p.tracks.carrier.headline)}: ${esc(p.tracks.carrier.reason)}</p></section>
<h2>Times</h2>
<table><tbody>${rows([
    ["Pickup window", `${esc(at(p.window.startMs))} to ${esc(clockTime(p.window.endMs, tz))}`],
    ["Parcels at window open", esc(p.baselineCount ?? "unreadable")],
    ["Parcels at window close", esc(p.closeCount ?? "unreadable")],
    ["Handoff seen", esc(at(p.handoffMs))],
    ["Alert", p.alert ? `${esc(at(p.alert.atMs))}: ${esc(p.alert.text)}` : "none raised"],
    ["Carrier tracking read", p.tracking ? esc(at(p.tracking[0].readAtMs)) : "not read yet"],
  ])}</tbody></table>
<h2>Porch frames</h2>
<div class="frames">${figures}</div>
<h2>Labels and carrier tracking</h2>
<table><thead><tr><th>Parcel</th><th>Carrier</th><th>Tracking number</th><th>Tracking state</th><th>Carrier scan</th></tr></thead><tbody>${rows(p.labels.map((l) => [
    esc(l.name ?? ""), esc(l.carrier), esc(l.trackingNumber), esc(l.status ?? "not read"), l.scanned === null ? "pending" : l.scanned ? "scanned" : "no scan",
  ]))}</tbody></table>
<h2>Event log</h2>
<table><thead><tr><th>Time</th><th>Event</th></tr></thead><tbody>${rows(p.timeline.map((t) => [esc(at(t.atMs)), esc(t.text)]))}</tbody></table>
<h2>Manifest</h2>
<table><tbody>${rows([
    ["Ring webhook deliveries", esc(p.manifest.webhookRequestIds.join(", ") || "none")],
    ["Porch reader", esc(p.provenance.vision ? `${p.provenance.vision.provider} / ${p.provenance.vision.model}` : "not recorded")],
    ["Frame hashes", p.manifest.frames.map((f) => `${esc(KIND[f.kind])}: <code>${esc(f.sha256)}</code>`).join("<br>")],
  ])}</tbody></table>
</main></body></html>
`;
}
