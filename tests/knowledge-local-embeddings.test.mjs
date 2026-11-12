import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLocalKnowledgeEmbedder, DEFAULT_LOCAL_EMBEDDING_REVISION } from "../desktop/server/knowledge/local-embeddings.mjs";
import { createLocalInference, localTextSegments } from "../desktop/server/knowledge/local-embedding-worker.mjs";

const vector = (x = 1, y = 0) => [x, y, ...Array(382).fill(0)];
const tokenizer = text => ({ input_ids: Array(Array.from(text).length + 2).fill(1) });
class FakeWorker extends EventEmitter {
  messages = [];
  terminated = false;
  postMessage(message) { this.messages.push(message); }
  async terminate() { this.terminated = true; }
}

test("local model is lazy, uses a pinned independent space, and never downloads for invalid or empty work", async () => {
  let spawned = 0;
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", workerFactory: () => { spawned++; return new FakeWorker(); } });
  assert.equal(client.space.dimensions, 384);
  assert.match(client.space.model, /^local:/);
  assert.ok(client.space.model.includes(DEFAULT_LOCAL_EMBEDDING_REVISION));
  assert.match(client.space.model, /mean-v1$/);
  assert.equal(client.status().status, "not_loaded");
  assert.deepEqual(await client.embed([]), []);
  await assert.rejects(client.embed([" "]), { code: "EMBEDDING_INPUT_INVALID" });
  await assert.rejects(client.embed(["x".repeat(200001)]), { code: "EMBEDDING_INPUT_INVALID" });
  assert.equal(spawned, 0);
  await client.close();
});

test("worker results and safe download progress are forwarded without source text", async () => {
  const worker = new FakeWorker(), progress = [];
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", onProgress: value => progress.push(value), workerFactory: options => {
    assert.equal(options.cacheDirectory, "/tmp/local-model-fixture/models");
    return worker;
  } });
  const pending = client.embed(["private article"]);
  worker.emit("message", { type: "status", status: "downloading", progress: 37.4, privateText: "must not leak" });
  assert.equal(client.status().progress, 37);
  const request = worker.messages[0];
  worker.emit("message", { id: request.id, vectors: [vector()] });
  assert.deepEqual(await pending, [vector()]);
  assert.doesNotMatch(JSON.stringify(progress), /private article|must not leak/);
  await client.close();
});

test("local query role is forwarded and unsupported roles fail before inference", async () => {
  const worker = new FakeWorker();
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", workerFactory: () => worker });
  await assert.rejects(client.embed(["text"], { role: "unknown" }), { code: "EMBEDDING_INPUT_INVALID" });
  assert.equal(worker.messages.length, 0);
  const pending = client.embed(["怎样减少打扰"], { role: "query" });
  assert.equal(worker.messages[0].role, "query");
  worker.emit("message", { id: worker.messages[0].id, vectors: [vector()] });
  await pending;
  await client.close();
});

test("caller cancellation rejects immediately and ignores late local vectors", async () => {
  const worker = new FakeWorker(), controller = new AbortController();
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", workerFactory: () => worker });
  const pending = client.embed(["private article"], { signal: controller.signal });
  const id = worker.messages[0].id;
  controller.abort(new Error("sensitive reason"));
  await assert.rejects(pending, error => error.code === "EMBEDDING_ABORTED" && !error.message.includes("sensitive"));
  assert.deepEqual(worker.messages[1], { type: "cancel", id });
  worker.emit("message", { id, vectors: [vector()] });
  await client.close();
});

test("pre-cancelled local work never starts a worker", async () => {
  const controller = new AbortController(); controller.abort();
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", workerFactory: () => { throw new Error("must not start"); } });
  await assert.rejects(client.embed(["text"], { signal: controller.signal }), { code: "EMBEDDING_ABORTED" });
  await client.close();
});

test("local timeout sends cancellation, invalid results are rejected, and worker errors are sanitized", async () => {
  const worker = new FakeWorker();
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", timeoutMs: 5, workerFactory: () => worker });
  await assert.rejects(client.embed(["text"]), { code: "EMBEDDING_TIMEOUT" });
  assert.equal(worker.messages.at(-1).type, "cancel");
  const invalid = client.embed(["text"]);
  worker.emit("message", { id: worker.messages.at(-1).id, vectors: [[1, 2]] });
  await assert.rejects(invalid, { code: "EMBEDDING_OUTPUT_INVALID" });
  const failure = client.embed(["text"]);
  worker.emit("error", new Error("private source and internal path"));
  await assert.rejects(failure, error => error.code === "EMBEDDING_LOCAL_ERROR" && !error.message.includes("private"));
  await client.close();
});

test("worker startup failure and cancellation transport errors remain safe and settle promptly", async () => {
  const unavailable = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", workerFactory: () => { throw new Error("private path or secret diagnostic"); } });
  await assert.rejects(unavailable.embed(["text"]), error => error.code === "EMBEDDING_LOCAL_ERROR" && !error.message.includes("private"));
  await unavailable.close();
  const worker = new FakeWorker(), controller = new AbortController();
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", workerFactory: () => worker });
  const pending = client.embed(["text"], { signal: controller.signal });
  worker.postMessage = () => { throw new Error("worker already exited"); };
  controller.abort();
  await assert.rejects(pending, { code: "EMBEDDING_ABORTED" });
  await client.close();
});

