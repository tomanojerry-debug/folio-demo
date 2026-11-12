const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_MODEL = "embedding-3";
const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BATCH_SEGMENTS = 32;
const MAX_INPUTS = 64;
const MAX_TOTAL_CHARACTERS = 200000;
// A UTF-8 byte budget is deliberately more conservative than estimating Chinese
// tokens by characters. Even byte-fallback tokenization stays below 3072 tokens.
const MAX_SEGMENT_BYTES = 2400;
const encoder = new TextEncoder();
const safeCodes = new Set(["EMBEDDING_OUTPUT_INVALID", "EMBEDDING_RATE_LIMITED", "EMBEDDING_PROVIDER_ERROR"]);

function fault(code, statusCode = 502) {
  const messages = {
    EMBEDDING_INPUT_INVALID: "Embedding input is invalid or exceeds the request limit.",
    EMBEDDING_OUTPUT_INVALID: "Embedding service returned invalid vectors.",
    EMBEDDING_RATE_LIMITED: "Embedding service is temporarily busy.",
    EMBEDDING_PROVIDER_ERROR: "Embedding service is unavailable.",
    EMBEDDING_TIMEOUT: "Embedding service timed out.",
    EMBEDDING_ABORTED: "Embedding request was cancelled.",
  };
  return Object.assign(new Error(messages[code]), { code, statusCode });
}

function splitText(text) {
  const segments = [];
  let part = "", bytes = 0, weight = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size > MAX_SEGMENT_BYTES) {
      segments.push({ text: part, weight });
      part = ""; bytes = 0; weight = 0;
    }
    part += character; bytes += size; weight++;
  }
  if (part) segments.push({ text: part, weight });
  return segments;
}

function normalized(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== "number" || !Number.isFinite(value))) throw fault("EMBEDDING_OUTPUT_INVALID");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw fault("EMBEDDING_OUTPUT_INVALID");
  return vector.map(value => value / norm);
}

function readVectors(payload, count, dimensions, model) {
  if (payload?.model !== undefined && payload.model !== model) throw fault("EMBEDDING_OUTPUT_INVALID");
  if (!Array.isArray(payload?.data) || payload.data.length !== count) throw fault("EMBEDDING_OUTPUT_INVALID");
  const vectors = Array(count);
  const indices = new Set();
  for (const entry of payload.data) {
    const index = entry?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count || indices.has(index)) throw fault("EMBEDDING_OUTPUT_INVALID");
    vectors[index] = normalized(entry.embedding, dimensions);
    indices.add(index);
  }
  return vectors;
}

/**
 * Optional, server-only embedding client. Coding Plan credentials and endpoints
 * are intentionally never used as a fallback for the separately billed API.
 */
export function createKnowledgeEmbedder(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  const key = typeof config.embeddingApiKey === "string" ? config.embeddingApiKey.trim() : "";
  if (!key) return null;
  const model = config.embeddingModel?.trim() || DEFAULT_MODEL;
  const dimensions = config.embeddingDimensions ?? DEFAULT_DIMENSIONS;
  const timeoutMs = config.embeddingTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(dimensions) || dimensions < 256 || dimensions > 2048) throw new TypeError("embeddingDimensions must be an integer between 256 and 2048.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError("embeddingTimeoutMs must be an integer between 1 and 300000.");
  let base;
  try { base = new URL(config.embeddingBaseUrl || DEFAULT_BASE_URL); }
  catch { throw new TypeError("embeddingBaseUrl must be an HTTP or HTTPS URL."); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new TypeError("embeddingBaseUrl must be an HTTP or HTTPS URL without credentials, query, or fragment.");
  const endpoint = `${base.href.replace(/\/+$/u, "")}/embeddings`;
  if (typeof fetchImpl !== "function") throw new TypeError("An embedding fetch implementation is required.");

  async function requestBatch(input, signal) {
    if (signal?.aborted) throw fault("EMBEDDING_ABORTED", 499);
    const controller = new AbortController();
    let timer, onAbort;
    const cancellation = new Promise((_, reject) => {
      onAbort = () => { controller.abort(); reject(fault("EMBEDDING_ABORTED", 499)); };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(fault("EMBEDDING_TIMEOUT", 504)); }, timeoutMs);
    });
    const work = (async () => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input, dimensions }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response?.ok) throw fault(response?.status === 429 ? "EMBEDDING_RATE_LIMITED" : "EMBEDDING_PROVIDER_ERROR", response?.status === 429 ? 429 : 502);
      let payload;
      try { payload = await response.json(); }
      catch (error) {
        if (error?.name === "TimeoutError") throw fault("EMBEDDING_TIMEOUT", 504);
        throw fault("EMBEDDING_OUTPUT_INVALID");
      }
      return readVectors(payload, input.length, dimensions, model);
    })();
    try { return await Promise.race([work, cancellation]); }
    catch (error) {
      if (signal?.aborted) throw fault("EMBEDDING_ABORTED", 499);
      if (error?.name === "TimeoutError" || error?.code === "EMBEDDING_TIMEOUT") throw fault("EMBEDDING_TIMEOUT", 504);
      if (safeCodes.has(error?.code)) throw fault(error.code, error.code === "EMBEDDING_RATE_LIMITED" ? 429 : 502);
      throw fault("EMBEDDING_PROVIDER_ERROR");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return Object.freeze({
    space: Object.freeze({ model, dimensions }),
    async embed(texts, { signal } = {}) {
      if (!Array.isArray(texts) || texts.length > MAX_INPUTS || texts.some(value => typeof value !== "string" || !value.trim()) || texts.reduce((sum, value) => sum + value.length, 0) > MAX_TOTAL_CHARACTERS) throw fault("EMBEDDING_INPUT_INVALID", 400);
      if (signal?.aborted) throw fault("EMBEDDING_ABORTED", 499);
      if (!texts.length) return [];
      const segments = texts.flatMap((text, inputIndex) => splitText(text).map(segment => ({ ...segment, inputIndex })));
      const sums = texts.map(() => Array(dimensions).fill(0));
      // Long logical inputs retain every character. Aggregate normalized segment
      // embeddings, weighted by Unicode code points, then normalize once more.
      // A single original input still produces exactly one stored vector.
      for (let start = 0; start < segments.length; start += MAX_BATCH_SEGMENTS) {
        const batch = segments.slice(start, start + MAX_BATCH_SEGMENTS);
        const vectors = await requestBatch(batch.map(segment => segment.text), signal);
        if (signal?.aborted) throw fault("EMBEDDING_ABORTED", 499);
        batch.forEach((segment, index) => {
          const sum = sums[segment.inputIndex];
          for (let column = 0; column < dimensions; column++) sum[column] += vectors[index][column] * segment.weight;
        });
      }
      return sums.map(vector => normalized(vector, dimensions));
    },
  });
}
