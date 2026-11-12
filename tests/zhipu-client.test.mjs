import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/ai/config.mjs";
import { createTextCompletion } from "../server/ai/zhipu-client.mjs";

test("GLM Flash defaults use the standard application API endpoint and enable supported reasoning parameters", async (t) => {
  const config = loadConfig({ ZHIPU_CODING_API_KEY: "test-only" });
  let requestURL, body;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requestURL = url; body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: "glm-5.3-flash", choices: [{ message: { content: "{}" } }] }) };
  });
  await createTextCompletion(config, { messages: [{ role: "user", content: "test" }], responseFormat: "json_object", temperature: 0.1 });
  assert.equal(requestURL, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(body.model, "glm-5.3-flash");
  assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: true });
  assert.equal(body.reasoning_effort, "low");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("explicit non-Flash configuration retains its request shape and invalid effort fails before calling", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [] }) };
  });
  await createTextCompletion(loadConfig({ ZHIPU_CODING_API_KEY: "test-only", ZHIPU_TEXT_MODEL: "glm-5.3" }), { messages: [], responseFormat: "text" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  assert.throws(() => loadConfig({ ZHIPU_REASONING_EFFORT: "none" }), /ZHIPU_REASONING_EFFORT/);
});

test("provider TimeoutError is normalized to MODEL_TIMEOUT and HTTP 504 without an implicit retry", async (t) => {
  const timeout = new DOMException("provider-internal-url-or-diagnostic", "TimeoutError");
  assert.equal(timeout.code, 23, "the real DOMException shape reproduces numeric provider codes");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw timeout; });
  await assert.rejects(
    createTextCompletion(loadConfig({ ZHIPU_CODING_API_KEY: "test-only" }), { messages: [{ role: "user", content: "test" }], responseFormat: "text" }),
    (error) => {
      assert.equal(error.code, "MODEL_TIMEOUT");
      assert.equal(error.statusCode, 504);
      assert.equal(error.message.includes("provider-internal-url-or-diagnostic"), false);
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("a timed out response body is normalized just like a timed out fetch", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => { throw new DOMException("body read expired", "TimeoutError"); } }));
  await assert.rejects(
    createTextCompletion(loadConfig({ ZHIPU_CODING_API_KEY: "test-only" }), { messages: [{ role: "user", content: "test" }], responseFormat: "json_object" }),
    (error) => error.code === "MODEL_TIMEOUT" && error.statusCode === 504,
  );
});

test("a still-active caller does not prevent a provider timeout from being classified", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.signal.aborted, false);
    throw new DOMException("provider timeout", "TimeoutError");
  });
  await assert.rejects(
    createTextCompletion(loadConfig({ ZHIPU_CODING_API_KEY: "test-only" }), { messages: [], responseFormat: "text", signal: controller.signal }),
    (error) => error.code === "MODEL_TIMEOUT" && error.statusCode === 504,
  );
  assert.equal(controller.signal.aborted, false);
});

test("caller cancellation keeps the original AbortError instead of masquerading as a provider timeout", async (t) => {
  const controller = new AbortController();
  const reason = new DOMException("task was cancelled", "AbortError");
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    controller.abort(reason);
    throw options.signal.reason;
  });
  await assert.rejects(
    createTextCompletion(loadConfig({ ZHIPU_CODING_API_KEY: "test-only" }), { messages: [], responseFormat: "text", signal: controller.signal }),
    (error) => { assert.equal(error, reason); return true; },
  );
});

test("an upstream deadline remains the caller's TimeoutError and is not reclassified as a provider failure", async (t) => {
  const controller = new AbortController();
  const reason = new DOMException("upstream harness deadline", "TimeoutError");
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    controller.abort(reason);
    throw options.signal.reason;
  });
  await assert.rejects(
    createTextCompletion(loadConfig({ ZHIPU_CODING_API_KEY: "test-only" }), { messages: [], responseFormat: "text", signal: controller.signal }),
    (error) => { assert.equal(error, reason); return true; },
  );
});
