import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openKnowledge } from "../desktop/server/knowledge/store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-knowledge-graph-"));
  let knowledge = await openKnowledge({ directory });
  t.after(async () => { await knowledge.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get knowledge() { return knowledge; }, async reopen() { await knowledge.close(); knowledge = await openKnowledge({ directory }); } };
}
function extraction(id, body, concepts, extra = {}) {
  return { status: "qualified", revision: 1, summary: `关于${concepts.join("、")}的资料。`, concepts,
    conceptEvidence: concepts.map(value => ({ value, evidence_ids: [`${id}#e1`] })),
    evidenceBundle: [{ evidence_id: `${id}#e1`, source_field: "body_text", locator: "原文证据片段 1", text: body }], ...extra };
}
async function add(knowledge, id, body, concepts, options = {}) {
  const result = await knowledge.captureSource({ collectionId: id, captureId: `capture:${id}`, sourceRevision: 1, source: { title: options.title || id, text: body, url: options.url || `https://example.org/${id}`, ...(options.evidence ? { evidence: options.evidence } : {}) } });
  const understood = extraction(id, body, concepts, options.extraction);
  await knowledge.attachUnderstanding({ collectionId: id, documentVersionId: result.documentVersionId, sourceRevision: 1, extraction: understood });
  return { descriptor: result, state: { id, title: options.title || id, url: options.url || `https://example.org/${id}`, status: "ready", sourceRevision: 1, input: { mode: "text", content: body }, content: body, extraction: understood }, body };
}

test("shared concepts return two current original passages with source versions and offsets", async t => {
  const { knowledge } = await fixture(t);
  const a = await add(knowledge, "a", "自然光经过窗户进入室内，建筑师需要结合遮阳判断阅读位置。", ["自然光"]);
  const b = await add(knowledge, "b", "阅读空间中的自然光需要避免眩光，朝向与亮度也值得观察。", ["自然光"]);
  await add(knowledge, "coffee", "咖啡烘焙温度决定酸度与风味，实验时需要控制粉水比例。", ["咖啡烘焙"]);
  const result = await knowledge.getConnections({ collectionId: "a" });
  assert.equal(result.mode, "evidence_graph");
  assert.equal(result.graphStatus, "ready");
  assert.equal(result.anchor.documentVersionId, a.descriptor.documentVersionId);
  assert.equal(result.anchor.understandingRevision, 1);
  assert.deepEqual(result.items.map(item => item.collectionId), ["b"]);
  const related = result.items[0];
  assert.equal(related.relationType, "shared_concept");
  assert.equal(related.documentVersionId, b.descriptor.documentVersionId);
  assert.equal(related.understandingRevision, 1);
  assert.equal(related.concepts[0].name, "自然光");
  assert.equal(related.concepts[0].mentionType, "literal_mention");
  for (const [record, body] of [[related.anchorChunks[0], a.body], [related.chunks[0], b.body]]) {
    assert.ok(record.chunkId && record.evidence_id && record.documentVersionId);
    assert.equal(body.slice(record.start, record.end), record.text);
    assert.ok(record.text.includes("自然光"));
  }
  assert.match(related.matchReasons.join(" "), /共同提及/u);
  const opened = await knowledge.readDocument({ collectionId: "b", offset: related.chunks[0].start, limit: related.chunks[0].end - related.chunks[0].start });
  assert.equal(opened.text, related.chunks[0].text);
});

test("abstract topics require valid current evidence and are labelled as system-extracted themes", async t => {
  const { knowledge } = await fixture(t);
  const topic = "保留人的最终判断";
  await add(knowledge, "a", "自动化可以给出建议，但最后的选择应由使用者自己作出。", [topic]);
  await add(knowledge, "b", "工具先提供候选解释，是否接受仍交给读者决定。", [topic]);
  await add(knowledge, "ungrounded", "这篇谈到另一种完全不同的材料，没有提供可核对的概念出处。", [topic], { extraction: { conceptEvidence: [{ value: topic, evidence_ids: ["forged#e1"] }] } });
  const result = await knowledge.getConnections({ collectionId: "a" });
  assert.deepEqual(result.items.map(item => item.collectionId), ["b"]);
  assert.equal(result.items[0].concepts[0].mentionType, "extracted_topic");
  assert.match(result.items[0].matchReasons.join(" "), /系统识别的共同主题/u);
  assert.ok(result.items[0].chunks.length && result.items[0].anchorChunks.length);
});

