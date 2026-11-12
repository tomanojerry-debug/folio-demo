import { Worker } from "node:worker_threads";
import path from "node:path";

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const DEFAULT_LOCAL_EMBEDDING_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

const messages = {
  EMBEDDING_LOCAL_ERROR: "Local embedding model could not be loaded or run.",
  EMBEDDING_OUTPUT_INVALID: "Local embedding model returned invalid vectors.",
  EMBEDDING_INPUT_INVALID: "Local embedding input is invalid or exceeds the request limit.",
  EMBEDDING_ABORTED: "Local embedding request was cancelled.",
  EMBEDDING_TIMEOUT: "Local embedding request timed out.",
  KNOWLEDGE_CLOSED: "Local embedding model is closed.",
};
const fault = code => Object.assign(new Error(messages[code] || messages.EMBEDDING_LOCAL_ERROR), { code: messages[code] ? code : "EMBEDDING_LOCAL_ERROR" });

/** CPU-only, lazy local inference. Only public model assets are downloaded. */
export function createLocalKnowledgeEmbedder({ directory, model = DEFAULT_LOCAL_EMBEDDING_MODEL, revision, cacheDirectory, onProgress, timeoutMs = 300000, localFilesOnly = false, workerFactory } = {}) {
  if (typeof directory !== "string" || !directory) throw new TypeError("A local model directory is required.");
  if (typeof model !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(model) || model.includes("..")) throw new TypeError("A public Hugging Face model name is required.");
  const e5 = model === "Xenova/multilingual-e5-small";
  revision ||= model === DEFAULT_LOCAL_EMBEDDING_MODEL ? DEFAULT_LOCAL_EMBEDDING_REVISION : e5 ? "761b726dd34fb83930e26aab4e9ac3899aa1fa78" : "main";
  if (typeof revision !== "string" || !/^[\w.-]{1,64}$/u.test(revision) || revision.includes("..")) throw new TypeError("A model revision is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new TypeError("Local embedding timeout must be between 1 and 600000 milliseconds.");
  const options = { model, revision, cacheDirectory: path.resolve(cacheDirectory || path.join(directory, "models")), dimensions: LOCAL_EMBEDDING_DIMENSIONS, localFilesOnly: Boolean(localFilesOnly), maxTokens: e5 ? 512 : 128, prefixStrategy: e5 ? "e5_query_passage" : "none" };
  const space = Object.freeze({ model: `local:${model}@${revision}:q8:${e5 ? "e5-query-passage-v1" : "mean-v1"}`, dimensions: LOCAL_EMBEDDING_DIMENSIONS });
  if (space.model.length > 200) throw new TypeError("The local model identity exceeds the supported length.");
  let worker = null, sequence = 0, closed = false, closing;
  let state = { provider: "local", status: "not_loaded", model, revision, dimensions: LOCAL_EMBEDDING_DIMENSIONS };
  const pending = new Map();

  function publish(update) {
    const next = { ...state, ...update };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    try { onProgress?.(structuredClone(state)); } catch {}
  }

  function rejectAll(error) {
    for (const request of pending.values()) { request.cleanup(); request.reject(error); }
    pending.clear();
  }

  function getWorker() {
    if (closed) throw fault("KNOWLEDGE_CLOSED");
    if (worker) return worker;
    let active;
    try { active = workerFactory ? workerFactory(options) : new Worker(new URL("./local-embedding-worker.mjs", import.meta.url), { workerData: options, execArgv: [] }); }
    catch { publish({ status: "error" }); throw fault("EMBEDDING_LOCAL_ERROR"); }
    worker = active;
    publish({ status: "loading", progress: 0 });
    active.on("message", response => {
      if (active !== worker || closed) return;
      if (response.type === "status") {
        const status = ["loading", "downloading", "ready", "error"].includes(response.status) ? response.status : state.status;
        publish({ status, ...(Number.isFinite(response.progress) ? { progress: Math.max(0, Math.min(100, Math.round(response.progress))) } : status === "loading" ? { progress: 0 } : {}) });
        return;
      }
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id); request.cleanup();
      if (response.error) { request.reject(fault(response.error.code)); return; }
      const vectors = response.vectors;
      if (!Array.isArray(vectors) || vectors.length !== request.count || vectors.some(vector => !Array.isArray(vector) || vector.length !== LOCAL_EMBEDDING_DIMENSIONS || vector.some(value => !Number.isFinite(value)) || !Number.isFinite(Math.hypot(...vector)) || Math.hypot(...vector) === 0)) {
        request.reject(fault("EMBEDDING_OUTPUT_INVALID")); return;
      }
      request.resolve(vectors);
    });
    active.on("error", () => {
      if (active !== worker || closed) return;
      worker = null;
      publish({ status: "error" });
      rejectAll(fault("EMBEDDING_LOCAL_ERROR"));
      void active.terminate().catch(() => {});
    });
    active.on("exit", () => {
      if (active !== worker || closed) return;
      worker = null;
      publish({ status: "error" });
      rejectAll(fault("EMBEDDING_LOCAL_ERROR"));
    });
    return active;
  }

  return Object.freeze({
    space,
    status() { return structuredClone(state); },
    async embed(texts, { signal, role = "passage" } = {}) {
      if (closed) throw fault("KNOWLEDGE_CLOSED");
      if (!Array.isArray(texts) || texts.length > 64 || texts.some(text => typeof text !== "string" || !text.trim()) || texts.reduce((sum, text) => sum + text.length, 0) > 200000) throw fault("EMBEDDING_INPUT_INVALID");
      if (!["query", "passage"].includes(role)) throw fault("EMBEDDING_INPUT_INVALID");
      if (signal?.aborted) throw fault("EMBEDDING_ABORTED");
      if (!texts.length) return [];
      const active = getWorker(), id = ++sequence;
      return new Promise((resolve, reject) => {
        let timer;
        const cancel = code => {
          if (!pending.has(id)) return;
          const request = pending.get(id);
          pending.delete(id); request.cleanup();
          try { active.postMessage({ type: "cancel", id }); } catch {}
          reject(fault(code));
        };
        const onAbort = () => cancel("EMBEDDING_ABORTED");
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
        pending.set(id, { resolve, reject, cleanup, count: texts.length });
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => cancel("EMBEDDING_TIMEOUT"), timeoutMs);
        try { active.postMessage({ type: "embed", id, texts, role }); }
        catch { pending.delete(id); cleanup(); reject(fault("EMBEDDING_LOCAL_ERROR")); }
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      publish({ status: "closed" });
      rejectAll(fault("KNOWLEDGE_CLOSED"));
      const active = worker;
      worker = null;
      closing = active ? Promise.resolve(active.terminate()).then(() => {}) : Promise.resolve();
      return closing;
    },
  });
}
