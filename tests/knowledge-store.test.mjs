import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openKnowledge } from "../desktop/server/knowledge/store.mjs";
import { searchTerms, searchUnits, canonicalSourceUrl } from "../desktop/server/knowledge/tokenize.mjs";

const space = { model: "injected-semantic-fixture", dimensions: 3 };
const source = (id, body, title = id, extra = {}) => ({ collectionId: id, captureId: `capture:${id}`, sourceRevision: 1, source: { title, text: body, ...extra } });
const stateItem = (id, body, extra = {}) => ({ id, title: id, status: "ready", sourceRevision: 1, input: { mode: "text", content: body }, ...extra });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-knowledge-"));
  let knowledge = await openKnowledge({ directory });
  t.after(async () => { await knowledge.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get knowledge() { return knowledge; }, async reopen() { await knowledge.close(); knowledge = await openKnowledge({ directory }); return knowledge; } };
}
async function embedAll(knowledge, vectors) {
  const work = await knowledge.embeddingWork({ space, limit: 128 });
  return knowledge.writeEmbeddings({ space, items: work.map(item => ({ ...item, vector: vectors[item.collectionId] || [0, 0, 1] })) });
}

test("originals survive AI failure, checkpoint cleanup and reopening with private permissions", async t => {
  const f = await fixture(t), body = "没有完成智能整理的原文，仍然必须可以在这里逐字读取。";
  const saved = await f.knowledge.captureSource(source("failed", body));
  await f.knowledge.reconcile({ collections: [stateItem("failed", body, { status: "failed" })], jobs: [] });
  await f.reopen();
  const read = await f.knowledge.readDocument({ collectionId: "failed" });
  assert.equal(read.text, body);
  assert.equal(read.documentVersionId, saved.documentVersionId);
  assert.equal(read.summary, "");
  assert.equal((await stat(path.join(f.directory, "knowledge.sqlite"))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
});

test("same source and capture replay is idempotent and a new AI live identity reuses unchanged body", async t => {
  const { knowledge } = await fixture(t), first = source("one", "原文中的自然光与空间关系。", "自然光");
  const saved = await knowledge.captureSource(first);
  assert.equal((await knowledge.captureSource(first)).documentVersionId, saved.documentVersionId);
  assert.equal((await knowledge.captureSource({ ...first, captureId: "another-live-run" })).documentVersionId, saved.documentVersionId);
  await embedAll(knowledge, { one: [1, 0, 0] });
  assert.deepEqual(await knowledge.embeddingWork({ space }), []);
  await knowledge.attachUnderstanding({ collectionId: "one", documentVersionId: saved.documentVersionId, sourceRevision: 1, extraction: { status: "qualified", revision: 2, summary: "只修改理解。", concepts: ["空间"] } });
  assert.deepEqual(await knowledge.embeddingWork({ space }), [], "Understanding changes do not invalidate original-body vectors");
});

test("Chinese two-character words and mixed text use safe full-text queries and return real excerpts", async t => {
  const { knowledge } = await fixture(t);
  await knowledge.captureSource(source("architecture", "建筑中的自然光会改变室内采光。JavaScript 快捷键可以组织界面操作。", "采光与界面"));
  await knowledge.captureSource(source("coffee", "咖啡烘焙温度决定风味与酸度。", "咖啡"));
  for (const query of ["建筑", "自然光", "JavaScript 快捷键", '"建筑" OR ()']) {
    const result = await knowledge.search({ query });
    assert.equal(result.items[0]?.collectionId, "architecture", query);
    assert.ok(result.items[0].chunks.some(chunk => chunk.text.includes("建筑")), query);
    assert.equal(result.mode, "full_text");
  }
  assert.deepEqual((await knowledge.search({ query: "quantum elephant" })).items, []);
  assert.deepEqual((await knowledge.search({ query: "这篇有什么内容？" })).items, []);
  assert.deepEqual((await knowledge.search({ query: "自然光", limit: 0 })).items, []);
  assert.deepEqual((await knowledge.search({ query: "自然光", collectionIds: ["coffee"] })).items, []);
  assert.ok(searchTerms("建筑里的JavaScript模型").includes("模型"));
  await assert.doesNotReject(knowledge.search({ query:'建筑" OR "malicious:query' }));
});

test("long-document search finds material beyond the beginning and preserves offsets and pagination", async t => {
  const { knowledge } = await fixture(t), body = "咖啡烘焙的常见问题。".repeat(500) + "\n隐藏在后半段的北极冻土观测记录，显示连续温度变化。";
  await knowledge.captureSource(source("long", body, "观察记录"));
  const hit = (await knowledge.search({ query: "北极冻土" })).items[0];
  const excerpt = hit.chunks.find(chunk => chunk.text.includes("北极冻土"));
  assert.ok(excerpt);
  assert.equal(body.slice(excerpt.start, excerpt.end), excerpt.text);
  const first = await knowledge.readDocument({ collectionId: "long", offset: 0, limit: 700 });
  assert.equal(first.text, body.slice(0, 700));
  assert.equal(first.nextOffset, 700);
  assert.equal(first.hasMore, true);
  const next = await knowledge.readDocument({ collectionId: "long", offset: first.nextOffset, limit: 700 });
  assert.equal(next.text, body.slice(700, 1400));
  const selected = await knowledge.readDocument({ collectionId: "long", chunkIds: [excerpt.chunkId], limit: 2000 });
  assert.equal(selected.chunks.length, 1);
  assert.equal(selected.chunks[0].chunkId, excerpt.chunkId);
});

test("semantic synonyms retrieve without shared terms and fusion keeps real lexical results", async t => {
  const { knowledge } = await fixture(t);
  await knowledge.captureSource(source("focus", "减少打断，留出连续时间，保护深度工作。", "专注工作"));
  await knowledge.captureSource(source("light", "自然光建筑与窗户朝向。", "采光"));
  await knowledge.captureSource(source("coffee", "咖啡豆的酸度与烘焙。", "咖啡"));
  await embedAll(knowledge, { focus: [1, 0, 0], light: [0.1, 0.99, 0], coffee: [0, 0, 1] });
  assert.deepEqual((await knowledge.search({ query: "attention restoration" })).items, []);
  const semantic = await knowledge.search({ query: "attention restoration", space, vector: [1, 0, 0] });
  assert.equal(semantic.mode, "hybrid");
  assert.deepEqual(semantic.items.map(item => item.collectionId), ["focus"]);
  assert.ok(semantic.items[0].matchReasons.includes("语义内容相近"));
  const hybrid = await knowledge.search({ query: "自然光", space, vector: [1, 0, 0] });
  assert.deepEqual(new Set(hybrid.items.map(item => item.collectionId)), new Set(["focus", "light"]));
  assert.deepEqual((await knowledge.search({ query: "unknown", space, vector: [-1, 0, 0], minSimilarity: 0.8 })).items, []);
});

test("embedding spaces are isolated and malformed vectors cannot enter the index", async t => {
  const { knowledge } = await fixture(t);
  await knowledge.captureSource(source("one", "室内自然光与空间设计。"));
  const [item] = await knowledge.embeddingWork({ space });
  for (const vector of [[1, 2], [0, 0, 0], [1, NaN, 0], [1, Infinity, 0]]) {
    await assert.rejects(knowledge.writeEmbeddings({ space, items: [{ ...item, vector }] }), { code: "KNOWLEDGE_INVALID_VECTOR" });
  }
  await embedAll(knowledge, { one: [1, 0, 0] });
  assert.ok((await knowledge.embeddingWork({ space: { model: "other-model", dimensions: 3 } })).length);
  assert.equal((await knowledge.search({ query: "unknown", space: { model: "other-model", dimensions: 3 }, vector: [1, 0, 0] })).mode, "full_text");
  assert.equal((await knowledge.status({ space })).semanticReady, 1);
});

test("similar articles exclude self, identical content and tracking variants of the same source", async t => {
  const { knowledge } = await fixture(t);
  const anchor = "空间设计中的自然光与窗户，共同改变日常生活节律。";
  await knowledge.captureSource(source("anchor", anchor, "自然光空间", { url: "https://example.org/article?page=1&utm_source=news#top" }));
  await knowledge.captureSource(source("copy", anchor, "转载"));
  await knowledge.captureSource(source("mirror", "同一链接后来读取到的自然光与空间设计内容。", "镜像", { url: "https://example.org/article?page=1&utm_campaign=other" }));
  await knowledge.captureSource(source("related", "建筑中的窗户布局影响自然光。", "采光建筑", { url: "https://example.org/article?page=2" }));
  await knowledge.captureSource(source("unrelated", "咖啡的烘焙影响酸度。", "咖啡"));
  await embedAll(knowledge, { anchor: [1, 0, 0], copy: [1, 0, 0], mirror: [1, 0, 0], related: [0.95, 0.05, 0], unrelated: [0, 0, 1] });
  const result = await knowledge.findSimilar({ collectionId: "anchor", space });
  assert.equal(result.mode, "hybrid");
  assert.deepEqual(result.items.map(item => item.collectionId), ["related"]);
  assert.equal(result.anchor.collectionId, "anchor");
  assert.ok(result.items[0].chunks.length);
  assert.ok(result.items[0].anchorChunks.length);
  assert.notEqual(canonicalSourceUrl("https://example.org/article?page=1"), canonicalSourceUrl("https://example.org/article?page=2"));
});

test("similar search falls back honestly to full text and permits no related articles", async t => {
  const { knowledge } = await fixture(t);
  await knowledge.captureSource(source("anchor", "建筑中的自然光有助于理解室内空间。", "自然光建筑"));
  await knowledge.captureSource(source("related", "建筑设计需要考虑自然光照射方向。", "窗户"));
  await knowledge.captureSource(source("coffee", "咖啡酸度来自烘焙。", "咖啡"));
  const result = await knowledge.findSimilar({ collectionId: "anchor" });
  assert.equal(result.mode, "full_text");
  assert.deepEqual(result.items.map(item => item.collectionId), ["related"]);
  assert.deepEqual((await knowledge.findSimilar({ collectionId: "coffee" })).items, []);
});

test("refresh failure retains the newer body without pairing it with old understanding", async t => {
  const { knowledge } = await fixture(t), oldBody = "旧版文字解释自然光与建筑，旧观点只属于旧文。", nextBody = "新版文字讨论咖啡与烘焙，完全不同的新版证据。";
  const old = await knowledge.captureSource(source("one", oldBody, "旧版"));
  const extraction = { status: "qualified", summary: "只存在于旧版理解的金色飞船", concepts: ["旧版概念"], evidenceBundle: [{ text: oldBody, evidence_id: "old#e1" }] };
  await knowledge.attachUnderstanding({ collectionId: "one", documentVersionId: old.documentVersionId, sourceRevision: 1, extraction });
  const newer = await knowledge.captureSource({ ...source("one", nextBody, "新版"), captureId: "refresh:two", sourceRevision: 2 });
  await knowledge.reconcile({ collections: [stateItem("one", oldBody, { status: "failed", sourceRevision: 1, extraction })], jobs: [] });
  const current = await knowledge.readDocument({ collectionId: "one" });
  assert.equal(current.documentVersionId, newer.documentVersionId);
  assert.equal(current.text, nextBody);
  assert.equal(current.summary, "");
  assert.deepEqual((await knowledge.search({ query: "金色飞船" })).items, []);
  assert.equal((await knowledge.readDocument({ collectionId: "one", documentVersionId: old.documentVersionId })).text, oldBody);
});

test("late older captures, old vectors and deleted collection writes never revive current search", async t => {
  const { knowledge } = await fixture(t);
  const first = await knowledge.captureSource({ ...source("one", "自然光建筑。", "第一版"), source: { title: "第一版", text: "自然光建筑。", capturedAt: "2026-11-10T01:00:00Z" } });
  const work = await knowledge.embeddingWork({ space });
  const next = await knowledge.captureSource({ ...source("one", "咖啡烘焙。", "第二版"), captureId: "next", source: { title: "第二版", text: "咖啡烘焙。", capturedAt: "2026-11-10T02:00:00Z" } });
  const late = await knowledge.captureSource({ ...source("one", "迟到旧内容。", "迟到"), captureId: "late", source: { title: "迟到", text: "迟到旧内容。", capturedAt: "2026-11-10T00:00:00Z" } });
  assert.equal(late.active, false);
  assert.equal((await knowledge.readDocument({ collectionId: "one" })).documentVersionId, next.documentVersionId);
  assert.deepEqual(await knowledge.writeEmbeddings({ space, items: work.map(item => ({ ...item, vector: [1, 0, 0] })) }), { written: 0, skipped: work.length });
  assert.notEqual(first.documentVersionId, next.documentVersionId);
  const currentWork = await knowledge.embeddingWork({ space });
  await knowledge.reconcile({ collections: [], jobs: [] });
  assert.deepEqual((await knowledge.search({ query: "咖啡" })).items, []);
  assert.deepEqual(await knowledge.writeEmbeddings({ space, items: currentWork.map(item => ({ ...item, vector: [1, 0, 0] })) }), { written: 0, skipped: currentWork.length });
  await assert.rejects(knowledge.readDocument({ collectionId: "one" }), { code: "NOT_FOUND" });
  await assert.rejects(knowledge.captureSource(source("one", "不应复活的正文。")), { code: "KNOWLEDGE_DELETED" });
});

test("reconciliation backfills only original evidence, text and source checkpoints; metadata stays honest", async t => {
  const { knowledge } = await fixture(t);
  const ready = { id: "ready", title: "证据资料", status: "ready", sourceRevision: 1, extraction: { status: "qualified", summary: "摘要不能替代正文", evidenceBundle: [{ evidence_id: "e1", source_field: "body_text", locator: "段落一", text: "真实第一段。" }, { evidence_id: "e2", source_field: "body_text", locator: "段落二", text: "真实第二段。" }] } };
  const missing = { id: "missing", title: "量子力学", url: "https://example.org/missing", status: "needs_input", summary: "这段摘要绝不能成为原文" };
  const failed = { id: "failed", title: "失败收藏", status: "failed", sourceRevision: 1 };
  const jobs = [{ id: "failed-job", collectionId: "failed", targetSourceRevision: 2, harness: { checkpoints: { source: { value: { title: "已取得页面", text: "页面已经读取，即使理解失败也要保存。", url: "https://example.org/fail" } } } } }];
  await knowledge.reconcile({ collections: [ready, missing, failed], jobs });
  assert.equal((await knowledge.readDocument({ collectionId: "ready" })).text, "真实第一段。真实第二段。");
  assert.equal((await knowledge.readDocument({ collectionId: "failed" })).text, jobs[0].harness.checkpoints.source.value.text);
  assert.equal((await knowledge.readDocument({ collectionId: "missing" })).coverage, "unavailable");
  const metadata = await knowledge.search({ query: "量子力学" });
  assert.equal(metadata.items[0].coverage, "unavailable");
  assert.deepEqual(metadata.items[0].chunks, []);
  assert.deepEqual((await knowledge.search({ query: "绝不能成为原文" })).items, []);
  const before = await knowledge.status({ space });
  await knowledge.reconcile({ collections: [ready, missing, failed], jobs });
  assert.deepEqual(await knowledge.status({ space }), before);
  assert.equal(JSON.stringify(before).includes("真实第一段"), false);
});

test("unknown database schemas are rejected without replacing stored source data", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  for (const version of [0, 99]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forme-knowledge-schema-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "knowledge.sqlite");
    let db = new DatabaseSync(filename);
    db.exec(`CREATE TABLE important_data (body TEXT); INSERT INTO important_data VALUES ('must survive'); PRAGMA user_version=${version};`);
    db.close();
    await assert.rejects(openKnowledge({ directory }), { code: "KNOWLEDGE_SCHEMA_UNSUPPORTED" });
    db = new DatabaseSync(filename);
    assert.equal(db.prepare("SELECT body FROM important_data").get().body, "must survive");
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, version);
    db.close();
  }
});

