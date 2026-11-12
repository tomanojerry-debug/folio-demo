const DEFAULTS = Object.freeze({
  zhipuBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  textModel: "glm-5.3-flash",
  minimaxHost: "https://api.minimax.cn/v1",
  visionModel: "MiniMax-M3",
});

export const configDefaults = DEFAULTS;

function string(env, name, fallback = "") {
  return env[name]?.trim() || fallback;
}

function number(env, name, fallback, min, max) {
  const value = Number(string(env, name, String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function credential(env, name) {
  const value = string(env, name);
  return /^(replace-|__FILL_ME__)/i.test(value) ? "" : value;
}

function endpoint(env, name, fallback) {
  return string(env, name, fallback).replace(/\/+$/, "");
}

export function visionCredential(env = process.env) {
  return credential(env, "MINIMAX_API_KEY") || credential(env, "MINIMAX_TOKEN_PLAN_API_KEY");
}

export function loadConfig(env = process.env) {
  const reasoningEffort = string(env, "ZHIPU_REASONING_EFFORT", "low");
  if (!["low", "high", "max"].includes(reasoningEffort)) {
    throw new RangeError("ZHIPU_REASONING_EFFORT must be low, high or max");
  }
  const embeddingBackend = string(env, "KNOWLEDGE_EMBEDDING_BACKEND", env.NODE_ENV === "test" ? "disabled" : "local");
  if (!["disabled", "local", "remote"].includes(embeddingBackend)) {
    throw new RangeError("KNOWLEDGE_EMBEDDING_BACKEND must be disabled, local or remote");
  }
  return Object.freeze({
    zhipuApiKey: credential(env, "ZHIPU_CODING_API_KEY"),
    zhipuBaseUrl: endpoint(env, "ZHIPU_CODING_BASE_URL", DEFAULTS.zhipuBaseUrl),
    textModel: string(env, "ZHIPU_TEXT_MODEL", DEFAULTS.textModel),
    reasoningEffort,
    textMaxTokens: number(env, "AI_TEXT_MAX_TOKENS", 4096, 512, 32_768),
    timeoutMs: number(env, "AI_REQUEST_TIMEOUT_MS", 60_000, 1000, 300_000),
    minimaxApiKey: visionCredential(env),
    minimaxHost: endpoint(env, "MINIMAX_API_HOST", DEFAULTS.minimaxHost),
    visionModel: string(env, "MINIMAX_VISION_MODEL", DEFAULTS.visionModel),
    webSearchApiKey: credential(env, "ZHIPU_WEB_SEARCH_API_KEY"),
    webSearchMcpUrl: endpoint(env, "ZHIPU_WEB_SEARCH_MCP_URL"),
    embeddingApiKey: credential(env, "ZHIPU_EMBEDDING_API_KEY"),
    embeddingBaseUrl: endpoint(env, "ZHIPU_EMBEDDING_BASE_URL", DEFAULTS.zhipuBaseUrl),
    embeddingModel: string(env, "ZHIPU_EMBEDDING_MODEL", "embedding-3"),
    embeddingDimensions: number(env, "ZHIPU_EMBEDDING_DIMENSIONS", 1024, 256, 2048),
    embeddingTimeoutMs: number(env, "KNOWLEDGE_EMBEDDING_TIMEOUT_MS", 15_000, 1000, 120_000),
    embeddingLocalCacheDirectory: string(env, "KNOWLEDGE_LOCAL_CACHE_DIR", ".data/knowledge-models"),
    embeddingBackend,
  });
}
