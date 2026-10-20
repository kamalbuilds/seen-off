import { signBody } from "../src/ring/signature.ts";

export const KEY = "test-signing-key-not-a-secret";

/** v1.1 motion_detected body in the shape documented under Notifications. A fixture, not a Ring delivery. */
export function motionBody(over: { requestId?: string; deviceId?: string; timestamp?: number; subType?: string } = {}): string {
  const deviceId = over.deviceId ?? "ava1.ring.device.TESTFIXTURE";
  const ts = over.timestamp ?? 1786715596787;
  return JSON.stringify({
    meta: { version: "1.1", time: "2026-10-21T13:39:57.200155525Z", request_id: over.requestId ?? "req-1", account_id: "ava1.ring.account.TESTFIXTURE" },
    data: {
      id: `${deviceId}_motion_${ts}`, type: "motion_detected",
      attributes: { source: deviceId, source_type: "devices", timestamp: ts, sub_type: over.subType ?? "human" },
      relationships: { devices: { links: { self: `/v1/devices/${deviceId}` } } },
    },
  });
}

export const signed = (body: string, key = KEY) => ({ "x-signature": signBody(key, body) });
export const bytes = (s: string) => new TextEncoder().encode(s);