test("restoring an explicitly restored collection rebuilds its removed search rows", async t => {
  const { knowledge } = await fixture(t), body = "建筑中的自然光与窗户布局。";
  await knowledge.captureSource(source("one", body));
  await knowledge.reconcile({ collections: [], jobs: [] });
  assert.deepEqual((await knowledge.search({ query: "自然光" })).items, []);
  await knowledge.reconcile({ collections: [stateItem("one", body)], jobs: [] });
  assert.equal((await knowledge.search({ query: "自然光" })).items[0]?.collectionId, "one");
});

test("full-text similarity requires topical evidence rather than shared function words", async t => {
  const { knowledge } = await fixture(t);
  await knowledge.captureSource(source("anchor", "自然光进入建筑的方式与窗户朝向有关。建筑师需要观察光影如何影响室内活动和使用者的日常节律。", "自然光与建筑"));
  await knowledge.captureSource(source("architecture", "建筑空间中的自然光会随着时间改变，窗户布局和光影塑造不同的室内感受。", "建筑中的采光"));
  await knowledge.captureSource(source("coffee", "咖啡豆的处理方式与烘焙温度影响酸度和风味。应记录每次实验条件，以便比较不同批次的味道。", "咖啡风味实验"));
  const result = await knowledge.findSimilar({ collectionId: "anchor" });
  assert.deepEqual(result.items.map(item => item.collectionId), ["architecture"]);
  assert.ok(result.items[0].matchedTerms.some(term => /自然光|建筑|窗户|光影/u.test(term)));
  assert.deepEqual((await knowledge.findSimilar({ collectionId: "coffee" })).items, []);
  assert.equal((await knowledge.search({ query: "建筑" })).items.length, 2, "Short domain queries remain searchable");
  assert.ok(searchTerms("眩光").includes("眩光"), "ICU single-character segmentation must not lose short domain words");
});

