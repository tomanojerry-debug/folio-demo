import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createKnowledgeManager } from "../desktop/server/knowledge/manager.mjs";

const collection = (id, title, body) => ({ id, title, url: `https://example.org/${id}`, status: "saved", type: "user_input", input: { mode: "text", content: body }, content: body });
const space = { model: "fixture-embedding", dimensions: 3 };
const vector = text => /自然光|日照|sunlight/u.test(text) ? [1, 0, 0] : /咖啡/u.test(text) ? [0, 1, 0] : [0, 0, 1];
const embedder = { space, embed: async texts => texts.map(vector) };

async function fixture(t, state, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-knowledge-manager-"));
  let current = state;
  const instances = [];
  const open = async overrides => {
    const manager = await createKnowledgeManager({ directory, getState: () => structuredClone(current), embedder: null, ...options, ...overrides });
    instances.push(manager);
    return manager;
  };
  const manager = await open();
  t.after(async () => {
    for (const instance of instances) await instance.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { manager, open, get state() { return current; }, set state(next) { current = next; } };
}

test("originals and full-text retrieval work without embedding configuration across reopen", async t => {
  const f = await fixture(t, { collections: [collection("light", "建筑与自然光", "窗户和天井把自然光带进室内。")], jobs: [] });
  assert.equal(f.manager.status().semanticStatus, "unconfigured");
  assert.equal(f.manager.status().storeStats.documents, 1);
  const result = await f.manager.search({ query: "自然光" });
  assert.equal(result.mode, "full_text");
  assert.deepEqual(result.items.map(item => item.collectionId), ["light"]);
  assert.equal((await f.manager.readDocument({ collectionId: "light" })).text, "窗户和天井把自然光带进室内。");
  await f.manager.close();
  const reopened = await f.open();
  assert.equal((await reopened.readDocument({ collectionId: "light" })).text, "窗户和天井把自然光带进室内。");
});

test("background indexing supports semantic recall and caches repeated query vectors", async t => {
  const calls = [];
  const f = await fixture(t, { collections: [collection("light", "建筑", "自然光带来更清晰的室内光照。"), collection("coffee", "饮品", "咖啡烘焙需要控制温度。")], jobs: [] }, { embedder: { space, embed: async texts => { calls.push(texts); return texts.map(vector); } } });
  await f.manager.idle();
  assert.equal(f.manager.status().semanticStatus, "ready");
  assert.equal(f.manager.status().storeStats.semanticReady, 2);
  const first = await f.manager.search({ query: "日照" });
  assert.equal(first.mode, "hybrid");
  assert.deepEqual(first.items.map(item => item.collectionId), ["light"]);
  assert.equal(first.items[0].matchedTerms.length, 0, "Recall comes from semantics rather than shared words");
  const count = calls.length;
  await f.manager.search({ query: "日照" });
  assert.equal(calls.length, count, "A repeated query reuses its vector");
});

test("provider failure preserves pending work, degrades to full text, and does not retry in a storm", async t => {
  let calls = 0;
  const f = await fixture(t, { collections: [collection("light", "自然光", "天井的自然光能照亮房间。")], jobs: [] }, { embedder: { space, embed: async () => { calls++; throw Object.assign(new Error("private provider diagnostic"), { code: "EMBEDDING_PROVIDER_ERROR" }); } } });
  await f.manager.idle();
  assert.equal(f.manager.status().semanticStatus, "unavailable");
  assert.equal(f.manager.status().lastErrorCode, "EMBEDDING_PROVIDER_ERROR");
  assert.equal(JSON.stringify(f.manager.status()).includes("private"), false);
  const result = await f.manager.search({ query: "自然光" });
  assert.equal(result.mode, "full_text");
  assert.equal(result.semanticStatus, "unavailable");
  assert.equal(result.items[0].collectionId, "light");
  await f.manager.sync();
  await f.manager.search({ query: "自然光" });
  assert.equal(calls, 1);
  assert.equal((await f.manager.readDocument({ collectionId: "light" })).text, "天井的自然光能照亮房间。");
});

test("query embedding failure leaves already indexed originals searchable", async t => {
  let fail = false;
  const f = await fixture(t, { collections: [collection("light", "自然光", "自然光照进建筑。")], jobs: [] }, { embedder: { space, embed: async texts => {
    if (fail) throw new Error("query provider failure");
    return texts.map(vector);
  } } });
  await f.manager.idle();
  fail = true;
  const result = await f.manager.search({ query: "自然光" });
  assert.equal(result.mode, "full_text");
  assert.equal(result.semanticStatus, "unavailable");
  assert.equal(result.items[0].collectionId, "light");
});

test("an invalid query vector degrades to full text before reaching vector storage", async t => {
  let fail = false;
  const f = await fixture(t, { collections: [collection("light", "自然光", "自然光照进建筑。")], jobs: [] }, { embedder: { space, embed: async texts => fail ? [[0, 0, 0]] : texts.map(vector) } });
  await f.manager.idle();
  fail = true;
  const result = await f.manager.search({ query: "自然光" });
  assert.equal(result.mode, "full_text");
  assert.equal(result.semanticStatus, "unavailable");
  assert.equal(result.items[0].collectionId, "light");
  assert.equal(f.manager.status().lastErrorCode, "EMBEDDING_OUTPUT_INVALID");
});

test("a deleted collection cannot be revived by delayed embedding results", async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { collections: [collection("light", "自然光", "自然光带来明亮的室内环境。")], jobs: [] }, { embedder: { space, embed: async texts => { started(); await gate; return texts.map(vector); } } });
  await ready;
  f.state = { collections: [], jobs: [] };
  await f.manager.sync();
  release();
  await f.manager.idle();
  assert.equal(f.manager.status().storeStats.totalCollections, 0);
  assert.deepEqual((await f.manager.search({ query: "自然光" })).items, []);
  await assert.rejects(f.manager.readDocument({ collectionId: "light" }), { code: "NOT_FOUND" });
});

