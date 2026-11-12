import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";
import { verify } from "../server/receipts.mjs";

const config = { zhipuApiKey: "", textModel: "refresh-fixture", timeoutMs: 1000 };
const url = "https://example.com/original-source";
const source = (version) => `第 ${version} 版实际读取的网页正文：这份来源提供可以核对的证据，使用者能够检查内容，并保留最终判断。`;
const fail = (code = "FETCH_FAILED") => Object.assign(new Error("injected fixture failure"), { code });
function model(callId, context) {
  assert.equal(callId, "CALL-P001");
  const refs = [context.evidence_bundle[0].evidence_id], summary = context.normalized_content.text;
  return { trace: { callId, model: "injected-refresh-fixture" }, output: {
    status: "candidate", summary, summary_evidence_ids: refs,
    digest: { status: "compact", overview: summary, evidence_ids: refs, highlights: [{ text: summary, evidence_ids: refs }] },
    breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "可核对来源", evidence_ids: refs }],
    content_reliability_score: 0.95, uncertainties: [],
  } };
}
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-refresh-source-")), releases = [];
  const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, model, fetchPage: async () => ({ url, type: "text/plain", text: source(1) }), ...overrides });
  t.after(async () => { releases.forEach((release) => release()); await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory, releases, privateState: async () => JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")) };
}
function assertPublic(value) {
  if (Array.isArray(value)) { value.forEach(assertPublic); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(["receipt", "receipts", "sourceHistory", "sourceInput", "sourceResult", "checkpoints", "input"].includes(key), false, `Private source payload leaked: ${key}`);
    assertPublic(child);
  }
}
async function capture(service) {
  const response = await service.capture({ mode: "link", content: url, title: "用户提交的真实来源" });
  await service.idle();
  assert.equal(service.state().collections[0].status, "ready");
  return response;
}

test("explicit source refresh rereads the URL, replaces signed evidence in the same collection and keeps three private versions", async (t) => {
  let reads = 0;
  const { service, privateState } = await fixture(t, { fetchPage: async (requested) => { assert.equal(requested, url); return { url, type: "text/plain", text: source(++reads) }; } });
  const first = await capture(service);
  const initial = (await privateState()).collections[0];
  assert.equal(initial.sourceRevision, 1);
  const response = await service.refreshSource({ collectionId: first.collectionId });
  assert.equal(response.job.type, "ingest");
  assert.equal(response.job.sourceRefresh, true);
  assertPublic(response);
  await service.idle();
  let saved = await privateState(), item = saved.collections[0];
  assert.equal(reads, 2);
  assert.equal(saved.collections.length, 1);
  assert.equal(item.id, first.collectionId);
  assert.equal(item.sourceRevision, 2);
  assert.equal(item.extraction.evidenceBundle[0].text, source(2));
  assert.notEqual(item.receipt, initial.receipt);
  assert.notEqual(item.sourceResult.id, initial.sourceResult.id);
  assert.equal(item.sourceHistory.length, 1);
  assert.deepEqual(item.sourceHistory[0].input, initial.input);
  assert.deepEqual(item.sourceHistory[0].extraction, initial.extraction);
  assert.deepEqual(item.sourceHistory[0].sourceResult, initial.sourceResult);
  assert.equal(item.sourceHistory[0].sourceRevision, 1);
  assert.ok(item.sourceHistory[0].createdAt);
  assert.equal(verify(item.sourceHistory[0].receipt, "collection").extraction.evidenceBundle[0].text, source(1));
  assert.equal(verify(item.receipt, "collection").extraction.evidenceBundle[0].text, source(2));
  assert.notEqual(saved.jobs.find((job) => job.id === response.job.id).harness.runId, saved.jobs.find((job) => job.id === first.job.id).harness.runId);
  for (let index = 0; index < 3; index++) { await service.refreshSource({ collectionId: first.collectionId }); await service.idle(); }
  saved = await privateState(); item = saved.collections[0];
  assert.equal(reads, 5);
  assert.equal(item.sourceRevision, 5);
  assert.deepEqual(item.sourceHistory.map((entry) => entry.sourceRevision), [2, 3, 4]);
  assert.deepEqual(item.sourceHistory.map((entry) => entry.extraction.evidenceBundle[0].text), [source(2), source(3), source(4)]);
  assertPublic(service.state());
});

test("a failed reread preserves old evidence and a job retry retains refresh intent without duplicating the collection", async (t) => {
  let reads = 0;
  const { service, privateState } = await fixture(t, { fetchPage: async () => {
    reads += 1;
    if (reads === 2) throw fail();
    return { url, type: "text/plain", text: reads === 1 ? source(1) : source(2) };
  } });
  const first = await capture(service), before = (await privateState()).collections[0];
  const refreshed = await service.refreshSource({ collectionId: first.collectionId });
  await service.idle();
  const failed = (await privateState()).collections[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.sourceRevision, 1);
  assert.equal(failed.receipt, before.receipt);
  assert.deepEqual(failed.extraction, before.extraction);
  assert.deepEqual(failed.sourceResult, before.sourceResult);
  assert.equal(failed.sourceHistory.length, 1);
  const retried = await service.retryJob({ jobId: refreshed.job.id });
  assert.equal(retried.job.sourceRefresh, true);
  assert.equal(retried.job.retryOf, refreshed.job.id);
  assertPublic(retried);
  await service.idle();
  const saved = await privateState(), item = saved.collections[0], job = saved.jobs.find((entry) => entry.id === retried.job.id);
  assert.equal(saved.collections.length, 1);
  assert.equal(item.id, first.collectionId);
  assert.equal(item.status, "ready");
  assert.equal(item.sourceRevision, 2);
  assert.equal(item.sourceHistory.length, 1, "Retry must not archive the same old source twice");
  assert.equal(item.extraction.evidenceBundle[0].text, source(2));
  assert.equal(job.sourceRefresh, true);
  assert.equal(job.baseSourceRevision, 1);
  assert.equal(job.targetSourceRevision, 2);
  assert.equal(job.sourceInput.content, url);
  assertPublic(service.state());
});

test("an understanding failure keeps the old signed result and retries the newly read checkpoint", async (t) => {
  let reads = 0, calls = 0;
  const { service, privateState } = await fixture(t, {
    fetchPage: async () => ({ url, type: "text/plain", text: source(++reads) }),
    model: (callId, context) => { calls += 1; if (calls === 2) throw fail("MODEL_PROVIDER_ERROR"); return model(callId, context); },
  });
  const first = await capture(service), before = (await privateState()).collections[0];
  await service.refreshSource({ collectionId: first.collectionId });
  await service.idle();
  assert.equal((await privateState()).collections[0].receipt, before.receipt);
  const retried = await service.retry({ collectionId: first.collectionId });
  assert.equal(retried.job.sourceRefresh, true, "The existing collection retry route must preserve refresh semantics too");
  await service.idle();
  const item = (await privateState()).collections[0];
  assert.equal(reads, 2, "The explicit refresh's successful source read is reusable after model failure");
  assert.equal(calls, 3);
  assert.equal(item.sourceRevision, 2);
  assert.equal(item.sourceHistory.length, 1);
  assert.equal(item.extraction.evidenceBundle[0].text, source(2));
  assertPublic(service.state());
});

test("source refresh rejects non-links, missing collections, active work and unconfigured AI", async (t) => {
  let release, announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const { service, releases } = await fixture(t, { fetchPage: async () => {
    reads += 1;
    if (reads === 2) { announce(); await gate; }
    return { url, type: "text/plain", text: source(reads) };
  } });
  releases.push(release);
  const first = await capture(service);
  const text = await service.capture({ mode: "text", content: source(1) });
  await service.idle();
  await assert.rejects(service.refreshSource({ collectionId: text.collectionId }), { code: "SOURCE_REFRESH_NOT_SUPPORTED" });
  await assert.rejects(service.refreshSource({ collectionId: "missing-collection" }), { code: "NOT_FOUND" });
  await service.refreshSource({ collectionId: first.collectionId });
  await started;
  await assert.rejects(service.refreshSource({ collectionId: first.collectionId }), { code: "JOB_RUNNING" });
  release(); await service.idle();
  assert.equal(service.state().jobs.filter((entry) => entry.sourceRefresh).length, 1);
  const offline = await fixture(t, { aiEnabled: false, fetchPage: () => { throw new Error("Disabled AI must not read sources"); }, model: () => { throw new Error("Disabled AI must not call a model"); } });
  const saved = await offline.service.capture({ mode: "link", content: url });
  await assert.rejects(offline.service.refreshSource({ collectionId: saved.collectionId }), { code: "AI_DISABLED" });
  assert.equal(offline.service.state().jobs.length, 0);
});
