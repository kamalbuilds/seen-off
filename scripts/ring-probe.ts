// Calls the real Ring Partner API with RING_* credentials. Needs a Playground token (RING_PLAYGROUND_TOKEN, 30 minutes)
// or a registered app (RING_CLIENT_ID, RING_CLIENT_SECRET, RING_REFRESH_TOKEN).
//   node scripts/ring-probe.ts devices
//   node scripts/ring-probe.ts history <deviceId>
//   node scripts/ring-probe.ts snapshot <deviceId> [epochMs] [out.jpg]
//   node scripts/ring-probe.ts whep <deviceId> [out.jpg]
import { writeFileSync } from "node:fs";
import { RingClient, ringAuthFromEnv } from "../src/ring/client.ts";
import { WhepFrameSource } from "../src/ring/whep.ts";

const [cmd, deviceId, a, b] = process.argv.slice(2);
const ring = new RingClient({ auth: ringAuthFromEnv() });

if (cmd === "devices") {
  for (const d of await ring.listDevices()) console.log(d.id, d.name);
} else if (cmd === "history" && deviceId) {
  for (const e of await ring.history(deviceId, ["ding", "on_demand", "motion.human", "motion.other_motion", "motion"])) console.log(e.eventType, new Date(e.startMs).toISOString(), new Date(e.endMs).toISOString(), e.id);
} else if (cmd === "snapshot" && deviceId) {
  const f = await ring.snapshotAt(deviceId, a ? Number(a) : Date.now() - 60_000);
  const out = b ?? "snapshot.jpg";
  writeFileSync(out, f.jpeg);
  console.log(`wrote ${out}: ${f.jpeg.length} bytes, origin ${f.origin}, media time ${new Date(f.mediaTimestampMs).toISOString()}`);
} else if (cmd === "whep" && deviceId) {
  const f = await new WhepFrameSource(ring).frameAt(deviceId, Date.now());
  const out = a ?? "whep.jpg";
  writeFileSync(out, f.jpeg);
  console.log(`wrote ${out}: ${f.jpeg.length} bytes`);
} else {
  console.error("usage: devices | history <deviceId> | snapshot <deviceId> [epochMs] [out.jpg] | whep <deviceId> [out.jpg]");
  process.exit(2);
}
