import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandler } from "../server/handler.mjs";
import { publicDemoSample } from "../server/public-demo.mjs";
import { publicDemoQuota } from "../server/quota.mjs";
import { createLedger } from "../worker/state.mjs";

const site = "https://demo.example.test";
const sessionSecret = "fixture-session-signing-secret-not-a-real-secret";
const workerKey = "fixture-worker-authentication-not-a-real-token";
const modelKey = "fixture-public-model-not-a-real-key";
const workerUrl = "http://127.0.0.1:8791";
const modelUrl = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const sample = { mode: "text", content: publicDemoSample.text, sampleId: publicDemoSample.id, requestId: "fixture-public-request" };

async function call(handler, action, { ip, auth, body, origin = site } = {}) {
  const req = { method: body ? "POST" : "GET", url: `/api/forme?action=${action}`, body, headers: { host: new URL(site).host }, socket: { remoteAddress: "127.0.0.1" } };
  if (body) Object.assign(req.headers, { origin, "content-type": "application/json" });
  if (ip) req.headers["x-forwarded-for"] = ip;
  if (auth) Object.assign(req.headers, { cookie: auth.cookie, "x-forme-csrf": auth.csrf });
  const response = {};
  await handler(req, {
    setHeader(name, value) { response[name.toLowerCase()] = value; },
    writeHead(status) { response.status = status; },
    end(value) { response.body = JSON.parse(value); },
  });
  return response;
}

function auth(response) {
  return { cookie: response["set-cookie"].split(";", 1)[0], csrf: response.body.csrf };
}

test("the public page displays the exact server-owned sample", async () => {
  const html = await readFile(new URL("../site/try/index.html", import.meta.url), "utf8");
  assert.equal(html.match(/<h2 id="sample-heading">([^<]+)<\/h2>/u)?.[1].trim(), publicDemoSample.title);
  assert.equal(html.match(/<p id="sample-text"[^>]*>([^<]+)<\/p>/u)?.[1].trim(), publicDemoSample.text);
});

