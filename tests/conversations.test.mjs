import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";
import { startDesktopServer } from "../desktop/server/index.mjs";
import { DEFAULT_CONVERSATION_ID, LEGACY_CONVERSATION_ID } from "../desktop/server/state.mjs";
import { buildConversationContext } from "../desktop/server/harness/context.mjs";

const config = { zhipuApiKey: "", textModel: "conversation-fixture", timeoutMs: 1000 };
const answer = text => ({ choices: [{ message: { content: text } }] });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guanxu-conversation-test-"));
  let service = await createDesktopService({ directory, config, aiEnabled: false, autoCurate: false, ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get service() { return service; }, async reopen(overrides = {}) { await service.close(); service = await createDesktopService({ directory, config, aiEnabled: false, autoCurate: false, ...options, ...overrides }); } };
}

function withoutConversation(value) { const { conversationId, ...rest } = value; return rest; }
const userMessages = state => state.messages.filter(entry => entry.role === "user");

test("legacy history and task payloads migrate once into one conversation without changing content", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guanxu-conversation-legacy-"));
  const before = { version: 1, brandingVersion: 1, profile: { name: "小墨", personality: "温柔有主见", preferences: "保留原偏好" },
    collections: [{ id: "collection-old", title: "原收藏", content: "原文", receipt: "original-receipt" }], exhibitions: [],
    messages: [{ id: "message-one", role: "user", text: "第一条旧问题", createdAt: "2026-11-01T00:00:00Z", context: { title: "原页面", url: "https://example.com/old" } },
      { id: "message-two", role: "assistant", text: "旧回答原样保留", sourceMessageId: "message-one", createdAt: "2026-11-01T00:01:00Z" }],
    jobs: [{ id: "job-old", type: "chat", status: "failed", messageId: "message-one", profileSnapshot: { name: "原称呼" },
      harness: { version: 1, steps: [], calls: [], checkpoints: { answer: { value: "不能丢掉的检查点" } } } }],
    workspace: { notes: { "collection-old": "我的备注" } },
  };
  await writeFile(path.join(directory, "state.json"), JSON.stringify(before));
  let service = await createDesktopService({ directory, config, aiEnabled: false, autoCurate: false });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const state = service.state();
  assert.equal(state.conversations.length, 1);
  assert.equal(state.activeConversationId, LEGACY_CONVERSATION_ID);
  assert.deepEqual(state.messages.map(withoutConversation), before.messages);
  const stored = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
  assert.deepEqual(stored.jobs.map(withoutConversation), before.jobs);
  assert.deepEqual(stored.collections, before.collections);
  assert.deepEqual(stored.profile, before.profile);
  assert.deepEqual(stored.workspace, before.workspace);
  assert.ok(stored.messages.every(entry => entry.conversationId === LEGACY_CONVERSATION_ID));
  assert.ok(stored.jobs.every(entry => entry.conversationId === LEGACY_CONVERSATION_ID));
  await service.close();
  service = await createDesktopService({ directory, config, aiEnabled: false, autoCurate: false });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")), stored);
});

test("new empty libraries use one reusable empty conversation and first message supplies its title", async t => {
  const f = await fixture(t);
  const first = f.service.state();
  assert.equal(first.conversations.length, 1);
  assert.equal(first.activeConversationId, DEFAULT_CONVERSATION_ID);
  assert.equal(first.conversations[0].messageCount, 0);
  assert.equal(first.conversations.some(item => item.id === LEGACY_CONVERSATION_ID), false);
  const [one, two] = await Promise.all([f.service.createConversation(), f.service.createConversation()]);
  assert.equal(one.conversation.id, two.conversation.id);
  assert.equal(f.service.state().conversations.length, 1);
  const sent = await f.service.send({ text: "关于自然光的第一个问题", conversationId: one.conversation.id });
  assert.equal(sent.conversationId, one.conversation.id);
  assert.equal(sent.state.conversations[0].title, "关于自然光的第一个问题");
  assert.equal(sent.state.conversations[0].messageCount, 2);
  assert.ok(sent.state.messages.every(entry => entry.conversationId === one.conversation.id));
  const next = await f.service.createConversation();
  assert.notEqual(next.conversation.id, one.conversation.id);
  assert.equal(next.state.activeConversationId, next.conversation.id);
  await f.service.selectConversation({ conversationId: one.conversation.id });
  await f.service.send({ text: "小窗没有显式编号时，继续当前对话" });
  assert.equal(f.service.state().messages.at(-1).conversationId, one.conversation.id);
  await f.reopen();
  assert.equal(f.service.state().activeConversationId, one.conversation.id);
  assert.equal(f.service.state().conversations.length, 2);
});