test("close is idempotent, terminates inference, and rejects queued work", async () => {
  const worker = new FakeWorker();
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", workerFactory: () => worker });
  const pending = client.embed(["text"]);
  const rejected = assert.rejects(pending, { code: "KNOWLEDGE_CLOSED" });
  const closing = client.close();
  assert.equal(client.close(), closing);
  await closing; await rejected;
  assert.equal(worker.terminated, true);
  assert.equal(client.status().status, "closed");
  await assert.rejects(client.embed(["text"]), { code: "KNOWLEDGE_CLOSED" });
});

test("token-aware segmentation preserves all Unicode text and never exceeds model capacity", () => {
  const text = "自然光🌱照进房间。".repeat(150);
  const segments = localTextSegments(text, tokenizer, 128);
  assert.equal(segments.join(""), text);
  assert.ok(segments.length > 1);
  assert.ok(segments.every(segment => tokenizer(segment).input_ids.length <= 128));
  assert.ok(segments.every(segment => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(segment)));
});

test("fake local inference uses mean pooling, batches four segments, and includes long-text tails", async () => {
  const seen = [], phases = [];
  let loads = 0;
  const pipe = async (texts, options) => {
    assert.deepEqual(options, { pooling: "mean", normalize: true });
    assert.ok(texts.length <= 4);
    seen.push(...texts);
    return { tolist: () => texts.map(text => text.includes("乙") ? vector(0, 1) : vector()) };
  };
  pipe.tokenizer = tokenizer;
  const runtime = createLocalInference({}, { pipelineFactory: async () => { loads++; return pipe; }, onProgress: phase => phases.push(phase.status) });
  const text = "甲".repeat(900) + "乙".repeat(126);
  const [result] = await runtime.embed([text]);
  assert.equal(seen.map(value => value.replace(/^passage: /u, "")).join(""), text);
  assert.ok(seen.every(value => tokenizer(value).input_ids.length <= 512));
  assert.ok(result[1] > 0, "Tail content contributes to the vector");
  assert.ok(Math.abs(Math.hypot(...result) - 1) < 1e-12);
  await runtime.embed(["甲"]);
  assert.equal(loads, 1);
  assert.deepEqual(phases, ["loading", "ready"]);
  await runtime.close();
});

test("E5 query and passage roles use their trained prefixes within the token budget", async () => {
  const seen = [];
  const pipe = async texts => { seen.push(...texts); return { tolist: () => texts.map(() => vector()) }; };
  pipe.tokenizer = (text, options) => tokenizer(text, options);
  pipe.tokenizer.model_max_length = 512;
  const runtime = createLocalInference({ prefixStrategy: "e5_query_passage", maxTokens: 512 }, { pipelineFactory: async () => pipe });
  await runtime.embed(["怎样降低打扰"], { role: "query" });
  await runtime.embed(["关闭无关通知可以减少任务切换。"], { role: "passage" });
  assert.deepEqual(seen, ["query: 怎样降低打扰", "passage: 关闭无关通知可以减少任务切换。"]);
  const parts = localTextSegments("甲".repeat(512), tokenizer, 512, "passage: ");
  assert.equal(parts.join(""), "甲".repeat(512));
  assert.ok(parts.every(value => tokenizer(`passage: ${value}`).input_ids.length <= 512));
  await runtime.close();
});

test("optional E5 experiments use a distinct pinned model and prefix identity", async () => {
  let options;
  const worker = new FakeWorker();
  const client = createLocalKnowledgeEmbedder({ directory: "/tmp/local-model-fixture", model: "Xenova/multilingual-e5-small", workerFactory: value => { options = value; return worker; } });
  const pending = client.embed(["query"], { role: "query" });
  assert.equal(options.prefixStrategy, "e5_query_passage");
  assert.equal(options.maxTokens, 512);
  assert.match(client.space.model, /761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8:e5-query-passage-v1$/);
  worker.emit("message", { id: worker.messages[0].id, vectors: [vector()] });
  await pending; await client.close();
});

test("cancelled runtime work stops before loading or between inference batches", async () => {
  let calls = 0, cancelled = false;
  const pipe = async texts => { calls++; cancelled = true; return { tolist: () => texts.map(() => vector()) }; };
  pipe.tokenizer = tokenizer;
  const runtime = createLocalInference({}, { pipelineFactory: async () => pipe });
  await assert.rejects(runtime.embed(["text"], { isCancelled: () => true }), { code: "EMBEDDING_ABORTED" });
  await assert.rejects(runtime.embed(["甲".repeat(2000)], { isCancelled: () => cancelled }), { code: "EMBEDDING_ABORTED" });
  assert.equal(calls, 1);
  await runtime.close();
});
