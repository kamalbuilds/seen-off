import type { Frame, FrameSource } from "../pickup/runner.ts";
import { RingApiError, RingSnapshotSource, type RingApi } from "./client.ts";
import { jpegSize } from "./probe.ts";

export interface PreflightStep {
  name: "auth" | "devices" | "history" | "snapshot" | "whep";
  status: "pass" | "fail" | "skip";
  ms: number;
  detail: string;
}

export interface PreflightOptions {
  deviceId?: string;
  /** The live-view grab. null skips it on purpose (reported as skipped, never as passed). */
  whep: FrameSource | null;
  snapshotLagMs?: number;
  now?: () => number;
}

const describeError = (e: unknown) => (e instanceof RingApiError ? `Ring ${e.status} ${e.code}: ${e.message.replace(/^ring \d+ \S+: /, "") || "no detail"}` : (e as Error).message.split("\n")[0]);
const frameInfo = (f: Frame) => {
  const s = jpegSize(f.jpeg);
  return `${s ? `${s.width}x${s.height} ` : ""}jpeg, ${f.jpeg.length} bytes, origin ${f.origin}`;
};

/**
 * Exercises each Ring surface the product depends on, in order, against the real account: token, device discovery, event history,
 * a snapshot download and a live WHEP frame. Each step is timed. A step whose prerequisite failed is skipped with the reason.
 * Nothing is substituted when a call fails: the step fails with Ring's own status and code.
 */
export async function runPreflight(api: RingApi, o: PreflightOptions): Promise<PreflightStep[]> {
  const now = o.now ?? Date.now;
  const out: PreflightStep[] = [];
  let blocked: string | null = null;
  let deviceId = o.deviceId;
  let deviceName = "";

  const step = async (name: PreflightStep["name"], run: () => Promise<string>) => {
    if (blocked) { out.push({ name, status: "skip", ms: 0, detail: `blocked: ${blocked}` }); return; }
    const t0 = performance.now();
    try {
      const detail = await run();
      out.push({ name, status: "pass", ms: Math.round(performance.now() - t0), detail });
    } catch (e) {
      out.push({ name, status: "fail", ms: Math.round(performance.now() - t0), detail: describeError(e) });
      blocked = `${name} failed`;
    }
  };

  await step("auth", async () => { await api.accessToken(); return "access token issued"; });
  await step("devices", async () => {
    const devices = await api.listDevices();
    if (devices.length === 0) throw new Error("Ring returned no devices for this account");
    const pick = deviceId ? devices.find((d) => d.id === deviceId) : devices[0];
    if (!pick) throw new Error(`device ${deviceId} is not one of the ${devices.length} this account lists`);
    deviceId = pick.id; deviceName = pick.name;
    return `${devices.length} device${devices.length === 1 ? "" : "s"}: ${devices.map((d) => d.name).join(", ")}`;
  });
  await step("history", async () => {
    const ev = await api.history(deviceId!, ["ding", "on_demand", "motion.human", "motion.other_motion", "motion"], 1);
    return ev.length === 0 ? `${deviceName}: no events yet` : `${deviceName}: ${ev.length} events, newest ${ev[0].eventType} at ${new Date(ev[0].startMs).toISOString()}`;
  });
  await step("snapshot", async () => frameInfo(await new RingSnapshotSource(api).frameAt(deviceId!, now() - (o.snapshotLagMs ?? 60_000))));
  if (o.whep === null) out.push({ name: "whep", status: "skip", ms: 0, detail: "skipped on request (--skip-whep)" });
  else await step("whep", async () => frameInfo(await o.whep!.frameAt(deviceId!, now())));
  return out;
}

export const preflightOk = (steps: PreflightStep[]) => steps.every((s) => s.status !== "fail");

/** The one-screen report: one line per surface with its timing, then the result line. */
export function formatPreflight(steps: PreflightStep[], where: string): string {
  const lines = [`Ring preflight against ${where}`, ""];
  for (const s of steps) lines.push(`${s.status.toUpperCase().padEnd(4)}  ${s.name.padEnd(9)}${(s.status === "skip" ? "-" : `${s.ms} ms`).padStart(8)}   ${s.detail}`);
  const n = (k: PreflightStep["status"]) => steps.filter((s) => s.status === k).length;
  lines.push("", `RESULT: ${n("pass")} passed, ${n("fail")} failed, ${n("skip")} skipped`);
  return lines.join("\n");
}
