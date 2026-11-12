import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";
import { ingest } from "../server/pipeline.mjs";

const config = { zhipuApiKey: "", textModel: "knowledge-fixture", timeoutMs: 1000 };
const reply = content => ({ choices: [{ message: { content } }] });
function candidate(_call, context) {
  const ids = [context.evidence_bundle[0].evidence_id];
  const summary = (context.user_corrections?.[0]?.text || context.normalized_content.text).slice(0, 160);
  return { trace: { model: "injected-knowledge-fixture" }, output: {
    status: "candidate", summary, summary_evidence_ids: ids,
    digest: { status: "compact", overview: summary, evidence_ids: ids, highlights: [{ text: summary, evidence_ids: ids }] },
    breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "可核对的知识", evidence_ids: ids }],
    content_reliability_score: 0.95, uncertainties: [],
  } };
}
function references(input) {
  const value = input.messages.find(item => item.content.startsWith("策展参考资料"));
  return JSON.parse(value.content.slice(value.content.indexOf("\n") + 1));
}
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-knowledge-service-"));
  let service;
  const options = { directory, config, aiEnabled: true, autoCurate: false, knowledgeEmbedder: null, model: candidate, chat: async () => reply("继续讨论。"), fetchPage: () => { throw Object.assign(new Error("No fixture source"), { code: "FETCH_FAILED" }); }, ...overrides };
  const open = async () => { service = await createDesktopService(options); return service; };
  await open();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, get service() { return service; },
    async reopen(mutate) {
      await service.close();
      if (mutate) {
        const file = path.join(directory, "state.json"), state = JSON.parse(await readFile(file, "utf8"));
        mutate(state); await writeFile(file, JSON.stringify(state), { mode: 0o600 });
      }
      return open();
    },
  };
}

test("plain originals are readable and searchable without AI and remain available after reopening", async t => {
  const f = await fixture(t, { aiEnabled: false });
  const body = "窗户的朝向改变室内自然光。建筑里的采光需要结合使用者的日常节律。";
  const saved = await f.service.capture({ mode: "text", title: "采光笔记", content: body });
  const first = await f.service.knowledgeRead({ collectionId: saved.collectionId, limit: 10 });
  assert.equal(first.document.text, body.slice(0, 10));
  assert.equal(first.document.nextOffset, 10);
  assert.equal((await f.service.knowledgeSearch({ query: "建筑 自然光" })).items[0].collectionId, saved.collectionId);
  assert.equal(f.service.state().capabilities.knowledge.semanticStatus, "unconfigured");
  await f.reopen();
  const restored = await f.service.knowledgeRead({ collectionId: saved.collectionId });
  assert.equal(restored.document.text, body);
  assert.equal(restored.document.documentVersionId, first.document.documentVersionId);
  assert.equal(f.service.state().collections.length, 1);
});

for (const kind of ["throw", "needs_input"]) test(`acquired web originals survive ${kind}, checkpoint eviction and reopening`, async t => {
  let reads = 0;
  const body = "网页原文中的独特线索：北极冻土监测需要连续温度记录，不应只保留一段摘要。";
  const f = await fixture(t, {
    fetchPage: async url => { reads++; return { url, type: "text/plain", title: "冻土观测", text: body }; },
    model: async () => {
      if (kind === "throw") throw Object.assign(new Error("injected model failure"), { code: "MODEL_PROVIDER_ERROR" });
      return { output: { status: "needs_input", needs_input_suggestion: "需要补充背景。" }, trace: { model: "fixture" } };
    },
  });
  const saved = await f.service.capture({ mode: "link", content: "https://example.org/permafrost" });
  await f.service.idle();
  assert.equal((await f.service.knowledgeRead({ collectionId: saved.collectionId })).document.text, body);
  await f.reopen(state => { for (const job of state.jobs) if (job.harness) job.harness.checkpoints = {}; });
  const result = await f.service.knowledgeSearch({ query: "冻土监测" });
  assert.equal(result.items[0].collectionId, saved.collectionId);
  assert.equal(result.items[0].summary, "");
  assert.equal(reads, 1, "Reopening must not reacquire a page to repair an index");
});

