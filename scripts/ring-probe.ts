// Calls the real Ring Partner API with RING_* credentials. Needs a Playground token (RING_PLAYGROUND_TOKEN, 30 minutes)
// or a registered app (RING_CLIENT_ID, RING_CLIENT_SECRET, RING_REFRESH_TOKEN). With neither set it makes no call and exits 2.
//
//   npm run ring:probe                      discovery + one snapshot + history + porch read, frames and report in data/probe/
//   npm run ring:probe -- demo --whep       the same, plus a live WHEP frame
//   npm run ring:probe -- demo <deviceId>   capture from one device
//   npm run ring:probe -- devices | history <deviceId> | snapshot <deviceId> [epochMs] [out.jpg] | whep <deviceId> [out.jpg]
import { writeFileSync } from "node:fs";
import { RingClient, ringAuthFromEnv } from "../src/ring/client.ts";
import { runProbe } from "../src/ring/probe.ts";
import { WhepFrameSource } from "../src/ring/whep.ts";
import { visionFromEnv } from "../src/vision/index.ts";

const argv = process.argv.slice(2);
const [first, ...rest] = argv;
const demo = first === undefined || first === "demo" || first.startsWith("--");
const cmd = demo ? "demo" : first;
const args = (demo ? argv.filter((a) => a !== "demo") : rest).filter((a) => !a.startsWith("--"));
const whepFlag = argv.includes("--whep");

let ring: RingClient;
try {
  ring = new RingClient({ auth: ringAuthFromEnv(), apiBase: process.env.RING_API_BASE });
} catch (e) {
  console.error(`No Ring call made: ${(e as Error).message}`);
  console.error("Set RING_PLAYGROUND_TOKEN (Ring Playground, 30 minute token) or RING_CLIENT_ID, RING_CLIENT_SECRET and RING_REFRESH_TOKEN in .env, then run this again.");
  process.exit(2);
}

if (cmd === "demo") {
  let vision;
  try { vision = visionFromEnv(); } catch { vision = undefined; }
  const r = await runProbe(ring, { deviceId: args[0], outDir: "data/probe", vision, whep: whepFlag ? new WhepFrameSource(ring) : undefined });
  console.log(`Ring devices on this account: ${r.devices.length}`);
  for (const d of r.devices) console.log(`  ${d.id}  ${d.name}${d.id === r.device.id ? "   <- capturing from this one" : ""}`);
  console.log(`Included resources: ${Object.entries(r.includedTypes).map(([t, n]) => `${t} x${n}`).join(", ") || "none"}`);
  console.log(`History: ${r.history.events} events${r.history.newest ? `, newest ${r.history.newest.eventType} ${r.history.newest.start}` : ""}`);
  const show = (label: string, f: NonNullable<typeof r.snapshot>) =>
    console.log(`${label}: ${f.width ?? "?"}x${f.height ?? "?"} jpeg, ${f.bytes} bytes, media time ${f.mediaTimestamp}, origin ${f.mediaOrigin}, ${f.latencyMs} ms, sha256 ${f.sha256.slice(0, 16)}, saved ${f.file}`);
  show("Snapshot", r.snapshot);
  if (r.whep) show("WHEP live frame", r.whep);
  if (r.porch) console.log("error" in r.porch ? `Porch read failed: ${r.porch.error}` : `Porch read (${r.porch.provider}/${r.porch.model}): ${r.porch.count} parcels`);
  console.log(`Report: ${r.reportFile}`);
} else if (cmd === "devices") {
  for (const d of await ring.listDevices()) console.log(d.id, d.name);
} else if (cmd === "history" && args[0]) {
  for (const e of await ring.history(args[0], ["ding", "on_demand", "motion.human", "motion.other_motion", "motion"])) console.log(e.eventType, new Date(e.startMs).toISOString(), new Date(e.endMs).toISOString(), e.id);
} else if (cmd === "snapshot" && args[0]) {
  const f = await ring.snapshotAt(args[0], args[1] ? Number(args[1]) : Date.now() - 60_000);
  const out = args[2] ?? "snapshot.jpg";
  writeFileSync(out, f.jpeg);
  console.log(`wrote ${out}: ${f.jpeg.length} bytes, origin ${f.origin}, media time ${new Date(f.mediaTimestampMs).toISOString()}`);
} else if (cmd === "whep" && args[0]) {
  const f = await new WhepFrameSource(ring).frameAt(args[0], Date.now());
  const out = args[1] ?? "whep.jpg";
  writeFileSync(out, f.jpeg);
  console.log(`wrote ${out}: ${f.jpeg.length} bytes`);
} else {
  console.error("usage: demo [deviceId] [--whep] | devices | history <deviceId> | snapshot <deviceId> [epochMs] [out.jpg] | whep <deviceId> [out.jpg]");
  process.exit(2);
}
