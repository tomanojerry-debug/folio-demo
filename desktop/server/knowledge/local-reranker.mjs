import { Worker } from "node:worker_threads";
import path from "node:path";

export const DEFAULT_LOCAL_RERANKER_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1";
export const DEFAULT_LOCAL_RERANKER_REVISION = "1427fd652930e4ba29e8149678df786c240d8825";
const knownErrors = new Set(["RERANKER_LOCAL_ERROR", "RERANKER_INPUT_INVALID", "RERANKER_OUTPUT_INVALID", "RERANKER_ABORTED", "RERANKER_TIMEOUT", "KNOWLEDGE_CLOSED"]);
const fault = code => Object.assign(new Error(code === "RERANKER_ABORTED" ? "Local relevance scoring was cancelled." : code === "RERANKER_TIMEOUT" ? "Local relevance scoring timed out." : code === "KNOWLEDGE_CLOSED" ? "Local relevance scorer is closed." : "Local relevance scoring is unavailable."), { code: knownErrors.has(code) ? code : "RERANKER_LOCAL_ERROR" });

/** Local query-passage relevance scoring, never a factual confidence measure. */
export function createLocalKnowledgeReranker({ directory, cacheDirectory, model = DEFAULT_LOCAL_RERANKER_MODEL, revision = DEFAULT_LOCAL_RERANKER_REVISION, localFilesOnly = false, onProgress, timeoutMs = 300000, workerFactory } = {}) {
  if (typeof directory !== "string" || !directory || !/^[\w.-]+\/[\w.-]+$/u.test(model) || model.includes("..") || !/^[\w.-]{1,64}$/u.test(revision) || revision.includes("..")) throw new TypeError("A local reranker directory and public model revision are required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new TypeError("Local reranking timeout must be between 1 and 600000 milliseconds.");
  // These are the official quantized files, not an implicit full-precision
  // fallback. The selected architecture is part of the scorer identity.
  const modelFile = process.arch === "arm64" ? "model_qint8_arm64" : process.arch === "x64" ? "model_quint8_avx2" : null;
  if (!modelFile) throw new TypeError("Local reranking supports ARM64 and x64 CPUs.");
  const options = { model, revision, modelFile, localFilesOnly: Boolean(localFilesOnly), cacheDirectory: path.resolve(cacheDirectory || path.join(directory, "models")) };
  const identity = `local-rerank:${model}@${revision}:${modelFile}:pair512-v2-independent`;
  let worker = null, sequence = 0, closed = false, closing;
  let state = { provider: "local", status: "not_loaded", model, revision, modelFile, scoreKind: "sigmoid_relevance_logit" };
  const pending = new Map();
  function publish(update) {
    const next = { ...state, ...update };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    try { onProgress?.(structuredClone(state)); } catch {}
  }
  function rejectAll(error) { for (const request of pending.values()) { request.cleanup(); request.reject(error); } pending.clear(); }
  function getWorker() {
    if (worker) return worker;
    let active;
    try { active = workerFactory ? workerFactory(options) : new Worker(new URL("./local-reranker-worker.mjs", import.meta.url), { workerData: options, execArgv: [] }); }
    catch { publish({ status: "error" }); throw fault("RERANKER_LOCAL_ERROR"); }
    worker = active; publish({ status: "loading", progress: 0 });
    active.on("message", response => {
      if (worker !== active || closed) return;
      if (response.type === "status") {
        if (["loading", "downloading", "ready", "error"].includes(response.status)) publish({ status: response.status, ...(Number.isFinite(response.progress) ? { progress: Math.max(0, Math.min(100, Math.round(response.progress))) } : {}) });
        return;
      }
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id); request.cleanup();
      if (response.error) { request.reject(fault(response.error.code)); return; }
      const rows = response.rows, seen = new Set();
      let valid = Array.isArray(rows) && rows.length === request.ids.size;
      if (valid) for (const row of rows) {
        if (!request.ids.has(row?.id) || seen.has(row.id) || !Number.isFinite(row.score) || row.score < 0 || row.score > 1 || !Number.isFinite(row.logit)) { valid = false; break; }
        seen.add(row.id);
      }
      if (!valid) { request.reject(fault("RERANKER_OUTPUT_INVALID")); return; }
      request.resolve(rows.map(row => ({ id: row.id, score: 1 / (1 + Math.exp(-row.logit)), logit: row.logit, scoreKind: "sigmoid_relevance_logit", queryExcerpt: row.queryExcerpt === true })));
    });
    const failed = () => {
      if (worker !== active || closed) return;
      worker = null; publish({ status: "error" }); rejectAll(fault("RERANKER_LOCAL_ERROR"));
      void active.terminate().catch(() => {});
    };
    active.on("error", failed); active.on("exit", failed);
    return active;
  }
  return Object.freeze({
    model: identity,
    status() { return structuredClone(state); },
    async rerank(query, items, { signal } = {}) {
      if (closed) throw fault("KNOWLEDGE_CLOSED");
      if (typeof query !== "string" || !query.trim() || query.length > 8000 || !Array.isArray(items) || items.length > 64 || items.some(item => typeof item?.id !== "string" || !item.id || item.id.length > 300 || typeof item.text !== "string" || !item.text.trim() || item.text.length > 12000) || new Set(items.map(item => item.id)).size !== items.length || items.reduce((sum, item) => sum + item.text.length, 0) > 120000) throw fault("RERANKER_INPUT_INVALID");
      if (signal?.aborted) throw fault("RERANKER_ABORTED");
      if (!items.length) return [];
      const active = getWorker(), id = ++sequence;
      return new Promise((resolve, reject) => {
        let timer;
        const cancel = code => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id); request.cleanup();
          try { active.postMessage({ type: "cancel", id }); } catch {}
          reject(fault(code));
        };
        const onAbort = () => cancel("RERANKER_ABORTED");
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
        pending.set(id, { resolve, reject, cleanup, ids: new Set(items.map(item => item.id)) });
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => cancel("RERANKER_TIMEOUT"), timeoutMs);
        try { active.postMessage({ type: "rerank", id, query, items: items.map(item => ({ id: item.id, text: item.text })) }); }
        catch { pending.delete(id); cleanup(); reject(fault("RERANKER_LOCAL_ERROR")); }
      });
    },
    close() {
      if (closing) return closing;
      closed = true; publish({ status: "closed" }); rejectAll(fault("KNOWLEDGE_CLOSED"));
      const active = worker; worker = null;
      closing = active ? Promise.resolve(active.terminate()).then(() => {}) : Promise.resolve();
      return closing;
    },
  });
}
