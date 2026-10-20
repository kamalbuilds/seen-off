import { createServer, type IncomingMessage, type Server } from "node:http";
import { createWebhookReceiver } from "./ring/webhook.ts";
import type { Ledger } from "./store/ledger.ts";
import type { PickupRunner, DayPlan } from "./pickup/runner.ts";

const MAX_BODY = 1_000_000;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface AppOptions {
  signingKey: string;
  ledger: Ledger;
  runner: PickupRunner;
  /** Called after a day is armed so the caller can schedule closeWindow and the 24 h tracking check. */
  onDayArmed?: (plan: DayPlan) => void;
}

/**
 * POST /ring/webhook   Ring v1.1 deliveries: verify X-Signature over raw bytes, record the event, ack. Vision runs later in runner.drain().
 * POST /days           arm a pickup day {dayId, deviceId, windowStartMs, windowEndMs, labels[]}
 * GET  /days/:id       the evidence packet
 */
export function createApp(o: AppOptions): Server {
  const receive = createWebhookReceiver({
    signingKey: o.signingKey,
    store: o.ledger,
    handle: (event) => o.ledger.insertEvent(event),
  });

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });
      if (req.method === "POST" && url.pathname === "/ring/webhook") {
        const r = await receive(await readBody(req), req.headers);
        send(r.status, r.body);
        if (r.status === 200) void o.runner.drain().catch((e) => console.error("drain failed", e));
        return;
      }
      if (req.method === "POST" && url.pathname === "/days") {
        const plan = JSON.parse((await readBody(req)).toString("utf8")) as DayPlan;
        const baseline = await o.runner.arm(plan);
        o.onDayArmed?.(plan);
        return send(201, { dayId: plan.dayId, baselineCount: baseline });
      }
      const m = url.pathname.match(/^\/days\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const p = o.ledger.getPacket(decodeURIComponent(m[1]));
        return p ? send(200, p) : send(404, { error: "no packet" });
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
}
