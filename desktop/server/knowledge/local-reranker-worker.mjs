import { parentPort, workerData } from "node:worker_threads";
import { mkdir, chmod } from "node:fs/promises";
import { setImmediate as yieldToMessages } from "node:timers/promises";

const fault = code => Object.assign(new Error("Local relevance operation failed."), { code });
// Dynamic int8 quantization can share an activation range across a batch, and
// padding changes that batch's shape. Score each query/passage window alone so
// adding or reordering unrelated candidates cannot change another item's gate.
const MAX_PAIR_TOKENS = 512, MAX_QUERY_TOKENS = 128, BATCH_SIZE = 1;
function count(tokenizer, query, passage) {
  const ids = tokenizer(query, { ...(passage !== undefined ? { text_pair: passage } : {}), truncation: false, padding: false, return_tensor: false }).input_ids;
  if (!Array.isArray(ids) && !ArrayBuffer.isView(ids)) throw fault("RERANKER_LOCAL_ERROR");
  return Array.isArray(ids[0]) ? ids[0].length : ids.length;
}

export function rerankerWindows(query, text, tokenizer) {
  const characters = Array.from(query);
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (count(tokenizer, characters.slice(0, middle).join("")) <= MAX_QUERY_TOKENS) low = middle;
    else high = middle - 1;
  }
  // Query excerpts are explicitly flagged in results. Passage text is never
  // silently truncated: all windows are scored and the best logit is retained.
  const boundedQuery = characters.slice(0, low).join("");
  const pieces = [];
  function split(values) {
    const value = values.join("");
    if (count(tokenizer, boundedQuery, value) <= MAX_PAIR_TOKENS) { pieces.push(value); return; }
    if (values.length <= 1) throw fault("RERANKER_INPUT_INVALID");
    const middle = Math.floor(values.length / 2);
    split(values.slice(0, middle)); split(values.slice(middle));
  }
  const values = Array.from(text);
  for (let start = 0; start < values.length; start += 512) split(values.slice(start, start + 512));
  const packed = [];
  for (const piece of pieces) {
    const previous = packed.at(-1);
    if (previous !== undefined && count(tokenizer, boundedQuery, previous + piece) <= MAX_PAIR_TOKENS) packed[packed.length - 1] += piece;
    else packed.push(piece);
  }
  return { query: boundedQuery, queryExcerpt: low < characters.length, windows: packed };
}

async function defaultLoader(options, progress) {
  await mkdir(options.cacheDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.cacheDirectory, 0o700);
  delete process.env.HF_TOKEN; delete process.env.HF_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(init.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method) || url.protocol !== "https:" || !["huggingface.co", "hf.co"].includes(url.hostname) || !url.pathname.startsWith(`/${options.model}/resolve/${options.revision}/`) || init.body) throw fault("RERANKER_LOCAL_ERROR");
    const headers = new Headers(init.headers); headers.delete("Authorization");
    return originalFetch(input, { ...init, headers });
  };
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
  env.cacheDir = options.cacheDirectory; env.localModelPath = `${options.cacheDirectory}/`;
  env.allowLocalModels = Boolean(options.localFilesOnly); env.allowRemoteModels = !options.localFilesOnly;
  env.useBrowserCache = false; env.useFSCache = true;
  const common = { revision: options.revision, cache_dir: options.cacheDirectory, local_files_only: Boolean(options.localFilesOnly), progress_callback: progress };
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(options.model, common),
    // The named official file is already int8. fp32 here selects an empty
    // filename suffix; it does not request the large unquantized model.onnx.
    AutoModelForSequenceClassification.from_pretrained(options.model, { ...common, device: "cpu", dtype: "fp32", model_file_name: options.modelFile, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } }),
  ]);
  tokenizer.model_max_length = MAX_PAIR_TOKENS;
  env.allowRemoteModels = false;
  globalThis.fetch = () => Promise.reject(fault("RERANKER_LOCAL_ERROR"));
  return { tokenizer, model };
}

