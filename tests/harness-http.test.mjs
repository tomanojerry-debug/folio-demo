import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDesktopServer } from "../desktop/server/index.mjs";
import { createTextCompletion } from "../server/ai/zhipu-client.mjs";

test("job retry HTTP endpoint enforces origin and returns one safe recoverable attempt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-harness-http-"));
  let calls = 0;
  const server = await startDesktopServer({ directory, port: 0, aiEnabled: true, autoCurate: false,
    config: { zhipuApiKey: "", timeoutMs: 1000 },
    chat: async () => {
      if (++calls === 1) throw Object.assign(new Error("fixture failure"), { code: "MODEL_PROVIDER_ERROR" });
      return { choices: [{ message: { content: "恢复后的唯一回答" } }] };
    },
  });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const post = (route, body, origin = server.origin) => fetch(`${server.origin}/api/desktop/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post("messages", { text: "请讨论一下资料与判断" })).status, 200);
  await server.service.idle();
  const parent = server.service.state().jobs[0];
  assert.equal(parent.status, "failed");
  assert.equal((await post("jobs/retry", { jobId: parent.id }, null)).status, 403);
  assert.equal((await post("jobs/retry", { jobId: parent.id }, "https://other.example")).status, 403);
  assert.equal(calls, 1);
  const response = await post("jobs/retry", { jobId: parent.id });
  assert.equal(response.status, 200);
  const retried = await response.json();
  assert.equal(retried.job.retryOf, parent.id);
  const noPrivateFields = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(["checkpoints", "receipt", "receipts", "profileSnapshot", "input", "baseReceipt"].includes(key), false, key);
      noPrivateFields(child);
    }
  };
  noPrivateFields(retried);
  await server.service.idle();
  const replay = await (await post("jobs/retry", { jobId: parent.id })).json();
  assert.equal(replay.job.id, retried.job.id);
  assert.equal(replay.job.status, "complete");
  assert.equal(calls, 2);
  assert.equal(replay.state.messages.filter((message) => message.text === "恢复后的唯一回答").length, 1);
  noPrivateFields(replay);
});

test("text adapter combines the harness cancellation signal with its provider timeout", async (t) => {
  const controller = new AbortController();
  let request;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    request = options;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "fixture" } }] }) };
  });
  await createTextCompletion({ zhipuApiKey: "fixture-only", zhipuBaseUrl: "https://example.invalid", textModel: "fixture", textMaxTokens: 512, timeoutMs: 1000 }, {
    messages: [{ role: "user", content: "test" }], responseFormat: "text", temperature: 0, signal: controller.signal,
  });
  assert.equal(request.signal.aborted, false);
  assert.equal(JSON.parse(request.body).signal, undefined);
  controller.abort();
  assert.equal(request.signal.aborted, true);
});
