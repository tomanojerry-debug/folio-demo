import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";

const answer = content => ({ choices: [{ message: { content } }] });
const config = { zhipuApiKey: "", embeddingBackend: "disabled", textModel: "semantic-integration-fixture" };

test("service context stage runs shared semantic memory retrieval, emits provenance and preserves conversation isolation", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "guanxu-semantic-integration-"));
  const calls = [], prompts = [];
  const provider = { space: { model: "fixture-synonyms", dimensions: 2 }, async embed(texts, { role } = {}) {
    calls.push({ role, texts: [...texts] });
    return texts.map(value => role === "query" || value.includes("sunshine") ? [1, 0] : [0, 1]);
  } };
  const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, knowledgeEmbedder: provider, knowledgeReranker: null,
    chat: async (_configuration, input) => { prompts.push(input.messages); return answer("Noted. This is a deterministic fixture response."); } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const original = service.state().activeConversationId;
  await service.send({ conversationId: original, text: "We decided to place the reading desk in sunshine." });
  await service.idle();
  const current = (await service.createConversation({ title: "New discussion" })).conversation.id;
  await service.send({ conversationId: current, text: "Explain breakfast." });
  await service.idle();
  assert.equal(JSON.stringify(prompts.at(-1)).includes("reading desk in sunshine"), false);
  assert.equal(calls.length, 0, "Memory embeddings are not requested for ordinary conversation");
  await service.send({ conversationId: current, text: "What did we discuss in our previous chat about daylight?" });
  await service.idle();
  assert.match(JSON.stringify(prompts.at(-1)), /reading desk in sunshine/);
  assert.ok(calls.some(call => call.role === "query"));
  assert.ok(calls.some(call => call.role === "document"));
  const state = service.state(), job = state.jobs.at(-1), reply = state.messages.at(-1);
  assert.equal(job.status, "complete");
  assert.equal(reply.conversationId, current);
  assert.ok(reply.memoryReferences.some(reference => reference.conversationId === original));
  assert.ok(job.harness.steps.some(step => step.tool === "search-memory" && step.status === "complete"));
  const stored = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
  const manifest = stored.jobs.at(-1).contextManifest;
  assert.equal(manifest.memory.retrieval, "hybrid-vector-lexical-v1");
  assert.equal(manifest.memory.semanticStatus, "ready");
  assert.ok(manifest.memory.recalls.every(reference => reference.sourceMessageIds.length));
  assert.ok(manifest.historyMessageIds.every(id => stored.messages.find(item => item.id === id).conversationId === current));
});

test("service records semantic fallback while still using source-linked lexical recall", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "guanxu-semantic-fallback-"));
  const prompts = [];
  const provider = { space: { model: "fixture-unavailable", dimensions: 2 }, async embed() { throw new Error("synthetic failure"); } };
  const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, knowledgeEmbedder: provider, knowledgeReranker: null,
    chat: async (_configuration, input) => { prompts.push(input.messages); return answer("根据真实历史片段回答。"); } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const a = service.state().activeConversationId;
  await service.send({ conversationId: a, text: "决定：展览必须围绕自然光安排。" }); await service.idle();
  const b = (await service.createConversation({ title: "新的话题" })).conversation.id;
  await service.send({ conversationId: b, text: "上次关于自然光的展览，我们决定怎么安排？" }); await service.idle();
  assert.match(JSON.stringify(prompts.at(-1)), /必须围绕自然光安排/);
  assert.equal(service.state().jobs.at(-1).status, "complete");
  const stored = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
  assert.equal(stored.jobs.at(-1).contextManifest.memory.semanticStatus, "fallback");
  assert.equal(stored.jobs.at(-1).contextManifest.memory.retrieval, "local-lexical-v1");
});

test("service page reads start an auditable session without becoming a dialogue turn or a recalled discussion", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "guanxu-read-memory-integration-"));
  const prompts = [];
  const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false,
    fetchPage: async url => ({ url, type: "text/html", text: "<main><h1>自然光阅读角</h1><p>这是一篇用来核对页面读取与会话记忆边界的合成原文。文章介绍自然光如何照亮阅读角，以及桌面与书架的位置。</p></main>" }),
    chat: async (_configuration, input) => { prompts.push(input.messages); return answer("合成的本轮回复。"); } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const opened = await service.openPage({ context: { title: "自然光阅读角", url: "https://example.org/daylight", attachmentId: "test-window", pageRevision: "page-a" }, requestId: "read-a" });
  const readEvent = service.state().messages.find(item => item.conversationId === opened.conversationId && item.kind === "page-read");
  assert.ok(readEvent, "The real service persists the read audit event");
  const other = (await service.createConversation({ title: "另一个讨论" })).conversation.id;
  await service.send({ conversationId: other, text: "上次我们讨论自然光阅读角，决定了什么？" }); await service.idle();
  assert.equal(service.state().messages.at(-1).memoryReferences?.length || 0, 0);
  const recallJob = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")).jobs.at(-1);
  assert.deepEqual(recallJob.contextManifest.memory.recalls, []);
  for (let index = 1; index <= 21; index++) {
    await service.send({ conversationId: opened.conversationId, text: index === 1 ? "决定：阅读角需要保留原来的圆桌。" : `第${index}轮围绕阅读角继续交流。` });
    await service.idle();
  }
  const stored = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
  const manifest = stored.jobs.at(-1).contextManifest;
  assert.equal(manifest.memory.recentTurnCount, 20);
  assert.equal(manifest.historyMessageIds.length, 41);
  assert.equal(manifest.historyMessageIds.includes(readEvent.id), false);
  const realFirstUser = stored.messages.find(item => item.conversationId === opened.conversationId && item.role === "user" && item.kind !== "page-read");
  assert.equal(manifest.historyMessageIds[0], realFirstUser.id, "Twenty real earlier turns are retained before turn 21");
  const conversation = stored.conversations.find(item => item.id === opened.conversationId);
  assert.equal(conversation.workingMemory.goal.text, "决定：阅读角需要保留原来的圆桌。");
  assert.equal(conversation.workingMemory.sourceMessageIds.includes(readEvent.id), false);
  assert.ok(stored.messages.some(item => item.id === readEvent.id), "The read event remains available to history/UI audit");
});
