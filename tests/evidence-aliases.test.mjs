import test from "node:test";
import assert from "node:assert/strict";
import { ingest, revise } from "../server/pipeline.mjs";
import { verify } from "../server/receipts.mjs";

process.env.FORME_SESSION_SECRET = "aliases-test-only-secret-with-more-than-32-characters";
const response = (ids) => ({ trace: { model: "injected-alias-check" }, output: { status: "candidate", summary: "保留来源与用户判断。", summary_evidence_ids: ids,
  digest: { status: "compact", overview: "资料保留来源，用户继续判断。", evidence_ids: ids, highlights: [{ text: "保留来源", evidence_ids: ids }] },
  breakdown: { status: "not_applicable", sections: [] }, concepts: [], content_reliability_score: 0.9, uncertainties: [] } });

test("understanding and revision expose short aliases while storing the exact original signed source IDs", async () => {
  let calls = 0;
  const model = async (_callId, context) => {
    calls++;
    assert.equal(context.item_id, "item1");
    assert.ok(context.evidence_bundle.every((entry, index) => entry.evidence_id === `item1-e${index + 1}`));
    return response(context.evidence_bundle.map((entry) => entry.evidence_id));
  };
  const original = await ingest({ mode: "text", content: "可靠的辅助工具保留原始材料，允许用户回到来源核对，并把最终判断交给使用者。" }, { model });
  assert.ok(original.extraction.summaryEvidence.every((id) => id.startsWith(`${original.collection.id}#e`)));
  const revised = await revise(original.receipt, "请明确区分来源和解释。", model);
  assert.equal(calls, 2);
  assert.deepEqual(revised.extraction.evidenceBundle, original.extraction.evidenceBundle);
  assert.deepEqual(revised.extraction.summaryEvidence, original.extraction.summaryEvidence);
  assert.equal(verify(revised.receipt, "collection").collection.id, original.collection.id);
});

test("unknown short aliases are rejected without fuzzy repair or silent reference dropping", async () => {
  await assert.rejects(ingest({ mode: "text", content: "可靠的工具应保留原始证据，让使用者能够继续核对来源并自行作出判断。" }, {
    model: async () => response(["item1-e999"]),
  }), { code: "MODEL_OUTPUT_INVALID" });
});
