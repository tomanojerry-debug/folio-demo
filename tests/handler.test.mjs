import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../server/handler.mjs";
process.env.FORME_SESSION_SECRET = "test-only-session-secret-with-over-32-characters";
process.env.ZHIPU_CODING_API_KEY = "test-placeholder";
const handler = createHandler({ quota: async () => {}, ingest: async () => ({ collection: { id: "test" } }) });
async function request(action, method = "GET", headers = {}, body) {
  let status, data; const responseHeaders = {};
  await handler({ url: `/api/forme?action=${action}`, method, headers: { host: "localhost", ...headers }, body }, { setHeader: (k, v) => { responseHeaders[k] = v; }, writeHead: (s) => { status = s; }, end: (raw) => { data = JSON.parse(raw); } });
  return { status, data, headers: responseHeaders };
}
test("visitors receive a default session without login; generation still requires its CSRF proof", async () => {
  const login = await request("session");
  assert.equal(login.data.account, "Folio 展示账号");
  assert.equal(login.data.enabled, true);
  assert.match(login.headers["Set-Cookie"], /HttpOnly/);
  const cookie = login.headers["Set-Cookie"].split(";")[0];
  assert.equal((await request("ingest", "POST", { cookie, "content-type": "application/json", "x-forme-csrf": login.data.csrf }, { mode: "text", content: "sample", requestId: "test-request-123456789" })).status, 200);
  assert.equal((await request("ingest", "POST", { "content-type": "application/json" }, { mode: "text" })).status, 401);
  assert.equal((await request("ingest", "POST", { cookie, "content-type": "application/json", "x-forme-csrf": login.data.csrf }, { mode: "parsed", requestId: "test-request-987654321" })).status, 400);
});
test("cross-site requests rejected and keys never returned", async () => {
  assert.equal((await request("session", "GET", { origin: "https://evil.example" })).status, 403);
  const result = await request("session"); assert.ok(!JSON.stringify(result).includes("test-placeholder"));
});

test("session advertises vision with the configured application key or legacy alias, without revealing either", async (t) => {
  const primary = "MINIMAX_API_KEY";
  const legacy = "MINIMAX_TOKEN_PLAN_API_KEY";
  const previous = [primary, legacy].map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env[primary];
  delete process.env[legacy];
  assert.equal((await request("session")).data.vision, false);
  for (const name of [primary, legacy]) {
    process.env[name] = "fixture-vision-key";
    const { data } = await request("session");
    assert.equal(data.vision, true);
    assert.equal(JSON.stringify(data).includes("fixture-vision-key"), false);
    delete process.env[name];
  }
  process.env[primary] = "replace-with-key";
  assert.equal((await request("session")).data.vision, false);
});