test("the public API keeps the fixed sample, credentials, visitor identity and quota isolated", async (t) => {
  const old = process.env;
  process.env = {
    NODE_ENV: "production", FOLIO_PUBLIC_TRUST_LOOPBACK_PROXY: "1",
    FORME_SESSION_SECRET: "fixture-legacy-session-not-a-real-secret-0123456789",
    FORME_WORKER_URL: "http://127.0.0.1:8790",
    FORME_WORKER_TOKEN: "fixture-legacy-worker-not-a-real-secret-0123456789",
    ZHIPU_CODING_API_KEY: "fixture-legacy-key-not-for-demo",
    ZHIPU_CODING_BASE_URL: "https://legacy-model.example.test",
    FOLIO_PUBLIC_SESSION_SECRET: sessionSecret, FOLIO_PUBLIC_WORKER_URL: workerUrl,
    FOLIO_PUBLIC_WORKER_TOKEN: workerKey, FOLIO_PUBLIC_DAILY_LIMIT: "2",
  };
  const dir = await mkdtemp(path.join(tmpdir(), "folio-public-ledger-test-"));
  t.after(async () => { process.env = old; await rm(dir, { recursive: true, force: true }); });
  const command = await createLedger(dir);
  const ledgerKeys = [];
  let modelCalls = 0;
  let ledgerUnavailable = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) === `${workerUrl}/state`) {
      assert.equal(init.headers.Authorization, `Bearer ${workerKey}`);
      if (ledgerUnavailable) return Response.json({ error: "WORKER_UNAVAILABLE" }, { status: 503 });
      const { command: args } = JSON.parse(init.body);
      ledgerKeys.push(args[0] === "EVAL" ? args[3] : args[1]);
      return Response.json({ result: await command(args) });
    }
    assert.equal(String(url), modelUrl);
    modelCalls++;
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${modelKey}`);
    const request = JSON.parse(init.body);
    assert.equal(request.max_tokens, 3072);
    const context = JSON.parse(request.messages.at(-1).content);
    assert.equal(context.normalized_content.text, publicDemoSample.text);
    assert.equal(context.normalized_content.title, publicDemoSample.title);
    const refs = [context.evidence_bundle[0].evidence_id];
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      status: "candidate", summary: "同一条河岸有两种听觉节奏。", summary_evidence_ids: refs,
      digest: { status: "ready", evidence_ids: refs, highlights: [] }, breakdown: { status: "ready", sections: [] },
      concepts: [], content_reliability_score: 0.9,
    }) } }] });
  });

  const handler = createHandler({ publicApiPath: "/folio-demo/api/forme" });
  const disabled = await call(handler, "session");
  assert.equal(disabled.body.enabled, false, "legacy credentials alone do not enable the public mode");
  assert.equal(disabled["set-cookie"], undefined);
  assert.equal((await call(handler, "ingest", { body: sample })).status, 503);
  process.env.FOLIO_PUBLIC_MODEL_API_KEY = modelKey;
  process.env.FOLIO_PUBLIC_WORKER_URL = process.env.FORME_WORKER_URL;
  assert.equal((await call(handler, "session")).body.enabled, false, "legacy Worker paths do not enable the public mode");
  process.env.FOLIO_PUBLIC_WORKER_URL = workerUrl;

  const first = await call(handler, "session");
  assert.match(first["set-cookie"], /^folio_public_session=.*; HttpOnly; SameSite=Strict; Path=\/folio-demo\/api\/forme; Max-Age=86400; Secure$/);
  assert.equal(first.body.enabled, true);
  assert.equal(first.body.publicDemo, true);
  assert.equal(first.body.sampleId, publicDemoSample.id);
  assert.equal(first.body.worker, false);
  assert.equal(first.body.vision, false);
  const one = auth(first);
  const two = auth(await call(handler, "session"));
  const three = auth(await call(handler, "session"));
  const ip = "192.0.2.10";
  assert.equal((await call(handler, "ingest", { body: sample, auth: { ...one, csrf: two.csrf }, ip })).status, 401);
  assert.equal((await call(handler, "ingest", { body: sample, auth: one, origin: "https://cross-origin.example.test", ip })).status, 403);
  assert.equal((await call(handler, "ingest", { body: sample, auth: one, origin: "http://demo.example.test", ip })).status, 403);
  assert.equal((await call(handler, "curate", { body: sample, auth: one, ip })).status, 404);
  for (const bad of [{ ...sample, mode: "link" }, { ...sample, content: "different input" }, { ...sample, title: "client title" }]) {
    assert.equal((await call(handler, "ingest", { body: bad, auth: one, ip })).status, 400);
  }
  assert.equal((await call(handler, "ingest", { body: { ...sample, content: "x".repeat(4100) }, auth: one, ip })).status, 413);
  assert.equal(modelCalls, 0);
  assert.deepEqual(ledgerKeys, []);

  ledgerUnavailable = true;
  assert.equal((await call(handler, "ingest", { body: sample, auth: one, ip })).status, 503);
  assert.equal(modelCalls, 0, "an unavailable ledger never starts a model call");
  ledgerUnavailable = false;
  const saved = await call(handler, "ingest", { body: sample, auth: one, ip });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.collection.title, publicDemoSample.title);
  assert.equal(saved.body.extraction.status, "qualified");
  assert.equal(saved.body.receipt, undefined);
  const retry = await call(handler, "ingest", { body: { ...sample, requestId: "fixture-second-request-id" }, auth: one, ip });
  assert.deepEqual(retry.body, saved.body);
  assert.equal(modelCalls, 1);
  const concurrent = await Promise.all([
    call(handler, "ingest", { body: sample, auth: two, ip: "192.0.2.20" }),
    call(handler, "ingest", { body: sample, auth: three, ip: "192.0.2.30" }),
  ]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 429]);
  assert.notEqual(concurrent.find(response => response.status === 200).body.collection.id, saved.body.collection.id);
  assert.equal(modelCalls, 2, "concurrent visitors cannot exceed the daily cap");
  assert(ledgerKeys.every(key => key.startsWith("forme:public:")));
  assert(ledgerKeys.every(key => !key.includes("192.0.2.")));
  const responses = JSON.stringify([first, saved, concurrent]);
  for (const secret of [sessionSecret, workerKey, modelKey]) assert(!responses.includes(secret));

  async function visitorBucket(peer, forwarded) {
    const keys = [];
    await publicDemoQuota({ socket: { remoteAddress: peer }, headers: { "x-forwarded-for": forwarded } }, 5, {
      sessionSecret, dailyLimit: 2, command: async args => { keys.push(args[3]); return 1; },
    });
    return keys.find(key => key.startsWith("forme:public:visitor:"));
  }
  assert.notEqual(await visitorBucket("127.0.0.1", "192.0.2.20"), await visitorBucket("127.0.0.1", "192.0.2.30"));
  assert.equal(await visitorBucket("192.0.2.10", "192.0.2.20"), await visitorBucket("192.0.2.10", "192.0.2.30"));
});
