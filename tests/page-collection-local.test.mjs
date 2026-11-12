import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";

const original = "Quartzbeacon is the term used in this article to refer to a source that a reader can verify. The collection should keep the same words, not a summary or a freshly fetched page.\n\nThe second paragraph gives the comparison: an offline copy stays available while the link can change.";
const newer = "Marshsignal is the revised term for the updated article. Readers can still open the version quoted in their earlier notes.\n\nThis update gives the second version its own evidence anchors and keeps the original Quartzbeacon version readable.";
const source = (more = {}) => ({ url: "https://example.com/report", title: "Reading source", attachmentId: "attachment-1", pageRevision: "revision-1", contentSource: "browser-accessibility", ...more });
const accepted = (service, requestId, context, reread = false) => service.openPage({ requestId, context, reread });
const collect = (service, read, requestId, context = read.context) => service.send({ text: "收藏这个页面", intent: "collect-page", context, conversationId: read.conversationId, requestId });

async function isolated(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "folio-page-collection-"));
  let network = 0, generations = 0;
  const options = {
    directory, config: { zhipuApiKey: "", embeddingBackend: "disabled" }, aiEnabled: true, autoCurate: false,
    knowledgeEmbedder: null, knowledgeReranker: null,
    fetchPage: () => { network++; throw new Error("Network should not be needed for the accepted source"); },
    model: () => { generations++; throw new Error("Collecting should not generate content"); }, ...overrides,
  };
  let service = await createDesktopService(options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory, calls: () => [network, generations], async restart(beforeStart) { await service.close(); await beforeStart?.(); service = await createDesktopService(options); return service; } };
}

test("Tag collection stores the exact accepted text, never a client replacement, without a refetch or model call", async t => {
  const h = await isolated(t);
  const { service } = h;
  const read = await accepted(service, "read-original", source({ text: original }));
  assert.equal(read.context.readStatus, "attached_text");
  const [response, concurrent] = await Promise.all([
    collect(service, read, "save-one", { ...read.context, text: "Client submitted a different body." }),
    collect(service, read, "save-two"),
  ]);
  const [collectionId] = response.message.collectionIds;
  assert.deepEqual(concurrent.message.collectionIds, [collectionId]);
  assert.match(response.message.text, /这一版正文保存到这台电脑/);
  assert.equal(response.state.collections.length, 1);
  assert.equal(response.state.collections[0].sourceSaveStatus, "complete");
  assert.equal(response.state.collections[0].savedPageSnapshotId, read.context.snapshotId);
  assert.equal(response.state.collections[0].pendingPageCapture, undefined);
  const { document } = await service.knowledgeRead({ collectionId });
  assert.equal(document.text, read.context.text);
  assert.equal(document.coverage, "complete");
  assert.equal(document.documentVersionId, response.state.collections[0].knowledgeDocumentVersionId);
  assert.equal((await service.knowledgeSearch({ query: "Quartzbeacon" })).items[0].collectionId, collectionId);
  const replay = await collect(service, read, "save-two");
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.id, concurrent.message.id);
  const pasted = await service.send({ text: `${read.context.url}?utm_source=chat#section` });
  assert.match(pasted.message.text, /已经收藏过了/);
  assert.deepEqual(pasted.message.collectionIds, [collectionId]);
  assert.equal(pasted.state.collections.length, 1);
  assert.equal(pasted.state.collections[0].knowledgeDocumentVersionId, document.documentVersionId);
  const recaptured = await service.capture({ mode: "link", content: `${read.context.url}?utm_source=workspace#section` });
  assert.equal(recaptured.duplicate, true);
  assert.equal(recaptured.collectionId, collectionId);
  assert.equal(recaptured.state.collections.length, 1);
  assert.equal(recaptured.state.collections[0].knowledgeDocumentVersionId, document.documentVersionId);
  assert.equal(service.state().jobs.length, 0);
  await service.idle();
  assert.deepEqual(h.calls(), [0, 0]);
});

test("selection-only and URL-only saves expose honest coverage without AI", async t => {
  const { service } = await isolated(t, { aiEnabled: false });
  const read = await accepted(service, "read-selection", source({ selection: "只保存用户选中的这段正文，不声称有整篇文章。" }));
  assert.equal(read.context.readStatus, "selection_only");
  const response = await collect(service, read, "save-selection");
  assert.match(response.message.text, /读到的节选/);
  const { document } = await service.knowledgeRead({ collectionId: response.message.collectionIds[0] });
  assert.equal(document.coverage, "partial");
  assert.equal(document.text, read.context.selection);
  const link = await service.send({ text: "收藏这个页面", intent: "collect-page", conversationId: "conversation-default", context: source({ url: "https://example.com/link-only", text: "An unaccepted client body." }) });
  assert.match(link.message.text, /已保存网页链接/);
  assert.equal(link.state.collections.find(item => item.id === link.message.collectionIds[0]).sourceSaveStatus, "unavailable");
  const unavailable = (await service.knowledgeRead({ collectionId: link.message.collectionIds[0] })).document;
  assert.equal(unavailable.documentVersionId, null);
  assert.equal(unavailable.text, "");
});

