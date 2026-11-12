import { CURATION_PLAN_MODE } from "../curation-plan.mjs";
import { fault } from "../errors.mjs";
import { getCall } from "./call-registry.mjs";
import { understandImage } from "./minimax-vision-client.mjs";
import { loadProductPrompt } from "./prompt-loader.mjs";
import { createTextCompletion } from "./zhipu-client.mjs";

export async function executeCall(config, payload, { signal } = {}) {
  const call = getCall(payload?.callId);
  if (call.kind === "vision") return understandImage(config, { ...payload, signal });

  const context = payload.runtimeContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) throw fault("INVALID_REQUEST");
  const planned = call.promptId === "P-003" && context.composition_mode === CURATION_PLAN_MODE;
  const prompt = await loadProductPrompt(planned ? "P-003-PLANNED" : call.promptId);
  const messages = [{ role: "system", content: prompt.system }];
  if (prompt.capability) messages.push({ role: "system", content: prompt.capability });
  messages.push({ role: "user", content: JSON.stringify(context) });

  return createTextCompletion(config, {
    messages,
    responseFormat: "json_object",
    temperature: call.kind === "evaluation" ? 0.1 : 0.2,
    signal,
  });
}
