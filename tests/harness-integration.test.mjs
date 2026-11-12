import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";
import { startDesktopServer } from "../desktop/server/index.mjs";

const config = { zhipuApiKey: "", embeddingBackend: "disabled", textModel: "synthetic-memory-fixture" };
const answer = content => ({ choices: [{ message: { content } }] });
const page = name => ({ title: `文章 ${name}`, appName: "Google Chrome", url: `https://example.org/${name.toLowerCase()}`,
  attachmentId: "fixture-window", pageRevision: name, browserWindowId: "10", browserTabId: name });
const source = url => ({ url, type: "text/html", text: `<main><h1>来源 ${url}</h1><p>真实读取的合成正文标记：${url.endsWith("/a") ? "A_ONLY_SOURCE" : "B_ONLY_SOURCE"}。这是用于核对来源归属的足够长原始段落，不包含任何私人内容。</p></main>` });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guanxu-harness-integration-"));
  let service = await createDesktopService({ directory, config, aiEnabled: false, autoCurate: false, fetchPage: async url => source(url), ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get service() { return service; }, async reopen() {
    await service.close(); service = await createDesktopService({ directory, config, aiEnabled: false, autoCurate: false, fetchPage: async url => source(url), ...options });
  } };
}

test("passive detection does not read or create; explicit page reads execute the versioned skill without collecting", async t => {
  let reads = 0;
  const f = await fixture(t, { fetchPage: async url => { reads++; return source(url); } });
  const before = f.service.state();
  assert.equal(f.service.resolvePage({ context: page("A") }).status, "unread");
  assert.equal(reads, 0);
  assert.deepEqual(f.service.state(), before);
  const preview = await f.service.readPage({ context: page("A"), requestId: "preview-a" });
  assert.equal(preview.context.skill.id, "read-page");
  assert.match(preview.context.skill.digest, /^[a-f0-9]{64}$/);
  assert.equal(f.service.state().messages.length, 0);
  const opened = await f.service.openPage({ context: page("A"), requestId: "open-a" });
  assert.equal(opened.created, true);
  assert.equal(opened.conversation.pageSession.expiresAt.length > 0, true);
  assert.equal(opened.state.messages.at(-1).kind, "page-read");
  assert.equal(opened.state.collections.length, 0);
  assert.equal(opened.state.jobs.length, 0);
});

test("page conversations share history but own source snapshots, drafts and independent view cursors", async t => {
  const calls = [];
  const f = await fixture(t, { aiEnabled: true, chat: async (_config, input) => { calls.push(input.messages); return answer("仅回复所属页面"); } });
  const a = await f.service.openPage({ context: page("A"), requestId: "open-a" });
  await f.service.selectSurface({ surface: "companion", conversationId: a.conversationId, draft: { text: "A 未发送草稿", scrollTop: 70 } });
  const b = await f.service.openPage({ context: page("B"), requestId: "open-b" });
  await f.service.selectSurface({ surface: "workspace", conversationId: b.conversationId, draft: { text: "B 主窗口草稿", scrollTop: 12 } });
  assert.equal(f.service.resolvePage({ context: page("A") }).conversationId, a.conversationId);
  await f.service.selectSurface({ surface: "companion", conversationId: a.conversationId, followMode: "pinned" });
  await f.service.send({ text: "请解释这篇文章的正文", intent: "chat", conversationId: a.conversationId, originSurface: "companion", requestId: "a-question" });
  await f.service.idle();
  const prompt = JSON.stringify(calls[0]);
  assert.match(prompt, /A_ONLY_SOURCE/);
  assert.equal(prompt.includes("B_ONLY_SOURCE"), false);
  const state = f.service.state();
  assert.equal(state.surfaceSessions.workspace.conversationId, b.conversationId);
  assert.equal(state.surfaceSessions.workspace.drafts[b.conversationId].text, "B 主窗口草稿");
  assert.equal(state.surfaceSessions.companion.drafts[a.conversationId].text, "A 未发送草稿");
  assert.equal(state.messages.at(-1).conversationId, a.conversationId);
  await assert.rejects(f.service.send({ text: "不可混入 B", conversationId: a.conversationId, context: page("B") }), { code: "PAGE_SESSION_MISMATCH" });
  await f.reopen();
  assert.equal(f.service.resolvePage({ context: page("A") }).conversationId, a.conversationId);
  assert.equal(f.service.state().surfaceSessions.workspace.drafts[b.conversationId].text, "B 主窗口草稿");
});