test("legacy literal labels can be recovered while abstract labels and substrings are not invented", async t => {
  const { knowledge } = await fixture(t);
  await add(knowledge, "a", "JavaScript 的事件循环需要区分调用栈和任务队列。", ["JavaScript", "art", "自主性判断"], { extraction: { conceptEvidence: [] } });
  await add(knowledge, "b", "javascript 中的任务队列决定回调执行顺序。", ["javascript", "art", "自主性判断"], { extraction: { conceptEvidence: [] } });
  await add(knowledge, "article", "An article can discuss roasting and taste without discussing paintings.", ["art"], { extraction: { conceptEvidence: [] } });
  const result = await knowledge.getConnections({ collectionId: "a" });
  assert.deepEqual(result.items.map(item => item.collectionId), ["b"]);
  assert.equal(result.items[0].concepts.length, 1);
  assert.equal(result.items[0].concepts[0].name, "JavaScript");
  const concepts = await knowledge.getConcepts({});
  assert.deepEqual(concepts.items.map(concept => concept.name), ["JavaScript"]);
  assert.equal(concepts.items[0].sourceCount, 2);
});

test("generic labels cannot create an all-library graph and zero limits stay empty", async t => {
  const { knowledge } = await fixture(t);
  for (const id of ["a", "b", "c"]) await add(knowledge, id, `${id} 文章给出内容来源，系统可以帮助理解知识和材料，但不代表具体主题。`, ["知识", "来源", "内容", "系统", "文章内容", "知识来源"]);
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a" })).items, []);
  assert.deepEqual((await knowledge.getConcepts({})).items, []);
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a", limit: 0 })).items, []);
});

test("conflicting claims remain a shared topic without asserted support, contradiction or causality", async t => {
  const { knowledge } = await fixture(t);
  await add(knowledge, "a", "作者认为少量咖啡因可以帮助保持清醒，但仅讨论自己的观察。", ["咖啡因"]);
  await add(knowledge, "b", "另一位作者认为咖啡因使自己焦虑，建议读者比较各自的身体反应。", ["咖啡因"]);
  const result = await knowledge.getConnections({ collectionId: "a" });
  assert.equal(result.items[0].relationType, "shared_concept");
  assert.doesNotMatch(result.items[0].matchReasons.join(" "), /支持|反对|因果|结论一致/u);
});

test("pending correction, unready status and late understanding writes cannot restore invalidated graph edges", async t => {
  const { knowledge } = await fixture(t);
  const a = await add(knowledge, "a", "窗户的自然光与遮阳可以一起影响室内阅读体验。", ["自然光"]);
  const b = await add(knowledge, "b", "自然光在一天中不断变化，室内亮度应结合具体位置判断。", ["自然光"]);
  await knowledge.reconcile({ collections: [a.state, b.state], workspace: { feedback: { "understanding:b": { decision: "pending_rewrite" } } } });
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a" })).items, []);
  assert.equal((await knowledge.getConnections({ collectionId: "b" })).graphStatus, "understanding_pending");
  await knowledge.attachUnderstanding({ collectionId: "b", documentVersionId: b.descriptor.documentVersionId, sourceRevision: 1, extraction: b.state.extraction });
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a" })).items, [], "A delayed prior understanding cannot bypass the persisted pending flag");
  await knowledge.reconcile({ collections: [a.state, b.state], workspace: { feedback: {} } });
  assert.equal((await knowledge.getConnections({ collectionId: "a" })).items[0].collectionId, "b");
  await knowledge.reconcile({ collections: [a.state, { ...b.state, status: "failed" }], workspace: { feedback: {} } });
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a" })).items, []);
});

test("new source versions and deletions invalidate edges without discarding original history", async t => {
  const { knowledge } = await fixture(t);
  const a = await add(knowledge, "a", "窗户与自然光可以影响室内的明暗层次。", ["自然光"]);
  const b = await add(knowledge, "b", "建筑中的自然光也与天井和遮阳有关。", ["自然光"]);
  const next = await knowledge.captureSource({ collectionId: "b", captureId: "refresh-b", sourceRevision: 2, source: { title: "新版资料", text: "这份新版只讨论茶叶发酵与温度，原来的采光解释保存在历史中。" } });
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a" })).items, []);
  await knowledge.attachUnderstanding({ collectionId: "b", documentVersionId: b.descriptor.documentVersionId, sourceRevision: 1, extraction: b.state.extraction });
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a" })).items, []);
  assert.equal((await knowledge.readDocument({ collectionId: "b", documentVersionId: b.descriptor.documentVersionId })).text, b.body);
  assert.notEqual(next.documentVersionId, b.descriptor.documentVersionId);
  await knowledge.reconcile({ collections: [a.state], jobs: [] });
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a" })).items, []);
  assert.equal((await knowledge.getConcepts({ query: "自然光" })).items[0].sourceCount, 1);
  await assert.rejects(knowledge.getConnections({ collectionId: "b" }), { code: "NOT_FOUND" });
});

