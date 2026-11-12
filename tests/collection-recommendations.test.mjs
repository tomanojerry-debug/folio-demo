import test from "node:test";
import assert from "node:assert/strict";
import { collectionDirections, recommendedCollections, renderRecommendationCard } from "../site/prototype/immersive-exhibition/collection-recommendations.js";

const collections = (...ids) => ids.map(id => ({ id, title: `收藏 ${id}` }));
const extraction = (collectionId, tags) => ({ collectionId, tags });

test("directions require a shared tag across at least two actual collections", () => {
  const items = collections("one", "two", "three");
  const extractions = [extraction("one", ["共同", "独有"]), extraction("two", ["共同"]), extraction("three", ["其他"])];
  assert.deepEqual(collectionDirections(items, extractions), [{ tag: "共同", members: ["one", "two"], evidence: ["共同"] }]);
  assert.deepEqual(collectionDirections(collections("one"), [extraction("one", ["单件", "单件"])]), []);
});

test("duplicate tags count once and unknown or explicitly rejected understandings do not vote", () => {
  const items = collections("one", "two", "rewrite");
  const extractions = [extraction("one", ["共同", "共同", " ", null]), extraction("two", ["共同"]), extraction("unknown", ["幽灵", "共同"]), extraction("rewrite", ["幽灵", "共同"])];
  const feedback = { "understanding:rewrite": { userSelected: true, decision: "pending_rewrite" } };
  const original = structuredClone({ items, extractions, feedback });
  assert.deepEqual(collectionDirections(items, extractions, { feedback }), [{ tag: "共同", members: ["one", "two"], evidence: ["共同"] }]);
  assert.deepEqual({ items, extractions, feedback }, original);
});

test("evidence contains only shared subgroups of the recommended direction", () => {
  const items = collections("one", "two", "three", "four");
  const extractions = [
    extraction("one", ["大组", "小组", "单件"]),
    extraction("two", ["大组", "小组"]),
    extraction("three", ["大组", "交叉"]),
    extraction("four", ["交叉"]),
  ];
  const direction = collectionDirections(items, extractions).find(item => item.tag === "大组");
  assert.deepEqual(direction.members, ["one", "two", "three"]);
  assert.deepEqual(direction.evidence, ["大组", "小组"]);
  assert.equal(direction.evidence.includes("交叉"), false);
  assert.equal(direction.evidence.includes("单件"), false);
});

test("direction sorting is stable across extraction order and limit bounds the result", () => {
  const items = collections("one", "two", "three");
  const extractions = [extraction("one", ["b", "a", "popular"]), extraction("two", ["a", "b", "popular"]), extraction("three", ["popular"])];
  const all = collectionDirections(items, extractions);
  assert.deepEqual(all.map(item => item.tag), ["popular", "a", "b"]);
  assert.deepEqual(collectionDirections(items, [...extractions].reverse()).map(item => item.tag), all.map(item => item.tag));
  assert.deepEqual(collectionDirections(items, extractions, { limit: 1 }).map(item => item.tag), ["popular"]);
  assert.deepEqual(collectionDirections(items, extractions, { limit: 0 }), []);
});

test("recommendation anchors prefer a real thumbnail and carry the original member ids", () => {
  const items = collections("text", "image");
  items[1].thumbnail = "/assets/actual.jpg";
  const extractions = [extraction("text", ["主题"]), extraction("image", ["主题"])];
  const [recommendation] = recommendedCollections(items, extractions);
  assert.equal(recommendation.item.id, "image");
  assert.equal(recommendation.item.thumbnail, "/assets/actual.jpg");
  assert.deepEqual(recommendation.members, ["text", "image"]);
  assert.equal(recommendation.tag, "主题");
});

test("multiple shared tags do not repeat cards and the main output is excluded", () => {
  const items = collections("main", "one", "two");
  const extractions = items.map(item => extraction(item.id, ["a", "b", "c"]));
  const recommendations = recommendedCollections(items, extractions, { excludeId: "main", limit: 6 });
  assert.deepEqual(recommendations.map(item => item.item.id), ["one", "two"]);
  assert.equal(new Set(recommendations.map(item => item.item.id)).size, recommendations.length);
  assert.ok(recommendations.every(item => item.members.includes(item.item.id)));
});

test("dismissed directions remain dismissed without fabricating replacement reasons", () => {
  const items = collections("one", "two");
  const extractions = items.map(item => extraction(item.id, ["a", "b"]));
  assert.deepEqual(recommendedCollections(items, extractions, { feedback: { "insight:a": { dismissed: true }, "insight:b": { dismissed: true } } }), []);
  const recommendations = recommendedCollections(items, extractions, { feedback: { "insight:a": { dismissed: true } } });
  assert.deepEqual(recommendations.map(item => item.tag), ["b"]);
});

test("a zero recommendation limit returns no cards", () => {
  const items = collections("one", "two");
  assert.deepEqual(recommendedCollections(items, items.map(item => extraction(item.id, ["a"])), { limit: 0 }), []);
});

test("the shared card keeps the original rail structure, real metadata and keyboard access", () => {
  const item = { id: "one", title: "真实收藏", source: "原始来源", thumbnail: "/assets/real-image.jpg" };
  const state = { extractions: [extraction("one", ["主题", "主题", "第二条"])], collectionCategories: { one: "我的分类" } };
  state.extractions[0].summary = "根据收藏本身整理的摘要。";
  const html = renderRecommendationCard({ item, tag: "主题", members: ["one", "two"] }, state, { typeLabel: "文章" });
  assert.match(html, /^<figure class="circular-card"/);
  assert.match(html, /data-action="open-collection" data-collection-id="one" data-tag="主题" data-members="one,two"/);
  assert.match(html, /tabindex="0" role="button" aria-label="查看推荐收藏：真实收藏"/);
  assert.match(html, /class="circular-media"><img src="\/assets\/real-image.jpg"/);
  assert.match(html, /原始来源 · 文章/);
  assert.match(html, /我的分类|根据收藏本身整理的摘要/);
  assert.match(html, /class="recommend-focus-tags"><span>主题<\/span><span>第二条<\/span>/);
});

test("text-only recommendations retain the original paper fallback instead of an invented picture", () => {
  const item = { id: "text", title: "一件文字收藏", source: "我的文字" };
  const html = renderRecommendationCard({ item, tag: "最近收下", members: ["text"] }, { extractions: [] });
  assert.match(html, /class="circular-media no-image"/);
  assert.match(html, /<span aria-hidden="true">最<\/span>/);
  assert.match(html, /一件文字收藏/);
  assert.doesNotMatch(html, /<img|需要你|核对理解/);
  assert.equal(renderRecommendationCard({ item: null }, {}), "");
});

test("shared recommendation rendering escapes source text, tags and action attributes", () => {
  const attack = '<img src=x onerror="bad()">';
  const item = { id: 'one" injected="yes', title: attack, source: attack, thumbnail: '/assets/image" onerror="bad()' };
  const state = { extractions: [{ collectionId: item.id, summary: '<script>bad()</script>', tags: [attack] }], collectionCategories: { [item.id]: attack } };
  const html = renderRecommendationCard({ item, tag: attack, members: [item.id, "two"] }, state, { typeLabel: attack });
  assert.doesNotMatch(html, /<script|<img src=x|data-collection-id="one" injected=|src="\/assets\/image" onerror=/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /data-members="one&quot; injected=&quot;yes,two"/);
});
