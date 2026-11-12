import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";

const pageUrl = "https://example.com/demo";
const videoUrl = "https://www.youtube.com/watch?v=HkKyxbhKJe8";
const command = `${pageUrl} 收藏这个视频的内容`;
const source = {
  url: videoUrl,
  title: "可核对的演示字幕",
  type: "video",
  transcriptSource: "platform_manual",
  segments: [
    { start_ms: 1000, end_ms: 4000, text: "第一段字幕介绍了演示中使用的资料来源。" },
    { start_ms: 4000, end_ms: 9000, text: "第二段字幕说明了如何从原始数据核对回答。" },
  ],
};
const transcript = source.segments.map(({ text }) => text).join("\n");

function candidate(callId, context) {
  assert.equal(callId, "CALL-P001");
  assert.equal(context.normalized_content.text, transcript);
  assert.equal(context.transcript_source, "platform_manual");
  const refs = context.evidence_bundle.map(({ evidence_id }) => evidence_id);
  const summary = "演示用原始资料核对回答。";
  return { trace: { callId, model: "fixture-video-understanding" }, output: {
    status: "candidate", summary, summary_evidence_ids: refs,
    digest: { status: "compact", overview: summary, evidence_ids: refs, highlights: [{ text: summary, evidence_ids: refs }] },
    breakdown: { status: "not_applicable", sections: [] },
    concepts: [{ value: "原始资料", evidence_ids: refs }],
    content_reliability_score: 0.95, uncertainties: [],
  } };
}

async function fixture(t, overrides) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "folio-video-capture-"));
  const options = {
    directory, config: { zhipuApiKey: "", timeoutMs: 1000 }, aiEnabled: true, autoCurate: false,
    knowledgeEmbedder: null, model: candidate,
    fetchPage: async () => { throw new Error("Unexpected page fetch in service fixture"); },
    ...overrides,
  };
  let service;
  t.after(async () => {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  });
  service = await createDesktopService(options);
  return {
    get service() { return service; },
    async reopen() {
      await service.close();
      service = await createDesktopService(options);
    },
  };
}

test("chat saves embedded video captions with timestamps and reuses the saved collection", async (t) => {
  let reads = 0;
  const f = await fixture(t, { readVideoCaptions: async (url, { signal }) => {
    assert.equal(url, pageUrl);
    assert.ok(signal instanceof AbortSignal);
    reads++;
    return source;
  } });
  const first = await f.service.send({
    text: command, originSurface: "workspace", requestId: "video-first", newConversation: { clientDraftId: "video-draft" },
  });
  const [saved] = first.state.collections;
  assert.ok(saved?.id);
  assert.equal(first.state.collections.length, 1);
  assert.deepEqual(first.message.collectionIds, [saved.id]);
  await f.service.idle();

  const [item] = f.service.state().collections;
  assert.equal(item.type, "video");
  assert.equal(item.status, "ready");
  assert.equal(item.content, pageUrl);
  assert.equal(item.extraction.transcriptSource, "platform_manual");
  assert.deepEqual(item.extraction.evidenceBundle.map(({ locator }) => locator), ["00:01–00:04", "00:04–00:09"]);
  const { document } = await f.service.knowledgeRead({ collectionId: item.id });
  assert.equal(document.sourceKind, "transcript");
  assert.equal(document.url, videoUrl);
  assert.equal(document.text, transcript);
  assert.match(document.chunks.map(({ locator }) => locator).join("\n"), /00:01–00:04/);

  await f.reopen();
  const repeated = await f.service.send({ text: command, conversationId: first.conversationId });
  assert.deepEqual(repeated.message.collectionIds, [item.id]);
  assert.equal(repeated.state.collections.length, 1);
  await f.service.idle();
  assert.equal(reads, 1);
  const { document: restored } = await f.service.knowledgeRead({ collectionId: item.id });
  assert.equal(restored.documentVersionId, document.documentVersionId);
  assert.equal(restored.text, transcript);
});

test("unavailable captions keep the page link and surface the source failure", async (t) => {
  let reads = 0, modelCalls = 0;
  const errorCode = "YOUTUBE_CAPTIONS_UNAVAILABLE";
  const { service } = await fixture(t, {
    readVideoCaptions: async () => {
      if (++reads === 1) throw Object.assign(new Error("No usable caption track"), { code: errorCode });
      return source;
    },
    model: async (...args) => { modelCalls++; return candidate(...args); },
  });
  const first = await service.send({ text: command });
  const [saved] = first.state.collections;
  assert.equal(saved.url, pageUrl);
  await service.idle();

  const state = service.state();
  assert.equal(modelCalls, 0);
  assert.equal(state.collections.length, 1);
  assert.equal(state.collections[0].url, pageUrl);
  const job = state.jobs.find(({ collectionId }) => collectionId === saved.id);
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, errorCode);
  assert.match(state.messages.at(-1).text, /字幕/);
  const { document } = await service.knowledgeRead({ collectionId: saved.id });
  assert.equal(document.coverage, "unavailable");
  assert.equal(document.text, "");

  await service.retryJob({ jobId: job.id });
  await service.idle();
  assert.equal(service.state().collections.length, 1);
  assert.equal(reads, 2);
  assert.equal(modelCalls, 1);
  const { document: retried } = await service.knowledgeRead({ collectionId: saved.id });
  assert.equal(retried.text, transcript);
});

