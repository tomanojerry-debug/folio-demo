import { parentPort, workerData } from "node:worker_threads";
import { mkdir, chmod } from "node:fs/promises";
import { setImmediate as yieldToMessages } from "node:timers/promises";

const MAX_TOKENS = 512;
const BATCH_SIZE = 4;
const DIMENSIONS = 384;
const fault = code => Object.assign(new Error("Local embedding operation failed."), { code });

function unit(vector) {
  if (!Array.isArray(vector) || vector.length !== DIMENSIONS || vector.some(value => !Number.isFinite(value))) throw fault("EMBEDDING_OUTPUT_INVALID");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw fault("EMBEDDING_OUTPUT_INVALID");
  return vector.map(value => value / norm);
}

function tokenCount(tokenizer, text) {
  const ids = tokenizer(text, { padding: false, truncation: false, return_tensor: false }).input_ids;
  if (!Array.isArray(ids) && !ArrayBuffer.isView(ids)) throw fault("EMBEDDING_LOCAL_ERROR");
  return Array.isArray(ids[0]) ? ids[0].length : ids.length;
}

/** Preserve every character; each returned segment fits the model token cap. */
export function localTextSegments(text, tokenizer, maximum = MAX_TOKENS, prefix = "") {
  const pieces = [];
  function split(characters) {
    const value = characters.join("");
    if (tokenCount(tokenizer, prefix + value) <= maximum) { pieces.push(value); return; }
    if (characters.length <= 1) throw fault("EMBEDDING_INPUT_INVALID");
    const middle = Math.floor(characters.length / 2);
    split(characters.slice(0, middle)); split(characters.slice(middle));
  }
  const characters = Array.from(text);
  for (let start = 0; start < characters.length; start += 512) split(characters.slice(start, start + 512));
  // Adjacent fragments can be packed without changing their original text.
  const packed = [];
  for (const piece of pieces) {
    const previous = packed.at(-1);
    if (previous !== undefined && tokenCount(tokenizer, prefix + previous + piece) <= maximum) packed[packed.length - 1] += piece;
    else packed.push(piece);
  }
  return packed;
}

async function defaultPipeline(options, progress) {
  await mkdir(options.cacheDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.cacheDirectory, 0o700);
  // The public model needs no token. Keep unrelated HF credentials out of
  // model downloads, and prevent any POST or inference request from this worker.
  delete process.env.HF_TOKEN; delete process.env.HF_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(init.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method) || url.protocol !== "https:" || !["huggingface.co", "hf.co"].includes(url.hostname) || !url.pathname.startsWith(`/${options.model}/resolve/${options.revision}/`) || init.body) throw fault("EMBEDDING_LOCAL_ERROR");
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    return originalFetch(input, { ...init, headers });
  };
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = options.cacheDirectory;
  env.allowLocalModels = Boolean(options.localFilesOnly);
  env.localModelPath = `${options.cacheDirectory}/`;
  env.allowRemoteModels = !options.localFilesOnly;
  env.useBrowserCache = false;
  env.useFSCache = true;
  const extractor = await pipeline("feature-extraction", options.model, {
    revision: options.revision, dtype: "q8", device: "cpu",
    cache_dir: options.cacheDirectory, local_files_only: Boolean(options.localFilesOnly),
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    progress_callback: progress,
  });
  // Once assets are loaded, all tokenization and inference are strictly local.
  env.allowRemoteModels = false;
  globalThis.fetch = () => Promise.reject(fault("EMBEDDING_LOCAL_ERROR"));
  return extractor;
}