test("queued mutations read current state and fail instead of recreating a deleted source", async t => {
  const f = await fixture(t, { collections: [collection("light", "自然光", "自然光照进建筑。")], jobs: [] });
  const pending = f.manager.captureSource({ collectionId: "light", captureId: "fresh", sourceRevision: 2, source: { title: "新版", text: "新版来源不能复活已删收藏。" } });
  f.state = { collections: [], jobs: [] };
  await assert.rejects(pending, { code: "KNOWLEDGE_DELETED" });
  assert.equal(f.manager.status().storeStats.totalCollections, 0);
});

test("chat-only state changes skip reconciliation and status notifications are exception safe", async t => {
  let notifications = 0;
  const f = await fixture(t, { collections: [collection("light", "自然光", "自然光照进建筑。")], jobs: [], messages: [] }, { onChange() { notifications++; throw new Error("UI observer failure"); } });
  const original = f.manager.status();
  const before = notifications;
  f.state.messages.push({ id: "chat", role: "user", text: "a new conversation" });
  assert.deepEqual(await f.manager.sync(), { unchanged: true });
  assert.deepEqual(f.manager.status(), original);
  assert.equal(notifications, before);
  const copy = f.manager.status();
  copy.storeStats.documents = 999;
  assert.equal(f.manager.status().storeStats.documents, 1, "A consumer cannot mutate cached status");
});

test("findSimilar uses the saved anchor embedding without embedding a generic similarity question", async t => {
  let calls = 0;
  const f = await fixture(t, { collections: [collection("a", "窗户", "自然光照进房间。"), collection("b", "天井", "天井把自然光引入建筑内部。"), collection("c", "咖啡", "咖啡烘焙要控制温度。")], jobs: [] }, { embedder: { space, embed: async texts => { calls++; return texts.map(vector); } } });
  await f.manager.idle();
  const before = calls;
  const result = await f.manager.findSimilar({ collectionId: "a" });
  assert.equal(result.mode, "hybrid");
  assert.deepEqual(result.items.map(item => item.collectionId), ["b"]);
  assert.ok(result.anchor.chunks.length);
  assert.ok(result.items[0].anchorChunks.length);
  assert.equal(calls, before);
});

test("query vector LRU remains bounded and refreshes recent entries", async t => {
  let queries = 0;
  const f = await fixture(t, { collections: [collection("a", "资料", "一段用于检索缓存验证的正文。")], jobs: [] }, { embedder: { space, embed: async texts => {
    if (texts.length === 1 && /^query-\d+$/u.test(texts[0])) queries++;
    return texts.map(vector);
  } } });
  await f.manager.idle();
  for (let index = 0; index < 129; index++) await f.manager.search({ query: `query-${index}` });
  assert.equal(queries, 129);
  await f.manager.search({ query: "query-128" });
  assert.equal(queries, 129);
  await f.manager.search({ query: "query-0" });
  assert.equal(queries, 130, "The oldest of 129 unique query vectors has been evicted");
});

test("different model spaces reindex independently after reopening", async t => {
  const f = await fixture(t, { collections: [collection("light", "自然光", "自然光照亮房间。")], jobs: [] }, { embedder });
  await f.manager.idle();
  await f.manager.close();
  let calls = 0;
  const other = await f.open({ embedder: { space: { model: "other-model", dimensions: 3 }, embed: async texts => { calls++; return texts.map(vector); } } });
  await other.idle();
  assert.ok(calls > 0, "Vectors from a different model must not satisfy this space");
  assert.equal(other.status().storeStats.semanticReady, 1);
});

test("close cancels stalled providers, is idempotent, and rejects later work", async t => {
  let started, signal;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { collections: [collection("light", "自然光", "自然光照进建筑。")], jobs: [] }, { embedder: { space, embed: async (_texts, options) => { signal = options.signal; started(); return new Promise(() => {}); } } });
  await ready;
  const first = f.manager.close();
  assert.equal(f.manager.close(), first);
  await first;
  assert.equal(signal.aborted, true);
  await assert.rejects(f.manager.sync(), { code: "KNOWLEDGE_CLOSED" });
  await assert.rejects(f.manager.search({ query: "自然光" }), { code: "KNOWLEDGE_CLOSED" });
});