test("Tag fallback saves the exact public preview only after explicit confirmation", async t => {
  let fetches = 0;
  const url = "https://example.com/public-preview";
  const { service } = await isolated(t, {
    aiEnabled: false,
    fetchPage: async requestedURL => {
      assert.equal(requestedURL, url);
      fetches++;
      return { text: original, url, type: "text/plain" };
    },
  });
  const preview = await service.readPage({ context: { url }, requestId: "public-read", retainPublicPreview: true });
  assert.equal(preview.readable, true);
  assert.ok(preview.previewId);
  assert.equal(service.state().collections.length, 0);
  assert.equal(service.state().messages.length, 0);
  const pasted = await service.readPage({ context: { text: original }, retainPublicPreview: true });
  assert.equal(pasted.previewId, undefined);
  const request = { text: "收藏这个页面", intent: "collect-page", context: { url }, previewId: preview.previewId, requestId: "save-preview" };
  await assert.rejects(service.send({ ...request, context: { url: "https://example.com/different" } }), { code: "PAGE_PREVIEW_EXPIRED" });
  await assert.rejects(service.send({ ...request, context: { url, text: newer } }), { code: "INVALID_REQUEST" });
  assert.equal(service.state().collections.length, 0);
  const saved = await service.send(request);
  const collectionId = saved.message.collectionIds[0];
  assert.match(saved.message.text, /这一版正文保存到这台电脑/);
  assert.equal(saved.state.collections[0].sourceSaveStatus, "complete");
  const { document } = await service.knowledgeRead({ collectionId });
  assert.equal(document.url, url);
  assert.equal(document.text, preview.context.text);
  assert.equal((await service.send(request)).replayed, true);
  assert.equal(service.state().collections.length, 1);
  assert.equal(fetches, 1);
});

test("rereading and collecting creates a new version, preserving the old citation after offline restart", async t => {
  const h = await isolated(t, { aiEnabled: false });
  const { service } = h;
  const v1 = await accepted(service, "read-v1", source({ text: original }));
  const first = await collect(service, v1, "save-v1");
  const collectionId = first.message.collectionIds[0];
  const firstDocument = (await service.knowledgeRead({ collectionId })).document;
  const v2 = await accepted(service, "read-v2", source({ text: newer, pageRevision: "revision-2" }), true);
  assert.equal(v2.conversationId, v1.conversationId);
  await assert.rejects(collect(service, v1, "save-stale"), { code: "PAGE_SOURCE_CHANGED" });
  const second = await collect(service, v2, "save-v2");
  assert.deepEqual(second.message.collectionIds, [collectionId]);
  assert.equal(second.state.collections.length, 1);
  const active = (await service.knowledgeRead({ collectionId })).document;
  assert.equal(active.sourceRevision, firstDocument.sourceRevision + 1);
  assert.notEqual(active.documentVersionId, firstDocument.documentVersionId);
  const offline = await h.restart();
  const { document } = await offline.knowledgeRead({ collectionId, documentVersionId: firstDocument.documentVersionId });
  assert.equal(document.text, v1.context.text);
  assert.equal(document.active, false);
  assert.equal((await offline.knowledgeRead({ collectionId })).document.text, v2.context.text);
  assert.deepEqual(h.calls(), [0, 0]);
});

test("restart resumes a journaled save after SQLite committed but before acknowledgment", async t => {
  let stateFile, interrupted;
  const h = await isolated(t, { aiEnabled: false, onChange: () => {
    if (!stateFile || interrupted) return;
    const raw = readFileSync(stateFile, "utf8");
    if (JSON.parse(raw).collections.some(item => item.pendingPageCapture)) interrupted = raw;
  } });
  stateFile = path.join(h.directory, "state.json");
  const read = await accepted(h.service, "read-restart", source({ text: original }));
  const response = await collect(h.service, read, "save-interrupted");
  assert.ok(interrupted);
  const [collectionId] = response.message.collectionIds;
  const prior = (await h.service.knowledgeRead({ collectionId })).document;
  // Keep the committed SQLite row; restore the real pre-acknowledgment JSON.
  const reopened = await h.restart(() => writeFile(stateFile, interrupted, "utf8"));
  const replay = await collect(reopened, read, "save-interrupted");
  assert.equal(replay.replayed, true);
  assert.match(replay.message.text, /这一版正文保存到这台电脑/);
  assert.equal(replay.state.messages.filter(item => item.role === "assistant" && item.collectionIds?.includes(collectionId)).length, 1);
  assert.equal((await reopened.knowledgeRead({ collectionId })).document.documentVersionId, prior.documentVersionId);
  assert.deepEqual(h.calls(), [0, 0]);
});

test("explicit understanding retry uses the same local version instead of fetching it again", async t => {
  const calls = [];
  const h = await isolated(t, { model: (callId, context) => {
    calls.push([callId, context.normalized_content.text]);
    throw Object.assign(new Error("The test provider is unavailable"), { code: "MODEL_NOT_CONFIGURED" });
  } });
  const { service } = h;
  const read = await accepted(service, "read-retry", source({ text: original }));
  const response = await collect(service, read, "save-retry");
  const [collectionId] = response.message.collectionIds;
  const before = (await service.knowledgeRead({ collectionId })).document;
  await service.retry({ collectionId });
  await service.idle();
  assert.deepEqual(calls, [["CALL-P001", read.context.text]]);
  assert.equal(h.calls()[0], 0);
  assert.equal(service.state().jobs.at(-1).status, "failed");
  assert.equal((await service.knowledgeRead({ collectionId })).document.documentVersionId, before.documentVersionId);
});
