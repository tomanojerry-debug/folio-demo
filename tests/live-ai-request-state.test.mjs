import test from "node:test";
import assert from "node:assert/strict";
import { captureFeedbackMessage, collectionUnderstandingState, syncTaskState } from "../site/prototype/immersive-exhibition/live-ai-request.js";

const item = (status = "ready") => ({ id: "collection-one", status, title: "原始收藏", content: "保留这段原始正文，不能把它当成模型理解。" });
const extraction = (more = {}) => ({ collectionId: "collection-one", status: "qualified", summary: "根据真实来源整理的摘要。", ...more });

test("capture receipts distinguish a raw save from queued work and completed understanding", () => {
  const offline = captureFeedbackMessage({ status: "saved", aiEnabled: false });
  assert.match(offline, /已收好原始内容/);
  assert.match(offline, /尚未连接/);
  assert.doesNotMatch(offline, /正在理解|理解已整理好|已排队/);
  for (const status of ["queued", "processing"]) {
    assert.doesNotMatch(captureFeedbackMessage({ status, aiEnabled: false }), /正在理解|已排队|理解已整理好/);
  }
  assert.match(captureFeedbackMessage({ status: "queued", aiEnabled: true }), /已排队/);
  assert.match(captureFeedbackMessage({ status: "processing", aiEnabled: true }), /正在理解中/);
  assert.match(captureFeedbackMessage({ status: "ready", aiEnabled: true }), /理解已整理好/);
  assert.match(captureFeedbackMessage({ status: "ready", aiEnabled: false }), /理解已整理好/, "disconnecting AI does not erase an already completed result");
});

test("incomplete capture receipts preserve the raw source and never claim successful understanding", () => {
  for (const status of ["needs_input", "needs_confirmation", "failed", "interrupted", "saved"]) {
    const message = captureFeedbackMessage({ status, aiEnabled: true });
    assert.match(message, /原始内容已收好/);
    assert.doesNotMatch(message, /理解已整理好|正在理解中/);
  }
  assert.match(captureFeedbackMessage({ status: "needs_input" }), /补充内容/);
  assert.match(captureFeedbackMessage({ status: "needs_confirmation" }), /核对来源/);
  assert.match(captureFeedbackMessage({ status: "failed" }), /重试/);
  assert.match(captureFeedbackMessage(), /确认保存状态/, "an unknown receipt must not invent a saved or completed result");
});

test("collection feedback tells the reader whether a link or pasted text was saved", () => {
  assert.match(captureFeedbackMessage({ mode: "link", status: "processing", aiEnabled: true }), /链接已收藏.*正文待读取/);
  assert.match(captureFeedbackMessage({ mode: "link", status: "saved", aiEnabled: false }), /仅收藏了链接/);
  assert.equal(captureFeedbackMessage({ mode: "text", status: "processing", aiEnabled: true }), "文字已收藏");
});

test("saved and incomplete phases cannot expose understanding review even when a stale summary exists", () => {
  for (const status of ["saved", "queued", "processing", "failed", "interrupted", "needs_input"]) {
    const result = collectionUnderstandingState(item(status), extraction(), {
      aiEnabled: true,
      acceptedSummary: "以前确认过的摘要，不能覆盖当前材料不足或未完成的状态。",
    });
    assert.equal(result.hasUnderstanding, false, status);
    assert.equal(result.loading, ["queued", "processing"].includes(status), status);
    assert.ok(result.title && result.description && result.statusMessage, "the raw-source view explains the actual state");
  }
});

test("a ready item still requires actual summary text and a completed extraction", () => {
  for (const missing of [undefined, {}, { status: "qualified", summary: "  \n\t" }]) {
    assert.equal(collectionUnderstandingState(item(), missing, { aiEnabled: true }).hasUnderstanding, false);
  }
  for (const status of ["queued", "processing", "failed", "interrupted", "needs_input", "unavailable"]) {
    assert.equal(collectionUnderstandingState(item(), extraction({ status }), { aiEnabled: true }).hasUnderstanding, false, status);
  }
  assert.equal(collectionUnderstandingState(item(), extraction({ summary: "" }), { acceptedSummary: "  " }).hasUnderstanding, false);
});

test("qualified and source-check understandings remain readable when AI is disconnected", () => {
  const qualified = collectionUnderstandingState(item(), extraction(), { aiEnabled: false });
  assert.equal(qualified.hasUnderstanding, true);
  assert.equal(qualified.loading, false);
  assert.equal(qualified.statusMessage, "已根据原始内容整理。");
  for (const [collection, understood] of [
    [item("needs_confirmation"), extraction()],
    [item(), extraction({ status: "needs_confirmation" })],
  ]) {
    const partial = collectionUnderstandingState(collection, understood, { aiEnabled: false });
    assert.equal(partial.hasUnderstanding, true);
    assert.equal(partial.loading, false);
    assert.match(partial.statusMessage, /部分内容仍需核对来源/);
  }
  assert.equal(collectionUnderstandingState(item(), extraction({ summary: "" }), {
    aiEnabled: false,
    acceptedSummary: "用户已保存的修订摘要。",
  }).hasUnderstanding, true, "an accepted edit is still a real readable understanding");
});

test("retry availability follows AI capability while insufficient material asks for supplementation", () => {
  for (const status of ["saved", "failed", "interrupted"]) {
    assert.equal(collectionUnderstandingState(item(status), {}, { aiEnabled: true }).canRetry, true, status);
    const unavailable = collectionUnderstandingState(item(status), {}, { aiEnabled: false });
    assert.equal(unavailable.hasUnderstanding, false);
    assert.equal(unavailable.loading, false);
    assert.equal(unavailable.canRetry, false, status);
  }
  const needsInput = collectionUnderstandingState(item("needs_input"), {}, { aiEnabled: true });
  assert.equal(needsInput.needsInput, true);
  assert.notEqual(needsInput.canRetry, true);
  assert.match(needsInput.description, /补充正文|文字稿/);
  for (const status of ["queued", "processing"]) {
    const unavailable = collectionUnderstandingState(item(status), extraction(), { aiEnabled: false });
    assert.equal(unavailable.loading, false);
    assert.equal(unavailable.hasUnderstanding, false);
    assert.match(unavailable.statusMessage, /尚未连接/);
  }
});

test("a failed rewrite preserves the previous qualified understanding and accepted edit for further review", () => {
  const draft = {
    collections: [item()],
    extractions: [extraction()],
    feedback: { "understanding:collection-one": { decision: "pending_rewrite", acceptedSummary: "用户先前保存的准确摘要。" } },
  };
  const before = structuredClone(draft);
  const revision = { action: "revise", id: "collection-one", status: "processing" };
  syncTaskState(draft, revision, "failed", "本次重写未完成，请稍后重试。");
  assert.deepEqual(draft, before, "failed revision work must not replace the usable source result or saved feedback");
  assert.equal(revision.status, "failed");
  assert.match(revision.error, /重试/);
  const view = collectionUnderstandingState(draft.collections[0], draft.extractions[0], {
    aiEnabled: true,
    acceptedSummary: draft.feedback["understanding:collection-one"].acceptedSummary,
  });
  assert.equal(view.hasUnderstanding, true);
  assert.equal(view.loading, false);
});
