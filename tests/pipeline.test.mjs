import test from "node:test";
import assert from "node:assert/strict";
import { ingest, revise, normalizeExtraction, evidenceFor, discover, curate, evaluate } from "../server/pipeline.mjs";
import { sign, verify } from "../server/receipts.mjs";
import { publicIP, validURL, htmlText } from "../server/safe-fetch.mjs";
import { loadProductPrompt } from "../server/ai/prompt-loader.mjs";
import { json3Segments } from "../worker/adapters.mjs";

process.env.FORME_SESSION_SECRET = "test-only-session-secret-with-over-32-characters";
function candidate(context) {
  const ids = [context.evidence_bundle[0].evidence_id];
  return { status: "candidate", summary: "可靠的系统应当保留人的判断。", summary_evidence_ids: ids, digest: { status: "compact", overview: "系统提供支持，人保留判断与责任。", evidence_ids: ids, highlights: [{ text: "保留人的判断", evidence_ids: ids, locator: "模型编造的时间戳" }] }, breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "人的判断", evidence_ids: ids }], content_reliability_score: 0.9, uncertainties: [] };
}
const fakeModel = async (_id, context) => ({ output: candidate(context), trace: { callId: "CALL-P001", model: "test", createdAt: new Date().toISOString() } });
test("Prompt loader includes explicit schemas for generation and independent evaluation", async () => {
  assert.match((await loadProductPrompt("P-001")).capability, /summary_evidence_ids/);
  assert.match((await loadProductPrompt("P-EVAL")).system, /connection_assessments/);
});
test("real ingestion maps into the existing UI contract with verifiable receipt", async () => {
  const result = await ingest({ mode: "text", content: "可靠的自动化系统能够解释来源，允许人撤销操作，并把最终判断和责任保留给人。" }, { model: fakeModel });
  assert.equal(result.collection.status, "ready");
  assert.equal(result.extraction.source, "live_ai");
  assert.equal(result.extraction.digest.highlights[0].locator, "原文证据片段 1");
  assert.equal(verify(result.receipt, "collection").collection.id, result.collection.id);
  assert.throws(() => verify(result.receipt.slice(0, -4) + "aaaa", "collection"), /RECEIPT_INVALID/);
});
test("fabricated references rejected; missing references cannot enter automatic curation", () => {
  const evidence = evidenceFor("真实原文", "item");
  const output = candidate({ evidence_bundle: evidence });
  output.summary_evidence_ids = ["invented"];
  assert.throws(() => normalizeExtraction(output, evidence), /MODEL_OUTPUT_INVALID/);
  output.summary_evidence_ids = [];
  assert.equal(normalizeExtraction(output, evidence).status, "needs_confirmation");
});
test("corrections re-run understanding with original signed evidence and a new receipt", async () => {
  const original = await ingest({ mode: "text", content: "好的系统应该保留原始来源，标注不确定性，并允许使用者在执行前改变判断。" }, { model: fakeModel });
  const result = await revise(original.receipt, "重点是过程可见，而不是效率。", async (_id, context) => {
    assert.deepEqual(context.evidence_bundle.map((entry) => entry.text), original.extraction.evidenceBundle.map((entry) => entry.text));
    assert.ok(context.evidence_bundle.every((entry) => /^item1-e\d+$/.test(entry.evidence_id)));
    assert.equal(context.user_corrections[0].source, "user_feedback");
    return { output: { ...candidate(context), summary: "过程应当可见，判断应当可撤销。" }, trace: { model: "test" } };
  });
  assert.equal(result.collection.id, original.collection.id);
  assert.equal(result.extraction.revision, 2);
  assert.deepEqual(result.extraction.evidenceBundle, original.extraction.evidenceBundle);
  assert.equal(verify(result.receipt, "collection").extraction.summary, "过程应当可见，判断应当可撤销。");
  await assert.rejects(revise(original.receipt, ""), /INVALID_REQUEST/);
});
test("unknown inputs do not silently become sample content", async () => {
  await assert.rejects(ingest({ mode: "parsed", content: "anything" }), /INVALID_REQUEST/);
  await assert.rejects(ingest({ mode: "link", content: "https://www.youtube.com/watch?v=wttQtw3jDVU" }), /WORKER_NOT_CONFIGURED/);
  await assert.rejects(ingest({ mode: "text", content: "short" }), /NEEDS_INPUT/);
});
test("public fetch blocks private addresses, credentials and nonstandard ports", () => {
  for (const ip of ["127.0.0.1", "10.0.0.3", "172.16.0.1", "192.168.1.2", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1"]) assert.equal(publicIP(ip), false, ip);
  assert.equal(publicIP("8.8.8.8"), true);
  for (const url of ["file:///etc/passwd", "http://localhost", "http://127.1", "http://[::1]", "https://user:secret@example.com", "https://example.com:8787"]) assert.throws(() => validURL(url), /UNSAFE_URL/);
});
test("HTML extraction excludes executable and navigation content", () => {
  const { text, title } = htmlText("<title>A &amp; B</title><script>secret()</script><nav>Menu</nav><article><h1>正文</h1><p>第一段。</p><p>第二段。</p></article>");
  assert.equal(title, "A & B"); assert.ok(text.includes("第一段。")); assert.ok(!text.includes("secret")); assert.ok(!text.includes("Menu"));
});
test("YouTube segments preserve original timestamps", () => {
  assert.deepEqual(json3Segments({ events: [{ tStartMs: 1250, dDurationMs: 2500, segs: [{ utf8: "hello" }, { utf8: " world" }] }] }), [{ start_ms: 1250, end_ms: 3750, text: "hello world" }]);
});
test("six signed real collections go through themes, curation and separate evaluation", async () => {
  const items = await Promise.all(Array.from({ length: 6 }, (_, i) => ingest({ mode: "text", content: `第${i}条收藏：可靠系统可以辅助人的决策，通过保留证据和可撤销的流程，让人承担最后的责任。` }, { model: fakeModel })));
  const refs = items.map((i) => i.extraction.evidenceBundle[0].evidence_id);
  const ids = items.map((i) => i.collection.id);
  const theme = await discover(items.map((i) => i.receipt), async (_callId, context) => {
    assert.equal(context.collection_activity_facts.available, false);
    assert.ok(context.eligible_extractions.every((entry) => entry.trace === undefined));
    return { output: { status: "candidate", themes: [{ title: "人的判断", evidence_ids: refs, connections: [{ connection_id: "c1", evidence_ids: refs.slice(0, 2) }] }] }, trace: { callId: "CALL-P002" } };
  });
  assert.equal(theme.status, "candidate");
  const draft = await curate(theme.receipt, async (_callId, context) => {
    assert.equal(context.collection_activity_facts.available, false);
    assert.ok(context.eligible_exhibits.every((entry) => entry.trace === undefined));
    return { output: { status: "candidate", title: "让系统退后", curatorial_note: { text: "人的判断", evidence_ids: refs }, rooms: [{ title: "判断与责任", exhibit_ids: ids, claims: [{ text: "系统辅助人", statement_type: "hypothesis", evidence_ids: refs }] }], connection_claims: [{ connection_id: "c1", text: "共同关系", evidence_ids: refs.slice(0, 2) }], open_question: "哪些判断应该保留？" }, trace: { callId: "CALL-P003" } };
  });
  assert.equal(verify(draft.receipt, "exhibition-candidate").candidate.connection_claims[0].statement_type, "hypothesis");
  const result = await evaluate(draft.receipt, async () => ({ output: { status: "evaluated", narrative_coherence: { score: 4 }, connection_assessments: [{ connection_id: "c1", score: 4 }], grounding_findings: [], fact_inference_findings: [], overinterpretation_findings: [], user_constraint_conflicts: [] }, trace: { callId: "CALL-PEVAL" } }));
  assert.equal(result.exhibition.status, "preview"); assert.equal(result.exhibition.items.length, 6);
  const blocked = await evaluate(draft.receipt, async () => ({ output: { status: "unable_to_evaluate" }, trace: {} }));
  assert.equal(blocked.exhibition.status, "needs_review");
  await assert.rejects(discover(Array(6).fill(items[0].receipt)), /INSUFFICIENT_ITEMS/);
});