test("similarity with generic titles needs sufficient two-sided content coverage", async t => {
  const { knowledge } = await fixture(t);
  await knowledge.captureSource(source("anchor", "窗户朝向改变自然光进入建筑的路径，光影与室内活动关系密切。", "阅读记录一"));
  await knowledge.captureSource(source("other", "自然光经过窗户进入建筑，朝向和光影改变室内感受。", "阅读记录二"));
  await knowledge.captureSource(source("generic", "处理不同问题的方式会影响最终结果。应记录各种条件并比较方法。", "阅读记录三"));
  assert.deepEqual((await knowledge.findSimilar({ collectionId: "anchor" })).items.map(item => item.collectionId), ["other"]);
});

test("a long topic query cannot retrieve documents by one unrelated generic action", async t => {
  const { knowledge } = await fixture(t);
  await knowledge.captureSource(source("free", "Orbit 免费版只能在联网时生成摘要，离线时可以阅读已经保存的文字。", "Orbit 免费版的离线限制"));
  await knowledge.captureSource(source("pro", "Orbit 专业版安装本机模型后可以离线生成摘要。", "Orbit 专业版的本机摘要"));
  assert.deepEqual((await knowledge.search({ query: "卡塔兰数生成函数的组合证明" })).items, []);
  assert.deepEqual(searchUnits("卡塔兰数生成函数的组合证明"), ["卡塔兰数", "生成", "函数", "组合", "证明"]);
  assert.equal((await knowledge.search({ query: "生成" })).items.length, 2, "An explicitly short action/topic query may still find the requested documents");
  assert.equal((await knowledge.search({ query: "Orbit 专业版 本机模型" })).items[0].collectionId, "pro");
});

