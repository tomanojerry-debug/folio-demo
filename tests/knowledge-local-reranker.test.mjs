import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLocalKnowledgeReranker, DEFAULT_LOCAL_RERANKER_REVISION } from "../desktop/server/knowledge/local-reranker.mjs";
import { createRerankerInference, rerankerWindows } from "../desktop/server/knowledge/local-reranker-worker.mjs";

class FakeWorker extends EventEmitter {
  messages = [];
  postMessage(message) { this.messages.push(message); }
  async terminate() { this.terminated = true; }
}
function tokenizer(query, options = {}) {
  if (Array.isArray(query)) return { query, passages: options.text_pair, options };
  return { input_ids: Array(Array.from(query).length + Array.from(options.text_pair || "").length + 4).fill(1) };
}

test("reranker is lazy, pins the public official architecture-specific model, and bounds inputs", async () => {
  let spawned = 0;
  const client = createLocalKnowledgeReranker({ directory: "/tmp/reranker", workerFactory: () => { spawned++; return new FakeWorker(); } });
  assert.ok(client.model.includes(DEFAULT_LOCAL_RERANKER_REVISION));
  assert.match(client.model, /model_q(?:int8_arm64|uint8_avx2)/);
  assert.match(client.model, /:pair512-v2-independent$/);
  assert.deepEqual(await client.rerank("query", []), []);
  await assert.rejects(client.rerank("", [{ id: "a", text: "text" }]), { code: "RERANKER_INPUT_INVALID" });
  await assert.rejects(client.rerank("query", [{ id: "a", text: "text" }, { id: "a", text: "other" }]), { code: "RERANKER_INPUT_INVALID" });
  assert.equal(spawned, 0);
  await client.close();
});

test("reranker worker protocol preserves item IDs and declares score semantics", async () => {
  const worker = new FakeWorker();
  const client = createLocalKnowledgeReranker({ directory: "/tmp/reranker", workerFactory: () => worker });
  const promise = client.rerank("query", [{ id: "a", text: "passage" }]);
  const request = worker.messages[0];
  assert.equal(request.type, "rerank");
  assert.equal(request.query, "query");
  worker.emit("message", { id: request.id, rows: [{ id: "a", score: 0.8, logit: 1.386, scoreKind: "sigmoid_relevance_logit" }] });
  assert.equal((await promise)[0].scoreKind, "sigmoid_relevance_logit");
  await client.close();
});

test("reranker cancellation rejects immediately and ignores late scores", async () => {
  const worker = new FakeWorker(), controller = new AbortController();
  const client = createLocalKnowledgeReranker({ directory: "/tmp/reranker", workerFactory: () => worker });
  const promise = client.rerank("query", [{ id: "a", text: "passage" }], { signal: controller.signal });
  const id = worker.messages[0].id;
  controller.abort();
  await assert.rejects(promise, { code: "RERANKER_ABORTED" });
  assert.deepEqual(worker.messages[1], { type: "cancel", id });
  worker.emit("message", { id, rows: [{ id: "a", score: 0.5, logit: 0 }] });
  await client.close();
});

test("invalid reranker output, timeout and shutdown do not expose model diagnostics", async () => {
  const worker = new FakeWorker();
  const client = createLocalKnowledgeReranker({ directory: "/tmp/reranker", timeoutMs: 5, workerFactory: () => worker });
  const invalid = client.rerank("query", [{ id: "a", text: "passage" }]);
  worker.emit("message", { id: worker.messages[0].id, rows: [{ id: "wrong", score: 0.5, logit: 0 }] });
  await assert.rejects(invalid, { code: "RERANKER_OUTPUT_INVALID" });
  await assert.rejects(client.rerank("query", [{ id: "a", text: "passage" }]), { code: "RERANKER_TIMEOUT" });
  const stalled = client.rerank("query", [{ id: "a", text: "passage" }]);
  const rejected = assert.rejects(stalled, { code: "KNOWLEDGE_CLOSED" });
  await client.close(); await rejected;
  assert.equal(worker.terminated, true);
});

test("query-passage windows fit 512 tokens, flag bounded queries, and retain passage tails", () => {
  const query = "q".repeat(300), text = "资料🌱".repeat(700);
  const result = rerankerWindows(query, text, tokenizer);
  assert.equal(result.queryExcerpt, true);
  assert.ok(result.query.length <= 128);
  assert.equal(result.windows.join(""), text);
  assert.ok(result.windows.every(window => tokenizer(result.query, { text_pair: window }).input_ids.length <= 512));
});

test("raw single-label logits are read directly and best passage windows determine each candidate", async () => {
  let calls = 0;
  const runtime = createRerankerInference({}, { loader: async () => ({ tokenizer, model: async inputs => {
    calls++;
    assert.equal(inputs.options.max_length, 512);
    assert.ok(inputs.query.every(query => query === "question"));
    return { logits: { tolist: () => inputs.passages.map(text => [text.includes("相关尾部") ? 3 : -4]) } };
  } }) });
  const result = await runtime.rerank("question", [{ id: "positive", text: "背景".repeat(600) + "相关尾部" }, { id: "negative", text: "无关材料" }]);
  assert.equal(result[0].id, "positive");
  assert.equal(result[0].logit, 3);
  assert.ok(Math.abs(result[0].score - 0.9525741268) < 1e-8);
  assert.equal(result[1].logit, -4);
  assert.equal(result[0].scoreKind, "sigmoid_relevance_logit");
  assert.ok(calls > 1);
  await runtime.close();
});

test("wrong classification dimensions and cancellation reject scoring", async () => {
  let called = 0;
  const runtime = createRerankerInference({}, { loader: async () => ({ tokenizer, model: async () => { called++; return { logits: { tolist: () => [[1, 2]] } }; } }) });
  await assert.rejects(runtime.rerank("query", [{ id: "a", text: "text" }], { isCancelled: () => true }), { code: "RERANKER_ABORTED" });
  assert.equal(called, 0);
  await assert.rejects(runtime.rerank("query", [{ id: "a", text: "text" }]), { code: "RERANKER_OUTPUT_INVALID" });
  await runtime.close();
});

test("a pair's score is invariant to other candidates, padding lengths and input order", async () => {
  const runtime = createRerankerInference({}, { loader: async () => ({ tokenizer, model: async inputs => {
    // Simulate a quantized model whose activation range depends on its batch.
    // This catches relevance drift rather than merely asserting a batch size.
    const largest = Math.max(...inputs.passages.map(text => text.length));
    return { logits: { tolist: () => inputs.passages.map(text => [
      (text.includes('目标依据') ? 0.2 : -4) + (largest - text.length) / 100,
    ]) } };
  } }) });
  const target = { id:'target', text:'目标依据说明应当读取这篇文章。' };
  const short = { id:'short', text:'短噪声。' }, long = { id:'long', text:'完全不相关的背景文字。'.repeat(200) };
  try {
    const [baseline] = await runtime.rerank('问题', [target]);
    for (const candidates of [[target, short], [target, long], [short, long, target], [long, target, short]]) {
      const result = (await runtime.rerank('问题', candidates)).find(item => item.id === target.id);
      assert.equal(result.logit, baseline.logit);
      assert.equal(result.score, baseline.score);
    }
  } finally { await runtime.close(); }
});
