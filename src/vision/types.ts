/** What a vision stage says about one porch frame. */
export interface PorchReading {
  present: boolean;
  count: number;
  raw: string;
}

/** Provider boundary: Bedrock Nova Lite is the target, OpenRouter serves the same model while AWS credentials are unusable. */
export interface VisionProvider {
  readonly name: string;
  readonly model: string;
  readPorch(jpeg: Uint8Array): Promise<PorchReading>;
}