test("unknown conversations reject before a message, capture or selection can mutate the library", async t => {
  const f = await fixture(t);
  const before = f.service.state();
  for (const action of [
    () => f.service.send({ text: "不要写进其他对话", conversationId: "missing" }),
    () => f.service.capture({ mode: "text", content: "这是一段长度足够的原始资料，不能写进未知对话。", conversationId: "missing" }),
    () => f.service.selectConversation({ conversationId: "missing" }),
    () => f.service.curate({ conversationId: "missing" }),
  ]) await assert.rejects(action(), { code: "NOT_FOUND" });
  for (const action of [() => f.service.selectConversation({}), () => f.service.createConversation({ title: "" }), () => f.service.send({ text: "问题", conversationId: { id: before.activeConversationId } })]) await assert.rejects(action(), { code: "INVALID_REQUEST" });
  assert.deepEqual(f.service.state(), before);
});

test("conversation prompts exclude other conversations while retaining earlier turns in the current one", async t => {
  const observed = [];
  const f = await fixture(t, { aiEnabled: true, chat: async (_config, input) => { observed.push(input); return answer(`回答-${observed.length}`); } });
  const a = f.service.state().activeConversationId;
  await f.service.send({ conversationId: a, text: "A秘密标记：只在这一段里保留" }); await f.service.idle();
  const b = (await f.service.createConversation()).conversation.id;
  await f.service.send({ conversationId: b, text: "B独立标记：一个全新的话题" }); await f.service.idle();
  await f.service.send({ conversationId: a, text: "继续A的问题" }); await f.service.idle();
  assert.equal(JSON.stringify(observed[1].messages).includes("A秘密标记"), false);
  assert.equal(JSON.stringify(observed[2].messages).includes("B独立标记"), false);
  assert.ok(JSON.stringify(observed[2].messages).includes("A秘密标记"));
  assert.ok(JSON.stringify(observed[2].messages).includes("回答-1"));
  const state = f.service.state();
  for (const job of state.jobs) {
    const source = state.messages.find(entry => entry.id === job.messageId);
    assert.equal(job.conversationId, source.conversationId);
    assert.ok(state.messages.filter(entry => entry.jobId === job.id).every(entry => entry.conversationId === job.conversationId));
    assert.ok(job.contextManifest.historyMessageIds.every(id => state.messages.find(entry => entry.id === id).conversationId === job.conversationId));
  }
});

test("pending answers and retried failed jobs return to their originating conversation after selection changes", async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, { aiEnabled: true, chat: async () => {
    calls++;
    if (calls === 1) { entered(); await held; throw Object.assign(new Error("fixture timeout"), { code: "MODEL_TIMEOUT" }); }
    return answer("恢复后只回到原对话");
  } });
  const a = f.service.state().activeConversationId;
  await f.service.send({ conversationId: a, text: "A正在等待的一条问题" });
  await started;
  const b = (await f.service.createConversation({ title: "B，另一个对话" })).conversation.id;
  release(); await f.service.idle();
  const failed = f.service.state().jobs[0];
  assert.equal(f.service.state().activeConversationId, b);
  assert.equal(f.service.state().messages.at(-1).conversationId, a);
  const retry = await f.service.retryJob({ jobId: failed.id });
  assert.equal(retry.job.conversationId, a);
  await f.service.idle();
  assert.equal(f.service.state().messages.at(-1).text, "恢复后只回到原对话");
  assert.equal(f.service.state().messages.at(-1).conversationId, a);
  assert.equal(f.service.state().activeConversationId, b);
  assert.equal(f.service.state().messages.filter(entry => entry.conversationId === b).length, 0);
});