test("source persistence is awaited before a model is invoked", async () => {
  let persisted = false, calls = 0;
  const body = "可靠的原文需要先被保存，然后才能调用智能模型进行理解与解释。";
  await ingest({ mode: "text", content: body }, {
    onSource: async snapshot => { await Promise.resolve(); assert.equal(snapshot.text, body); persisted = true; },
    model: async (...args) => { assert.equal(persisted, true); calls++; return candidate(...args); },
  });
  assert.equal(calls, 1);
  await assert.rejects(ingest({ mode: "text", content: body }, { onSource: async () => { throw new Error("cannot save source"); }, model: async () => { throw new Error("must not call model"); } }), /cannot save source/);
});

test("normalized concepts retain their validated original evidence identities", async () => {
  const result = await ingest({ mode: "text", content: "概念与知识需要保留可以核对的原文证据，避免标签与实际来源失去关联。" }, { model:candidate });
  assert.deepEqual(result.extraction.conceptEvidence.map(entry => entry.value), result.extraction.concepts);
  assert.ok(result.extraction.conceptEvidence[0].evidence_ids.every(id => result.extraction.evidenceBundle.some(entry => entry.evidence_id === id)));
  assert.ok(result.extraction.conceptEvidence[0].evidence_ids.every(id => !/^item1-e/u.test(id)), "Stored concept evidence uses signed source IDs rather than prompt aliases");
});

test("a refreshed body is retained when understanding fails and retry accepts it without another fetch", async t => {
  const oldBody = "旧版原文介绍自然光与窗户布局，包含可以核对的空间设计记录。";
  const newBody = "新版原文新增北极冻土观测，不应混用旧版关于窗户布局的理解。";
  let reads = 0, failNew = true;
  const f = await fixture(t, {
    fetchPage: async url => ({ url, type: "text/plain", title: "来源版本", text: ++reads === 1 ? oldBody : newBody }),
    model: async (...args) => {
      if (args[1].normalized_content.text === newBody && failNew) { failNew = false; throw Object.assign(new Error("injected failure"), { code: "MODEL_PROVIDER_ERROR" }); }
      return candidate(...args);
    },
  });
  const saved = await f.service.capture({ mode: "link", content: "https://example.org/versions" });
  await f.service.idle();
  const first = (await f.service.knowledgeRead({ collectionId: saved.collectionId })).document;
  const refresh = await f.service.refreshSource({ collectionId: saved.collectionId });
  await f.service.idle();
  const second = (await f.service.knowledgeRead({ collectionId: saved.collectionId })).document;
  assert.equal(second.text, newBody);
  assert.notEqual(second.documentVersionId, first.documentVersionId);
  assert.equal(f.service.state().collections[0].sourceRevision, 1, "Failed understanding must preserve existing refresh retry contract");
  const search = await f.service.knowledgeSearch({ query: "北极冻土" });
  assert.equal(search.items[0].sourceRevision, 2);
  assert.equal(search.items[0].summary, "", "V1 summary cannot be paired with V2 original");
  await f.service.retryJob({ jobId: refresh.job.id });
  await f.service.idle();
  const accepted = f.service.state().collections[0];
  assert.equal(accepted.sourceRevision, 2);
  assert.equal(accepted.understandingDocumentVersionId, second.documentVersionId);
  assert.equal(reads, 2);
  assert.equal((await f.service.knowledgeRead({ collectionId: saved.collectionId, documentVersionId: first.documentVersionId })).document.text, oldBody);
});

