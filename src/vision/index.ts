import { BedrockVision } from "./bedrock.ts";
import { OpenRouterVision } from "./openrouter.ts";
import type { VisionProvider } from "./types.ts";

export type { PorchReading, VisionProvider } from "./types.ts";

/** VISION_PROVIDER=bedrock or openrouter is required (no guessing which credentials work). Keys are read from env only. */
export function visionFromEnv(env: NodeJS.ProcessEnv = process.env): VisionProvider {
  const want = env.VISION_PROVIDER;
  if (want === "bedrock") {
    if (!env.AWS_BEARER_TOKEN_BEDROCK) throw new Error("VISION_PROVIDER=bedrock needs AWS_BEARER_TOKEN_BEDROCK");
    return new BedrockVision(env.AWS_BEARER_TOKEN_BEDROCK, env.BEDROCK_MODEL_ID, env.AWS_REGION ?? "us-east-1");
  }
  if (want === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new Error("VISION_PROVIDER=openrouter needs OPENROUTER_API_KEY");
    return new OpenRouterVision(env.OPENROUTER_API_KEY, env.VISION_MODEL);
  }
  throw new Error(`VISION_PROVIDER must be bedrock or openrouter, got ${want ?? "unset"}`);
}
