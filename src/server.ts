import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createWebhookReceiver } from "./ring/webhook.ts";
import type { Ledger } from "./store/ledger.ts";
import type { PickupRunner, DayPlan } from "./pickup/runner.ts";
import type { Provenance } from "./provenance.ts";

const UI_HTML = readFileSync(new URL("./ui/index.html", import.meta.url), "utf8");

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
  /** Devices the seller can pick in the form, each labelled with where the list came from. */
  devices?: () => Promise<{ id: string; name: string; provenance: Provenance }[]>;
}

/**
 * POST /ring/webhook   Ring v1.1 deliveries: verify X-Signature over raw bytes, record the event, ack. Vision runs later in runner.drain().
 * POST /days           arm a pickup day {dayId, deviceId, windowStartMs, windowEndMs, labels[]}
 * GET  /days/:id       the evidence packet, rebuilt from the ledger on every read
 * GET  /days/:id/frames/:n   the stored frame behind packet.frames[n]
 * GET  /                the seller page; GET /api/days lists pickup days, GET /api/devices lists doorbells
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
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return void res.end(UI_HTML);
      }
      if (req.method === "GET" && url.pathname === "/api/days") {
        return send(200, { days: o.ledger.listDays().map((d) => {
          const p = o.runner.packetOf(d.dayId);
          return { dayId: p.dayId, status: p.status, verdict: p.verdict, window: p.window, labels: p.labels.length, baselineCount: p.baselineCount, closeCount: p.closeCount, alert: p.alert?.kind ?? null, provenance: p.provenance.verdict ?? p.provenance.frames };
        }) });
      }
      if (req.method === "GET" && url.pathname === "/api/devices") {
        return send(200, { devices: o.devices ? await o.devices() : [] });
      }
      const frame = url.pathname.match(/^\/days\/([^/]+)\/frames\/(\d+)$/);
      if (req.method === "GET" && frame) {
        const id = decodeURIComponent(frame[1]);
        const obs = o.ledger.hasDay(id) ? o.ledger.observations(id)[Number(frame[2])] : undefined;
        if (!obs?.framePath) return send(404, { error: "no stored frame" });
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" });
        return void res.end(readFileSync(obs.framePath));
      }
      const m = url.pathname.match(/^\/days\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const id = decodeURIComponent(m[1]);
        return o.ledger.hasDay(id) ? send(200, o.runner.packetOf(id)) : send(404, { error: "no such day" });
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
}
