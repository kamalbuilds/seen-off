import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createWebhookReceiver } from "./ring/webhook.ts";
import { DAY_ID, validatePlan } from "./pickup/plan.ts";
import type { Ledger } from "./store/ledger.ts";
import type { PickupRunner } from "./pickup/runner.ts";
import type { Provenance } from "./provenance.ts";
import type { RingIntegration } from "./ring/integration.ts";
import { RingLinkError } from "./ring/oauth.ts";
import { RingNotConnected } from "./ring/session.ts";
import { RingApiError } from "./ring/client.ts";

const UI_HTML = readFileSync(new URL("./ui/index.html", import.meta.url), "utf8");

const MAX_BODY = 1_000_000;

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new BodyTooLarge("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface AppOptions {
  signingKey: string;
  ledger: Ledger;
  runner: PickupRunner;
  /** Devices the seller can pick in the form, each labelled with where the list came from. */
  devices?: () => Promise<{ id: string; name: string; provenance: Provenance }[]>;
  /** Connect Ring (partner-initiated OAuth), the seller's doorbells and a porch photo taken on demand. */
  ring?: RingIntegration;
  /** Recorded pickup days the seller can play through the pipeline from the page. */
  replay?: {
    days(): { dayId: string; labels: number; startMs: number }[];
    /** Starts playing the recorded day under a fresh day name and returns that name; the day fills in while it plays. */
    start(dayId: string): string;
    /** A scripted run of contrasting days, back to back, for a first-time viewer. */
    demo?: {
      start(): void;
      status(): { running: boolean; current: string | null; steps: { title: string; blurb: string; dayId: string | null }[] };
    };
  };
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
        let body: unknown;
        try { body = JSON.parse((await readBody(req)).toString("utf8")); } catch (e) {
          if (e instanceof BodyTooLarge) throw e;
          return send(400, { error: "invalid pickup day", errors: ["body is not valid JSON"] });
        }
        const check = validatePlan(body);
        if (!check.ok) return send(400, { error: "invalid pickup day", errors: check.errors });
        if (o.ledger.hasDay(check.plan.dayId)) return send(409, { error: "pickup day exists", errors: [`dayId ${check.plan.dayId} is already armed`] });
        const baseline = await o.runner.arm(check.plan);
        return send(201, { dayId: check.plan.dayId, baselineCount: baseline });
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
      if (url.pathname.startsWith("/ring/") || url.pathname === "/api/ring" || url.pathname.startsWith("/api/ring/")) {
        const ring = o.ring;
        if (!ring) return send(404, { error: "ring is not available on this server" });
        const fail = (e: unknown) => {
          if (e instanceof RingNotConnected) return send(409, { error: "ring not connected", errors: [e.message] });
          if (e instanceof RingLinkError) return send(e.code === "unknown_device" ? 404 : 400, { error: e.code, errors: [e.message] });
          if (e instanceof RingApiError) return send(502, { error: "ring error", errors: [`Ring answered ${e.status} ${e.code}.`] });
          return send(500, { error: (e as Error).message });
        };
        if (req.method === "GET" && url.pathname === "/api/ring") return send(200, ring.status());
        if (req.method === "GET" && url.pathname === "/ring/connect") {
          try { res.writeHead(302, { location: ring.connect(), "cache-control": "no-store" }); return void res.end(); } catch (e) { return fail(e); }
        }
        if (req.method === "GET" && url.pathname === "/ring/callback") {
          let to = "/?ring=connected";
          try { await ring.callback(url.searchParams); } catch (e) {
            to = `/?ring=error&reason=${encodeURIComponent(e instanceof RingLinkError ? e.message : "Something went wrong linking Ring. Try again.")}`;
          }
          res.writeHead(302, { location: to, "cache-control": "no-store" });
          return void res.end();
        }
        if (req.method === "GET" && url.pathname === "/api/ring/devices") { try { return send(200, { devices: await ring.devices() }); } catch (e) { return fail(e); } }
        if (req.method === "POST" && url.pathname === "/api/ring/snapshot") {
          let body: { deviceId?: unknown };
          try { body = JSON.parse((await readBody(req)).toString("utf8")); } catch (e) {
            if (e instanceof BodyTooLarge) throw e;
            return send(400, { error: "invalid request", errors: ["body is not valid JSON"] });
          }
          if (typeof body.deviceId !== "string" || body.deviceId.length === 0 || body.deviceId.length > 128) return send(400, { error: "invalid request", errors: ["deviceId must be a doorbell id"] });
          try { return send(200, await ring.photo(body.deviceId)); } catch (e) { return fail(e); }
        }
        const ph = url.pathname.match(/^\/api\/ring\/photos\/([^/]+)$/);
        if (req.method === "GET" && ph) {
          const bytes = ring.photoFile(decodeURIComponent(ph[1]));
          if (!bytes) return send(404, { error: "no such photo" });
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" });
          return void res.end(bytes);
        }
        return send(404, { error: "not found" });
      }
      if (req.method === "GET" && url.pathname === "/api/stream") {
        // Server-sent events: one "change" per burst of ledger writes, so an open page redraws as each frame, verdict and scan lands.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 1500\n: connected\n\n");
        let pending: Set<string> | null = null;
        const flush = () => { const ids = [...pending!]; pending = null; res.write(`event: change\ndata: ${JSON.stringify({ dayIds: ids })}\n\n`); };
        const onChange = (dayId?: string) => { if (pending === null) { pending = new Set(); setTimeout(flush, 80); } pending.add(dayId ?? ""); };
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        o.ledger.changes.on("change", onChange);
        req.on("close", () => { clearInterval(beat); o.ledger.changes.off("change", onChange); });
        return;
      }
      if (url.pathname === "/api/replay" && req.method === "GET") return send(200, { days: o.replay?.days() ?? [], demo: o.replay?.demo?.status() ?? null });
      if (url.pathname === "/api/demo" && req.method === "POST") {
        if (!o.replay?.demo) return send(404, { error: "no demo on this server" });
        if (o.replay.demo.status().running) return send(409, { error: "demo busy", errors: ["the demo is already playing"] });
        try { o.replay.demo.start(); } catch (e) { return send(409, { error: "demo busy", errors: [(e as Error).message] }); }
        return send(202, o.replay.demo.status());
      }
      if (url.pathname === "/api/replay" && req.method === "POST") {
        if (!o.replay) return send(404, { error: "replay is not available on this server" });
        let body: { dayId?: unknown };
        try { body = JSON.parse((await readBody(req)).toString("utf8")); } catch (e) {
          if (e instanceof BodyTooLarge) throw e;
          return send(400, { error: "invalid replay request", errors: ["body is not valid JSON"] });
        }
        const known = o.replay.days().some((d) => d.dayId === body.dayId);
        if (typeof body.dayId !== "string" || !known) return send(400, { error: "invalid replay request", errors: ["dayId must be one of the recorded pickup days"] });
        try { return send(202, { dayId: o.replay.start(body.dayId) }); } catch (e) { return send(409, { error: "replay busy", errors: [(e as Error).message] }); }
      }
      if (req.method === "GET" && url.pathname === "/api/devices") {
        return send(200, { devices: o.devices ? await o.devices() : [] });
      }
      const frame = url.pathname.match(/^\/days\/([^/]+)\/frames\/(\d+)$/);
      if (req.method === "GET" && frame) {
        const id = decodeURIComponent(frame[1]);
        const obs = o.ledger.hasDay(id) ? o.ledger.observations(id)[Number(frame[2])] : undefined;
        if (!obs?.framePath) return send(404, { error: "no stored frame" });
        const bytes = readFileSync(obs.framePath);
        // The file must still be the frame the vision stage read; a changed file is refused, never served as evidence.
        if (createHash("sha256").update(bytes).digest("hex") !== obs.frameSha256) return send(409, { error: "frame does not match its recorded hash" });
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" });
        return void res.end(bytes);
      }
      const m = url.pathname.match(/^\/days\/([^/]+)$/);
      if (req.method === "DELETE" && m) {
        const id = decodeURIComponent(m[1]);
        if (!o.ledger.hasDay(id)) return send(404, { error: "no such day" });
        o.ledger.deleteDay(id);
        if (o.runner.d.evidenceDir && DAY_ID.test(id)) rmSync(join(o.runner.d.evidenceDir, id), { recursive: true, force: true });
        return send(200, { deleted: id });
      }
      if (req.method === "GET" && m) {
        const id = decodeURIComponent(m[1]);
        return o.ledger.hasDay(id) ? send(200, o.runner.packetOf(id)) : send(404, { error: "no such day" });
      }
      send(404, { error: "not found" });
    } catch (e) {
      if (e instanceof BodyTooLarge) return send(413, { error: "body too large" });
      send(500, { error: (e as Error).message });
    }
  });
}