test("fixed page expiry creates a fresh conversation only on an accepted read and keeps the old history", async t => {
  let timestamp = Date.parse("2026-11-10T07:00:00Z");
  const f = await fixture(t, { clock: () => timestamp });
  const a = await f.service.openPage({ context: page("A"), requestId: "day-one" });
  await f.service.send({ conversationId: a.conversationId, text: "昨天的讨论不应自动混进明天" });
  timestamp += 24 * 60 * 60 * 1000 - 1;
  assert.equal(f.service.resolvePage({ context: page("A") }).conversationId, a.conversationId);
  timestamp++;
  assert.equal(f.service.resolvePage({ context: page("A") }).status, "expired");
  const count = f.service.state().conversations.length;
  f.service.resolvePage({ context: page("A") });
  assert.equal(f.service.state().conversations.length, count);
  const next = await f.service.openPage({ context: page("A"), requestId: "day-two" });
  assert.notEqual(next.conversationId, a.conversationId);
  assert.equal(next.state.messages.some(item => item.conversationId === a.conversationId && item.text.includes("昨天的讨论")), true);
  assert.equal(next.state.messages.filter(item => item.conversationId === next.conversationId).length, 1);
});

test("page reads deduplicate concurrent requests, survive restart and reject changing the accepted payload", async t => {
  let reads = 0;
  const f = await fixture(t, { fetchPage: async url => { reads++; return source(url); } });
  const body = { context: page("A"), requestId: "only-once" };
  const [a, duplicate] = await Promise.all([f.service.openPage(body), f.service.openPage(body)]);
  assert.equal(a.conversationId, duplicate.conversationId);
  assert.equal(reads, 1);
  await f.reopen();
  assert.equal((await f.service.openPage(body)).conversationId, a.conversationId);
  assert.equal(reads, 1);
  await assert.rejects(f.service.openPage({ ...body, context: page("B") }), { code: "INVALID_REQUEST" });
  const failing = await fixture(t, { fetchPage: async () => { throw Object.assign(new Error("fixture failure"), { code: "FETCH_FAILED" }); } });
  const before = failing.service.state().conversations.length;
  const failed = await failing.service.openPage(body);
  assert.equal(failed.readable, false);
  assert.equal(failing.service.state().conversations.length, before);
});

test("explicit memory has durable source IDs, versioned settings edits and revocation that stays out of future prompts", async t => {
  const observed = [];
  const f = await fixture(t, { aiEnabled: true, chat: async (_config, input) => { observed.push(input.messages); return answer("按有效记忆回答"); } });
  const conversationId = f.service.state().activeConversationId;
  await f.service.send({ conversationId, text: "记住：我的阅读角必须使用琥珀色灯罩。" });
  const entry = f.service.memories().memories[0];
  assert.equal(entry.sourceConversationId, conversationId);
  assert.equal(entry.sourceMessageIds.length, 1);
  await f.service.send({ conversationId, text: "帮我描述阅读角" }); await f.service.idle();
  assert.match(JSON.stringify(observed[0]), /琥珀色灯罩/);
  await f.service.updateMemory({ action: "forget", memoryId: entry.id });
  await f.service.send({ conversationId, text: "继续描述阅读角" }); await f.service.idle();
  assert.equal(JSON.stringify(observed[1]).includes("琥珀色灯罩"), false);
  await f.reopen();
  assert.equal(f.service.memories().memories.length, 0);
  const saved = JSON.parse(await readFile(path.join(f.directory, "state.json"), "utf8"));
  assert.equal(saved.memory.entries[0].status, "revoked");
  assert.equal(saved.memory.tombstones.length, 1);
  assert.equal(saved.messages.some(item => item.text.includes("琥珀色灯罩")), true, "original history remains available for deliberate review");
});

