import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDesktopServer } from "../desktop/server/index.mjs";

test("first launch verifies a personal model, uses it for Tag chat and reopens the saved profile", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "folio-model-setup-"));
  const calls = [];
  const key = "fixture-personal-model-key";
  const provider = http.createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    calls.push({ url: req.url, authorization: req.headers.authorization, input: JSON.parse(Buffer.concat(body)) });
    res.setHeader("Content-Type", "application/json");
    const valid = req.headers.authorization === `Bearer ${key}`;
    res.statusCode = valid ? 200 : 401;
    res.end(JSON.stringify(valid ? { choices: [{ message: { content: "模型连接验证回复" } }] } : { error: { message: "fixture provider error" } }));
  });
  let runtime;
  try {
    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const options = { directory, modelSetup: true };
    runtime = await startDesktopServer(options);
    const baseURL = `http://127.0.0.1:${provider.address().port}/v1/chat/completions`;
    const model = "folio-test";
    const endpoint = `${runtime.origin}/api/desktop/model-setup`;
    const post = (url, body, origin = runtime.origin) => fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
    });
    const stage = await fetch(`${runtime.origin}/prototype/immersive-exhibition/light.html`, { redirect: "manual" });
    assert.equal(stage.status, 303);
    assert.equal(stage.headers.get("Location"), "/curator/model-setup.html");
    assert.match(await (await fetch(new URL(stage.headers.get("Location"), runtime.origin))).text(), /连接你的模型/);
    assert.equal((await fetch(`${runtime.origin}/api/desktop/state`)).status, 409);
    assert.equal((await post(endpoint, { baseURL, model, apiKey: key }, "https://example.org")).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await post(endpoint, { baseURL, model, apiKey: "invalid-key" })).status, 502);
    await assert.rejects(stat(path.join(directory, "model-provider.json")), { code: "ENOENT" });
    const verified = await post(endpoint, { baseURL, model, apiKey: key });
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { configured: true });
    assert.equal((await stat(path.join(directory, "model-provider.json"))).mode & 0o777, 0o600);
    assert.equal((await post(endpoint, { baseURL, model, apiKey: key })).status, 409);

    assert.equal((await post(`${runtime.origin}/api/desktop/messages`, { text: "你好，Tag！" })).status, 200);
    await runtime.service.idle();
    const state = await (await fetch(`${runtime.origin}/api/desktop/state`)).text();
    assert.match(state, /模型连接验证回复/);
    assert.ok(!state.includes(key));
    assert.ok(calls.length >= 3);
    for (const call of calls) {
      assert.equal(call.url, "/v1/chat/completions");
      assert.equal(call.input.model, model);
      assert.ok(!Object.hasOwn(call.input, "thinking"));
    }

    await runtime.close();
    runtime = await startDesktopServer(options);
    assert.deepEqual(await (await fetch(`${runtime.origin}/api/desktop/model-setup`)).json(), { configured: true });
    assert.equal((await fetch(`${runtime.origin}/prototype/immersive-exhibition/light.html`, { redirect: "manual" })).status, 200);
  } finally {
    await runtime?.close();
    if (provider.listening) await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
