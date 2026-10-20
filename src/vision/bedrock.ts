import { PORCH_PROMPT, parseReading } from "./prompt.ts";
import type { PorchReading, VisionProvider } from "./types.ts";

/** Bedrock Converse with a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK). Nova Lite is the model the CV Guidelines name as the Stage 3 default. */
export class BedrockVision implements VisionProvider {
  readonly name = "bedrock";
  readonly model: string;
  readonly #bearer: string;
  readonly #region: string;

  constructor(bearer: string, model = "amazon.nova-lite-v1:0", region = "us-east-1") {
    this.#bearer = bearer;
    this.model = model;
    this.#region = region;
  }

  async readPorch(jpeg: Uint8Array): Promise<PorchReading> {
    const url = `https://bedrock-runtime.${this.#region}.amazonaws.com/model/${encodeURIComponent(this.model)}/converse`;
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: [
            { image: { format: "jpeg", source: { bytes: Buffer.from(jpeg).toString("base64") } } },
            { text: PORCH_PROMPT },
          ],
        }],
        inferenceConfig: { maxTokens: 60, temperature: 0 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`bedrock ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { output?: { message?: { content?: { text?: string }[] } } };
    const text = body.output?.message?.content?.map((c) => c.text ?? "").join("");
    if (!text) throw new Error("bedrock returned no text");
    return parseReading(text);
  }
}