test("a queued follow-up sees the earlier answer even when that answer was appended after the follow-up", async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const observed = [];
  const f = await fixture(t, { aiEnabled: true, chat: async (_config, input) => {
    observed.push(input);
    if (observed.length === 1) { entered(); await held; return answer("第一轮已经完成的明暗分析"); }
    return answer("按上一轮分析继续");
  } });
  const conversationId = f.service.state().activeConversationId;
  await f.service.send({ conversationId, text: "先分析房间的光" }); await started;
  await f.service.send({ conversationId, text: "按刚才回答继续给出建议" });
  release(); await f.service.idle();
  const second = observed[1].messages.filter(entry => entry.role !== "system");
  assert.ok(second.some(entry => entry.role === "assistant" && entry.content === "第一轮已经完成的明暗分析"));
  assert.ok(second.findIndex(entry => entry.content === "第一轮已经完成的明暗分析") < second.findIndex(entry => entry.content === "按刚才回答继续给出建议"));
});

test("explicit capture ownership survives a different selected conversation", async t => {
  const f = await fixture(t, { aiEnabled: true, model: (callId, context) => {
    assert.equal(callId, "CALL-P001");
    const refs = [context.evidence_bundle[0].evidence_id];
    return { trace: { callId, model: "injected-fixture" }, output: { status: "candidate", summary: "在窗边保留明暗过渡。", summary_evidence_ids: refs,
      digest: { status: "compact", overview: "保留明暗过渡。", evidence_ids: refs, highlights: [{ text: "自然光", evidence_ids: refs }] },
      breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "自然光", evidence_ids: refs }], content_reliability_score: .95, uncertainties: [] } };
  } });
  const a = f.service.state().activeConversationId;
  const b = (await f.service.createConversation({ title: "另一个对话" })).conversation.id;
  const captured = await f.service.capture({ conversationId: a, mode: "text", content: "这是一份关于自然光与窗边明暗过渡的原始记录，保留来源以便继续核对。" });
  assert.equal(captured.job.conversationId, a);
  await f.service.idle();
  assert.equal(f.service.state().activeConversationId, b);
  assert.ok(f.service.state().messages.every(entry => entry.conversationId === a));
  assert.ok(f.service.state().jobs.every(entry => entry.conversationId === a));
});

test("manual curation respects its explicit conversation instead of the currently selected chat", async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { aiEnabled: true, autoCurate: true, model: async (callId, context) => {
    if (callId === "CALL-P002") { entered(); await held; return { trace: { callId, model: "injected-fixture" }, output: { status: "waiting_for_content", themes: [] } }; }
    assert.equal(callId, "CALL-P001");
    const refs = [context.evidence_bundle[0].evidence_id];
    return { trace: { callId, model: "injected-fixture" }, output: { status: "candidate", summary: "在窗边保留明暗过渡。", summary_evidence_ids: refs,
      digest: { status: "compact", overview: "保留明暗过渡。", evidence_ids: refs, highlights: [{ text: "自然光", evidence_ids: refs }] },
      breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "自然光", evidence_ids: refs }], content_reliability_score: .95, uncertainties: [] } };
  } });
  const a = f.service.state().activeConversationId;
  const b = (await f.service.createConversation({ title: "正在阅读的另一个对话" })).conversation.id;
  for (let index = 0; index < 6; index++) await f.service.capture({ conversationId: a, mode: "text", content: `第 ${index} 份关于自然光与窗边明暗过渡的原始记录，保留真实来源以便继续核对。` });
  await f.service.idle();
  assert.equal(f.service.state().jobs.filter(job => job.type === "curate").length, 0);
  await f.service.curate({ conversationId:a });
  await started;
  const curation = f.service.state().jobs.find(job => job.type === "curate");
  assert.equal(curation.conversationId, a);
  assert.equal(curation.automatic, false);
  assert.equal(f.service.state().activeConversationId, b);
  release(); await f.service.idle();
  const result = f.service.state();
  assert.equal(result.jobs.find(job => job.id === curation.id).result, "waiting_for_content");
  assert.ok(result.messages.filter(entry => entry.jobId === curation.id).every(entry => entry.conversationId === a));
  assert.equal(result.messages.filter(entry => entry.conversationId === b).length, 0);
});

