import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../server/ai/config.mjs";
import { createTextCompletion } from "../../server/ai/zhipu-client.mjs";

const fileName = "model-provider.json";
const problem = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

function validate({ baseURL, model, apiKey }) {
  if (typeof baseURL !== "string" || baseURL.length > 2048) throw problem("请输入模型 API 地址。", "INVALID_MODEL_URL");
  let url;
  try { url = new URL(baseURL.trim()); }
  catch { throw problem("请输入完整的模型 API 地址，例如 https://api.openai.com/v1。", "INVALID_MODEL_URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw problem("请使用 HTTPS 地址。本机模型可用 localhost 的 HTTP 地址。", "INVALID_MODEL_URL");
  }
  if (typeof model !== "string" || !model.trim() || model.length > 160 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw problem("请输入供应商提供的模型名称。", "INVALID_MODEL_NAME");
  }
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 2048 || !/^[\x21-\x7e]+$/.test(apiKey.trim())) {
    throw problem("请输入有效的 API Key。", "INVALID_MODEL_KEY");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return { baseURL: url.href.replace(/\/+$/, ""), model: model.trim(), apiKey: apiKey.trim() };
}

export async function loadModelProfile(directory) {
  let raw;
  try { raw = await readFile(path.join(directory, fileName), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return validate(JSON.parse(raw));
}

export async function saveModelProfile(directory, profile) {
  const temp = path.join(directory, `.${fileName}.${randomUUID()}`);
  const file = await open(temp, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(profile), "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path.join(directory, fileName));
  } finally { await unlink(temp).catch(() => {}); }
}

export function modelConfig(profile) {
  const config = loadConfig({ ...process.env, KNOWLEDGE_EMBEDDING_BACKEND: "disabled" });
  return {
    ...config,
    zhipuApiKey: profile.apiKey,
    zhipuBaseUrl: profile.baseURL,
    textModel: profile.model,
    textProvider: new URL(profile.baseURL).hostname === "open.bigmodel.cn" ? "zhipu" : "openai-compatible",
  };
}

export async function checkModelProfile(input, complete = createTextCompletion) {
  const profile = validate(input);
  const config = { ...modelConfig(profile), timeoutMs: 15_000, textMaxTokens: 64 };
  let result;
  try {
    result = await complete(config, {
      messages: [{ role: "user", content: "Reply with OK." }],
      temperature: 0,
    });
  } catch (error) {
    if (error.code === "MODEL_RATE_LIMITED") throw problem("模型服务暂时限流，请稍后重试。", error.code, 429);
    throw problem("连接模型失败，请核对 API 地址、模型名称和 Key。", "MODEL_CONNECTION_FAILED", 502);
  }
  if (!result?.choices?.length) throw problem("服务没有返回对话结果，请检查模型是否支持 Chat Completions。", "MODEL_CONNECTION_FAILED", 502);
  return profile;
}