test("twenty complete recent turns coexist with source-linked earlier working memory", async t => {
  const observed = [];
  const f = await fixture(t, { aiEnabled: true, chat: async (_config, input) => { observed.push(input.messages); return answer(`合成回答 ${observed.length}`); } });
  const conversationId = f.service.state().activeConversationId;
  for (let index = 1; index <= 23; index++) {
    await f.service.send({ conversationId, text: index === 1 ? "决定：整场展览必须保留铜色框架。" : `第 ${index} 轮关于展览的普通讨论。` });
    await f.service.idle();
  }
  const state = f.service.state(), last = state.jobs.at(-1);
  const stored = JSON.parse(await readFile(path.join(f.directory, "state.json"), "utf8"));
  const manifest = stored.jobs.at(-1).contextManifest;
  assert.equal(manifest.memory.recentTurnCount, 20);
  assert.match(JSON.stringify(observed.at(-1)), /铜色框架/);
  assert.equal(state.messages.filter(item => item.conversationId === conversationId && item.role === "user").length, 23);
  const working = f.service.conversationMemory({ conversationId }).workingMemory;
  assert.equal(working.strategy, "extractive-v1");
  assert.ok(working.sourceMessageIds.every(id => state.messages.some(item => item.id === id)));
  assert.equal(last.status, "complete");
});

test("a new conversation recalls relevant prior discussion only when asked and returns traceable references", async t => {
  const observed = [];
  const f = await fixture(t, { aiEnabled: true, chat: async (_config, input) => { observed.push(input.messages); return answer("根据已有讨论回答"); } });
  const a = f.service.state().activeConversationId;
  await f.service.send({ conversationId: a, text: "决定：窗边阅读角采用弧形书架，保留黄铜把手。" }); await f.service.idle();
  const b = (await f.service.createConversation({ title: "新的讨论" })).conversation.id;
  await f.service.send({ conversationId: b, text: "介绍一种早餐" }); await f.service.idle();
  assert.equal(JSON.stringify(observed.at(-1)).includes("黄铜把手"), false);
  await f.service.send({ conversationId: b, text: "上次讨论窗边阅读角，我们决定怎么设计书架？" }); await f.service.idle();
  assert.match(JSON.stringify(observed.at(-1)), /黄铜把手/);
  const reply = f.service.state().messages.at(-1);
  assert.ok(reply.memoryReferences.some(reference => reference.conversationId === a));
  assert.ok(reply.memoryReferences.every(reference => reference.sourceMessageIds.length));
});

test("forgetting a memory while the model runs suppresses the stale result and leaves a recoverable job", async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { aiEnabled: true, chat: async () => { started(); await held; return answer("旧偏好：琥珀色灯罩"); } });
  const conversationId = f.service.state().activeConversationId;
  await f.service.send({ conversationId, text: "记住：琥珀色灯罩" });
  const memoryId = f.service.memories().memories[0].id;
  await f.service.send({ conversationId, text: "介绍我的偏好" }); await entered;
  await f.service.updateMemory({ action: "forget", memoryId });
  release(); await f.service.idle();
  const state = f.service.state();
  assert.equal(state.jobs.at(-1).errorCode, "MEMORY_CHANGED");
  assert.equal(state.messages.some(item => item.text === "旧偏好：琥珀色灯罩"), false);
});

test("new harness and memory routes keep the same-origin loopback boundary", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guanxu-harness-http-"));
  const runtime = await startDesktopServer({ directory, config, aiEnabled: false, autoCurate: false, fetchPage: async url => source(url) });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const post = (route, body, origin = runtime.origin) => fetch(`${runtime.origin}/api/desktop/${route}`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post("pages/open", { context: page("A"), requestId: "http-a" }, "https://untrusted.example")).status, 403);
  const opened = await (await post("pages/open", { context: page("A"), requestId: "http-a" })).json();
  assert.equal(opened.created, true);
  assert.equal((await (await post("pages/resolve", { context: page("A") })).json()).conversationId, opened.conversationId);
  const description = await (await fetch(`${runtime.origin}/api/desktop/harness`)).json();
  assert.deepEqual(description.sections.map(section => section.id), ["context-memory", "tools-flow", "runtime-security", "evaluation"]);
  assert.equal(JSON.stringify(description).includes("A_ONLY_SOURCE"), false);
  assert.equal((await post("memories", { action: "forget", memoryId: "unknown" }, "https://untrusted.example")).status, 403);
});