test("short explicit technical acronyms are searchable without semantic inference", async t => {
  const { knowledge } = await fixture(t);
  await knowledge.captureSource(source("ai", "Quick AI 可以把选中文字交给模型处理。", "Quick AI"));
  await knowledge.captureSource(source("coffee", "咖啡冲煮需要控制粉水比例。", "咖啡"));
  assert.deepEqual((await knowledge.search({ query: "AI" })).items.map(item => item.collectionId), ["ai"]);
});

test("short independent paragraphs remain semantic chunks even inside long original evidence", async t => {
  const { knowledge } = await fixture(t);
  const opening = "建筑中的自然光通过窗户和天井进入室内。朝向、遮阳和窗墙比共同影响采光，不能只凭窗户面积判断舒适度。建筑师应记录不同时段的亮度。\n";
  const body = opening + "档案背景仅记录材料位置与研究备注。".repeat(90);
  const saved = await knowledge.captureSource(source("long", body, "采光实验", { evidence: [{ text: body, locator: "原文证据片段 1", evidence_id: "source#e1" }] }));
  const read = await knowledge.readDocument({ collectionId: "long", limit: 10000 });
  assert.equal(read.text, body);
  assert.equal(read.chunks[0].text, opening);
  assert.ok(read.chunks.every(chunk => chunk.text.length <= 600));
  assert.equal(read.chunks.map(chunk => chunk.text).join(""), body);
  assert.ok(read.chunks.every(chunk => body.slice(chunk.start, chunk.end) === chunk.text));
  assert.ok(read.chunks.every(chunk => chunk.evidence_id === "source#e1"));
  assert.equal(saved.chunkingVersion, "paragraph-600-v2");
  const work = await knowledge.embeddingWork({ space, limit: 128 });
  assert.ok(work.some(item => item.kind === "chunk" && item.text.endsWith(opening)));
});

