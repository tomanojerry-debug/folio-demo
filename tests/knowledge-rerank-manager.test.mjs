import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createKnowledgeManager } from "../desktop/server/knowledge/manager.mjs";

// The real MiniLM revision contains the substring "e5". Family detection must
// use the repository identity rather than accidentally interpreting that hash.
const space = { model: "local:Xenova/paraphrase-multilingual-MiniLM-L12-v2@2c4055b12046f11709e9df2c122e59ffbdc2f900:q8:mean-v1", dimensions: 3 };
const item = (id, title, body, extra = {}) => ({ id, title, url: `https://example.org/${id}`, status: "saved", sourceRevision: 1, type: "user_input", content: body, input: { mode: "text", content: body }, ...extra });
const light = item("light", "采光建筑", "窗户让自然光进入房间，使室内更加明亮。");
const coffee = item("coffee", "咖啡风味", "咖啡豆烘焙需要控制温度与酸度。");
function sourceVector(text) { return /窗户|自然光/u.test(text) ? [0.2, 0.98, 0] : [0.25, 0.968, 0]; }
function embeddingClient(extra = {}) { return { space, embed: async (texts, { role }) => texts.map(value => role === "query" ? [1, 0, 0] : sourceVector(value)), ...extra }; }
const rankRows = (pairs, score) => pairs.map(pair => ({ id: pair.id, score: typeof score === "function" ? score(pair) : score, scoreKind: "sigmoid_relevance_logit" }));
async function fixture(t, { collections = [light, coffee], config = {}, ...options } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-rerank-manager-"));
  let state = { collections: structuredClone(collections), jobs: [], workspace: { feedback: {} } };
  const manager = await createKnowledgeManager({ directory, config, getState: () => structuredClone(state), embedder: embeddingClient(), ...options });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.idle();
  return { manager, directory, get state() { return state; }, set state(value) { state = value; } };
}

test("wide semantic candidates require actual passage relevance rather than direct exposure", async t => {
  let calls = 0;
  const f = await fixture(t, { reranker: { rerank: async (query, pairs) => {
    calls++;
    assert.equal(query, "sunbeam");
    assert.ok(pairs.some(pair => pair.text.includes("咖啡")), "The deliberately weak dense candidate reaches the quality stage");
    return rankRows(pairs, pair => pair.text.includes("窗户") ? 0.9 : 0.004);
  } } });
  const result = await f.manager.search({ query: "sunbeam" });
  assert.equal(calls, 1);
  assert.equal(result.reranked, true);
  assert.deepEqual(result.items.map(value => value.collectionId), ["light"]);
  assert.ok(result.items[0].semanticScore < 0.55, "Recall used the MiniLM candidate profile rather than the old universal cutoff");
  assert.equal(result.items[0].rerankScore, 0.9);
  assert.equal(result.items[0].rerankScoreKind, "sigmoid_relevance_logit");
});

test("low-quality semantic candidates can produce an empty result", async t => {
  const f = await fixture(t, { reranker: { rerank: async (_query, pairs) => rankRows(pairs, 0.004) } });
  assert.deepEqual((await f.manager.search({ query: "unrelated mathematical topic" })).items, []);
});

test("search collapses duplicate bodies and tracking variants within its result list", async t => {
  const mirror = item("light-mirror", "采光转载", light.content);
  const trackingCopy = item("light-tracking", "采光摘录", `${light.content}补充一个不同段落。`, { url:`${light.url}?utm_source=copy` });
  const f = await fixture(t, { collections:[light, mirror, trackingCopy, coffee], reranker:{ rerank:async (_query, pairs) => rankRows(pairs, pair => pair.text.includes("窗户") ? 0.9 : 0.001) } });
  const result = await f.manager.search({ query:"sunbeam", limit:5 });
  assert.equal(result.items.length, 1);
  assert.ok(["light", "light-mirror", "light-tracking"].includes(result.items[0].collectionId));
  assert.equal(f.state.collections.length, 4, "Deduplication only groups results; it never removes saved collections.");
});

test("similar results collapse copies of each other as well as copies of the anchor", async t => {
  const mirror = item("light-mirror", "采光转载", light.content);
  const f = await fixture(t, { collections:[coffee, light, mirror], reranker:{ rerank:async (_query, pairs) => rankRows(pairs, 0.9) } });
  const result = await f.manager.findSimilar({ collectionId:"coffee", limit:5 });
  assert.equal(result.items.length, 1);
  assert.ok(["light", "light-mirror"].includes(result.items[0].collectionId));
});

