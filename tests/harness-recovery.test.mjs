import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";

const config = { zhipuApiKey: "", textModel: "recovery-fixture", timeoutMs: 1000 };
const reply = (content) => ({ choices: [{ message: { content } }] });

function recoveryModel(callId, context) {
  const trace = { callId, model: "recovery-fixture" };
  if (callId === "CALL-P001") {
    const refs = [context.evidence_bundle[0].evidence_id];
    return { trace, output: { status: "candidate", summary: "收藏保留原始来源，让使用者继续核对并作出判断。", summary_evidence_ids: refs, digest: { status: "compact", overview: "保留证据", evidence_ids: refs, highlights: [{ text: "让人继续核对", evidence_ids: refs }] }, breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "证据", evidence_ids: refs }], content_reliability_score: 0.95, uncertainties: [] } };
  }
  if (callId === "CALL-P002") {
    const refs = context.eligible_extractions.map((item) => item.evidenceBundle[0].evidence_id);
    return { trace, output: { status: "candidate", themes: [{ id: "theme-recovery", title: "证据与判断", evidence_ids: refs, connections: [{ connection_id: "connection-recovery", text: "这些收藏共同讨论证据与判断。", evidence_ids: refs.slice(0, 2) }] }] } };
  }
  if (callId === "CALL-P003") {
    const items = context.eligible_exhibits.slice(0, 6);
    const refs = items.map((item) => item.evidenceBundle[0].evidence_id);
    if (context.room_plan) return { trace, output: { status: "candidate", title: "继续核对", curatorial_lens: "balanced", curatorial_note: { text: "保留来源可以支持下一步判断。", statement_type: "hypothesis", evidence_ids: refs }, room_narrative: { title: "原始证据", introduction: "逐项比较来源。", claims: items.map((item) => ({ text: "来源支持核对。", statement_type: "extraction", evidence_ids: [item.evidenceBundle[0].evidence_id] })) }, connection_claims: [{ connection_id: "connection-recovery", text: "材料之间有共同的关注点。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }] } };
    return { trace, output: { status: "candidate", title: "继续核对", curatorial_note: { text: "保留来源可以支持下一步判断。", evidence_ids: refs.slice(0, 1) }, rooms: [{ id: "room-recovery", title: "原始证据", exhibit_ids: items.map((item) => item.item_id), claims: [{ text: "来源支持核对。", statement_type: "extraction", evidence_ids: refs.slice(0, 1) }] }], connection_claims: [{ connection_id: "connection-recovery", text: "材料之间有共同的关注点。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }] } };
  }
  if (callId === "CALL-PEVAL") return { trace, output: { status: "evaluated", narrative_coherence: { score: 4 }, grounding_findings: [], fact_inference_findings: [], overinterpretation_findings: [], user_constraint_conflicts: [], connection_assessments: [{ connection_id: "connection-recovery", score: 4 }] } };
  throw new Error("Unexpected recovery model call");
}

async function fixture(t, overrides) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-harness-recovery-"));
  const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, model: recoveryModel, ...overrides });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return service;
}

test("a timed-out conversation releases the product queue and its late answer never appears", { timeout: 10000 }, async (t) => {
  let finishLate;
  let originalSignal;
  let calls = 0;
  const service = await fixture(t, {
    harnessLimits: { stepTimeoutMs: 50 },
    chat: async (_config, input) => {
      calls++;
      if (calls === 1) {
        originalSignal = input.signal;
        return new Promise((resolve) => { finishLate = () => resolve(reply("这是一条过期的晚到回答")); });
      }
      return reply("第二条消息已经正常回答");
    },
  });
  await service.send({ text: "第一条消息等待模型超时" });
  await service.send({ text: "第二条消息应继续处理" });
  await service.idle();
  const state = service.state();
  assert.deepEqual(state.jobs.map((job) => job.status), ["failed", "complete"]);
  assert.equal(state.jobs[0].errorCode, "HARNESS_TIMEOUT");
  assert.equal(originalSignal.aborted, true);
  assert.equal(calls, 2);
  assert.equal(state.messages.at(-1).text, "第二条消息已经正常回答");
  finishLate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.state().messages.some((message) => message.text.includes("过期的晚到回答")), false);
  assert.equal(service.state().jobs[0].harness.calls[0].status, "failed");
  assert.equal(service.state().collections.length, 0);
});

test("a one-call curation budget preserves progress and advances only on explicit retries", { timeout: 10000 }, async (t) => {
  const calls = [];
  const service = await fixture(t, {
    harnessLimits: { maxModelCalls: 1 },
    model: (callId, context) => { calls.push(callId); return recoveryModel(callId, context); },
  });
  for (let index = 0; index < 6; index++) await service.capture({ mode: "text", content: `第${index}份来源材料：可靠的收藏工具需要保留原始证据，让使用者能回到材料继续核对并且自行判断。` });
  await service.idle();
  const first = await service.curate();
  await service.idle();
  assert.equal(service.state().jobs.find((job) => job.id === first.job.id).errorCode, "HARNESS_BUDGET_EXCEEDED");
  assert.equal(calls.filter((call) => call === "CALL-P002").length, 1);
  assert.equal(calls.includes("CALL-P003"), false);
  assert.equal(service.state().exhibitions.length, 0);
  const second = await service.retryJob({ jobId: first.job.id });
  await service.idle();
  assert.equal(service.state().jobs.find((job) => job.id === second.job.id).errorCode, "HARNESS_BUDGET_EXCEEDED");
  assert.equal(calls.filter((call) => call === "CALL-P002").length, 1);
  assert.equal(calls.filter((call) => call === "CALL-P003").length, 1);
  assert.equal(calls.includes("CALL-PEVAL"), false);
  const third = await service.retryJob({ jobId: second.job.id });
  await service.idle();
  assert.equal(service.state().jobs.find((job) => job.id === third.job.id).status, "complete");
  assert.equal(calls.filter((call) => call === "CALL-P002").length, 1);
  assert.equal(calls.filter((call) => call === "CALL-P003").length, 1);
  assert.equal(calls.filter((call) => call === "CALL-PEVAL").length, 1);
  assert.equal(service.state().exhibitions.length, 1);
  assert.equal(service.state().jobs.filter((job) => job.type === "curate").every((job) => job.harness.calls.length === 1), true);
});

test("replaying a legacy collection retry after success cannot leave the collection processing", { timeout: 10000 }, async (t) => {
  let calls = 0;
  const service = await fixture(t, { model: (callId, context) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("injected first failure"), { code: "MODEL_PROVIDER_ERROR" });
    return recoveryModel(callId, context);
  } });
  const captured = await service.capture({ mode: "text", content: "可靠的收藏工具保留原始证据，让使用者能继续核对并自行判断。" });
  await service.idle();
  assert.equal(service.state().collections[0].status, "failed");
  const retried = await service.retry({ collectionId: captured.collectionId });
  await service.idle();
  assert.equal(service.state().collections[0].status, "ready");
  const replayed = await service.retry({ collectionId: captured.collectionId });
  await service.idle();
  assert.equal(replayed.job.id, retried.job.id);
  assert.equal(service.state().collections[0].status, "ready");
  assert.equal(service.state().jobs.length, 2);
  assert.equal(calls, 2);
});

test("an old retry request cannot create another billable attempt after its child fails", { timeout: 10000 }, async (t) => {
  let calls = 0;
  const service = await fixture(t, { chat: async () => {
    calls++;
    throw Object.assign(new Error("injected repeated provider failure"), { code: "MODEL_PROVIDER_ERROR" });
  } });
  await service.send({ text: "讨论一下这次失败应该如何处理" });
  await service.idle();
  const ancestor = service.state().jobs[0];
  const second = await service.retryJob({ jobId: ancestor.id });
  await service.idle();
  assert.equal(service.state().jobs.find((job) => job.id === second.job.id).status, "failed");
  const replays = await Promise.all(Array.from({ length: 4 }, () => service.retryJob({ jobId: ancestor.id })));
  await service.idle();
  assert.equal(replays.every((value) => value.job.id === second.job.id), true);
  assert.equal(service.state().jobs.length, 2);
  assert.equal(calls, 2);
  const third = await service.retryJob({ jobId: second.job.id });
  await service.idle();
  assert.notEqual(third.job.id, second.job.id);
  assert.equal(service.state().jobs.length, 3);
  assert.equal(calls, 3);
});

test("normalizing an HTML source checkpoint preserves the real article title", { timeout: 10000 }, async (t) => {
  const articleTitle = "设计如何支持人的判断";
  let reads = 0;
  let observedTitle;
  const service = await fixture(t, {
    fetchPage: async (url) => {
      reads++;
      return { url, type: "text/html; charset=utf-8", text: `<html><head><title>${articleTitle}</title></head><body><article><p>可靠的收藏工具应当保留原始材料，让使用者回到来源继续核对，而不是用模型猜测代替人的判断。</p></article></body></html>` };
    },
    model: (callId, context) => { observedTitle = context.normalized_content.title; return recoveryModel(callId, context); },
  });
  const captured = await service.capture({ mode: "link", content: "https://example.com/article-with-title" });
  await service.idle();
  const item = service.state().collections.find((entry) => entry.id === captured.collectionId);
  assert.equal(item.status, "ready");
  assert.equal(item.title, articleTitle);
  assert.equal(observedTitle, articleTitle);
  assert.equal(reads, 1);
});

test("an old failed correction cannot overwrite a later successful independent revision", { timeout: 10000 }, async (t) => {
  const oldCorrection = "这是一条后来已经过时的修改说明";
  const newCorrection = "新的理解应当保留人的判断与来源边界";
  let calls = 0;
  const service = await fixture(t, { model: (callId, context) => {
    calls++;
    const correction = context.user_corrections?.[0]?.text;
    if (correction === oldCorrection) throw Object.assign(new Error("injected old correction failure"), { code: "MODEL_PROVIDER_ERROR" });
    const result = recoveryModel(callId, context);
    if (correction) result.output.summary = correction;
    return result;
  } });
  const captured = await service.capture({ mode: "text", content: "可靠的收藏工具保留原始来源，让使用者可以回到证据继续核对并作出自己的判断。" });
  await service.idle();
  const oldRevision = await service.revise({ collectionId: captured.collectionId, correction: oldCorrection });
  await service.idle();
  assert.equal(service.state().jobs.find((job) => job.id === oldRevision.job.id).status, "failed");
  const newRevision = await service.revise({ collectionId: captured.collectionId, correction: newCorrection });
  await service.idle();
  assert.equal(service.state().jobs.find((job) => job.id === newRevision.job.id).status, "complete");
  assert.equal(service.state().collections[0].summary, newCorrection);
  await assert.rejects(service.retryJob({ jobId: oldRevision.job.id }), { code: "SOURCE_CHANGED" });
  await assert.rejects(service.retry({ collectionId: captured.collectionId }), { code: "SOURCE_CHANGED" });
  await service.idle();
  assert.equal(calls, 3);
  assert.equal(service.state().jobs.length, 3);
  assert.equal(service.state().collections[0].status, "ready");
  assert.equal(service.state().collections[0].summary, newCorrection);
});
