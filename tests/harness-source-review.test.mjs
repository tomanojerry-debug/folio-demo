import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";
import { verify } from "../server/receipts.mjs";

const config = { zhipuApiKey: "", textModel: "source-review-fixture", timeoutMs: 1000 };
function model(callId, context) {
  const trace = { callId, model: "injected-source-review-fixture" };
  if (callId === "CALL-P001") {
    const refs = [context.evidence_bundle[0].evidence_id], summary = context.normalized_content.text;
    return { trace, output: { status: "candidate", summary, summary_evidence_ids: refs,
      digest: { status: "compact", overview: summary, evidence_ids: refs, highlights: [{ text: summary, evidence_ids: refs }] },
      breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "证据与判断", evidence_ids: refs }], content_reliability_score: 0.95, uncertainties: [] } };
  }
  if (callId === "CALL-P002") {
    const refs = context.eligible_extractions.map((item) => item.evidenceBundle[0].evidence_id);
    return { trace, output: { status: "candidate", themes: [{ id: "review-theme", title: "证据与判断", evidence_ids: refs, connections: [{ connection_id: "review-connection", text: "来源有共同的判断问题。", evidence_ids: refs.slice(0, 2) }] }] } };
  }
  if (callId === "CALL-P003") {
    const items = context.eligible_exhibits.slice(0, 6), refs = items.map((item) => item.evidenceBundle[0].evidence_id);
    return { trace, output: { status: "candidate", title: "来源的边界", curatorial_note: { text: "根据可核对的来源寻找联系。", evidence_ids: refs.slice(0, 1) },
      rooms: [{ id: "review-room", title: "判断与来源", introduction: "材料关注相似的问题。", exhibit_ids: items.map((item) => item.item_id), claims: [{ text: "来源让人继续核对。", statement_type: "extraction", evidence_ids: refs.slice(0, 1) }] }],
      connection_claims: [{ connection_id: "review-connection", text: "两条材料可能关注同一个问题。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }], open_question: "还需要什么证据？" } };
  }
  if (callId === "CALL-PEVAL") return { trace, output: { status: "evaluated", narrative_coherence: { score: 4 }, grounding_findings: [], fact_inference_findings: [], overinterpretation_findings: [], user_constraint_conflicts: [], connection_assessments: [{ connection_id: "review-connection", score: 4 }] } };
  throw new Error(`Unexpected fixture call ${callId}`);
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-source-review-")), services = [];
  let reads = 0;
  const open = async () => {
    const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, model,
      fetchPage: async (url) => ({ url, type: "text/plain", text: `实际来源第 ${++reads} 版：可靠的辅助工具需要保留原始证据，让用户可以核对材料，并把最终判断留给人。` }),
    });
    services.push(service); return service;
  };
  t.after(async () => { for (const service of services) await service.close(); await rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, "state.json");
  return { service: await open(), open, privateState: async () => JSON.parse(await readFile(file, "utf8")),
    patchClosed: async (mutate) => { const state = JSON.parse(await readFile(file, "utf8")); mutate(state); await writeFile(file, JSON.stringify(state), { mode: 0o600 }); },
  };
}
async function seed(kit, refresh = false) {
  for (let index = 1; index <= 6; index++) await kit.service.capture({ mode: "link", content: `https://example.com/source-${index}` });
  await kit.service.idle();
  if (refresh) { await kit.service.refreshSource({ collectionId: kit.service.state().collections[0].id }); await kit.service.idle(); }
  const queued = await kit.service.curate(); await kit.service.idle();
  const exhibition = kit.service.state().exhibitions.find((item) => item.id === kit.service.state().jobs.find((job) => job.id === queued.job.id).exhibitionId);
  assert.equal(exhibition.status, "preview");
  return { exhibitionId: exhibition.id, collectionId: kit.service.state().collections[0].id };
}
function assertPublic(value) {
  if (Array.isArray(value)) { value.forEach(assertPublic); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(["receipt", "receipts", "sourceHistory", "sourceInput", "sourceResult", "checkpoints", "input"].includes(key), false, `Private proof/history leaked: ${key}`);
    assertPublic(child);
  }
}

for (const decision of ["pending_rewrite", "confirmed_edited"]) {
  test(`${decision} feedback marks an existing exhibition for human review without rewriting its signed model result`, async (t) => {
    const kit = await fixture(t), { service } = kit;
    const { exhibitionId, collectionId } = await seed(kit, true);
    const baseline = (await kit.privateState()).exhibitions.find((item) => item.id === exhibitionId);
    const messages = service.state().messages.length;
    const feedback = { ops: [{ field: "feedback", key: `understanding:${collectionId}`, value: { decision, correctionPrompt: "人工审查发现原理解仍有残余错误，需要重新核对来源。" } }] };
    const response = await service.workspace(feedback);
    const projected = response.state.exhibitions.find((item) => item.id === exhibitionId);
    assert.equal(projected.status, "needs_review");
    assert.equal(projected.sourceReviewPending, true);
    assert.deepEqual(projected.sourceReviewCollectionIds, [collectionId]);
    assert.ok(projected.sourceReviewPendingAt);
    const stored = (await kit.privateState()).exhibitions.find((item) => item.id === exhibitionId);
    assert.equal(stored.status, "preview");
    assert.equal(stored.receipt, baseline.receipt);
    assert.deepEqual(stored.evaluation, baseline.evaluation);
    assert.deepEqual(stored.traces, baseline.traces);
    assert.equal(verify(stored.receipt, "exhibition").status, "preview");
    assert.deepEqual(verify(stored.receipt, "exhibition").evaluation, baseline.evaluation);
    assertPublic(response);
    await service.workspace(feedback);
    const repeated = service.state().exhibitions.find((item) => item.id === exhibitionId);
    assert.deepEqual(repeated.sourceReviewCollectionIds, [collectionId]);
    assert.equal(repeated.sourceReviewPendingAt, projected.sourceReviewPendingAt);
    assert.equal(service.state().messages.length, messages, "Repeated human feedback must not duplicate notifications");
    await service.workspace({ ops: [{ field: "feedback", key: `understanding:${collectionId}`, value: { decision: "confirmed" } }] });
    await service.workspace({ ops: [{ field: "feedback", key: `understanding:${collectionId}`, delete: true }] });
    assert.equal(service.state().exhibitions.find((item) => item.id === exhibitionId).status, "needs_review", "Clearing source feedback must not silently approve an old exhibition");
    await service.close();
    const reopened = await kit.open();
    assert.equal(reopened.state().exhibitions.find((item) => item.id === exhibitionId).status, "needs_review");
    const queued = await reopened.curate(); await reopened.idle();
    const newId = reopened.state().jobs.find((job) => job.id === queued.job.id).exhibitionId;
    assert.notEqual(newId, exhibitionId);
    assert.equal(reopened.state().exhibitions.find((item) => item.id === newId).status, "preview", "A new independently assessed exhibition has its own result");
    assert.equal(reopened.state().exhibitions.find((item) => item.id === exhibitionId).status, "needs_review");
    assertPublic(reopened.state());
  });
}

test("ordinary notes, other feedback kinds and unrelated sources do not downgrade an exhibition", async (t) => {
  const kit = await fixture(t), { service } = kit;
  const { exhibitionId, collectionId } = await seed(kit);
  const extra = await service.capture({ mode: "text", content: "这条新收藏不属于已经生成的展览，因此它的人工反馈不应该影响那场旧展览。" }); await service.idle();
  await service.workspace({ ops: [
    { field: "notes", key: collectionId, value: "普通观展批注。" },
    { field: "feedback", key: `tags:${collectionId}`, value: { decision: "pending_rewrite" } },
    { field: "feedback", key: `understanding:${extra.collectionId}`, value: { decision: "pending_rewrite" } },
    { field: "feedback", key: "understanding:unknown-source", value: { decision: "confirmed_edited" } },
  ] });
  const exhibition = service.state().exhibitions.find((item) => item.id === exhibitionId);
  assert.equal(exhibition.status, "preview");
  assert.equal(exhibition.sourceReviewPending, undefined);
  assertPublic(service.state());
});

test("legacy pipeline source IDs still match a reviewed source after a source refresh", async (t) => {
  const kit = await fixture(t), { service } = kit;
  const { exhibitionId, collectionId } = await seed(kit);
  const original = (await kit.privateState()).exhibitions.find((item) => item.id === exhibitionId);
  await service.refreshSource({ collectionId }); await service.idle();
  await service.close();
  await kit.patchClosed((state) => { delete state.exhibitions.find((item) => item.id === exhibitionId).collectionIds; });
  const reopened = await kit.open();
  const response = await reopened.workspace({ ops: [{ field: "feedback", key: `understanding:${collectionId}`, value: { decision: "pending_rewrite" } }] });
  assert.equal(response.state.exhibitions.find((item) => item.id === exhibitionId).status, "needs_review");
  const stored = (await kit.privateState()).exhibitions.find((item) => item.id === exhibitionId);
  assert.equal(stored.receipt, original.receipt);
  assert.deepEqual(stored.evaluation, original.evaluation);
  assert.deepEqual(stored.sourceReviewCollectionIds, [collectionId]);
  assertPublic(response);
});