test("captions are saved without AI beside an existing webpage collection", async (t) => {
  let modelCalls = 0;
  const { service } = await fixture(t, {
    aiEnabled: false,
    fetchPage: async () => ({ url: pageUrl, type: "text/plain", text: "网页文字会留在自己的收藏中。" }),
    readVideoCaptions: async () => source,
    model: async () => { modelCalls++; throw new Error("Model must be disabled"); },
  });
  const webpage = await service.capture({ mode: "link", content: pageUrl, title: "演示网页" });
  await service.idle();
  const saved = await service.send({ text: command });
  await service.idle();

  const [web, video] = service.state().collections;
  assert.equal(modelCalls, 0);
  assert.equal(service.state().collections.length, 2);
  assert.equal(web.id, webpage.collectionId);
  assert.equal(web.url, pageUrl);
  assert.equal(web.type, "article");
  assert.deepEqual(saved.message.collectionIds, [video.id]);
  assert.equal(video.type, "video");
  const { document } = await service.knowledgeRead({ collectionId: video.id });
  assert.equal(document.sourceKind, "transcript");
  assert.equal(document.text, transcript);
});

test("a failed understanding keeps the transcript and retries without rereading YouTube", async (t) => {
  let reads = 0, modelCalls = 0;
  const { service } = await fixture(t, {
    readVideoCaptions: async () => { reads++; return source; },
    model: async (...args) => {
      if (++modelCalls === 1) throw Object.assign(new Error("Model unavailable"), { code: "MODEL_PROVIDER_ERROR" });
      return candidate(...args);
    },
  });
  const initial = await service.send({ text: command });
  const [collectionId] = initial.message.collectionIds;
  await service.idle();
  const firstJob = service.state().jobs.find(job => job.collectionId === collectionId);
  assert.equal(firstJob.status, "failed");
  assert.equal(firstJob.errorCode, "MODEL_PROVIDER_ERROR");
  const { document } = await service.knowledgeRead({ collectionId });
  assert.equal(document.text, transcript);

  await service.retryJob({ jobId: firstJob.id });
  await service.idle();
  assert.equal(reads, 1);
  assert.equal(modelCalls, 2);
  assert.equal(service.state().collections[0].status, "ready");
  const { document: retried } = await service.knowledgeRead({ collectionId });
  assert.equal(retried.documentVersionId, document.documentVersionId);
});

test("a failed understanding after refreshing captions leaves the new source current and retryable", async (t) => {
  let reads = 0, modelCalls = 0;
  const { service } = await fixture(t, {
    readVideoCaptions: async () => { reads++; return source; },
    model: async (...args) => {
      if (++modelCalls === 2) throw Object.assign(new Error("Model unavailable"), { code: "MODEL_PROVIDER_ERROR" });
      return candidate(...args);
    },
  });
  const first = await service.send({ text: command });
  const [collectionId] = first.message.collectionIds;
  await service.idle();
  const { document: original } = await service.knowledgeRead({ collectionId });
  const { job } = await service.refreshSource({ collectionId });
  await service.idle();

  const { document: refreshed } = await service.knowledgeRead({ collectionId });
  assert.notEqual(refreshed.documentVersionId, original.documentVersionId);
  assert.equal(refreshed.sourceRevision, service.state().collections[0].sourceRevision);
  assert.equal(refreshed.text, transcript);
  await service.retryJob({ jobId: job.id });
  await service.idle();
  assert.equal(reads, 2);
  assert.equal(modelCalls, 3);
  assert.equal(service.state().collections[0].status, "ready");
});

test("a page can still be collected as an article after its video was collected", async (t) => {
  const { service } = await fixture(t, {
    aiEnabled: false,
    fetchPage: async () => ({ url: pageUrl, type: "text/plain", text: "网页文字会留在自己的收藏中。" }),
    readVideoCaptions: async () => source,
  });
  const video = await service.send({ text: command });
  const [videoId] = video.message.collectionIds;
  await service.idle();
  const article = await service.capture({ mode: "link", content: pageUrl, title: "演示网页" });
  assert.notEqual(article.collectionId, videoId);
  const repeated = await service.send({ text: pageUrl });
  assert.deepEqual(repeated.message.collectionIds, [article.collectionId]);
  assert.equal(repeated.state.collections.length, 2);
});

test("quoted, negative and interrogative video instructions stay in chat", async (t) => {
  let reads = 0, chats = 0;
  const { service } = await fixture(t, {
    readVideoCaptions: async () => { reads++; return source; },
    chat: async () => { chats++; return { choices: [{ message: { content: "我明白了。" } }] }; },
  });
  for (const text of [`“${command}”`, `${pageUrl} 不要收藏这个视频的内容`, `${command}？`]) {
    await service.send({ text });
  }
  await assert.rejects(service.send({ text: "http://127.0.0.1/private 收藏这个视频的内容" }), { code: "UNSAFE_URL" });
  await service.idle();
  assert.equal(reads, 0);
  assert.equal(chats, 3);
  assert.deepEqual(service.state().collections, []);
});
