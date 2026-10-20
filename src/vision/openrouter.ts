import { PORCH_PROMPT, parseReading } from "./prompt.ts";
import type { PorchReading, VisionProvider } from "./types.ts";

export class OpenRouterVision implements VisionProvider {
  readonly name = "openrouter";
  readonly model: string;
  readonly #apiKey: string;
  readonly #base: string;

  constructor(apiKey: string, model = "amazon/nova-lite-v1", base = "https://openrouter.ai/api/v1") {
    this.#apiKey = apiKey;
    this.model = model;
    this.#base = base;
  }

  async readPorch(jpeg: Uint8Array): Promise<PorchReading> {
    const res = await fetch(`${this.#base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: 60,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: PORCH_PROMPT },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error("openrouter returned no content");
    return parseReading(text);
  }
}