test("reranking failure falls back to strict full text and failure details remain private", async t => {
  let calls = 0;
  const f = await fixture(t, { reranker: { rerank: async () => { calls++; throw Object.assign(new Error("private provider payload"), { code: "RERANKING_LOCAL_ERROR" }); } } });
  const semanticOnly = await f.manager.search({ query: "sunbeam" });
  assert.equal(semanticOnly.mode, "full_text");
  assert.equal(semanticOnly.rerankingFallback, true);
  assert.deepEqual(semanticOnly.items, []);
  const literal = await f.manager.search({ query: "自然光" });
  assert.equal(literal.mode, "full_text");
  assert.deepEqual(literal.items.map(value => value.collectionId), ["light"]);
  assert.equal(calls, 1, "A failed local model is not called in a retry storm");
  assert.equal(f.manager.status().rerankingStatus, "unavailable");
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /private provider/u);
});

test("invalid reranker output cannot expose broad candidates", async t => {
  const f = await fixture(t, { reranker: { rerank: async (_query, pairs) => [{ id: pairs[0].id, score: NaN }] } });
  const result = await f.manager.search({ query: "sunbeam" });
  assert.deepEqual(result.items, []);
  assert.equal(result.mode, "full_text");
  assert.equal(f.manager.status().lastRerankingErrorCode, "RERANKING_OUTPUT_INVALID");
});

test("strong exact identifiers and complete titles survive unfamiliar semantic scores", async t => {
  const source = item("calibration", "建筑采光校准手册", "本次测量使用 LUX-742 校准卡，测量位置是北侧阅读桌。");
  const f = await fixture(t, { collections: [source], reranker: { rerank: async (_query, pairs) => rankRows(pairs, 0.0001) } });
  const identifier = await f.manager.search({ query: "LUX-742 的校准数值" });
  assert.equal(identifier.items[0]?.collectionId, "calibration");
  assert.equal(identifier.items[0].qualitySource, "exact_identifier");
  const title = await f.manager.search({ query: "请找建筑采光校准手册" });
  assert.equal(title.items[0]?.qualitySource, "exact_title");
});

test("unchanged queries reuse vector and passage-ranking caches", async t => {
  let rankCalls = 0, queryCalls = 0;
  const f = await fixture(t, { embedder: embeddingClient({ embed: async (texts, { role }) => { if (role === "query") queryCalls++; return texts.map(value => role === "query" ? [1, 0, 0] : sourceVector(value)); } }), reranker: { rerank: async (_query, pairs) => { rankCalls++; return rankRows(pairs, 0.9); } } });
  const first = await f.manager.search({ query: "sunbeam" });
  f.state.messages = [{ role: "user", text: "Chat does not change original source pairs" }];
  const second = await f.manager.search({ query: "sunbeam" });
  assert.deepEqual(second, first);
  assert.equal(rankCalls, 1);
  assert.equal(queryCalls, 1);
});

