// One-screen readiness report for the Ring integration: auth, devices, history, snapshot and WHEP, each with its timing.
// Exits 0 only when every step passes (a step skipped with --skip-whep does not count as a failure). Exit 1: a step failed. Exit 2: no Ring credentials, no call made.
//   npm run ring:preflight
//   npm run ring:preflight -- --skip-whep      leave out the live-view frame
//   npm run ring:preflight -- <deviceId>       check one doorbell
import { formatPreflight, preflightOk, runPreflight } from "../src/ring/preflight.ts";
import { RingSession } from "../src/ring/session.ts";
import { WhepFrameSource } from "../src/ring/whep.ts";

const args = process.argv.slice(2);
const skipWhep = args.includes("--skip-whep");
const deviceId = args.find((a) => !a.startsWith("--"));

const ring = new RingSession({ tokenFile: process.env.RING_REFRESH_TOKEN_FILE ?? "data/ring-refresh-token" });
if (!ring.connected) {
  console.error("No Ring call made: Ring is not connected.");
  console.error("Use Connect Ring on the seller page, or set RING_PLAYGROUND_TOKEN, or RING_CLIENT_ID, RING_CLIENT_SECRET and RING_REFRESH_TOKEN in .env, then run this again.");
  process.exit(2);
}
const steps = await runPreflight(ring, { deviceId, whep: skipWhep ? null : new WhepFrameSource(ring) });
console.log(formatPreflight(steps, process.env.RING_API_BASE ?? "https://api.amazonvision.com"));
process.exit(preflightOk(steps) ? 0 : 1);
