import test from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeEmbedder } from "../desktop/server/knowledge/embeddings.mjs";

const config = { embeddingApiKey: "test-private-key", embeddingDimensions: 256 };
const vector = (x = 1, y = 0, dimensions = 256) => [x, y, ...Array(dimensions - 2).fill(0)];
const response = (input, make = () => vector()) => ({ ok: true, json: async () => ({ model: "embedding-3", data: input.map((text, index) => ({ index, embedding: make(text, index) })) }) });

test("embedding configuration is independent of Coding Plan and absent configuration makes no network request", () => {
  let called = false;
  assert.equal(createKnowledgeEmbedder({ zhipuApiKey: "coding-key", zhipuBaseUrl: "https://example.org/coding" }, { fetchImpl() { called = true; } }), null);
  assert.equal(createKnowledgeEmbedder({ embeddingApiKey: "   " }), null);
  assert.equal(called, false);
});

test("embedding requests use the standard endpoint, independent model/space, and index order", async () => {
  let url, options;
  const embedder = createKnowledgeEmbedder(config, { fetchImpl: async (target, settings) => {
    url = target; options = settings;
    return { ok: true, json: async () => ({ data: [{ index: 1, embedding: vector(0, 3) }, { index: 0, embedding: vector(2, 0) }] }) };
  } });
  const vectors = await embedder.embed(["原文甲", "source B"]);
  assert.equal(url, "https://open.bigmodel.cn/api/paas/v4/embeddings");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer test-private-key");
  assert.equal(options.redirect, "error");
  assert.deepEqual(JSON.parse(options.body), { model: "embedding-3", input: ["原文甲", "source B"], dimensions: 256 });
  assert.deepEqual(embedder.space, { model: "embedding-3", dimensions: 256 });
  assert.deepEqual(vectors.map(item => item.slice(0, 2)), [[1, 0], [0, 1]]);
});

test("default dimensions and explicit base URLs preserve their configured space", async () => {
  const embedder = createKnowledgeEmbedder({ embeddingApiKey: "key", embeddingBaseUrl: "http://127.0.0.1:1234/v1/" }, { fetchImpl: async (url, options) => {
    assert.equal(url, "http://127.0.0.1:1234/v1/embeddings");
    assert.equal(JSON.parse(options.body).dimensions, 1024);
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: vector(1, 0, 1024) }] }) };
  } });
  assert.equal((await embedder.embed(["text"]))[0].length, 1024);
  assert.deepEqual(embedder.space, { model: "embedding-3", dimensions: 1024 });
});

test("long Unicode input preserves all characters and aggregates segment vectors by code-point weight", async () => {
  const inputs = [];
  const text = "甲".repeat(800) + "乙".repeat(400);
  const embedder = createKnowledgeEmbedder(config, { fetchImpl: async (_url, options) => {
    const input = JSON.parse(options.body).input;
    inputs.push(...input);
    assert.ok(input.every(part => Buffer.byteLength(part, "utf8") <= 2400));
    return response(input, part => part.includes("甲") ? vector(1, 0) : vector(0, 1));
  } });
  const [result] = await embedder.embed([text]);
  assert.equal(inputs.join(""), text);
  assert.deepEqual(inputs.map(item => item.length), [800, 400]);
  assert.ok(Math.abs(result[0] - 2 / Math.sqrt(5)) < 1e-12);
  assert.ok(Math.abs(result[1] - 1 / Math.sqrt(5)) < 1e-12);
});

test("large logical texts cross provider batches without dropping text or splitting Unicode pairs", async () => {
  const seen = [], batches = [];
  const text = "🌱".repeat(600 * 34);
  const embedder = createKnowledgeEmbedder(config, { fetchImpl: async (_url, options) => {
    const input = JSON.parse(options.body).input;
    batches.push(input.length); seen.push(...input);
    assert.ok(input.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part)));
    return response(input);
  } });
  const [result] = await embedder.embed([text]);
  assert.deepEqual(batches, [32, 2]);
  assert.equal(seen.join(""), text);
  assert.deepEqual(result, vector());
});

test("empty work is free and invalid or oversized logical requests fail before any fetch", async () => {
  let calls = 0;
  const embedder = createKnowledgeEmbedder(config, { fetchImpl: () => { calls++; throw new Error("must not call"); } });
  assert.deepEqual(await embedder.embed([]), []);
  for (const input of [null, "text", [""], ["  "], [42], Array(65).fill("text"), ["x".repeat(200001)]]) {
    await assert.rejects(embedder.embed(input), { code: "EMBEDDING_INPUT_INVALID", statusCode: 400 });
  }
  assert.equal(calls, 0);
});

