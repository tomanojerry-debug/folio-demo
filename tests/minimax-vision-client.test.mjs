import assert from "node:assert/strict";
import test from "node:test";
import { executeCall } from "../server/ai/ai-service.mjs";
import { loadConfig } from "../server/ai/config.mjs";

const image = "data:image/png;base64,AA==";

test("image understanding uses the MiniMax application API and returns text to the pipeline", async (t) => {
  const config = loadConfig({ MINIMAX_API_KEY: "fixture-vision-key" });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.minimax.cn/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer fixture-vision-key");
    assert.equal(options.redirect, "error");
    const request = JSON.parse(options.body);
    assert.equal(request.model, "MiniMax-M3");
    assert.deepEqual(request.messages[0].content, [
      { type: "text", text: "描述图片" },
      { type: "image_url", image_url: { url: image } },
    ]);
    return Response.json({ choices: [{ message: { content: "图片说明" } }] });
  });

  const reply = await executeCall(config, { callId: "CALL-VISION01", prompt: "描述图片", imageSource: image });
  assert.equal(reply.content, "图片说明");
  assert.equal(reply.model, "MiniMax-M3");
});

test("image understanding requires a configured key and a browser image, before sending a request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("an invalid request reached the provider"));
  const payload = { callId: "CALL-VISION01", prompt: "描述图片", imageSource: image };
  await assert.rejects(executeCall(loadConfig({}), payload), { code: "VISION_NOT_CONFIGURED" });
  const configured = loadConfig({ MINIMAX_API_KEY: "fixture-vision-key" });
  await assert.rejects(executeCall(configured, { ...payload, imageSource: "https://example.test/image.png" }), { code: "INVALID_REQUEST" });
  assert.equal(fetch.mock.callCount(), 0);
});
