import test from "node:test";
import assert from "node:assert/strict";
import { curate, evaluate } from "../server/pipeline.mjs";
import { executeCall } from "../server/ai/ai-service.mjs";
import { CURATION_PLAN_MODE } from "../server/curation-plan.mjs";
import { sign, verify } from "../server/receipts.mjs";

process.env.FORME_SESSION_SECRET = "test-only-recovery-integration-secret-over-32-characters";
function fixture(count = 6, supported = count) {
  const items = Array.from({ length: count }, (_, index) => {
    const id = `actual-source-${index + 1}`;
    return { collection: { id, title: `真实来源标题 ${index + 1}`, type: "article", source: "原始网页", url: `https://example.com/${index + 1}` }, extraction: {
      status: "qualified", summary: `来源 ${index + 1} 的有据理解。`, summaryEvidence: [`${id}#e1`],
      evidenceBundle: [{ evidence_id: `${id}#e1`, locator: "原文实际证据片段 1", source_field: "body_text", text: `完整来源 ${index + 1}：保留准确的 WCAG 1.4.3 和证据边界。` }],
    } };
  });
  const refs = items.slice(0, supported).map((item) => item.extraction.evidenceBundle[0].evidence_id);
  const theme = { title: "证据与控制", evidence_ids: refs, connections: [
    { connection_id: "in-plan", evidence_ids: refs.slice(0, 2) },
    ...(refs.length > 9 ? [{ connection_id: "outside-plan", evidence_ids: [refs[0], refs.at(-1)] }] : []),
  ] };
  return { items, theme, receipt: sign({ items, theme, traces: [{ callId: "CALL-P002", model: "injected" }] }, "theme", 3600) };
}

test("planned recovery preserves real IDs through aliasing and still requires independent evaluation", async () => {
  const input = fixture(10);
  let request;
  const candidate = await curate(input.receipt, async (callId, context) => {
    assert.equal(callId, "CALL-P003"); request = context;
    assert.equal(context.composition_mode, CURATION_PLAN_MODE);
    assert.equal(context.room_plan.length, 1);
    const selected = context.room_plan[0].exhibit_ids;
    assert.equal(selected.length, 9);
    assert.deepEqual(context.eligible_exhibits.map((item) => item.item_id), selected);
    assert.deepEqual(context.validated_connections.map((connection) => connection.connection_id), ["in-plan"]);
    for (const item of context.eligible_exhibits) {
      const index = Number(item.item_id.slice(4)) - 1;
      assert.equal(item.evidenceBundle[0].text, input.items[index].extraction.evidenceBundle[0].text);
      assert.equal(item.evidenceBundle[0].locator, input.items[index].extraction.evidenceBundle[0].locator);
    }
    const refs = context.eligible_exhibits.map((item) => item.evidenceBundle[0].evidence_id);
    return { trace: { callId, model: "injected-planned" }, output: {
      status: "candidate", title: "保留核对空间", curatorial_lens: "balanced",
      curatorial_note: { text: "这些来源共同关注可核对的证据。", statement_type: "hypothesis", evidence_ids: refs },
      room_narrative: { title: "证据与控制", introduction: "逐项比较材料。", claims: refs.map((ref) => ({ text: "这条来源提供可核对的信息。", statement_type: "extraction", evidence_ids: [ref] })) },
      connection_claims: [{ connection_id: "in-plan", text: "两条材料可能讨论相似的控制边界。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }],
      open_question: "还需要什么证据？",
    } };
  }, { recoveryPlan: true });
  assert.equal(candidate.status, "candidate");
  const signed = verify(candidate.receipt, "exhibition-candidate");
  assert.equal(signed.candidate.rooms.length, 1);
  assert.deepEqual(signed.candidate.rooms[0].exhibit_ids, input.items.slice(0, 9).map((item) => item.collection.id));
  assert.equal(signed.candidate.rooms[0].room_id, "room-main");
  assert.equal(Object.hasOwn(signed.candidate, "room_narrative"), false);
  assert.deepEqual(signed.items, input.items, "The frozen source set remains intact in the signed candidate");
  assert.ok(request);
  let evaluations = 0;
  const result = await evaluate(candidate.receipt, async (callId, context) => {
    evaluations += 1; assert.equal(callId, "CALL-PEVAL");
    assert.equal(context.candidate.rooms.length, 1);
    assert.equal(context.candidate.rooms[0].exhibit_ids.length, 9);
    return { trace: { callId, model: "injected-independent-evaluator" }, output: { status: "evaluated", narrative_coherence: { score: 3 }, grounding_findings: [], fact_inference_findings: [], overinterpretation_findings: [], user_constraint_conflicts: [], connection_assessments: [{ connection_id: "in-plan", score: 4 }] } };
  });
  assert.equal(evaluations, 1);
  assert.equal(result.exhibition.status, "needs_review", "A valid server-owned layout must never bypass the quality gate");
});

test("recovery does not call P003 when fewer than five sources are supported by theme evidence", async () => {
  const input = fixture(6, 4);
  const result = await curate(input.receipt, () => { throw new Error("Unsupported layout must not call a model"); }, { recoveryPlan: true });
  assert.equal(result.status, "waiting_for_content");
  assert.equal(Object.hasOwn(result, "receipt"), false);
});

test("normal first composition keeps its multi-room contract", async () => {
  const input = fixture();
  const result = await curate(input.receipt, async (_callId, context) => {
    assert.equal(Object.hasOwn(context, "composition_mode"), false);
    assert.equal(Object.hasOwn(context, "room_plan"), false);
    const exhibits = context.eligible_exhibits;
    const refs = exhibits.map((item) => item.evidenceBundle[0].evidence_id);
    return { trace: { callId: "CALL-P003" }, output: { status: "candidate", title: "常规双厅", curatorial_lens: "balanced",
      curatorial_note: { text: "比较来源。", statement_type: "hypothesis", evidence_ids: refs },
      rooms: [0, 3].map((start, index) => ({ room_id: `normal-${index + 1}`, title: `常规展厅 ${index + 1}`, introduction: "按主题观看。", exhibit_ids: exhibits.slice(start, start + 3).map((item) => item.item_id), claims: [{ text: "来源可核对。", statement_type: "extraction", evidence_ids: refs.slice(start, start + 3) }] })),
      connection_claims: [{ connection_id: "in-plan", text: "共同的问题。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }],
    } };
  });
  assert.equal(verify(result.receipt, "exhibition-candidate").candidate.rooms.length, 2);
});

test("the provider adapter selects the planned prompt only for the exact server composition mode", async (t) => {
  const originalFetch = globalThis.fetch, requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, request) => { requests.push(JSON.parse(request.body)); return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }); };
  const config = { zhipuApiKey: "offline-fixture", zhipuBaseUrl: "https://example.test", textModel: "glm-5.3-flash", reasoningEffort: "low", textMaxTokens: 512, timeoutMs: 1000 };
  await executeCall(config, { callId: "CALL-P003", runtimeContext: { composition_mode: CURATION_PLAN_MODE } });
  await executeCall(config, { callId: "CALL-P003", runtimeContext: {} });
  await executeCall(config, { callId: "CALL-P003", runtimeContext: { composition_mode: "unknown-mode" } });
  assert.match(requests[0].messages[1].content, /room_narrative/);
  assert.match(requests[0].messages[1].content, /room_plan/);
  assert.doesNotMatch(requests[1].messages[1].content, /room_narrative/);
  assert.equal(requests[1].messages[1].content, requests[2].messages[1].content);
});