test("same document, mirrored source and duplicate content are excluded from connections", async t => {
  const { knowledge } = await fixture(t);
  const body = "建筑中的自然光与窗户布局共同决定室内明暗，应该结合具体环境观察。";
  await add(knowledge, "a", body, ["自然光"], { url: "https://example.org/source?utm_source=one#top" });
  await add(knowledge, "copy", body, ["自然光"]);
  await add(knowledge, "mirror", "这个版本也讨论自然光与建筑，但来源其实是同一篇页面。", ["自然光"], { url: "https://example.org/source?utm_campaign=two" });
  await add(knowledge, "other", "另一篇独立文章讨论自然光进入阅读空间时应考虑的方向。", ["自然光"]);
  assert.deepEqual((await knowledge.getConnections({ collectionId: "a" })).items.map(item => item.collectionId), ["other"]);
});

test("concept graph preserves evidence bindings across paragraph rechunking and reopening", async t => {
  const f = await fixture(t), opening = "这一段先介绍档案背景和记录位置，并未涉及后面的具体论点。\n";
  const tail = "后段证据讨论自然光和窗户朝向，应该保留真实字符位置以便继续检查。";
  const a = await add(f.knowledge, "a", opening + tail, ["自然光"]);
  const b = await add(f.knowledge, "b", "自然光进入室内需要考虑天井、窗户与周围环境的变化。", ["自然光"]);
  await f.reopen();
  const result = await f.knowledge.getConnections({ collectionId: "a" });
  assert.equal(result.items[0].anchorChunks[0].text, tail);
  assert.equal(result.items[0].anchorChunks[0].start, opening.length);
  assert.equal(result.items[0].anchorChunks[0].evidence_id, "a#e1", "References map from the original evidence text even when chunks initially had no evidence IDs");
  assert.equal(result.anchor.documentVersionId, a.descriptor.documentVersionId);
  assert.equal(result.items[0].documentVersionId, b.descriptor.documentVersionId);
});

test("schema-two databases migrate and recover grounded literal nodes without changing sources or vectors", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t);
  const a = await add(f.knowledge, "a", "自然光进入建筑时需要考虑窗户朝向和周围遮挡。", ["自然光"], { extraction: { conceptEvidence: [] } });
  await add(f.knowledge, "b", "室内自然光需要避免过强眩光，并结合阅读位置调整遮阳。", ["自然光"], { extraction: { conceptEvidence: [] } });
  const space = { model: "graph-migration-fixture", dimensions: 2 };
  const work = await f.knowledge.embeddingWork({ space });
  await f.knowledge.writeEmbeddings({ space, items: work.map(item => ({ ...item, vector: [1, 0] })) });
  await f.knowledge.close();
  const db = new DatabaseSync(path.join(f.directory, "knowledge.sqlite"));
  const oldVectors = db.prepare("SELECT count(*) AS total FROM embeddings").get().total;
  db.exec("BEGIN IMMEDIATE; DROP TABLE concept_mentions; DROP TABLE concept_nodes; DROP TABLE graph_state; ALTER TABLE collections DROP COLUMN graph_blocked; ALTER TABLE understandings DROP COLUMN concept_evidence; ALTER TABLE understandings DROP COLUMN concept_grounding; PRAGMA user_version=2; COMMIT;");
  db.close();
  await f.reopen();
  const status = await f.knowledge.status({ space });
  assert.equal(status.schemaVersion, 3);
  assert.equal(status.items.reduce((sum, item) => sum + item.embeddedCount, 0), oldVectors);
  assert.equal((await f.knowledge.readDocument({ collectionId: "a" })).documentVersionId, a.descriptor.documentVersionId);
  assert.equal((await f.knowledge.getConnections({ collectionId: "a" })).items[0].collectionId, "b");
  assert.equal((await f.knowledge.getConcepts({ query: "自然光" })).items[0].sourceCount, 2);
});
