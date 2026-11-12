import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDesktopService } from "../desktop/server/service.mjs";
import { buildConversationContext } from "../desktop/server/harness/context.mjs";

const config = { zhipuApiKey: "", textModel: "workspace-context-fixture", timeoutMs: 1000 };
const answer = { choices: [{ message: { content: "依据本轮选择的来源讨论。" } }] };
function model(callId, context) {
  assert.equal(callId, "CALL-P001");
  const refs = [context.evidence_bundle[0].evidence_id];
  const summary = context.normalized_content.text.slice(0, 150);
  return { trace: { callId, model: "injected-fixture" }, output: {
    status: "candidate", summary, summary_evidence_ids: refs,
    digest: { status: "compact", overview: summary, evidence_ids: refs, highlights: [{ text: summary, evidence_ids: refs }] },
    breakdown: { status: "not_applicable", sections: [] },
    concepts: [{ value: "可核对的来源", evidence_ids: refs }], content_reliability_score: 0.95, uncertainties: [],
  } };
}
function references(input) {
  const message = input.messages.find((entry) => entry.content.startsWith("策展参考资料"));
  return JSON.parse(message.content.slice(message.content.indexOf("\n") + 1));
}
async function fixture(t, count = 2) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-workspace-context-"));
  const observed = [];
  const options = { directory, config, aiEnabled: true, autoCurate: false, model,
    chat: async (_config, input) => {
      observed.push(input);
      return { choices: [{ message: { content: answer.choices[0].message.content + references(input).collections.map((item) => `[[collection:${item.id}]]`).join("") } }] };
    },
    fetchPage: async () => { throw new Error("Workspace discussion must not fetch a URL"); },
  };
  let service = await createDesktopService(options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  for (let index = 0; index < count; index++) await service.capture({ mode: "text", title: `独立材料 ${index}`, content: `第 ${index} 份独立材料：保留可核对的来源，方便使用者检查自己的解释。这里是唯一的材料编号 ${index}。` });
  await service.idle();
  return { get service() { return service; }, observed,
    async addExhibition(value) {
      await service.close();
      const file = path.join(directory, "state.json");
      const state = JSON.parse(await readFile(file, "utf8"));
      state.exhibitions.push(value);
      await writeFile(file, JSON.stringify(state));
      service = await createDesktopService(options);
    },
  };
}

test("workspace discussion includes the selected collection without lexical overlap and preserves one conversation", async (t) => {
  const f = await fixture(t);
  const [selected, unrelated] = f.service.state().collections;
  await f.service.send({ text: "聊聊这条", intent: "chat", collectionIds: [selected.id] });
  await f.service.idle();
  assert.deepEqual(references(f.observed[0]).collections.map((item) => item.id), [selected.id]);
  assert.ok(references(f.observed[0]).collections[0].evidence.length);
  assert.equal(JSON.stringify(f.observed[0].messages).includes(unrelated.id), false);
  const state = f.service.state();
  assert.deepEqual(state.messages.findLast((item) => item.role === "user").workspaceContext, { collectionIds: [selected.id] });
  assert.deepEqual(state.messages.at(-1).relatedCollectionIds, [selected.id]);
  assert.equal(state.collections.length, 2);
  // Even a bare URL from the workspace entry is a question, not capture intent.
  await f.service.send({ text: "https://example.org/discuss-only", intent: "chat", collectionIds: [selected.id] });
  await f.service.idle();
  assert.equal(f.service.state().collections.length, 2);
  assert.equal(f.observed.length, 2);
  assert.deepEqual(references(f.observed[1]).collections.map((item) => item.id), [selected.id]);
});

test("unknown or forged workspace references reject before messages or jobs are persisted", async (t) => {
  const f = await fixture(t);
  const before = f.service.state();
  const cases = [
    [{ collectionIds: ["missing"] }, "NOT_FOUND"],
    [{ exhibitionId: "missing" }, "NOT_FOUND"],
    [{ collectionIds: "not-an-array" }, "INVALID_REQUEST"],
    [{ collectionIds: Array.from({ length: 7 }, () => before.collections[0].id) }, "INVALID_REQUEST"],
    [{ collectionIds: [{ id: before.collections[0].id, summary: "伪造正文" }] }, "INVALID_REQUEST"],
    [{ collectionIds: [before.collections[0].id], intent: "collect-page", context: { url: "https://example.org/", title: "网页" } }, "INVALID_REQUEST"],
  ];
  for (const [body, code] of cases) await assert.rejects(f.service.send({ text: "聊聊这条", intent: "chat", ...body }), { code });
  assert.equal(f.service.state().messages.length, before.messages.length);
  assert.equal(f.service.state().jobs.length, before.jobs.length);
  assert.equal(f.observed.length, 0);
});

test("an exhibition resolves only its persisted source IDs and reports bounded partial context", async (t) => {
  const f = await fixture(t, 8);
  const collections = f.service.state().collections;
  await f.addExhibition({ id: "exhibition-fixture", title: "本轮选择的小展", status: "ready", sourceCollectionIds: collections.map((item) => item.extraction.collectionId), rooms: [] });
  await f.service.send({ text: "这些材料有什么联系？", intent: "chat", exhibitionId: "exhibition-fixture" });
  await f.service.idle();
  const data = references(f.observed[0]);
  assert.equal(data.workspaceContext.id, "exhibition-fixture");
  assert.equal(data.workspaceContext.title, "本轮选择的小展");
  assert.equal(data.workspaceContext.selectedCount, 8);
  assert.deepEqual(data.collections.map((item) => item.id), collections.slice(0, 6).map((item) => item.id));
  const response = f.service.state().messages.at(-1);
  assert.deepEqual(response.relatedCollectionIds, collections.slice(0, 6).map((item) => item.id));
  assert.equal(response.contextTruncated, true);
  assert.ok(f.observed[0].messages.reduce((sum, item) => sum + item.content.length, 0) <= 60000);
});

test("pending explicit selections reveal status without resurrecting stale analysis", () => {
  const input = { profile: {}, exhibitions: [], collections: [{ id: "pending", status: "needs_confirmation", title: "标题", summary: "不应引用的旧摘要", extraction: { status: "qualified", evidenceBundle: [{ evidence_id: "old", text: "不应引用的旧证据" }] } }], messages: [{ id: "current", role: "user", text: "聊聊这个", workspaceContext: { collectionIds: ["pending"] } }] };
  const result = buildConversationContext({ state: input, messageId: "current" });
  const data = references(result);
  assert.deepEqual(result.manifest.itemIds, ["pending"]);
  assert.equal(data.collections[0].understandingStatus, "not_ready");
  assert.deepEqual(data.collections[0].evidence, []);
  assert.equal(JSON.stringify(result.messages).includes("不应引用的旧"), false);
});
