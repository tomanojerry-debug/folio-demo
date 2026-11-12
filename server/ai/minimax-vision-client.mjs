import { fault } from "../errors.mjs";
import { postModelJson } from "./provider-request.mjs";

export async function understandImage(config, { prompt, imageSource, signal }) {
  if (!config.minimaxApiKey) throw fault("VISION_NOT_CONFIGURED", 503);
  if (typeof prompt !== "string" || !prompt.trim() || typeof imageSource !== "string"
    || imageSource.length > 2_500_000 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageSource)) {
    throw fault("INVALID_REQUEST");
  }
  const host = config.minimaxHost.endsWith("/v1") ? config.minimaxHost : `${config.minimaxHost}/v1`;
  const body = {
    model: config.visionModel,
    messages: [{
      role: "user",
      content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageSource } }],
    }],
    max_completion_tokens: 2048,
    reasoning_split: true,
  };
  const data = await postModelJson(`${host}/chat/completions`, config.minimaxApiKey, body, { timeoutMs: config.timeoutMs, signal });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw fault("MODEL_OUTPUT_INVALID", 502);
  return { content, model: data.model || config.visionModel, usage: data.usage || null };
}
