import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";
import { sign, verify } from "../server/receipts.mjs";

// Every state mutation below targets a fresh disposable fixture, never a user's
// directory. Injected dependencies make provider/network calls impossible.
const config = { zhipuApiKey: "", textModel: "boundary-fixture", timeoutMs: 1000 };
const answer = () => ({ choices: [{ message: { content: "只根据当前有效资料回答。" } }] });
const failure = () => Object.assign(new Error("fixture failure"), { code: "MODEL_PROVIDER_ERROR" });
function model(callId, context) {
  const trace = { callId, model: "injected-boundary-fixture" };
  if (callId === "CALL-P001") {
    const refs = [context.evidence_bundle[0].evidence_id];
    const summary = (context.user_corrections?.[0]?.text || context.normalized_content.text).slice(0, 180);
    return { trace, output: { status: "candidate", summary, summary_evidence_ids: refs,
      digest: { status: "compact", overview: summary, evidence_ids: refs, highlights: [{ text: summary, evidence_ids: refs }] },
      breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "来源与判断", evidence_ids: refs }], content_reliability_score: 0.95, uncertainties: [] } };
  }
  if (callId === "CALL-P002") {
    const refs = context.eligible_extractions.map((item) => item.evidenceBundle[0].evidence_id);
    return { trace, output: { status: "candidate", themes: [{ id: "boundary-theme", title: "来源与判断", evidence_ids: refs, connections: [{ connection_id: "boundary-connection", text: "材料关注共同的判断问题。", evidence_ids: refs.slice(0, 2) }] }] } };
  }
  if (callId === "CALL-P003") {
    const items = context.eligible_exhibits.slice(0, 6), refs = items.map((item) => item.evidenceBundle[0].evidence_id);
    if (context.room_plan) return { trace, output: {
      status: "candidate", title: "边界测试展览", curatorial_lens: "balanced",
      curatorial_note: { text: "从来源寻找联系。", statement_type: "hypothesis", evidence_ids: refs },
      room_narrative: { title: "保留判断", introduction: "材料之间的联系。", claims: items.map((item) => ({ text: "证据允许用户核对。", statement_type: "extraction", evidence_ids: [item.evidenceBundle[0].evidence_id] })) },
      connection_claims: [{ connection_id: "boundary-connection", text: "来源可能关注同一问题。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }],
      open_question: "还有哪些证据？",
    } };
    return { trace, output: { status: "candidate", title: "边界测试展览", curatorial_note: { text: "从来源寻找联系。", evidence_ids: refs.slice(0, 1) },
      rooms: [{ id: "boundary-room", title: "保留判断", introduction: "材料之间的联系。", exhibit_ids: items.map((item) => item.item_id), claims: [{ text: "证据允许用户核对。", statement_type: "extraction", evidence_ids: refs.slice(0, 1) }] }],
      connection_claims: [{ connection_id: "boundary-connection", text: "来源可能关注同一问题。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }], open_question: "还有哪些证据？" } };
  }
  if (callId === "CALL-PEVAL") return { trace, output: { status: "evaluated", narrative_coherence: { score: 4 }, grounding_findings: [], fact_inference_findings: [], overinterpretation_findings: [], user_constraint_conflicts: [], connection_assessments: [{ connection_id: "boundary-connection", score: 4 }] } };
  throw new Error(`Unexpected fixture call ${callId}`);
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-harness-boundary-"));
  const services = [];
  const open = async () => {
    const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, model, chat: async () => answer(), fetchPage: () => { throw new Error("Network is forbidden in boundary fixtures"); }, ...overrides });
    services.push(service);
    return service;
  };
  t.after(async () => { for (const service of services) await service.close(); await rm(directory, { recursive: true, force: true }); });
  const stateFile = path.join(directory, "state.json");
  const patchClosedState = async (mutate) => {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    mutate(state);
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  };
  return { service: await open(), open, patchClosedState };
}
async function seedSix(service) {
  for (let index = 1; index <= 6; index++) await service.capture({ mode: "text", title: `独立来源 ${index}`, content: `第 ${index} 份独立来源强调保留原始证据，让用户能够核对材料，并把最终判断留给人。` });
  await service.idle();
  assert.equal(service.state().collections.filter((item) => item.status === "ready").length, 6);
}

test("pending rewrite feedback keeps old understanding out of collection retrieval", { timeout: 20000 }, async (t) => {
  let observed;
  const kit = await fixture(t, { chat: async (_config, input) => { observed = input; return answer(); } });
  const marker = "OLD_UNDERSTANDING_MUST_NOT_REACH_MODEL";
  const saved = await kit.service.capture({ mode: "text", title: "冻土观察", content: `冻土观察旧理解的私有测试标记：${marker}，这份原文有足够长度形成经过证据校验的收藏。` });
  await kit.service.idle();
  await kit.service.workspace({ ops: [{ field: "feedback", key: `understanding:${saved.collectionId}`, value: { decision: "pending_rewrite", correctionPrompt: "旧理解需要核对，请勿当作已确认结论。" } }] });
  await kit.service.close();
  // Isolate retrieval from old conversational quotations of the same summary.
  await kit.patchClosedState((state) => { state.messages = []; });
  const reopened = await kit.open();
  await reopened.send({ text: "之前收藏的冻土观察讲了什么？" });
  await reopened.idle();
  assert.ok(observed);
  const prompt = JSON.stringify(observed.messages);
  assert.ok(prompt.includes("冻土观察"), "The collection should remain discoverable by title");
  assert.equal(prompt.includes(marker), false, "Neither stale summary nor its evidence may enter a new retrieval");
  assert.match(prompt, /待核对|尚未完成|not_ready|needs_review/, "The model should be told the understanding is not confirmed");
  assert.equal(reopened.state().collections.length, 1);
});

test("a changed source rejects an old curation retry before any model call", { timeout: 20000 }, async (t) => {
  const calls = [];
  let fail = true;
  const { service } = await fixture(t, { model: async (callId, context) => {
    calls.push(callId);
    if (callId === "CALL-PEVAL" && fail) { fail = false; throw failure(); }
    return model(callId, context);
  } });
  await seedSix(service);
  const queued = await service.curate();
  await service.idle();
  assert.equal(service.state().jobs.find((job) => job.id === queued.job.id).status, "failed");
  await service.revise({ collectionId: service.state().collections[0].id, correction: "用户确认的新理解：这条来源讨论的是判断责任，不是简单提升处理效率。" });
  await service.idle();
  assert.equal(service.state().collections[0].status, "ready");
  const before = calls.length, jobsBefore = service.state().jobs.length;
  await assert.rejects(service.retryJob({ jobId: queued.job.id }), { code: "SOURCE_CHANGED", statusCode: 409 });
  await service.idle();
  assert.equal(calls.length, before, "Stale curation must be rejected before a model invocation");
  assert.equal(service.state().jobs.length, jobsBefore, "Rejection must not enqueue a child run");
  assert.equal(service.state().exhibitions.length, 0);
});

for (const checkpoint of ["discover", "compose"]) for (const corruption of ["damaged", "expired", "missing"]) {
  test(`${corruption} ${checkpoint} receipt invalidates the dependent checkpoint chain`, { timeout: 20000 }, async (t) => {
    const calls = [];
    let fail = true;
    const kit = await fixture(t, { model: async (callId, context) => {
      calls.push(callId);
      if (callId === "CALL-PEVAL" && fail) { fail = false; throw failure(); }
      return model(callId, context);
    } });
    await seedSix(kit.service);
    const queued = await kit.service.curate();
    await kit.service.idle();
    assert.equal(kit.service.state().jobs.find((job) => job.id === queued.job.id).status, "failed");
    await kit.service.close();
    await kit.patchClosedState((state) => {
      const saved = state.jobs.find((job) => job.id === queued.job.id).harness.checkpoints;
      assert.ok(saved.discover?.value.receipt && saved.compose?.value.receipt);
      const purpose = checkpoint === "discover" ? "theme" : "exhibition-candidate";
      if (corruption === "missing") delete saved[checkpoint].value.receipt;
      else saved[checkpoint].value.receipt = corruption === "damaged" ? "invalid-signature" : sign(verify(saved[checkpoint].value.receipt, purpose), purpose, -1);
    });
    const reopened = await kit.open();
    const retried = await reopened.retryJob({ jobId: queued.job.id });
    await reopened.idle();
    assert.equal(reopened.state().jobs.find((job) => job.id === retried.job.id).status, "complete");
    assert.equal(calls.filter((call) => call === "CALL-P002").length, checkpoint === "discover" ? 2 : 1);
    assert.equal(calls.filter((call) => call === "CALL-P003").length, 2, "Composition must run again if its own or the preceding receipt is invalid");
    assert.equal(calls.filter((call) => call === "CALL-PEVAL").length, 2);
    assert.equal(reopened.state().exhibitions.length, 1);
    assert.equal(reopened.state().collections.length, 6);
  });
}

test("YouTube ingestion keeps its official title and cover without treating watch-page metadata as transcript evidence", { timeout: 20000 }, async (t) => {
  const reads = [];
  let calls = 0;
  const { service } = await fixture(t, { fetchPage: (url, _, { representation }) => {
    reads.push({ url, representation });
    if (representation === "metadata") return { type: "application/json", text: JSON.stringify({ provider_name: "YouTube", title: "A real video title" }) };
    throw new Error("Cover network unavailable");
  }, model: () => { calls += 1; throw new Error("An unavailable transcript must not reach the model"); } });
  const saved = await service.capture({ mode: "link", content: "https://www.youtube.com/watch?v=fixture1234" });
  await service.idle();
  const state = service.state(), job = state.jobs.find((entry) => entry.id === saved.job.id);
  assert.deepEqual(reads.map(read => read.representation), ["metadata", "cover", "cover"]);
  assert.equal(new URL(reads[0].url).searchParams.get("url"), "https://www.youtube.com/watch?v=fixture1234");
  assert.equal(calls, 0);
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "WORKER_NOT_CONFIGURED");
  const preview = job.harness.steps.find((step) => step.name === "source");
  assert.equal(preview?.status, "complete");
  assert.equal(preview?.label, "读取视频标题与封面");
  assert.equal(state.collections.length, 1);
  assert.equal(state.collections[0].url, "https://www.youtube.com/watch?v=fixture1234");
  assert.equal(state.collections[0].title, "A real video title");
  assert.equal(state.collections[0].type, "video");
  assert.equal(state.collections[0].thumbnail, "https://i.ytimg.com/vi/fixture1234/mqdefault.jpg");
  assert.equal(state.collections[0].knowledgeDocumentVersionId, undefined);
});