test("first retry of a saved collection respects an explicit conversation when another chat is selected", async t => {
  const f = await fixture(t);
  const a = f.service.state().activeConversationId;
  const captured = await f.service.capture({ conversationId: a, mode: "text", content: "这是一份先保存原始内容的长资料，连接服务以后再继续理解。" });
  const b = (await f.service.createConversation({ title: "不要接收A的任务" })).conversation.id;
  await f.reopen({ aiEnabled: true, model: () => { throw Object.assign(new Error("fixture failure"), { code: "MODEL_TIMEOUT" }); } });
  await assert.rejects(f.service.retry({ collectionId: captured.collectionId, conversationId: "missing" }), { code: "NOT_FOUND" });
  const retried = await f.service.retry({ collectionId: captured.collectionId, conversationId: a });
  assert.equal(retried.job.conversationId, a);
  await f.service.idle();
  assert.equal(f.service.state().activeConversationId, b);
  assert.equal(f.service.state().messages.at(-1).conversationId, a);
});

test("startup with qualified text does not launch a cloud curation task into the selected conversation", async t => {
  const model = async (callId, context) => {
    assert.equal(callId, "CALL-P001");
    const refs = [context.evidence_bundle[0].evidence_id];
    return { trace: { callId, model: "injected-fixture" }, output: { status: "candidate", summary: "保留对光的观察。", summary_evidence_ids: refs,
      digest: { status: "compact", overview: "保留对光的观察。", evidence_ids: refs, highlights: [{ text: "自然光", evidence_ids: refs }] },
      breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "自然光", evidence_ids: refs }], content_reliability_score: .95, uncertainties: [] } };
  };
  const f = await fixture(t, { aiEnabled: true, model });
  const a = f.service.state().activeConversationId;
  for (let index = 0; index < 6; index++) await f.service.capture({ conversationId: a, mode: "text", content: `第 ${index} 份关于自然光与材料边界的原始观察，之后可以继续核对和整理。` });
  await f.service.idle();
  const b = (await f.service.createConversation({ title: "重启前选中的空对话" })).conversation.id;
  await f.reopen({ autoCurate: true }); await f.service.idle();
  assert.equal(f.service.state().jobs.filter(job => job.type === "curate").length, 0);
  assert.equal(f.service.state().exhibitions.length, 0);
  assert.equal(f.service.state().activeConversationId, b);
  assert.equal(f.service.state().messages.filter(entry => entry.conversationId === b).length, 0);
});

test("same request ID is persisted once, survives restart and rejects changed text or scope", async t => {
  let calls = 0;
  const f = await fixture(t, { aiEnabled: true, chat: async () => { calls++; return answer("只生成一次的回答"); } });
  const conversationId = f.service.state().activeConversationId;
  const body = { conversationId, requestId: "home-launch-one", text: "这条问题只应发送一次", intent: "chat" };
  const results = await Promise.all([f.service.send(body), f.service.send(body)]);
  await f.service.idle();
  assert.equal(results.filter(result => result.replayed).length, 1);
  assert.equal(calls, 1);
  assert.equal(userMessages(f.service.state()).length, 1);
  assert.equal(f.service.state().jobs.length, 1);
  assert.ok(f.service.state().messages.every(entry => !Object.hasOwn(entry, "requestFingerprint")));
  const before = f.service.state();
  for (const changed of [{ text: "换了问题" }, { intent: undefined }, { context: { title: "换了来源", text: "这是一段完整而不同的页面正文。" } }]) await assert.rejects(f.service.send({ ...body, ...changed }), { code: "INVALID_REQUEST" });
  for (const requestId of ["", "bad request", "x".repeat(101), null]) await assert.rejects(f.service.send({ ...body, requestId }), { code: "INVALID_REQUEST" });
  assert.deepEqual(f.service.state(), before);
  await f.reopen();
  const replay = await f.service.send(body);
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.text, "只生成一次的回答");
  assert.equal(calls, 1);
  const another = (await f.service.createConversation()).conversation.id;
  await f.service.send({ ...body, conversationId: another }); await f.service.idle();
  assert.equal(calls, 2, "Request IDs are scoped to their conversation");
});