test("semantic retrieval, similar-article scope and actual citations share the same source identities", async t => {
  const observed = [], embeddingCalls = [];
  const embedder = { space: { model: "injected-semantic", dimensions: 3 }, async embed(texts) {
    embeddingCalls.push(texts);
    return texts.map(value => /attention|focus|专注|打断|注意力|连续时间/iu.test(value) ? [1, 0, 0] : /自然光|建筑/u.test(value) ? [0, 1, 0] : [0, 0, 1]);
  } };
  const f = await fixture(t, { knowledgeEmbedder: embedder, chat: async (_config, input) => {
    observed.push(input);
    const data = references(input);
    const cited = data.collections.find(item => item.similarityTo) || data.collections[0];
    return reply(`可从原文继续核对。${cited ? `[[collection:${cited.id}]]` : ""}`);
  } });
  const original = "减少打断，给深度工作留下连续时间，保护专注所需的环境和节律。";
  const a = await f.service.capture({ mode: "text", title: "专注工作", content: original });
  const b = await f.service.capture({ mode: "text", title: "保护注意力", content: "关闭频繁提示，把分散的任务集中处理，让注意力回到同一件事情。" });
  const duplicate = await f.service.capture({ mode: "text", title: "同文转载", content: original });
  await f.service.capture({ mode: "text", title: "咖啡烘焙", content: "咖啡豆的酸度取决于烘焙温度和处理方式，保留实验记录便于核对。" });
  await f.service.idle();
  const search = await f.service.knowledgeSearch({ query: "attention restoration" });
  assert.equal(search.mode, "hybrid");
  assert.ok(search.items.some(item => item.collectionId === b.collectionId));
  assert.ok(search.items.every(item => item.title !== "咖啡烘焙"));
  const similar = await f.service.knowledgeSimilar({ collectionId: a.collectionId });
  assert.ok(similar.items.some(item => item.collectionId === b.collectionId));
  assert.ok(similar.items.every(item => ![a.collectionId, duplicate.collectionId].includes(item.collectionId)));
  assert.ok(similar.anchor.chunks.length && similar.items[0].chunks.length);
  const before = embeddingCalls.length;
  await f.service.send({ text: "你背后用的什么模型", intent: "chat" });
  await f.service.idle();
  assert.deepEqual(references(observed.at(-1)).collections, []);
  assert.equal(embeddingCalls.length, before, "An identity question must not embed a library query");
  await f.service.send({ text: "和这篇类似的文章有哪些？", intent: "chat", collectionIds: [a.collectionId] });
  await f.service.idle();
  const data = references(observed.at(-1));
  assert.equal(data.workspaceContext.selectedCount, 1);
  assert.ok(data.collections.some(item => item.id === b.collectionId && item.similarityTo === a.collectionId));
  assert.deepEqual(f.service.state().messages.at(-1).relatedCollectionIds, [b.collectionId]);
  assert.equal(f.service.state().collections.length, 4);
  const version = (await f.service.knowledgeRead({ collectionId: a.collectionId })).document.documentVersionId;
  const callsBeforeRevision = embeddingCalls.length;
  await f.service.revise({ collectionId: a.collectionId, correction: "重点是减少打断带来的切换，而不是工作时长。" });
  await f.service.idle();
  assert.equal((await f.service.knowledgeRead({ collectionId: a.collectionId })).document.documentVersionId, version);
  assert.equal(embeddingCalls.length, callsBeforeRevision, "Understanding correction should reuse original vectors");
});

test("bad or missing source IDs cannot read another original and cover lookup never becomes source evidence", async t => {
  let reads = 0;
  const f = await fixture(t, { aiEnabled: false, fetchPage: async (url) => {
    reads++;
    return { url, type: "text/html", text: "<main>这是网址里的原始正文，未启用整理时只读取收藏展示信息，不能把正文当作已有的本机证据。</main>" };
  } });
  const a = await f.service.capture({ mode: "text", title: "有原文", content: "这是保存在本机的真实原文，只能通过对应收藏的身份读取。" });
  const b = await f.service.capture({ mode: "link", title: "只有链接", content: "https://example.org/unread" });
  await f.service.idle();
  assert.equal(reads, 1, "The explicit capture can look for a cover");
  const doc = (await f.service.knowledgeRead({ collectionId: a.collectionId })).document;
  await assert.rejects(f.service.knowledgeRead({ collectionId: b.collectionId, documentVersionId: doc.documentVersionId }), { code: "NOT_FOUND" });
  await assert.rejects(f.service.knowledgeRead({ collectionId: "missing" }), { code: "NOT_FOUND" });
  await assert.rejects(f.service.knowledgeSearch({ query: "原文", limit: 0 }), { code: "INVALID_REQUEST" });
  const unavailable = (await f.service.knowledgeRead({ collectionId: b.collectionId })).document;
  assert.equal(unavailable.coverage, "unavailable");
  assert.deepEqual(unavailable.chunks, []);
  await f.reopen();
  assert.equal(reads, 1, "Knowledge queries and reopening never reacquire the page");
  const hit = (await f.service.knowledgeSearch({ query: "只有链接" })).items[0];
  assert.equal(hit.documentVersionId, null);
});