/** Exported only to allow deterministic fake-pipeline tests without downloads. */
export function createLocalInference(options, { pipelineFactory = defaultPipeline, onProgress = () => {} } = {}) {
  let loading, extractor;
  async function load() {
    if (!loading) {
      onProgress({ status: "loading" });
      loading = Promise.resolve().then(() => pipelineFactory(options, progress => {
        // Tokenizer and model assets download concurrently. Show the large ONNX
        // file's percentage, instead of oscillating between unrelated file bars.
        if (progress?.status === "progress") onProgress({ status: "downloading", ...(Number.isFinite(progress.progress) && /\.onnx$/u.test(progress.file || "") ? { progress: progress.progress } : {}) });
      })).then(value => {
        extractor = value;
        if (typeof extractor !== "function" || typeof extractor.tokenizer !== "function") throw fault("EMBEDDING_LOCAL_ERROR");
        const cap = Math.min(MAX_TOKENS, options.maxTokens || 128);
        extractor.tokenizer.model_max_length = Math.min(cap, Number(extractor.tokenizer.model_max_length) || cap);
        onProgress({ status: "ready", progress: 100 });
        return extractor;
      }).catch(error => { loading = null; onProgress({ status: "error" }); throw error; });
    }
    return loading;
  }
  return {
    async embed(texts, { isCancelled = () => false, role = "passage" } = {}) {
      if (!["query", "passage"].includes(role)) throw fault("EMBEDDING_INPUT_INVALID");
      if (isCancelled()) throw fault("EMBEDDING_ABORTED");
      const pipe = await load();
      if (isCancelled()) throw fault("EMBEDDING_ABORTED");
      // E5 is retrieval-trained: queries and indexed passages have distinct
      // prefixes, even in non-English languages. Count the prefix in the token
      // budget and apply it to every long-text segment, not just the first one.
      const prefix = options.prefixStrategy === "e5_query_passage" ? `${role}: ` : "";
      const segments = texts.flatMap((text, index) => localTextSegments(text, pipe.tokenizer, pipe.tokenizer.model_max_length, prefix).map(value => ({ text: prefix + value, index, weight: Array.from(value).length })));
      if (segments.length > 4096) throw fault("EMBEDDING_INPUT_INVALID");
      const sums = texts.map(() => Array(DIMENSIONS).fill(0));
      for (let start = 0; start < segments.length; start += BATCH_SIZE) {
        await yieldToMessages();
        if (isCancelled()) throw fault("EMBEDDING_ABORTED");
        const batch = segments.slice(start, start + BATCH_SIZE);
        const output = await pipe(batch.map(segment => segment.text), { pooling: "mean", normalize: true });
        const vectors = output?.tolist?.();
        if (!Array.isArray(vectors) || vectors.length !== batch.length) throw fault("EMBEDDING_OUTPUT_INVALID");
        batch.forEach((segment, row) => {
          const vector = unit(vectors[row]);
          for (let column = 0; column < DIMENSIONS; column++) sums[segment.index][column] += vector[column] * segment.weight;
        });
      }
      if (isCancelled()) throw fault("EMBEDDING_ABORTED");
      return sums.map(unit);
    },
    async close() { await extractor?.dispose?.(); },
  };
}

if (parentPort) {
  const cancelled = new Set(), requests = new Set();
  const runtime = createLocalInference(workerData, { onProgress: progress => parentPort.postMessage({ type: "status", ...progress }) });
  let tail = Promise.resolve();
  parentPort.on("message", request => {
    if (request.type === "cancel") { if (requests.has(request.id)) cancelled.add(request.id); return; }
    if (request.type !== "embed") return;
    requests.add(request.id);
    tail = tail.then(async () => {
      try {
        if (cancelled.has(request.id)) return;
        const vectors = await runtime.embed(request.texts, { isCancelled: () => cancelled.has(request.id), role: request.role || "passage" });
        if (!cancelled.has(request.id)) parentPort.postMessage({ id: request.id, vectors });
      } catch (error) {
        if (!cancelled.has(request.id)) parentPort.postMessage({ id: request.id, error: { code: ["EMBEDDING_INPUT_INVALID", "EMBEDDING_OUTPUT_INVALID", "EMBEDDING_ABORTED"].includes(error.code) ? error.code : "EMBEDDING_LOCAL_ERROR" } });
      } finally { cancelled.delete(request.id); requests.delete(request.id); }
    });
  });
}
