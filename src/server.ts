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
import { linkPage, linkProblemPage } from "./ring/link-page.ts";
import { RingNotConnected } from "./ring/session.ts";
import { RingApiError } from "./ring/client.ts";
import { isPublicRoute, type OperatorAuth } from "./operator.ts";
import { exportKit } from "./pickup/export.ts";
import { claimFacts, draftClaim, type ClaimWriter } from "./pickup/claim.ts";

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
  /** Operator sign-in. When set, every route except Ring's own (webhook, link, token exchange), /health and the sign-in form needs a session cookie; unset leaves the console open (local use). */
  operator?: OperatorAuth;
  /**
   * Public read-only demo: anyone can watch the recorded days play and open their packets, nobody can arm, delete or reach Ring.
   * The replay itself drives a second, loopback-only app over the same ledger, so its own POSTs never pass through this one.
   */
  readOnly?: boolean;
  /** Drafts carrier and marketplace claims from a packet (Qwen3-VL on Bedrock). Unset hides the claim button. */
  claims?: ClaimWriter;
  /** Recorded pickup days the seller can play through the pipeline from the page. */
  replay?: {
    days(): { dayId: string; labels: number; startMs: number; title?: string; timeZone?: string }[];
    /** Starts playing the recorded day under a fresh day name and returns that name; the day fills in while it plays. */
    start(dayId: string): string;
    /** A scripted run of contrasting days, back to back, for a first-time viewer. */
    demo?: {
      start(): void;
      status(): { running: boolean; current: string | null; steps: { title: string; blurb: string; dayId: string | null; quote?: { text: string; by: string; url: string } }[] };
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
  // A grounded draft is kept per packet, so pressing "Draft the claim" again (or many visitors on the public demo) costs one model call.
  const drafts = new Map<string, ReturnType<typeof draftClaim>>();
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
      if (o.readOnly && ((req.method === "POST" && url.pathname === "/days") || (req.method === "DELETE" && /^\/days\/[^/]+$/.test(url.pathname))
        || url.pathname.startsWith("/ring/") || url.pathname === "/api/ring" || url.pathname.startsWith("/api/ring/"))) {
        return send(403, { error: "read-only demo", errors: ["This public demo only plays recorded pickup days."] });
      }
      if (o.operator) {
        const op = o.operator;
        const page = (status: number, body: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(body); };
        if (req.method === "POST" && url.pathname === "/login") {
          const r = op.login(new URLSearchParams((await readBody(req)).toString("utf8")).get("code") ?? "");
          if ("cookie" in r) { res.writeHead(302, { location: "/", "set-cookie": r.cookie, "cache-control": "no-store" }); return void res.end(); }
          return page(r.locked ? 429 : 401, op.page(r.error));
        }
        if (req.method === "POST" && url.pathname === "/logout") { res.writeHead(302, { location: "/", "set-cookie": op.logoutCookie(), "cache-control": "no-store" }); return void res.end(); }
        if (!isPublicRoute(req.method, url.pathname) && !op.authed(req)) {
          if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return page(200, op.page());
          return send(401, { error: "sign in required" });
        }
      }
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
          return { dayId: p.dayId, title: p.title, timeZone: p.timeZone, status: p.status, verdict: p.verdict, window: p.window, labels: p.labels.length, baselineCount: p.baselineCount, closeCount: p.closeCount, alert: p.alert?.kind ?? null, provenance: p.provenance.verdict ?? p.provenance.frames };
        }) });
      }
      if (url.pathname.startsWith("/ring/") || url.pathname === "/api/ring" || url.pathname.startsWith("/api/ring/")) {
        const ring = o.ring;
        if (!ring) return send(404, { error: "ring is not available on this server" });
        const fail = (e: unknown) => {
          if (e instanceof RingNotConnected) return send(409, { error: "ring not connected", errors: [e.message] });
          if (e instanceof RingLinkError) return send(e.code === "unknown_device" ? 404 : e.code === "ring_driven" ? 409 : 400, { error: e.code, errors: [e.message] });
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
        const html = (status: number, body: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(body); };
        const form = async () => new URLSearchParams((await readBody(req)).toString("utf8"));
        if (req.method === "POST" && url.pathname === "/ring/oauth/token") {
          // Token Exchange URL: Ring posts the single-use authorization code here, form-encoded.
          try { await ring.tokenExchange((await form()).get("code")); return send(200, { status: "ok" }); }
          catch (e) { if (e instanceof RingLinkError) return send(e.code === "code_rejected" || e.code === "token_failed" ? 502 : 400, { error: e.code }); throw e; }
        }
        if (req.method === "GET" && url.pathname === "/ring/link") {
          // Account Link URL: Ring sends the user here with nonce and time; the sign-in is shown only for a fresh, well-formed link.
          try { const l = ring.linkEntry(url.searchParams.get("nonce"), url.searchParams.get("time")); return html(200, linkPage(l)); }
          catch (e) { if (e instanceof RingLinkError) return html(400, linkProblemPage(e.message)); throw e; }
        }
        if (req.method === "POST" && url.pathname === "/ring/link") {
          const f = await form();
          const sub = { nonce: f.get("nonce"), time: f.get("time"), email: f.get("email") ?? "", passcode: f.get("passcode") ?? "" };
          try { await ring.linkSubmit(sub); res.writeHead(302, { location: "/?ring=connected", "cache-control": "no-store" }); return void res.end(); }
          catch (e) {
            if (!(e instanceof RingLinkError)) throw e;
            if ((e.code === "bad_sign_in" || e.code === "locked") && sub.nonce && sub.time) return html(e.code === "locked" ? 429 : 401, linkPage({ nonce: sub.nonce, time: sub.time, email: sub.email, error: e.message }));
            return html(400, linkProblemPage(e.message));
          }
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
      if (url.pathname === "/api/replay" && req.method === "GET") return send(200, { days: o.replay?.days() ?? [], demo: o.replay?.demo?.status() ?? null, ...(o.readOnly ? { public: true } : {}) });
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
      // The file must still be the frame the vision stage read; a changed file is refused, never served or exported as evidence.
      const storedFrame = (id: string, n: number): Buffer | "missing" | "changed" => {
        const obs = o.ledger.hasDay(id) ? o.ledger.observations(id)[n] : undefined;
        if (!obs?.framePath) return "missing";
        const bytes = readFileSync(obs.framePath);
        return createHash("sha256").update(bytes).digest("hex") === obs.frameSha256 ? bytes : "changed";
      };
      const frame = url.pathname.match(/^\/days\/([^/]+)\/frames\/(\d+)$/);
      if (req.method === "GET" && frame) {
        const bytes = storedFrame(decodeURIComponent(frame[1]), Number(frame[2]));
        if (bytes === "missing") return send(404, { error: "no stored frame" });
        if (bytes === "changed") return send(409, { error: "frame does not match its recorded hash" });
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" });
        return void res.end(bytes);
      }
      if (req.method === "GET" && url.pathname === "/api/features") return send(200, { claims: Boolean(o.claims) });
      const kit = url.pathname.match(/^\/days\/([^/]+)\/(export|claim)$/);
      if (kit) {
        const id = decodeURIComponent(kit[1]);
        if (!o.ledger.hasDay(id)) return send(404, { error: "no such day" });
        const p = o.runner.packetOf(id);
        if (req.method === "GET" && kit[2] === "export") {
          const frames = new Map<number, Uint8Array>();
          for (const f of p.frames) { const b = storedFrame(id, f.index); if (typeof b !== "string") frames.set(f.index, b); }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${DAY_ID.test(id) ? id : "day"}-evidence.html"`, "cache-control": "no-store" });
          return void res.end(exportKit(p, frames, Date.now()));
        }
        if (req.method === "POST" && kit[2] === "claim") {
          if (!o.claims) return send(404, { error: "claims are not configured on this server" });
          let r;
          const key = JSON.stringify([id, p.verdict, p.windowVerdict, claimFacts(p)]);
          let pending = drafts.get(key);
          if (!pending) {
            pending = draftClaim(p, o.claims);
            drafts.set(key, pending);
            pending.then((d) => { if (!d?.draft) drafts.delete(key); }, () => drafts.delete(key));
            if (drafts.size > 200) drafts.delete(drafts.keys().next().value!);
          }
          try { r = await pending; } catch (e) { return send(502, { error: "claim writer failed", errors: [(e as Error).message] }); }
          if (!r) return send(422, { error: "nothing to dispute", errors: ["This day has no missed pickup or unscanned handoff to claim."] });
          return send(r.draft ? 200 : 422, r);
        }
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
