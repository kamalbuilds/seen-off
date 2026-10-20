import { verifySignature } from "./signature.ts";

export const RING_EVENT_TYPES = [
  "motion_detected", "button_press", "device_added", "device_removed", "device_online", "device_offline",
  "app_integration_added", "app_integration_removed", "subscription_activated", "subscription_deactivated",
] as const;

export interface RingEvent {
  requestId: string;
  accountId: string;
  type: string;
  deviceId?: string;
  timestampMs?: number;
  subType?: string;
  componentIds?: string[];
  raw: unknown;
}

export interface IdempotencyStore {
  isDone(requestId: string): boolean;
  markDone(requestId: string): void;
}

export interface WebhookResult {
  status: number;
  body: { status: string; detail?: string };
}

export class EnvelopeError extends Error {}

/** v1.1 envelope: meta.request_id and meta.account_id, data.type, data.attributes.{source,timestamp,sub_type,component_ids}. */
export function parseEnvelope(raw: unknown): RingEvent {
  const o = raw as { meta?: Record<string, unknown>; data?: { type?: unknown; attributes?: Record<string, unknown> } };
  const requestId = o?.meta?.request_id;
  const accountId = o?.meta?.account_id;
  const type = o?.data?.type;
  if (o?.meta?.version !== "1.1") throw new EnvelopeError("meta.version must be 1.1");
  if (typeof requestId !== "string" || !requestId) throw new EnvelopeError("meta.request_id missing");
  if (typeof accountId !== "string" || !accountId) throw new EnvelopeError("meta.account_id missing");
  if (typeof type !== "string" || !type) throw new EnvelopeError("data.type missing");
  const a = o.data?.attributes ?? {};
  return {
    requestId, accountId, type, raw,
    deviceId: typeof a.source === "string" ? a.source : undefined,
    timestampMs: typeof a.timestamp === "number" ? a.timestamp : undefined,
    subType: typeof a.sub_type === "string" ? a.sub_type : undefined,
    componentIds: Array.isArray(a.component_ids) ? a.component_ids.map(String) : undefined,
  };
}

export interface ReceiverOptions {
  signingKey: string;
  store: IdempotencyStore;
  /** Must be quick: enqueue or record, never run vision inline (CV Guidelines: acknowledge, enqueue, process in the background). */
  handle: (event: RingEvent) => Promise<void> | void;
  /** Ring treats no answer within 5 s as a failed delivery; stay under it. */
  ackBudgetMs?: number;
}

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export function createWebhookReceiver(opts: ReceiverOptions) {
  const budget = opts.ackBudgetMs ?? 4000;
  const inFlight = new Set<string>();

  return async function receive(rawBody: Uint8Array, headers: Record<string, string | string[] | undefined>): Promise<WebhookResult> {
    if (!verifySignature(opts.signingKey, rawBody, header(headers, "x-signature"))) {
      return { status: 401, body: { status: "invalid_signature" } };
    }
    let event: RingEvent;
    try {
      event = parseEnvelope(JSON.parse(Buffer.from(rawBody).toString("utf8")));
    } catch (e) {
      return { status: 400, body: { status: "bad_payload", detail: (e as Error).message } };
    }
    if (opts.store.isDone(event.requestId)) return { status: 200, body: { status: "already_processed" } };
    if (inFlight.has(event.requestId)) return { status: 503, body: { status: "in_flight" } };

    inFlight.add(event.requestId);
    // Mark only after the handler succeeded. A throw leaves the id unmarked so Ring's retry is processed, not swallowed.
    const work = Promise.resolve()
      .then(() => opts.handle(event))
      .then(() => opts.store.markDone(event.requestId))
      .finally(() => inFlight.delete(event.requestId));
    const slow = new Promise<"slow">((r) => setTimeout(() => r("slow"), budget).unref());
    try {
      const winner = await Promise.race([work.then(() => "done" as const), slow]);
      if (winner === "slow") {
        work.catch(() => {});
        return { status: 503, body: { status: "ack_budget_exceeded" } };
      }
      return { status: 200, body: { status: "processed" } };
    } catch (e) {
      return { status: 500, body: { status: "handler_failed", detail: (e as Error).message } };
    }
  };
}
