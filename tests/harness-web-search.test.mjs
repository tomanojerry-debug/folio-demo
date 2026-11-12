import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopService } from "../desktop/server/service.mjs";

const at = new Date(2026, 10, 12, 13).getTime();
const day = "2026-11-12";
const report = (host, title, publishedAt = day, path = "/model") => ({
  url: `https://${host}${path}`, title, snippet: `${title}的搜索摘要`, publishedAt,
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "folio-web-search-"));
  const service = await createDesktopService({
    directory, config: { embeddingBackend: "disabled" }, autoCurate: false, aiEnabled: false,
    clock: () => at, ...options,
  });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return service;
}

test("Tag posts five ranked sources in the requesting conversation without reading page or library data", async t => {
  const calls = [];
  const service = await fixture(t, {
    fetchPage: () => assert.fail("Search should not visit a linked page"),
    chat: () => assert.fail("Search results should not be sent to a text model"),
    searchWeb: async ({ signal, ...request }) => {
      assert.equal(signal.aborted, false);
      calls.push(request);
      return [
        report("news-one.example", "先返回的同一页面没有日期", "", "/model?utm_source=search"),
        report("wide-news.example", "科技产业最新趋势"),
        report("news-one.example", "公司发布新模型"),
        report("news-one.example", "新模型的另一则报道", day, "/second"),
        report("news-two.example", "新模型开始公测"),
        report("news-three.example", "早前报道", "2026-11-11"),
        report("news-four.example", "开放模型权重"),
        { ...report("mp.weixin.qq.com", "公众号发布技术解读"), source: "mp.weixin.qq.com" },
        { ...report("invalid.example", "无效来源"), url: "https://127.0.0.1/test" },
        report("news-five.example", "搜索服务收录的独家采访", ""),
      ];
    },
  });
  const body = {
    text: "帮我找找今天关于新AI模型发布的新闻", originSurface: "companion", requestId: "public-query",
    context: { url: "https://unrelated.example/private", text: "不应发送的页面正文" },
  };
  const accepted = await service.send(body);
  assert.equal(accepted.message, null);
  assert.equal(accepted.state.jobs.at(-1).webSearch, true);
  await service.idle();
  const replay = await service.send(body);
  assert.equal(replay.replayed, true);
  assert.deepEqual(calls, [{ query: "2026-11-12 关于新AI模型发布的新闻", recency: "oneDay" }]);
  const { messages, jobs, collections } = service.state();
  const answer = messages.at(-1);
  assert.equal(answer.id, replay.message.id);
  assert.equal(answer.conversationId, accepted.conversationId);
  assert.equal(answer.sourceMessageId, messages.find(row => row.requestId === "public-query").id);
  assert.equal(answer.webSources.length, 5);
  assert.equal(answer.webSources[3].source, "微信公众号");
  assert.deepEqual(answer.webSources.map(row => row.title), [
    "公司发布新模型", "新模型开始公测", "开放模型权重", "公众号发布技术解读", "新模型的另一则报道",
  ]);
  assert.equal(answer.webSources.every(row => row.publishedAt === day), true);
  assert.equal(answer.webSearchSkill.id, "web-search");
  assert.match(answer.webSearchSkill.digest, /^[a-f0-9]{64}$/);
  assert.equal(collections.length, 0);
  assert.deepEqual(jobs.at(-1).harness.calls, []);
  assert.deepEqual(jobs.at(-1).harness.steps.map(row => [row.tool, row.status]), [["search-web", "complete"]]);
});

test("web search failure can retry in the same conversation and labels undated results honestly", async t => {
  let attempts = 0;
  const service = await fixture(t, { searchWeb: async () => {
    if (++attempts === 1) throw Object.assign(new Error("private provider details"), { code: "WEB_SEARCH_RATE_LIMITED" });
    return [report("news.example", "有标注日期的发布"), report("other.example", "日期未标注的报道", "")];
  } });
  const sent = await service.send({ text: "搜索今天的 AI 模型新闻", intent: "chat", originSurface: "workspace" });
  await service.idle();
  let state = service.state();
  const failed = state.jobs.at(-1);
  assert.equal(failed.errorCode, "WEB_SEARCH_RATE_LIMITED");
  assert.match(state.messages.at(-1).text, /限额/);
  assert.doesNotMatch(JSON.stringify(state), /private provider details/);
  await service.retryJob({ jobId: failed.id });
  await service.idle();
  state = service.state();
  const answer = state.messages.at(-1);
  assert.equal(answer.conversationId, sent.conversationId);
  assert.equal(state.jobs.at(-1).retryOf, failed.id);
  assert.match(answer.text, /1 条标注为今天发布.*另有 1 条来自近 24 小时搜索，发布日期未标注/);
  assert.equal(answer.webSources[1].publishedAt, undefined);
});

test("website queries honor a requested result count and explicit local searches stay local", async t => {
  const requests = [];
  const service = await fixture(t, { searchWeb: async ({ query, recency }) => {
    requests.push({ query, recency });
    return [report("docs.example", "概念文档", ""), report("course.example", "基础教程", ""), report("other.example", "延伸阅读", "")];
  } });
  await service.send({ text: "帮我找 2 个量子纠缠入门网站" });
  await service.idle();
  assert.equal(service.state().messages.at(-1).webSources.length, 2);
  assert.deepEqual(requests, [{ query: "量子纠缠入门网站", recency: "noLimit" }]);
  await service.send({ text: "帮我查一下我的收藏里的量子纠缠" });
  await service.send({ text: "查一下这段代码有没有问题" });
  await service.idle();
  assert.equal(requests.length, 1);
});