test("reranking outside the mutation queue does not revive a deleted source", async t => {
  let began, release;
  const started = new Promise(resolve => { began = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { reranker: { rerank: async (_query, pairs) => { began(); await gate; return rankRows(pairs, 0.9); } } });
  const search = f.manager.search({ query: "sunbeam" });
  await started;
  f.state.collections = [];
  await f.manager.sync();
  release();
  assert.deepEqual((await search).items, []);
  await f.manager.idle();
});

test("a source version changed during inference cannot return its old passage", async t => {
  let began, release;
  const started = new Promise(resolve => { began = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { collections: [light], reranker: { rerank: async (_query, pairs) => { began(); await gate; return rankRows(pairs, 0.9); } } });
  const search = f.manager.search({ query: "sunbeam" });
  await started;
  const body = "新版已经改为记录茶叶发酵过程，旧采光原文只在历史版本中保留。";
  f.state.collections[0].sourceRevision = 2;
  f.state.collections[0].input.content = body;
  await f.manager.captureSource({ collectionId: "light", captureId: "version-two", sourceRevision: 2, source: { title: "新版", text: body } });
  release();
  assert.deepEqual((await search).items, []);
});

test("a corrected or pending understanding cannot leak the old summary after inference", async t => {
  let began, release;
  const started = new Promise(resolve => { began = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const source = { ...structuredClone(light), status: "ready", extraction: { status: "qualified", summary: "旧理解必须消失。", revision: 1, concepts: ["采光"], evidenceBundle: [{ evidence_id: "e1", text: light.content }] } };
  const f = await fixture(t, { collections: [source], reranker: { rerank: async (_query, pairs) => { began(); await gate; return rankRows(pairs, 0.9); } } });
  const search = f.manager.search({ query: "sunbeam" });
  await started;
  f.state.workspace.feedback["understanding:light"] = { decision: "pending_rewrite" };
  await f.manager.sync();
  release();
  const result = await search;
  assert.equal(result.items[0].summary, "");
  assert.deepEqual(result.items[0].concepts, []);
  assert.doesNotMatch(JSON.stringify(result), /旧理解必须消失/u);
});

test("close cancels a stalled reranker and closes both model clients", async t => {
  let began, signal, embeddingCloses = 0, rankingCloses = 0;
  const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { embedder: embeddingClient({ close: async () => { embeddingCloses++; } }), reranker: { rerank: async (_query, _pairs, options) => { signal = options.signal; began(); return new Promise(() => {}); }, close: async () => { rankingCloses++; } } });
  const search = f.manager.search({ query: "sunbeam" });
  const rejected = assert.rejects(search, { code: "KNOWLEDGE_CLOSED" });
  await started;
  await f.manager.close();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(embeddingCloses, 1);
  assert.equal(rankingCloses, 1);
});

test("moderate document similarity needs corroboration from short-title relevance", async t => {
  const calls = [];
  const f = await fixture(t, { collections: [light, item("related", "日照与室内", "光照变化改变了房间的明暗。"), coffee], embedder:embeddingClient({ embed:async texts => texts.map(value => value.includes("光照变化") ? [0.4, Math.sqrt(0.84), 0] : value.includes("咖啡") ? [0, 0, 1] : [1, 0, 0]) }), reranker: { rerank: async (query, pairs) => {
    calls.push(query);
    if (query === "日照与室内") return rankRows(pairs, 0.08);
    if (query === "咖啡风味") return rankRows(pairs, 0.001);
    return rankRows(pairs, pair => pair.text.includes("光照变化") ? 0.001 : 0.004);
  } } });
  const result = await f.manager.findSimilar({ collectionId: "light" });
  assert.deepEqual(result.items.map(value => value.collectionId), ["related"]);
  assert.equal(result.items[0].rerankDirection, "candidate_title");
  assert.equal(result.items[0].rerankScore, 0.08);
  assert.equal(result.items[0].qualitySource, "source_pair_with_title");
  assert.ok(calls.includes("采光建筑") && calls.includes("日照与室内"));
  assert.ok(calls.every(query => !query.includes("窗户让")), "An entire article is not supplied as a relevance question");
});

test("empty and metadata-only libraries do not load or call semantic models", async t => {
  for (const collections of [[], [{ id: "metadata", title: "尚未读到原文的建筑资料", status: "saved", type: "article", url: "https://example.org/metadata", input: { mode: "link", content: "https://example.org/metadata" } }]]) {
    let embedCalls = 0, rankCalls = 0;
    const f = await fixture(t, { collections, embedder: embeddingClient({ embed: async () => { embedCalls++; throw new Error("Must not load"); } }), reranker: { rerank: async () => { rankCalls++; throw new Error("Must not load"); } } });
    const result = await f.manager.search({ query: "建筑资料" });
    assert.equal(result.mode, "full_text");
    assert.equal(embedCalls, 0);
    assert.equal(rankCalls, 0);
    if (collections.length) assert.equal(result.items[0]?.coverage, "unavailable");
  }
});

test("full-text-only managers never call a supplied reranker", async t => {
  let calls = 0;
  const f = await fixture(t, { embedder: null, reranker: { rerank: async () => { calls++; throw new Error("Must not run"); } } });
  assert.equal((await f.manager.search({ query: "自然光" })).items[0].collectionId, "light");
  assert.equal(calls, 0);
});

test("the highest-ranked tail passage remains first after version revalidation and opens at its real offset", async t => {
  const opening = "首段背景介绍咖啡温度、烘焙风味和记录格式，这些材料与本轮问题没有直接关系。\n";
  const tail = "尾段目标证据说明窗户让自然光进入房间，采光和遮阳应该结合实际朝向观察。";
  const source = item("long", "专题汇编", opening + tail);
  const f = await fixture(t, { collections: [source], reranker: { rerank: async (_query, pairs) => rankRows(pairs, pair => pair.text.includes("尾段目标证据") ? 0.9 : 0.001) } });
  const result = await f.manager.search({ query: "sunbeam" });
  const first = result.items[0].chunks[0];
  assert.equal(first.text, tail);
  assert.equal(first.start, opening.length);
  assert.equal(first.end, source.content.length);
  assert.equal(result.items[0].rerankChunkId, first.chunkId);
  const opened = await f.manager.readDocument({ collectionId: source.id, offset: first.start, limit: first.end - first.start });
  assert.equal(opened.text, tail, "The UI's first-passage offset opens the actual relevant passage");
});

test("document-pair similarity preserves the actual paired evidence order on both articles", async t => {
  const anchorOpening = "起点首段只是无关背景记录，列出一些材料名称和整理顺序，尚未讨论具体主题。\n";
  const anchorTail = "起点尾段证据讨论窗户采光与遮阳，原文内容应保留实际字符定位以便回看。";
  const candidateOpening = "候选首段只说明文档编号与保存位置，列出不同批次的索引和整理时间。\n";
  const candidateTail = "候选尾段证据说明自然光如何进入房间，并建议结合窗户朝向研究实际采光。";
  const a = item("anchor", "起点主题", anchorOpening + anchorTail), b = item("related", "候选主题", candidateOpening + candidateTail);
  const f = await fixture(t, { collections: [a, b], embedder:embeddingClient({ embed:async texts => texts.map(value => value.includes("尾段证据") ? [1, 0, 0] : value.includes("候选首段") ? [0, 0, 1] : [0, 1, 0]) }), reranker: { rerank: async (query, pairs) => rankRows(pairs, pair => query === a.title ? pair.text.includes("候选尾段证据") ? 0.08 : 0.001 : pair.text.includes("起点尾段证据") ? 0.09 : 0.001) } });
  const result = await f.manager.findSimilar({ collectionId: a.id });
  const related = result.items.find(value => value.collectionId === b.id);
  assert.equal(related.chunks[0].text, candidateTail);
  assert.equal(related.chunks[0].start, candidateOpening.length);
  assert.equal(related.anchorChunks[0].text, anchorTail);
  assert.equal(related.anchorChunks[0].start, anchorOpening.length);
  assert.equal(related.rerankChunkId, related.chunks[0].chunkId);
  assert.equal(related.rerankAnchorChunkId, related.anchorChunks[0].chunkId);
  assert.equal(related.pairedChunkId, related.chunks[0].chunkId);
  assert.equal(related.pairedAnchorChunkId, related.anchorChunks[0].chunkId);
  const opened = await f.manager.readDocument({ collectionId: a.id, offset: related.anchorChunks[0].start, limit: anchorTail.length });
  assert.equal(opened.text, anchorTail);
});

test("source-pair meaning can rescue an opaque title while an unrelated pair cannot pass on QA alone", async t => {
  const related = item("related", "另一扇窗", "柔和日照让房间里的阅读更加舒适。");
  const f = await fixture(t, { collections:[light, related, coffee],
    embedder:embeddingClient({ embed:async texts => texts.map(value => value.includes("咖啡") ? [0.2, Math.sqrt(0.96), 0] : value.includes("柔和日照") ? [0.6, 0, 0.8] : [1, 0, 0]) }),
    reranker:{ rerank:async (_query, pairs) => rankRows(pairs, pair => pair.text.includes("咖啡") ? 0.99 : 0.001) } });
  const result = await f.manager.findSimilar({ collectionId:"light" });
  assert.deepEqual(result.items.map(value => value.collectionId), ["related"]);
  assert.equal(result.items[0].qualitySource, "source_pair_semantic");
  assert.ok(result.items[0].pairedSimilarity >= 0.45);
});

test("two weak search signals are insufficient even when a wide candidate was retrieved", async t => {
  const f = await fixture(t, { reranker:{ rerank:async (_query, pairs) => rankRows(pairs, 0.04) } });
  const result = await f.manager.search({ query:"sunbeam" });
  assert.deepEqual(result.items, []);
});