test("provider index, dimension, model and vector validation reject unusable output", async () => {
  const outputs = [
    { data: [] },
    { data: [{ index: 1, embedding: vector() }] },
    { data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] },
    { data: [{ index: 0, embedding: [1, 0] }] },
    { data: [{ index: 0, embedding: Array(256).fill(0) }] },
    { data: [{ index: 0, embedding: [Infinity, ...Array(255).fill(0)] }] },
    { data: [{ index: 0, embedding: ["1", ...Array(255).fill(0)] }] },
    { model: "different-space", data: [{ index: 0, embedding: vector() }] },
  ];
  for (const payload of outputs) {
    const embedder = createKnowledgeEmbedder(config, { fetchImpl: async () => ({ ok: true, json: async () => payload }) });
    await assert.rejects(embedder.embed(["text"]), { code: "EMBEDDING_OUTPUT_INVALID", statusCode: 502 });
  }
});

test("duplicate provider indices cannot impersonate a complete batch", async () => {
  const embedder = createKnowledgeEmbedder(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] }) }) });
  await assert.rejects(embedder.embed(["甲", "乙"]), { code: "EMBEDDING_OUTPUT_INVALID" });
});

test("HTTP failures expose safe errors and never parse provider diagnostics or retry implicitly", async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0, reads = 0;
    const embedder = createKnowledgeEmbedder(config, { fetchImpl: async () => {
      calls++;
      return { ok: false, status, json: async () => { reads++; throw new Error("secret provider diagnostic"); } };
    } });
    await assert.rejects(embedder.embed(["text"]), error => {
      assert.equal(error.code, status === 429 ? "EMBEDDING_RATE_LIMITED" : "EMBEDDING_PROVIDER_ERROR");
      assert.doesNotMatch(error.message, /test-private-key|secret|diagnostic/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(reads, 0);
  }
});

test("network and JSON errors do not expose source text, endpoints or credentials", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("test-private-key http://private-host internal-diagnostic"); },
    async () => { throw Object.assign(new Error("test-private-key provider-body"), { code: "EMBEDDING_PROVIDER_ERROR" }); },
    async () => ({ ok: true, json: async () => { throw new Error("test-private-key provider-body"); } }),
  ]) {
    const embedder = createKnowledgeEmbedder(config, { fetchImpl });
    await assert.rejects(embedder.embed(["private source text"]), error => {
      assert.doesNotMatch(error.message, /private|provider-body|diagnostic/);
      assert.ok(["EMBEDDING_PROVIDER_ERROR", "EMBEDDING_OUTPUT_INVALID"].includes(error.code));
      return true;
    });
  }
});

test("a client deadline aborts a stalled request and a stalled response body", async () => {
  for (const stage of ["fetch", "body"]) {
    let capturedSignal;
    const embedder = createKnowledgeEmbedder({ ...config, embeddingTimeoutMs: 5 }, { fetchImpl: async (_url, options) => {
      capturedSignal = options.signal;
      if (stage === "fetch") return new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    } });
    await assert.rejects(embedder.embed(["text"]), { code: "EMBEDDING_TIMEOUT", statusCode: 504 });
    assert.equal(capturedSignal.aborted, true);
  }
});

test("provider TimeoutError is normalized even before the client deadline", async () => {
  const embedder = createKnowledgeEmbedder(config, { fetchImpl: async () => { throw new DOMException("private diagnostic", "TimeoutError"); } });
  await assert.rejects(embedder.embed(["text"]), { code: "EMBEDDING_TIMEOUT", statusCode: 504 });
});

test("caller cancellation prevents fetch or aborts in-flight work without exposing its reason", async () => {
  let calls = 0;
  const before = new AbortController();
  before.abort(new Error("sensitive cancellation reason"));
  const embedder = createKnowledgeEmbedder(config, { fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.signal.aborted, false);
    return new Promise(() => {});
  } });
  await assert.rejects(embedder.embed(["text"], { signal: before.signal }), { code: "EMBEDDING_ABORTED", statusCode: 499 });
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = embedder.embed(["text"], { signal: during.signal });
  during.abort(new Error("sensitive cancellation reason"));
  await assert.rejects(pending, error => {
    assert.equal(error.code, "EMBEDDING_ABORTED");
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
  assert.equal(calls, 1);
});

test("bad client configuration fails without including supplied private URL values", () => {
  for (const overrides of [{ embeddingDimensions: 2 }, { embeddingDimensions: NaN }, { embeddingTimeoutMs: 0 }, { embeddingBaseUrl: "file:///private/data" }, { embeddingBaseUrl: "https://username:secret@example.org/" }, { embeddingBaseUrl: "https://example.org/?token=secret" }]) {
    assert.throws(() => createKnowledgeEmbedder({ ...config, ...overrides }), error => {
      assert.equal(error.name, "TypeError");
      assert.doesNotMatch(error.message, /secret|private\/data/);
      return true;
    });
  }
});
