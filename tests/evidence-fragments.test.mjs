import test from "node:test";
import assert from "node:assert/strict";
import { evidenceFor, normalizeExtraction } from "../server/pipeline.mjs";

test("article fragments retain the exact source and prefer paragraph boundaries over splitting words", () => {
  const paragraph = "Accessible interfaces preserve clear labels and user control. ".repeat(14);
  const content = `${paragraph}\n${paragraph}\n${paragraph}`;
  const evidence = evidenceFor(content, "article");
  assert.equal(evidence.map((entry) => entry.text).join(""), content);
  assert.ok(evidence.every((entry) => entry.text.length <= 1200));
  assert.ok(evidence.slice(0, -1).every((entry) => /\s$/u.test(entry.text)));
  assert.equal(evidence[0].locator, "原文证据片段 1");
  assert.equal(evidence[0].text, `${paragraph}\n`);
});

test("a long unbroken source does not lose characters or split a surrogate pair", () => {
  const content = "字".repeat(1199) + "🌿" + "字".repeat(1400);
  const evidence = evidenceFor(content, "unicode");
  assert.equal(evidence.map((entry) => entry.text).join(""), content);
  assert.equal(evidence[0].text.length, 1199);
  assert.ok(evidence.every((entry) => !/[\uD800-\uDBFF]$/u.test(entry.text) && !/^[\uDC00-\uDFFF]/u.test(entry.text)));
});

test("video evidence keeps the actual transcript segment and timestamp", () => {
  assert.deepEqual(evidenceFor("not used", "video", [{ text: "actual transcript", start_ms: 1500, end_ms: 3200 }]), [
    { evidence_id: "video#e1", source_field: "transcript", locator: "00:01–00:03", text: "actual transcript" },
  ]);
});

test("normalized understanding preserves the validated overview and point evidence IDs", () => {
  const evidence = evidenceFor("Original evidence", "article");
  const ids = [evidence[0].evidence_id];
  const result = normalizeExtraction({ status: "candidate", summary: "Summary", summary_evidence_ids: ids,
    digest: { status: "compact", overview: "Overview", evidence_ids: ids, highlights: [{ text: "Highlight", evidence_ids: ids }] },
    breakdown: { status: "compact", sections: [{ title: "Section", evidence_ids: ids, points: [{ title: "Point", explanation: "Explanation", evidence_ids: ids }] }] },
    concepts: [], content_reliability_score: 0.9, uncertainties: [],
  }, evidence);
  assert.deepEqual(result.digest.evidence_ids, ids);
  assert.deepEqual(result.breakdown.sections[0].evidence_ids, ids);
  assert.deepEqual(result.breakdown.sections[0].points[0].evidence_ids, ids);
});