export function createRerankerInference(options, { loader = defaultLoader, onProgress = () => {} } = {}) {
  let loading, instance;
  async function load() {
    if (!loading) {
      onProgress({ status: "loading" });
      loading = Promise.resolve().then(() => loader(options, progress => {
        if (progress?.status === "progress") onProgress({ status: "downloading", ...(Number.isFinite(progress.progress) && /\.onnx$/u.test(progress.file || "") ? { progress: progress.progress } : {}) });
      })).then(value => {
        if (typeof value?.tokenizer !== "function" || typeof value?.model !== "function") throw fault("RERANKER_LOCAL_ERROR");
        instance = value; onProgress({ status: "ready", progress: 100 }); return value;
      }).catch(error => { loading = null; onProgress({ status: "error" }); throw error; });
    }
    return loading;
  }
  return {
    async rerank(query, items, { isCancelled = () => false } = {}) {
      if (isCancelled()) throw fault("RERANKER_ABORTED");
      const { tokenizer, model } = await load();
      if (isCancelled()) throw fault("RERANKER_ABORTED");
      const windows = items.flatMap(item => {
        const parts = rerankerWindows(query, item.text, tokenizer);
        return parts.windows.map(text => ({ id: item.id, text, query: parts.query, queryExcerpt: parts.queryExcerpt }));
      });
      if (windows.length > 256) throw fault("RERANKER_INPUT_INVALID");
      const best = new Map();
      for (let start = 0; start < windows.length; start += BATCH_SIZE) {
        await yieldToMessages();
        if (isCancelled()) throw fault("RERANKER_ABORTED");
        const batch = windows.slice(start, start + BATCH_SIZE);
        const inputs = tokenizer(batch.map(item => item.query), { text_pair: batch.map(item => item.text), padding: false, truncation: true, max_length: MAX_PAIR_TOKENS });
        const result = await model(inputs), logits = result?.logits?.tolist?.();
        if (!Array.isArray(logits) || logits.length !== batch.length || logits.some(row => !Array.isArray(row) || row.length !== 1 || !Number.isFinite(row[0]))) throw fault("RERANKER_OUTPUT_INVALID");
        batch.forEach((item, index) => {
          const logit = logits[index][0], previous = best.get(item.id);
          if (!previous || logit > previous.logit) best.set(item.id, { id: item.id, score: 1 / (1 + Math.exp(-logit)), logit, scoreKind: "sigmoid_relevance_logit", queryExcerpt: item.queryExcerpt });
        });
      }
      if (isCancelled()) throw fault("RERANKER_ABORTED");
      return items.map(item => best.get(item.id)).sort((a, b) => b.logit - a.logit);
    },
    async close() { await instance?.model?.dispose?.(); },
  };
}

if (parentPort) {
  const cancelled = new Set(), requests = new Set();
  const runtime = createRerankerInference(workerData, { onProgress: progress => parentPort.postMessage({ type: "status", ...progress }) });
  let tail = Promise.resolve();
  parentPort.on("message", request => {
    if (request.type === "cancel") { if (requests.has(request.id)) cancelled.add(request.id); return; }
    if (request.type !== "rerank") return;
    requests.add(request.id);
    tail = tail.then(async () => {
      try {
        if (cancelled.has(request.id)) return;
        const rows = await runtime.rerank(request.query, request.items, { isCancelled: () => cancelled.has(request.id) });
        if (!cancelled.has(request.id)) parentPort.postMessage({ id: request.id, rows });
      } catch (error) {
        if (!cancelled.has(request.id)) parentPort.postMessage({ id: request.id, error: { code: ["RERANKER_INPUT_INVALID", "RERANKER_OUTPUT_INVALID", "RERANKER_ABORTED"].includes(error.code) ? error.code : "RERANKER_LOCAL_ERROR" } });
      } finally { cancelled.delete(request.id); requests.delete(request.id); }
    });
  });
}