test("schema-one chunk migration preserves sources and replaces stale chunk vectors", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t);
  const opening = "窗户与天井让自然光进入室内，建筑采光需要结合朝向和遮阳观察。\n";
  const body = opening + "这是与首段主题无关的长背景档案。".repeat(70);
  const saved = await f.knowledge.captureSource(source("one", body, "采光"));
  await embedAll(f.knowledge, { one: [1, 0, 0] });
  await f.knowledge.close();
  const db = new DatabaseSync(path.join(f.directory, "knowledge.sqlite"));
  db.exec("BEGIN IMMEDIATE; DELETE FROM embeddings WHERE kind='chunk'; DELETE FROM chunks;");
  db.prepare("INSERT INTO chunks(id,version_id,position,body,start_offset,end_offset,locator,evidence_id) VALUES(?,?,?,?,?,?,?,?)").run("legacy-chunk", saved.documentVersionId, 0, body, 0, body.length, "旧原文证据片段 1", "source#e1");
  db.prepare("INSERT INTO embeddings(entity_id,version_id,space,kind,vector,created_at) VALUES(?,?,?,?,?,?)").run("legacy-chunk", saved.documentVersionId, `${space.model}:${space.dimensions}`, "chunk", Buffer.from(Float32Array.from([1, 0, 0]).buffer), new Date().toISOString());
  db.exec("ALTER TABLE documents DROP COLUMN chunking_version; PRAGMA user_version=1; COMMIT;");
  db.close();
  await f.reopen();
  const read = await f.knowledge.readDocument({ collectionId: "one", limit: 10000 });
  assert.equal(read.documentVersionId, saved.documentVersionId);
  assert.equal(read.text, body);
  assert.equal(read.chunks[0].text, opening);
  assert.equal(read.chunkingVersion, "paragraph-600-v2");
  assert.ok(read.chunks.every(chunk => chunk.chunkId !== "legacy-chunk"));
  const status = await f.knowledge.status({ space });
  assert.equal(status.schemaVersion, 3);
  assert.equal(status.items[0].embeddedCount, 1, "Document vector stays cached but all old chunk vectors are removed");
  const work = await f.knowledge.embeddingWork({ space });
  assert.ok(work.length > 1);
  assert.ok(work.every(item => item.kind === "chunk" && item.id !== "legacy-chunk"));
});

