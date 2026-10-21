import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AlertDelivery, Alerter, AlertKind } from "./pickup/runner.ts";

type Alert = { dayId: string; kind: AlertKind; text: string };

/** Appends one JSON line per alert. */
export function fileAlerter(path: string): Alerter {
  return {
    async send(a) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...a }) + "\n");
      return { channels: [{ name: "file", ok: true }] };
    },
  };
}

/**
 * POSTs {text, dayId, kind} as JSON. The `text` field is what Slack, Discord-compatible and ntfy-style incoming webhooks read,
 * so a seller's phone gets the alert through whichever of those they point it at. The URL is never logged or stored.
 */
export function webhookAlerter(url: string, name = "webhook", fetchImpl: typeof fetch = fetch): Alerter {
  return {
    async send(a: Alert) {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `Outbox ${a.kind}: ${a.text}`, dayId: a.dayId, kind: a.kind }), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${name} answered ${res.status}`);
      return { channels: [{ name, ok: true, status: res.status }] };
    },
  };
}

/**
 * Sends to every channel. One channel failing does not stop the others and is recorded in the delivery;
 * only when every channel fails does the send throw, so the scheduler retries the alert.
 */
export function fanoutAlerter(channels: { name: string; alerter: Alerter }[]): Alerter {
  return {
    async send(a) {
      const out: AlertDelivery["channels"] = [];
      for (const c of channels) {
        try { out.push(...((await c.alerter.send(a)) ?? { channels: [{ name: c.name, ok: true }] }).channels); }
        catch (e) { out.push({ name: c.name, ok: false, error: (e as Error).message }); }
      }
      if (out.length > 0 && out.every((c) => !c.ok)) throw new Error(`every alert channel failed: ${out.map((c) => `${c.name}: ${c.error}`).join("; ")}`);
      return { channels: out };
    },
  };
}