test("pure context assembly keeps legacy untagged fixtures compatible without mixing tagged messages", () => {
  const result = buildConversationContext({ state: { profile: {}, collections: [], messages: [
    { id: "old", role: "user", text: "旧的未分组问题" }, { id: "foreign", conversationId: "other", role: "assistant", text: "另一段的秘密" }, { id: "current", role: "user", text: "继续旧问题" },
  ] }, messageId: "current" });
  assert.deepEqual(result.manifest.historyMessageIds, ["old", "current"]);
  assert.equal(JSON.stringify(result.messages).includes("另一段的秘密"), false);
});

test("replaying an accepted exhibition request does not re-resolve sources changed since submission", async t => {
  const f = await fixture(t);
  const captured = await f.service.capture({ mode: "text", content: "这是用于验证展览历史来源映射的独立文字资料，之后只改变来源编号。" });
  const file = path.join(f.directory, "state.json");
  await f.service.close();
  let saved = JSON.parse(await readFile(file, "utf8"));
  saved.collections[0].extraction = { collectionId: "source-before-refresh", status: "qualified", summary: "测试来源" };
  saved.exhibitions.push({ id: "old-exhibition", title: "历史来源展览", sourceCollectionIds: ["source-before-refresh"], rooms: [] });
  await writeFile(file, JSON.stringify(saved)); await f.reopen();
  const body = { conversationId: f.service.state().activeConversationId, requestId: "exhibition-replay", text: "继续讨论这场展览", intent: "chat", exhibitionId: "old-exhibition" };
  await f.service.send(body);
  const count = f.service.state().messages.length;
  await f.service.close();
  saved = JSON.parse(await readFile(file, "utf8"));
  saved.collections.find(item => item.id === captured.collectionId).extraction.collectionId = "source-after-refresh";
  await writeFile(file, JSON.stringify(saved)); await f.reopen();
  assert.equal((await f.service.send(body)).replayed, true);
  assert.equal(f.service.state().messages.length, count);
  await assert.rejects(f.service.send({ ...body, requestId: "new-exhibition-request" }), { code: "INVALID_REQUEST" });
});

test("conversation HTTP routes enforce the existing same-origin boundary", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guanxu-conversation-http-"));
  const runtime = await startDesktopServer({ directory, config, aiEnabled: false, autoCurate: false });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const post = (route, body, origin = runtime.origin) => fetch(`${runtime.origin}/api/desktop/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  for (const route of ["conversations", "conversations/select"]) {
    assert.equal((await post(route, {}, "https://untrusted.example")).status, 403);
    assert.equal((await post(route, {}, null)).status, 403);
  }
  const created = await post("conversations", {});
  assert.equal(created.status, 200);
  const data = await created.json();
  assert.equal(data.conversation.id, data.state.activeConversationId);
  assert.equal((await post("conversations/select", { conversationId: "missing" })).status, 404);
  assert.equal((await post("conversations/select", { conversationId: data.conversation.id })).status, 200);
  const body = { conversationId: data.conversation.id, requestId: "http-submit", text: "这是一条本机消息" };
  assert.equal((await post("messages", body)).status, 200);
  assert.equal((await (await post("messages", body)).json()).replayed, true);
  assert.equal(userMessages(runtime.service.state()).length, 1);
});
