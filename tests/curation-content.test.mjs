import test from "node:test";
import assert from "node:assert/strict";
import { discover, curate, model } from "../server/pipeline.mjs";
import { sign } from "../server/receipts.mjs";

process.env.FORME_SESSION_SECRET = "test-only-curation-content-secret-over-32-characters";

test("P003 receives every original evidence span once while P002 keeps its understanding input", async () => {
  const items = Array.from({ length: 6 }, (_, index) => {
    const id = `source-${index + 1}`;
    const evidenceBundle = Array.from({ length: 3 }, (_, offset) => ({
      evidence_id: `${id}#e${offset + 1}`, source_field: "body_text", locator: `原文实际章节 ${offset + 1}`,
      text: `来源 ${index + 1}、章节 ${offset + 1} 的完整正文：包含 WCAG 1.4.3 和 4.5:1 等不可改写的事实。\n${"保留原始语义与定位，不能剪掉尾部。".repeat(90)}尾部证据-${index}-${offset}`,
    }));
    return {
      collection: { id, title: `真实来源 ${index + 1}`, type: "article", source: "网页正文", url: `https://example.com/${id}` },
      extraction: { collectionId: id, status: "qualified", summary: `来源 ${index + 1} 的核心理解。`, summaryEvidence: evidenceBundle.map((entry) => entry.evidence_id), evidenceBundle,
        digest: { overview: "REDUNDANT_DIGEST", highlights: [{ text: "重复的生成提取。".repeat(80) }] },
        breakdown: { sections: [{ title: "REDUNDANT_BREAKDOWN", points: [{ explanation: "重复的生成理解。".repeat(80) }] }] },
        hint: "PRIVATE_DIAGNOSTIC_HINT", trace: { model: "PRIVATE_TRACE", elapsedMs: 123 },
        tags: ["重复标签"], concepts: ["重复概念"], reliability: 0.95, transcriptSource: null,
      },
    };
  });
  const originals = structuredClone(items);
  const theme = await discover(items.map((item) => sign(item, "collection")), async (callId, context) => {
    assert.equal(callId, "CALL-P002");
    assert.equal(context.eligible_extractions[0].digest.overview, "REDUNDANT_DIGEST");
    assert.equal(context.eligible_extractions[0].breakdown.sections[0].title, "REDUNDANT_BREAKDOWN");
    const refs = context.eligible_extractions.map((item) => item.evidenceBundle[0].evidence_id);
    return { trace: { callId, model: "injected-fixture" }, output: { status: "candidate", themes: [{ title: "可核对的来源", evidence_ids: refs, connections: [{ connection_id: "c1", evidence_ids: refs.slice(0, 2) }] }] } };
  });
  assert.equal(theme.status, "candidate");
  await curate(theme.receipt, async (callId, context) => {
    assert.equal(callId, "CALL-P003");
    assert.equal(context.eligible_exhibits.length, 6);
    for (const [index, compact] of context.eligible_exhibits.entries()) {
      const item = originals[index];
      assert.equal(compact.item_id, `item${index + 1}`);
      assert.equal(compact.title, item.collection.title);
      assert.equal(compact.summary, item.extraction.summary);
      assert.equal(compact.source, item.collection.source);
      assert.equal(compact.url, item.collection.url);
      assert.equal(compact.content_type, item.collection.type);
      assert.equal(compact.status, "qualified");
      assert.deepEqual(compact.summary_evidence_ids, item.extraction.summaryEvidence.map((_id, offset) => `item${index + 1}-e${offset + 1}`));
      assert.deepEqual(compact.evidenceBundle, item.extraction.evidenceBundle.map((entry, offset) => ({ ...entry, evidence_id: `item${index + 1}-e${offset + 1}` })), "Only existing evidence ID aliases may change; all text, locators and source fields remain exact");
      for (const field of ["digest", "breakdown", "hint", "trace", "collectionId", "tags", "concepts", "reliability", "summaryEvidence", "evidence_bundle"]) assert.equal(Object.hasOwn(compact, field), false, `Redundant field must not reach P003: ${field}`);
      const serialized = JSON.stringify(compact);
      for (const span of item.extraction.evidenceBundle) assert.equal(serialized.split(span.text.replaceAll("\n", "\\n")).length - 1, 1, "Each complete source span appears once in the P003 input");
    }
    return { trace: { callId, model: "injected-fixture" }, output: { status: "waiting_for_content" } };
  });
  assert.deepEqual(items, originals, "Compression must not mutate signed source objects");
});

test("provider truncation diagnostics survive invalid JSON without changing the public error code", async (t) => {
  const originalFetch = globalThis.fetch;
  const variables = ["ZHIPU_CODING_API_KEY", "ZHIPU_TEXT_MODEL"];
  const originalEnv = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  t.after(() => { globalThis.fetch = originalFetch; for (const key of variables) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; } });
  process.env.ZHIPU_CODING_API_KEY = "injected-local-fixture-key";
  process.env.ZHIPU_TEXT_MODEL = "glm-5.3-flash";
  let reply = { model: "glm-5.3-flash", choices: [{ finish_reason: "stop", message: { content: '{"status":"candidate"}' } }], usage: { total_tokens: 123 } };
  globalThis.fetch = async () => new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  const complete = await model("CALL-P003", { fixture: true });
  assert.equal(complete.trace.finishReason, "stop");
  reply = { ...reply, choices: [{ finish_reason: "length", message: { content: '{"status":"candidate"' } }] };
  await assert.rejects(model("CALL-P003", { fixture: true }), (error) => {
    assert.equal(error.code, "MODEL_OUTPUT_INVALID");
    assert.equal(error.statusCode, 502);
    assert.equal(error.trace.finishReason, "length");
    assert.equal(error.trace.model, "glm-5.3-flash");
    assert.equal(error.trace.usage.total_tokens, 123);
    assert.equal(JSON.stringify(error.trace).includes("candidate"), false, "The diagnostic must not contain the incomplete raw answer or reasoning");
    return true;
  });
  reply = { ...reply, choices: [{ finish_reason: "unrecognized-provider-diagnostic", message: { content: "{}" } }] };
  assert.equal(Object.hasOwn((await model("CALL-P003", { fixture: true })).trace, "finishReason"), false);
});
