import { BedrockVision } from "./bedrock.ts";
import { BedrockMantleVision } from "./bedrock-mantle.ts";
import { OpenRouterVision } from "./openrouter.ts";
import { RecordedVision } from "./recorded.ts";
import type { VisionProvider } from "./types.ts";

export type { PorchReading, VisionProvider } from "./types.ts";

/**
 * VISION_PROVIDER picks the stage; unset or empty defaults to bedrock-mantle when AWS_BEARER_TOKEN_BEDROCK is set,
 * then to the recorded Qwen3-VL readings when a recording file is given. Keys are read from env only.
 */
export function visionFromEnv(env: NodeJS.ProcessEnv = process.env, recordedFile?: string): VisionProvider {
  const want = env.VISION_PROVIDER || (env.AWS_BEARER_TOKEN_BEDROCK ? "bedrock-mantle" : recordedFile ? "recorded" : undefined);
  if (want === "recorded") {
    if (!recordedFile) throw new Error("VISION_PROVIDER=recorded needs a recorded readings file");
    return RecordedVision.fromFile(recordedFile);
  }
  if (want === "bedrock-mantle") {
    if (!env.AWS_BEARER_TOKEN_BEDROCK) throw new Error("VISION_PROVIDER=bedrock-mantle needs AWS_BEARER_TOKEN_BEDROCK");
    return new BedrockMantleVision(env.AWS_BEARER_TOKEN_BEDROCK, env.BEDROCK_MANTLE_MODEL || undefined, env.AWS_REGION || "us-east-1");
  }
  if (want === "bedrock") {
    if (!env.AWS_BEARER_TOKEN_BEDROCK) throw new Error("VISION_PROVIDER=bedrock needs AWS_BEARER_TOKEN_BEDROCK");
    return new BedrockVision(env.AWS_BEARER_TOKEN_BEDROCK, env.BEDROCK_MODEL_ID || undefined, env.AWS_REGION || "us-east-1");
  }
  if (want === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new Error("VISION_PROVIDER=openrouter needs OPENROUTER_API_KEY");
    return new OpenRouterVision(env.OPENROUTER_API_KEY, env.VISION_MODEL || undefined);
  }
  throw new Error(`VISION_PROVIDER must be bedrock-mantle, bedrock, openrouter or recorded, got ${want ?? "unset"}`);
}
