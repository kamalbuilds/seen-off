import { PORCH_PROMPT, parseReading } from "./prompt.ts";
import type { PorchReading, VisionProvider } from "./types.ts";

export type MantleContent = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** Bedrock "mantle" OpenAI-compatible endpoint with a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK). Qwen3-VL reads the frame as a data URL. */
export class BedrockMantleVision implements VisionProvider {
  readonly name = "bedrock-mantle";
  readonly model: string;
  readonly #bearer: string;
  readonly #base: string;

  constructor(bearer: string, model = "qwen.qwen3-vl-235b-a22b-instruct", region = "us-east-1") {
    this.#bearer = bearer;
    this.model = model;
    this.#base = `https://bedrock-mantle.${region}.api.aws/v1`;
  }

  async readPorch(jpeg: Uint8Array): Promise<PorchReading> {
    return parseReading(await this.chat([
      { type: "text", text: PORCH_PROMPT },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` } },
    ], 60));
  }

  /** One chat completion on the same endpoint and model; shared by the porch read and the claim writer. */
  async chat(content: MantleContent[], maxTokens: number, temperature = 0): Promise<string> {
    const res = await fetch(`${this.#base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, temperature, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`bedrock-mantle ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error("bedrock-mantle returned no content");
    return text;
  }
}
