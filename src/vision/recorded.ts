import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PorchReading, VisionProvider } from "./types.ts";

export interface RecordedReads {
  provider: string;
  model: string;
  recordedAt: string;
  /** sha256 of the frame bytes -> every reply the model gave for that frame, in call order. */
  reads: Record<string, { file: string; replies: PorchReading[] }>;
}

/**
 * Replays Qwen3-VL readings recorded from one live bedrock-mantle pass, keyed by the sha256 of the frame bytes.
 * A frame that was never recorded throws, so the runner stores a null count instead of a guess.
 * Repeated reads of one frame step through the recorded replies, matching the live re-read on an empty baseline.
 */
export class RecordedVision implements VisionProvider {
  readonly name: string;
  readonly model: string;
  readonly #reads: RecordedReads["reads"];
  readonly #calls = new Map<string, number>();

  constructor(rec: RecordedReads) {
    this.name = `${rec.provider} (recorded)`;
    this.model = rec.model;
    this.#reads = rec.reads;
  }

  static fromFile(path: string): RecordedVision {
    return new RecordedVision(JSON.parse(readFileSync(path, "utf8")) as RecordedReads);
  }

  async readPorch(jpeg: Uint8Array): Promise<PorchReading> {
    const sha = createHash("sha256").update(jpeg).digest("hex");
    const r = this.#reads[sha];
    if (!r || r.replies.length === 0) throw new Error(`no recorded reading for frame ${sha.slice(0, 12)}`);
    const n = this.#calls.get(sha) ?? 0;
    this.#calls.set(sha, n + 1);
    return r.replies[n % r.replies.length];
  }
}
