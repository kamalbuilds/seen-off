import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Frame, FrameSource } from "../pickup/runner.ts";
import type { RingApi } from "./client.ts";

const run = promisify(execFile);
const LIVE_WINDOW_MS = 2 * 60_000;

/**
 * Live-view frame via the aiortc worker (Node has no WebRTC). Live view shows now, so a request for a time
 * outside the last two minutes is refused rather than answered with the wrong moment.
 */
export class WhepFrameSource implements FrameSource {
  readonly name = "ring-whep";
  readonly provenance = "live" as const;
  readonly #client: RingApi;
  readonly #python: string;
  readonly #apiBase: string | undefined;

  constructor(client: RingApi, python = process.env.WHEP_PYTHON ?? "python3", apiBase?: string) {
    this.#client = client;
    this.#python = python;
    this.#apiBase = apiBase;
  }

  async frameAt(deviceId: string, atMs: number): Promise<Frame> {
    if (Math.abs(Date.now() - atMs) > LIVE_WINDOW_MS) throw new Error("WHEP shows live video only, requested time is not now");
    const dir = await mkdtemp(join(tmpdir(), "whep-"));
    try {
      const out = join(dir, "frame.jpg");
      const args = ["worker/whep_frame.py", "--device", deviceId, "--out", out, ...(this.#apiBase ? ["--api-base", this.#apiBase] : [])];
      await run(this.#python, args, { env: { ...process.env, RING_ACCESS_TOKEN: await this.#client.accessToken() }, timeout: 60_000 });
      return { jpeg: new Uint8Array(await readFile(out)), mediaTimestampMs: Date.now(), origin: "whep-live" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
