import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";

// Product scenarios use the real evidence/signing pipeline with an injected
// model. They never need .env, network access, or a developer's private state.
const config = { zhipuApiKey: "", textModel: "harness-fixture", timeoutMs: 1000 };
const answer = (content = "根据已有资料继续讨论。") => ({ choices: [{ message: { content } }] });
const providerFailure = () => Object.assign(new Error("injected provider failure"), { code: "MODEL_PROVIDER_ERROR" });

function fixtureModel(callId, context) {
  const trace = { callId, model: "harness-injected-fixture", createdAt: new Date().toISOString() };
  if (callId === "CALL-P001") {
    const refs = [context.evidence_bundle[0].evidence_id];
    const summary = context.normalized_content.text.slice(0, 180);
    return { trace, output: {
      status: "candidate", summary, summary_evidence_ids: refs,
      digest: { status: "compact", overview: summary, evidence_ids: refs, highlights: [{ text: summary, evidence_ids: refs }] },
      breakdown: { status: "not_applicable", sections: [] },
      concepts: [{ value: "来源与判断", evidence_ids: refs }],
      content_reliability_score: 0.95, uncertainties: [],
    } };
  }
  if (callId === "CALL-P002") {
    const refs = context.eligible_extractions.map((entry) => entry.evidenceBundle[0].evidence_id);
    return { trace, output: { status: "candidate", themes: [{
      id: "theme-harness", title: "来源与判断", evidence_ids: refs,
      connections: [{ connection_id: "connection-harness", text: "多条收藏共同讨论证据与判断。", evidence_ids: refs.slice(0, 2) }],
    }] } };
  }
  if (callId === "CALL-P003") {
    const entries = context.eligible_exhibits.slice(0, 6);
    const refs = entries.map((entry) => entry.evidenceBundle[0].evidence_id);
    if (context.room_plan) return { trace, output: {
      status: "candidate", title: "判断与证据", curatorial_lens: "balanced", curatorial_note: { text: "从可核对的材料中寻找联系。", statement_type: "hypothesis", evidence_ids: refs },
      room_narrative: { title: "保留来源", introduction: "比较材料中的共同问题。", claims: entries.map((entry) => ({ text: "来源允许人继续核对。", statement_type: "extraction", evidence_ids: [entry.evidenceBundle[0].evidence_id] })) },
      connection_claims: [{ connection_id: "connection-harness", text: "材料之间可能存在共同的关注点。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }],
      open_question: "什么证据可以帮助你进一步判断？",
    } };
    return { trace, output: {
      status: "candidate", title: "判断与证据", curatorial_note: { text: "从可核对的材料中寻找联系。", evidence_ids: refs.slice(0, 1) },
      rooms: [{ id: "room-harness", title: "保留来源", introduction: "比较材料中的共同问题。", exhibit_ids: entries.map((entry) => entry.item_id), claims: [{ text: "来源允许人继续核对。", statement_type: "extraction", evidence_ids: refs.slice(0, 1) }] }],
      connection_claims: [{ connection_id: "connection-harness", text: "材料之间可能存在共同的关注点。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }],
      open_question: "什么证据可以帮助你进一步判断？",
    } };
  }
  if (callId === "CALL-PEVAL") return { trace, output: {
    status: "evaluated", narrative_coherence: { score: 4 }, grounding_findings: [], fact_inference_findings: [],
    overinterpretation_findings: [], user_constraint_conflicts: [],
    connection_assessments: [{ connection_id: "connection-harness", score: 4 }],
  } };
  throw new Error(`Unexpected fixture model call: ${callId}`);
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-harness-product-"));
  const service = await createDesktopService({
    directory, config, aiEnabled: true, autoCurate: false, model: fixtureModel,
    chat: async () => answer(),
    fetchPage: () => { throw new Error("Product fixtures must not fetch the network"); },
    ...overrides,
  });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory, privateState: async () => JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")) };
}

async function seedSix(service) {
  for (let index = 1; index <= 6; index++) await service.capture({
    mode: "text", title: `来源材料 ${index}`,
    content: `第 ${index} 条独立的来源材料：可靠工具应当保留原始证据，让使用者继续核对，并把最终判断交给人。`,
  });
  await service.idle();
  assert.equal(service.state().collections.filter((entry) => entry.status === "ready").length, 6);
}

function assertPublic(value) {
  if (Array.isArray(value)) { value.forEach(assertPublic); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(["receipt", "receipts", "checkpoints", "input", "profileSnapshot"].includes(key), false, `Private job data leaked through ${key}`);
    assertPublic(child);
  }
}

test("harness retrieves a relevant older collection beyond the recent twelve", { timeout: 20000 }, async (t) => {
  let observed;
  const { service } = await fixture(t, { chat: async (_config, input) => { observed = input; return answer(); } });
  const marker = "北极冻土观察的独特证据：冻土温度监测必须保留连续观测记录。";
  await service.capture({ mode: "text", title: "北极冻土观察", content: marker });
  for (let index = 0; index < 14; index++) await service.capture({ mode: "text", title: `城市绿地 ${index}`, content: `第 ${index} 条城市绿地资料：公园和步行道路的设计，应当保留可以核对的调查记录，方便居民理解改造。` });
  await service.idle();
  await service.send({ text: "之前收藏的北极冻土观察，冻土温度监测需要保留什么？" });
  await service.idle();
  assert.ok(observed, "The conversation must reach the injected chat provider");
  assert.ok(JSON.stringify(observed.messages).includes(marker), "The relevant collection must survive recency filtering");
  assert.equal(service.state().collections.length, 15, "Retrieval must not create another collection");
  await assert.rejects(service.retryJob({ jobId: service.state().jobs.find((entry) => entry.type === "ingest").id }), { code: "JOB_NOT_RETRYABLE" });
});

test("model identity stays out of the library and only cited current-turn sources are persisted", async (t) => {
  const observed = [];
  let invalidCalls = 0;
  const { service, directory, privateState } = await fixture(t, { chat: async (_config, input) => {
    observed.push(input);
    const reference = input.messages.find((entry) => entry.content.startsWith("策展参考资料"));
    const sources = JSON.parse(reference.content.slice(reference.content.indexOf("\n") + 1)).collections;
    if (!sources.length) return answer("当前使用 GLM 模型。[[collection:invented-model-manual]]");
    if (input.messages.at(-1).content.includes("不引用资料")) return answer("这次只聊一般看法。");
    if (input.messages.at(-1).content.includes("只剩标记") && invalidCalls++ === 0) return answer(`[[collection:${sources[0].id}]]`);
    return answer(`第一篇介绍了模型调用。[[collection:${sources[0].id}]][[collection:${sources[0].id}]][[collection:invented-source]]`);
  } });
  for (const title of ["Quick AI | Raycast Manual", "介绍 – JavaScript | MDN", "二十六分钟认识本地智能体"]) {
    await service.capture({ mode: "text", title, content: `${title}：这份模型资料说明背后的大模型、对象模型或智能体调用方式。阅读资料时应保留原始证据和上下文，方便人继续核对解释。` });
  }
  await service.idle();
  await service.send({ text: "你背后用的什么模型" });
  await service.idle();
  let state = service.state();
  const identity = state.messages.at(-1);
  assert.equal(identity.text, "当前使用 GLM 模型。");
  assert.deepEqual(identity.relatedCollectionIds, []);
  assert.equal(identity.referenceAttribution, "explicit_citations");
  assert.equal(identity.contextTruncated, false);
  assert.deepEqual(state.jobs.find((job) => job.id === identity.jobId).contextManifest.itemIds, []);

  await service.send({ text: "比较一下收藏里的模型资料" });
  await service.idle();
  state = service.state();
  const cited = state.messages.at(-1);
  const manifest = state.jobs.find((job) => job.id === cited.jobId).contextManifest;
  assert.equal(manifest.itemIds.length, 3, "All retrieved candidates remain auditable");
  assert.deepEqual(cited.relatedCollectionIds, [manifest.itemIds[0]], "Only the one cited candidate becomes a visible reference");
  assert.equal(cited.text, "第一篇介绍了模型调用。");
  assert.equal(cited.referenceAttribution, "explicit_citations");
  assert.match(JSON.stringify(observed[1].messages.filter((entry) => entry.role === "system")), /\[\[collection:/);

  await service.send({ text: "聊聊收藏里的模型，但不引用资料" });
  await service.idle();
  const uncited = service.state().messages.at(-1);
  assert.deepEqual(uncited.relatedCollectionIds, [], "No citation must not fall back to retrieval candidates");
  assert.equal(service.state().jobs.find((job) => job.id === uncited.jobId).contextManifest.itemIds.length, 3);
  await service.send({ text: "解释收藏里的模型，只剩标记", intent: "chat", collectionIds: [manifest.itemIds[0]] });
  await service.idle();
  const invalid = service.state().jobs.at(-1);
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.errorCode, "MODEL_OUTPUT_INVALID");
  assert.doesNotMatch(service.state().messages.at(-1).text, /\[\[collection:/);
  const persisted = await privateState();
  assert.equal(persisted.jobs.find((job) => job.id === invalid.id).harness.checkpoints.answer, undefined, "Invalid output must not poison the retry checkpoint");
  await service.retryJob({ jobId: invalid.id });
  await service.idle();
  assert.equal(invalidCalls, 2);
  assert.equal(service.state().jobs.at(-1).status, "complete");
  assert.equal(service.state().messages.at(-1).relatedCollectionIds.length, 1);

  await service.close();
  const reopened = await createDesktopService({ directory, config, aiEnabled: false, autoCurate: false });
  t.after(() => reopened.close());
  const restored = reopened.state().messages.find((entry) => entry.id === cited.id);
  assert.deepEqual(restored.relatedCollectionIds, cited.relatedCollectionIds);
  assert.equal(restored.referenceAttribution, "explicit_citations");
  assert.equal(restored.text, cited.text);
});

test("harness freezes queued profile fields while preference revocation takes precedence", { timeout: 20000 }, async (t) => {
  let releaseFirst, firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const observed = [];
  const { service } = await fixture(t, { chat: async (_config, input) => {
    observed.push(input);
    if (observed.length === 1) { firstStarted(); await gate; }
    return answer();
  } });
  t.after(() => releaseFirst());
  const before = "提交时的稳定偏好：请关注自然光";
  const after = "排队之后的新偏好：请关注霓虹灯";
  await service.profile({ name: "拾", personality: "安静敏锐", preferences: before });
  await service.send({ text: "第一条占用队列的讨论" });
  await started;
  await service.send({ text: "第二条已经提交的讨论" });
  await service.profile({ name: "小光", personality: "直率", preferences: after });
  releaseFirst();
  await service.idle();
  assert.equal(observed.length, 2);
  const second = JSON.stringify(observed[1].messages);
  const profileFrom = input => {
    const reference = input.messages.find(item => item.content.startsWith("策展参考资料"));
    return JSON.parse(reference.content.slice(reference.content.indexOf("\n") + 1)).profile;
  };
  assert.equal(profileFrom(observed[1]).personality, "安静敏锐", "Non-memory profile fields keep their submission-time snapshot");
  assert.equal(profileFrom(observed[1]).name, "拾", "The queued run keeps its original curator name");
  assert.equal(second.includes(before), false, "Removing a preference in settings revokes it even for an older queued snapshot");
  assert.equal(second.includes(after), false, "A later-added preference must not enter the queued run's snapshot");
  assert.equal(service.state().jobs[0].status, "failed", "The first answer was already in flight when its preference was revoked");
  assert.equal(service.state().jobs[0].errorCode, "MEMORY_CHANGED");
  assert.equal(service.state().jobs[1].status, "complete");
  assert.equal(service.state().profile.preferences, after, "The current profile still keeps the user's later edit");
  await service.send({ text: "第三条更新后提交的讨论" });
  await service.idle();
  const third = JSON.stringify(observed[2].messages);
  assert.ok(third.includes(after), "A newly submitted turn receives the updated effective preference");
  assert.equal(profileFrom(observed[2]).name, "小光");
  assert.equal(profileFrom(observed[2]).personality, "直率");
});

for (const failingStage of ["CALL-P003", "CALL-PEVAL"]) {
  test(`harness retries ${failingStage} without repeating completed curation stages`, { timeout: 20000 }, async (t) => {
    const calls = [];
    let fail = true;
    const { service, privateState } = await fixture(t, { model: async (callId, context) => {
      calls.push(callId);
      if (callId === failingStage && fail) { fail = false; throw providerFailure(); }
      return fixtureModel(callId, context);
    } });
    await seedSix(service);
    const queued = await service.curate();
    assertPublic(queued);
    await service.idle();
    const failed = service.state().jobs.find((entry) => entry.id === queued.job.id);
    assert.equal(failed.status, "failed");
    assert.equal(service.state().exhibitions.length, 0);
    const stored = (await privateState()).jobs.find((entry) => entry.id === queued.job.id);
    assert.ok(stored.harness?.checkpoints && Object.keys(stored.harness.checkpoints).length > 0, "Completed stages must have durable checkpoints before retry");
    assertPublic(service.state());
    const retries = await Promise.all(Array.from({ length: 4 }, () => service.retryJob({ jobId: failed.id })));
    const retried = retries[0];
    assert.equal(new Set(retries.map((entry) => entry.job.id)).size, 1, "Concurrent clicks must create one retry run");
    assertPublic(retried);
    assert.notEqual(retried.job.id, failed.id, "Retry preserves the failed attempt as history");
    assert.equal(retried.job.retryOf, failed.id);
    await service.idle();
    assert.equal(service.state().jobs.find((entry) => entry.id === failed.id).status, "failed");
    assert.equal(service.state().jobs.find((entry) => entry.id === retried.job.id).status, "complete");
    assert.equal(service.state().exhibitions.length, 1);
    assert.equal(calls.filter((entry) => entry === "CALL-P002").length, 1, "Successful discovery must not incur another model call");
    assert.equal(calls.filter((entry) => entry === "CALL-P003").length, failingStage === "CALL-P003" ? 2 : 1);
    assert.equal(calls.filter((entry) => entry === "CALL-PEVAL").length, failingStage === "CALL-PEVAL" ? 2 : 1);
    assert.equal(service.state().collections.length, 6);
    assertPublic(service.state());
    const beforeRepeatedClick = calls.length;
    const repeated = await service.retryJob({ jobId: failed.id });
    assert.equal(repeated.job.id, retried.job.id, "Repeated retry clicks must reuse the same successful child run");
    await service.idle();
    assert.equal(calls.length, beforeRepeatedClick);
    assert.equal(service.state().exhibitions.length, 1, "A completed run must not publish its exhibition twice");
  });
}

test("harness retries a failed ingest without duplicating the original collection", { timeout: 20000 }, async (t) => {
  let fail = true;
  const { service } = await fixture(t, { model: async (callId, context) => {
    if (fail) { fail = false; throw providerFailure(); }
    return fixtureModel(callId, context);
  } });
  const first = await service.capture({ mode: "text", title: "同一份原始材料", content: "这份原始材料需要在整理失败时保留原文和稳定编号，重试不能制造另一条收藏。" });
  await service.idle();
  const failed = service.state().jobs.find((entry) => entry.collectionId === first.collectionId);
  assert.equal(failed.status, "failed");
  const retried = await service.retryJob({ jobId: failed.id });
  assertPublic(retried);
  assert.equal(retried.job.retryOf, failed.id);
  await service.idle();
  const state = service.state();
  assert.equal(state.collections.length, 1);
  assert.equal(state.collections[0].id, first.collectionId);
  assert.equal(state.collections[0].status, "ready");
  assert.equal(state.jobs.filter((entry) => entry.collectionId === first.collectionId).length, 2, "The retry retains failed-attempt history");
  const repeated = await service.retryJob({ jobId: failed.id });
  assert.equal(repeated.job.id, retried.job.id);
  assert.equal(service.state().collections.length, 1);
  assertPublic(service.state());
});

test("harness reuses the captured web source when understanding is retried", { timeout: 20000 }, async (t) => {
  let reads = 0, fail = true;
  const source = "第一次读取的真实正文：这份网页证据需要保留，让理解失败后的重试仍然基于同一份来源。";
  const { service } = await fixture(t, {
    fetchPage: async (url) => {
      reads += 1;
      assert.equal(url, "https://example.com/frozen-source");
      return { url, type: "text/plain", text: reads === 1 ? source : "后来已经变化的网页正文，不应悄悄替换本次任务首次读取的证据。" };
    },
    model: async (callId, context) => {
      if (fail) { fail = false; throw providerFailure(); }
      assert.equal(context.normalized_content.text, source);
      return fixtureModel(callId, context);
    },
  });
  const first = await service.capture({ mode: "link", content: "https://example.com/frozen-source" });
  await service.idle();
  assert.equal(reads, 1);
  assert.equal(service.state().collections[0].status, "failed");
  await service.retryJob({ jobId: first.job.id });
  await service.idle();
  assert.equal(reads, 1, "A successful read checkpoint must be reused rather than rereading changed web content");
  const item = service.state().collections[0];
  assert.equal(item.id, first.collectionId);
  assert.equal(item.status, "ready");
  assert.equal(item.extraction.evidenceBundle[0].text, source);
  assertPublic(service.state());
});

test("harness resumes a failed evaluation after reopening without regenerating its exhibition candidate", { timeout: 20000 }, async (t) => {
  const calls = [];
  let fail = true;
  const model = async (callId, context) => {
    calls.push(callId);
    if (callId === "CALL-PEVAL" && fail) { fail = false; throw providerFailure(); }
    return fixtureModel(callId, context);
  };
  const { service, directory } = await fixture(t, { model });
  await seedSix(service);
  const queued = await service.curate();
  await service.idle();
  assert.equal(service.state().jobs.find((entry) => entry.id === queued.job.id).status, "failed");
  await service.close();
  const reopened = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, model,
    chat: async () => answer(), fetchPage: () => { throw new Error("Reopening must not fetch a source again"); },
  });
  try {
    await reopened.idle();
    assert.equal(calls.filter((entry) => entry === "CALL-PEVAL").length, 1, "Reopening alone must not replay a failed run");
    const retried = await reopened.retryJob({ jobId: queued.job.id });
    await reopened.idle();
    assert.equal(reopened.state().jobs.find((entry) => entry.id === retried.job.id).status, "complete");
    assert.equal(calls.filter((entry) => entry === "CALL-P002").length, 1);
    assert.equal(calls.filter((entry) => entry === "CALL-P003").length, 1);
    assert.equal(calls.filter((entry) => entry === "CALL-PEVAL").length, 2);
    assert.equal(reopened.state().exhibitions.length, 1);
    assertPublic(reopened.state());
  } finally {
    await reopened.close();
  }
});
