import { Worker } from "node:worker_threads";
import path from "node:path";

/** Database I/O and vector scans execute outside the desktop HTTP event loop. */
export async function openKnowledge({ directory } = {}) {
  if (typeof directory !== "string" || !directory) throw new TypeError("A knowledge directory is required");
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: { directory: path.resolve(directory) }, execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")) });
  let nextId = 0, closed = false, failed;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const restoreError = value => Object.assign(new Error(value?.message || "Knowledge storage failed"), { code: value?.code || "KNOWLEDGE_STORAGE_ERROR" });
  worker.on("message", response => {
    if (response.ready) { readyResolve(); return; }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(restoreError(response.error));
    else request.resolve(response.value);
  });
  worker.on("error", error => {
    failed = error;
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  worker.on("exit", code => {
    if (closed && !pending.size) return;
    const error = failed || Object.assign(new Error(`Knowledge worker exited (${code})`), { code: "KNOWLEDGE_WORKER_EXITED" });
    failed = error;
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  function call(method, args = {}) {
    if (closed || failed) return Promise.reject(failed || Object.assign(new Error("Knowledge storage is closed"), { code: "KNOWLEDGE_CLOSED" }));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, args }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  try { await ready; }
  catch (error) { closed = true; await worker.terminate(); throw error; }
  const api = Object.fromEntries(["captureSource", "reconcile", "attachUnderstanding", "readDocument", "embeddingWork", "writeEmbeddings", "search", "findSimilar", "getConnections", "getConcepts", "curationDocuments", "status", "flush"].map(method => [method, args => call(method, args)]));
  let closing;
  return {
    ...api,
    close() {
      if (closing) return closing;
      closing = call("close").finally(async () => { closed = true; await worker.terminate(); });
      return closing;
    },
  };
}