test("selected-source full-text retrieval applies scope before the global candidate limit", async t => {
  const { knowledge } = await fixture(t);
  const distractions = Array.from({ length: 401 }, (_, index) => stateItem(`distractor-${index}`, "quasar", { title: "quasar quasar quasar" }));
  const targetBody = "quasar\n" + "This background has enough distinct context to make the body hit rank below hundreds of exact-title distractions. ".repeat(30);
  const target = stateItem("target", targetBody, { title: "Selected science note" });
  await knowledge.reconcile({ collections: [...distractions, target], jobs: [] });
  assert.equal((await knowledge.readDocument({ collectionId: "target" })).text, targetBody);
  const selected = await knowledge.search({ query: "quasar", collectionIds: ["target"], limit: 1 });
  assert.deepEqual(selected.items.map(item => item.collectionId), ["target"]);
  assert.ok(selected.items[0].chunks.some(chunk => chunk.text.includes("quasar")));
  assert.deepEqual((await knowledge.search({ query: "quasar", collectionIds: [] })).items, []);
  assert.deepEqual((await knowledge.search({ query: "quasar", collectionIds: ["unknown", "target"] })).items.map(item => item.collectionId), ["target"]);
});

test("document similarity selects the best actual passage pair without replacing semantic candidates with lexical overlap", async t => {
  const { knowledge } = await fixture(t);
  const first = "Anchor background alpha inventories archived materials and explains the record format.\n";
  const second = "Anchor background beta gives unrelated administrative information about the archive.\n";
  const anchorTail = "Anchor genuine passage studies how daylight enters a reading room through an atrium.";
  const candidateFirst = "Candidate background discusses an archive and its general administrative record format.\n";
  const candidateTail = "Candidate genuine passage explains windows directing sunlight toward indoor reading desks.";
  await knowledge.captureSource(source("anchor", first + second + anchorTail, "Anchor research"));
  await knowledge.captureSource(source("candidate", candidateFirst + candidateTail, "Candidate notes"));
  const work = await knowledge.embeddingWork({ space, limit: 128 });
  await knowledge.writeEmbeddings({ space, items: work.map(item => ({ ...item, vector: item.kind === "document" ? [1, 1, 0] : item.collectionId === "anchor" ? item.text.includes("Anchor genuine") ? [0, 0, 1] : item.text.includes("background beta") ? [0, 1, 0] : [1, 0, 0] : item.text.includes("Candidate genuine") ? [0.1, 0, 1] : [1, 1, 0] })) });
  const result = await knowledge.findSimilar({ collectionId: "anchor", space });
  const candidate = result.items.find(item => item.collectionId === "candidate");
  assert.ok(candidate);
  assert.ok(candidate.pairedSimilarity > 0.99);
  assert.equal(candidate.chunks[0].text, candidateTail);
  assert.equal(candidate.chunks[0].start, candidateFirst.length);
  assert.equal(candidate.anchorChunks[0].text, anchorTail);
  assert.equal(candidate.anchorChunks[0].start, first.length + second.length);
  assert.equal(candidate.pairedChunkId, candidate.chunks[0].chunkId);
  assert.equal(candidate.pairedAnchorChunkId, candidate.anchorChunks[0].chunkId);
  assert.equal(candidate.pairedScoreKind, "cosine_similarity");
});
