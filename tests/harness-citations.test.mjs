import test from "node:test";
import assert from "node:assert/strict";
import { parseCollectionCitations } from "../desktop/server/harness/citations.mjs";

test("retrieved but uncited collections never become answer references", () => {
  assert.deepEqual(parseCollectionCitations("我是基于 GLM 的助手。", ["raycast", "mdn", "agent"]), { text: "我是基于 GLM 的助手。", relatedCollectionIds: [] });
});

test("only explicitly cited current-turn sources survive, in first-citation order", () => {
  const result = parseCollectionCitations("先看键盘操作。[[collection:keyboard]] 再看对比度。[[collection:contrast]][[collection:keyboard]][[collection:old-history-source]][[collection:made-up]]", ["design", "contrast", "keyboard"]);
  assert.deepEqual(result, { text: "先看键盘操作。 再看对比度。", relatedCollectionIds: ["keyboard", "contrast"] });
  assert.doesNotMatch(result.text, /\[\[collection:/);
});

test("malformed citation IDs cannot name another collection", () => {
  const result = parseCollectionCitations("内容。[[collection:source ]][[collection:]][[collection:source,other]][[collection:null]]", ["source", "other"]);
  assert.deepEqual(result, { text: "内容。", relatedCollectionIds: [] });
});

test("an answer containing only markers has no readable reply or references", () => {
  assert.deepEqual(parseCollectionCitations(" [[collection:source]] ", ["source"]), { text: "", relatedCollectionIds: [] });
});

test("visible output limits exclude tail citations and never split internal markers", () => {
  assert.deepEqual(parseCollectionCitations("甲乙。[[collection:first]]丙丁。[[collection:tail]]", ["first", "tail"], 4), { text: "甲乙。丙", relatedCollectionIds: ["first"] });
  assert.deepEqual(parseCollectionCitations("甲乙。[[collection:first]]丙丁。[[collection:tail]]", ["first", "tail"], 3), { text: "甲乙。", relatedCollectionIds: ["first"] });
  assert.deepEqual(parseCollectionCitations("正文。[[collection:unfinished", ["unfinished"]), { text: "正文。", relatedCollectionIds: [] });
  assert.deepEqual(parseCollectionCitations("正文。[[collection:unfinished", ["unfinished"], 6), { text: "正文。", relatedCollectionIds: [] });
  for (const fragment of ["[[collection:source]", "[[collection:", "[[collectio", "[[c", "[["]) {
    assert.deepEqual(parseCollectionCitations(`正文。${fragment}`, ["source"]), { text: "正文。", relatedCollectionIds: [] }, fragment);
    assert.deepEqual(parseCollectionCitations(fragment, ["source"]), { text: "", relatedCollectionIds: [] }, fragment);
  }
});