test("first text acceptance creates one conversation atomically and reuses its identity on ambiguous retries", async t => {
  const f = await fixture(t);
  const body = { text: "一个尚未保存的新话题", originSurface: "companion", requestId: "first-request", newConversation: { clientDraftId: "first-draft" } };
  const before = f.service.state().conversations.length;
  const [one, two] = await Promise.all([f.service.send(body), f.service.send(body)]);
  assert.equal(one.conversationId, two.conversationId);
  assert.equal(f.service.state().conversations.length, before + 1);
  assert.equal(f.service.state().messages.filter(item => item.role === "user").length, 1);
  await f.reopen();
  assert.equal((await f.service.send(body)).conversationId, one.conversationId);
  await assert.rejects(f.service.send({ ...body, text: "不能换请求内容" }), { code: "INVALID_REQUEST" });
});

test("shutdown settles an uncooperative page adapter and late data cannot create a session", async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { fetchPage: url => new Promise(resolve => { entered(); release = () => resolve(source(url)); }) });
  const reading = f.service.openPage({ context: page("A"), requestId: "non-cooperative" });
  await started;
  await f.service.close();
  const result = await reading;
  assert.equal(result.readable, false);
  assert.equal(result.context.readError, "SERVICE_STOPPING");
  release();
  assert.equal(f.service.state().messages.length, 0);
});

test("a slow earlier page read cannot replace a newer explicitly selected surface conversation", async t => {
  let enteredA, releaseA;
  const startedA = new Promise(resolve => { enteredA = resolve; });
  const heldA = new Promise(resolve => { releaseA = resolve; });
  const f = await fixture(t, { fetchPage: async url => {
    if (url.endsWith("/a")) { enteredA(); await heldA; }
    return source(url);
  } });
  const pendingA = f.service.openPage({ context: page("A"), requestId: "slow-a" });
  try {
    await startedA;
    const b = await f.service.openPage({ context: page("B"), requestId: "newer-b" });
    // The still-current frontend explicitly accepts B. A may persist its source,
    // but finishing old I/O is not another user selection.
    await f.service.selectSurface({ surface: "companion", conversationId: b.conversationId, followMode: "follow" });
    releaseA();
    const a = await pendingA;
    assert.notEqual(a.conversationId, b.conversationId);
    assert.equal(f.service.state().surfaceSessions.companion.conversationId, b.conversationId);
    assert.equal(f.service.resolvePage({ context: page("A") }).conversationId, a.conversationId);
    assert.equal(f.service.resolvePage({ context: page("B") }).conversationId, b.conversationId);
  } finally { releaseA(); await pendingA; }
});

test("page request replay returns its accepted source snapshot after a later explicit reread", async t => {
  let version = "SOURCE_VERSION_ONE", reads = 0;
  const f = await fixture(t, { fetchPage: async url => {
    reads++;
    const result = source(url);
    return { ...result, text: result.text.replace("</main>", `<p>${version}: this source version is retained as immutable reading evidence.</p></main>`) };
  } });
  const firstBody = { context: page("A"), requestId: "original-source" };
  const first = await f.service.openPage(firstBody);
  version = "SOURCE_VERSION_TWO";
  const rereadBody = { context: page("A"), requestId: "updated-source", reread: true };
  const updated = await f.service.openPage(rereadBody);
  assert.equal(updated.conversationId, first.conversationId);
  assert.match(first.context.text, /SOURCE_VERSION_ONE/);
  assert.match(updated.context.text, /SOURCE_VERSION_TWO/);
  assert.notEqual(updated.context.snapshotId, first.context.snapshotId);

  const replayedFirst = await f.service.openPage(firstBody);
  const replayedUpdate = await f.service.openPage(rereadBody);
  assert.equal(replayedFirst.replayed, true);
  assert.equal(replayedFirst.context.snapshotId, first.context.snapshotId);
  assert.equal(replayedFirst.context.readAt, first.context.readAt);
  assert.equal(replayedFirst.context.text, first.context.text);
  assert.equal(replayedUpdate.context.snapshotId, updated.context.snapshotId);
  assert.equal(replayedUpdate.context.text, updated.context.text);
  assert.equal(reads, 2);
  assert.equal(f.service.pageSource({ conversationId: first.conversationId }).context.snapshotId, updated.context.snapshotId,
    "replaying an old request must not roll back the conversation's currently accepted source");
  const events = f.service.state().messages.filter(message => message.kind === "page-read");
  assert.equal(events.length, 2);
  assert.equal(events[0].context.snapshotId, first.context.snapshotId);
  assert.equal(events[1].context.snapshotId, updated.context.snapshotId);
});
