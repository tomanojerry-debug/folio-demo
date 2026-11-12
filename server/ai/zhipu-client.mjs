import { fault } from "../errors.mjs";
import { postModelJson } from "./provider-request.mjs";

export async function createTextCompletion(config, { messages, temperature, responseFormat, signal }) {
  if (!config.zhipuApiKey) throw fault("MODEL_NOT_CONFIGURED", 503);
  const flash = config.textModel.toLowerCase() === "glm-5.3-flash";
  const request = {
    model: config.textModel,
    messages,
    temperature,
    max_tokens: config.textMaxTokens,
  };
  if (config.textProvider !== "openai-compatible") {
    request.thinking = flash ? { type: "enabled", clear_thinking: true } : { type: "disabled" };
    if (flash) request.reasoning_effort = config.reasoningEffort;
  }
  if (responseFormat) request.response_format = { type: responseFormat };
  const data = await postModelJson(`${config.zhipuBaseUrl}/chat/completions`, config.zhipuApiKey, request, { timeoutMs: config.timeoutMs, signal });
  if (!Array.isArray(data?.choices)) throw fault("MODEL_OUTPUT_INVALID", 502);
  return data;
}
