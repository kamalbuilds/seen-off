import { randomUUID } from "node:crypto";
import { signBody } from "../src/ring/signature.ts";

/**
 * Signed Ring v1.1 webhook sender. This is a SIMULATOR (the Playground emits no webhooks, Amazon organizer: a self-built
 * simulator is fine). It signs exactly as the Ring docs specify: HMAC-SHA256 hex of the raw body, "sha256=" prefix.
 */
export function motionEnvelope(a: { deviceId: string; timestampMs: number; subType: string; requestId?: string; accountId?: string }): string {
  return JSON.stringify({
    meta: { version: "1.1", time: new Date(a.timestampMs).toISOString(), request_id: a.requestId ?? randomUUID(), account_id: a.accountId ?? "ava1.ring.account.SIMULATOR" },
    data: {
      id: `${a.deviceId}_motion_${a.timestampMs}`, type: "motion_detected",
      attributes: { source: a.deviceId, source_type: "devices", timestamp: a.timestampMs, sub_type: a.subType },
      relationships: { devices: { links: { self: `/v1/devices/${a.deviceId}` } } },
    },
  });
}

export interface Delivery {
  status: number;
  ms: number;
  body: string;
}

export async function deliver(url: string, signingKey: string, rawBody: string, opts: { signature?: string | null } = {}): Promise<Delivery> {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "outbox-simulator/0.1" };
  const sig = opts.signature === undefined ? signBody(signingKey, rawBody) : opts.signature;
  if (sig !== null) headers["x-signature"] = sig;
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers, body: rawBody, signal: AbortSignal.timeout(6000) });
  return { status: res.status, ms: performance.now() - t0, body: await res.text() };
}
