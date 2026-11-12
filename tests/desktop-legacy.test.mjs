import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopService } from "../desktop/server/service.mjs";
import { startDesktopServer } from "../desktop/server/index.mjs";
import { mapDesktopState, workspaceDiff, productWorkspaceURL } from "../site/curator/desktop-legacy-bridge.js";

const config = { zhipuApiKey: "", textModel: "test", timeoutMs: 1000 };
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-legacy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function understanding(callId, context, summary = "来源可核对，人保留判断。") {
  const refs = [context.evidence_bundle[0].evidence_id];
  return { trace: { callId, model: "injected-test" }, output: { status: "candidate", summary, summary_evidence_ids: refs, digest: { status: "compact", overview: summary, evidence_ids: refs, highlights: [{ text: summary, evidence_ids: refs }] }, breakdown: { status: "not_applicable", sections: [] }, concepts: [{ value: "人的判断", evidence_ids: refs }], content_reliability_score: 0.9, uncertainties: [] } };
}

test("legacy sample URLs resolve to the same product library without losing their destination", () => {
  for (const hash of ["#top", "#chat", "#gallery"]) {
    const current = productWorkspaceURL(`http://127.0.0.1:4191/prototype/immersive-exhibition/light.html?sample=1&collection=source%2Fa&exhibition=show-one&conversation=chat-one${hash}`);
    assert.equal(current.searchParams.has("sample"),false);
    assert.equal(current.searchParams.get("collection"),"source/a");
    assert.equal(current.searchParams.get("exhibition"),"show-one");
    assert.equal(current.searchParams.get("conversation"),"chat-one");
    assert.equal(current.hash,hash);
  }
});

test("legacy state keeps stable local IDs, exposes no demo seed, and diffs only user-owned fields", () => {
  const empty = mapDesktopState({ collections: [], exhibitions: [], jobs: [], workspace: {} });
  assert.deepEqual(empty.collections, []);
  assert.deepEqual(empty.studioNotes, []);
  assert.deepEqual(empty.exhibitionRecords, []);
  const mapped = mapDesktopState({ collections: [{ id: "local-one", title: "我的收藏", status: "ready", extraction: { collectionId: "source-one", status: "qualified", summary: "真实模型输出" } }], exhibitions: [{ id: "exhibition-one", sourceCollectionIds: ["source-one"], rooms: [{ exhibit_ids: ["source-one"] }], items: [{ id: "source-one", title: "我的收藏" }] }], jobs: [] });
  assert.equal(mapped.extractions[0].collectionId, "local-one");
  assert.equal(mapped.liveExhibitions[0].items[0].id, "local-one");
  assert.equal(mapped.liveExhibitions[0].rooms[0].exhibit_ids[0], "local-one");
  const modified = structuredClone(mapped);
  modified.collections[0].summary = "客户端不能伪造AI摘要";
  modified.extractions[0].summary = "客户端不能修改来源校验";
  modified.liveExhibitions[0].title = "客户端不能覆盖AI展览";
  modified.notes["local-one"] = "我为什么收藏它。";
  modified.feedback["understanding:local-one"] = { decision: "confirmed", acceptedTags: ["人的判断"] };
  const ops = workspaceDiff(mapped, modified);
  assert.deepEqual(new Set(ops.map((op) => op.field)), new Set(["notes", "feedback"]));
});

test("historical exhibition links keep their local collection after an explicit source refresh", () => {
  const mapped = mapDesktopState({ collections: [{ id: "local-item", status: "ready", extraction: { collectionId: "new-source", status: "qualified" } }],
    exhibitions: [{ id: "older-exhibition", sourceCollectionIds: ["old-source"], collectionIds: ["local-item"], rooms: [{ exhibit_ids: ["old-source"] }], items: [{ id: "old-source", title: "Original version" }] }], jobs: [] });
  assert.deepEqual(mapped.liveExhibitions[0].sourceCollectionIds, ["local-item"]);
  assert.deepEqual(mapped.liveExhibitions[0].rooms[0].exhibit_ids, ["local-item"]);
  assert.equal(mapped.liveExhibitions[0].items[0].id, "local-item");
});

test("restricted workspace persists original note and feedback forms without overwriting AI data", async (t) => {
  const directory = await temporary(t);
  const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, model: understanding });
  const captured = await service.capture({ mode: "text", content: "一个可靠的系统应该保留原始来源，让人核对证据，并把最后的判断和责任留给使用者。" });
  await service.idle();
  const id = captured.collectionId;
  const summary = service.state().collections[0].summary;
  await Promise.all([
    service.workspace({ ops: [{ field: "notes", key: id, value: "我认同可解释性。" }] }),
    service.workspace({ ops: [{ field: "collectionCategories", key: id, value: "产品设计" }, { field: "feedback", key: `understanding:${id}`, value: { decision: "confirmed", acceptedTags: ["人的判断"] } }] }),
    service.workspace({ ops: [{ field: "exhibitionNotes", key: "note-one", value: { id: "note-one", kind: "text", content: "来源可以继续追问。", comment: "这是我的批注", exhibitId: id, createdAt: "2026-11-08T00:00:00.000Z" } }, { field: "studioNotes", key: "studio-one", value: { id: "studio-one", title: "我自己的手记", blocks: [{ type: "opinion", ai: false, text: "判断留给自己。" }], status: "saved" } }] }),
  ]);
  await assert.rejects(service.workspace({ ops: [{ field: "collections", key: id, value: { summary: "伪造" } }] }), { code: "INVALID_WORKSPACE_PATCH" });
  await assert.rejects(service.workspace({ ops: [{ field: "feedback", key: "__proto__", value: { decision: "confirmed" } }] }), { code: "INVALID_WORKSPACE_PATCH" });
  await assert.rejects(service.workspace({ ops: [{ field: "studioNotes", key: "studio-one", value: { id: "studio-one", receipt: "不能伪造凭证" } }] }), { code: "INVALID_WORKSPACE_PATCH" });
  assert.equal(service.state().collections[0].summary, summary);
  assert.equal(service.state().collections[0].status, "ready");
  await service.close();
  const reopened = await createDesktopService({ directory, config, aiEnabled: false });
  const state = reopened.state();
  assert.equal(state.workspace.notes[id], "我认同可解释性。");
  assert.equal(state.workspace.collectionCategories[id], "产品设计");
  assert.equal(state.workspace.exhibitionNotes[0].comment, "这是我的批注");
  assert.equal(state.workspace.studioNotes[0].blocks[0].text, "判断留给自己。");
  assert.equal(state.collections[0].summary, summary);
  await reopened.close();
});

test("structured image capture saves the original locally without AI and rejects unsafe inputs", async (t) => {
  const directory = await temporary(t);
  const service = await createDesktopService({ directory, config, aiEnabled: false });
  const image = "data:image/png;base64,aGVsbG8=";
  const captured = await service.capture({ mode: "image", image, title: "我的图片" });
  assert.equal(captured.state.collections[0].status, "saved");
  assert.equal(captured.state.collections[0].thumbnail, image);
  assert.equal(captured.state.collections[0].extraction, undefined);
  assert.equal(captured.state.jobs.length, 0);
  await assert.rejects(service.capture({ mode: "image", image: "data:text/html;base64,aGVsbG8=" }), { code: "INVALID_REQUEST" });
  await assert.rejects(service.capture({ mode: "link", content: "http://127.0.0.1/private" }), { code: "UNSAFE_URL" });
  const privateState = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
  assert.equal(privateState.collections[0].input.image, image);
  await service.close();
});

test("failed revisions preserve prior signed understanding and retry keeps the correction", async (t) => {
  const directory = await temporary(t);
  let calls = 0;
  const service = await createDesktopService({ directory, config, aiEnabled: true, autoCurate: false, model: (callId, context) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("injected failure"), { code: "MODEL_PROVIDER_ERROR" });
    if (calls === 3) assert.equal(context.user_corrections[0].text, "重点是责任，而不是效率。");
    return understanding(callId, context, calls === 3 ? "重点是责任应当可追溯。" : undefined);
  } });
  const captured = await service.capture({ mode: "text", content: "自动化系统可以提高效率，但依然需要保留原始来源，让人能够核对最终判断和执行责任。" });
  await service.idle();
  const original = service.state().collections[0];
  await service.workspace({ ops: [{ field: "feedback", key: `understanding:${captured.collectionId}`, value: { decision: "pending_rewrite", correctionPrompt: "重点是责任，而不是效率。" } }] });
  await service.revise({ collectionId: captured.collectionId, correction: "重点是责任，而不是效率。" });
  await service.idle();
  assert.equal(service.state().collections[0].summary, original.summary);
  assert.deepEqual(service.state().collections[0].extraction, original.extraction);
  assert.equal(service.state().collections[0].status, "failed");
  await service.retry({ collectionId: captured.collectionId });
  await service.idle();
  assert.equal(service.state().collections[0].id, captured.collectionId);
  assert.equal(service.state().collections[0].summary, "重点是责任应当可追溯。");
  assert.equal(service.state().workspace.feedback[`understanding:${captured.collectionId}`], undefined);
  await service.close();
});

test("local server serves only approved legacy files and sends durable state events without a public demo session", async (t) => {
  const directory = await temporary(t);
  const runtime = await startDesktopServer({ directory, config, aiEnabled: false, port: 0 });
  t.after(() => runtime.close());
  const get = (route, init) => fetch(runtime.origin + route, init);
  assert.equal((await get("/prototype/immersive-exhibition/app.js")).status, 200);
  const workspaceScript = await get("/prototype/immersive-exhibition/light-workspace.js");
  assert.equal(workspaceScript.status, 200);
  assert.match(workspaceScript.headers.get("content-type"), /text\/javascript/);
  const homeDashboard = await get("/prototype/immersive-exhibition/home-dashboard.js");
  assert.equal(homeDashboard.status, 200);
  assert.match(homeDashboard.headers.get("content-type"), /text\/javascript/);
  const recommendations = await get("/prototype/immersive-exhibition/collection-recommendations.js");
  assert.equal(recommendations.status, 200);
  assert.match(recommendations.headers.get("content-type"), /text\/javascript/);
  const workspaceStyles = await get("/prototype/immersive-exhibition/light-workspace.css");
  assert.equal(workspaceStyles.status, 200);
  assert.match(workspaceStyles.headers.get("content-type"), /text\/css/);
  const controls = await get("/vendor/basecoat/basecoat-scoped.css");
  assert.equal(controls.status, 200);
  assert.match(controls.headers.get("content-type"), /text\/css/);
  assert.match(controls.headers.get("content-security-policy"), /script-src 'self'/);
  for (const script of ["basecoat", "dropdown-menu"]) {
    const resource = await get(`/vendor/basecoat/js/${script}.min.js`);
    assert.equal(resource.status, 200);
    assert.match(resource.headers.get("content-type"), /text\/javascript/);
  }
  assert.equal((await get("/curator/ui-system.css")).status, 200);
  assert.equal((await get("/vendor/basecoat/build-scoped.mjs")).status, 404);
  assert.equal((await get("/vendor/basecoat/package.json")).status, 404);
  assert.equal((await get("/prototype/immersive-exhibition/assets/generated/p001-sample-results.js")).status, 200);
  assert.equal((await get("/prototype/immersive-exhibition/gallery3d/index.html")).status, 404);
  assert.equal((await get("/prototype/immersive-exhibition/__seed.html")).status, 404);
  assert.equal((await get("/editions/winter2026/")).status, 404);
  assert.equal((await get("/api/forme?action=session")).status, 404);
  assert.equal((await get("/server/receipts.mjs")).status, 404);
  const controller = new AbortController();
  const events = await get("/api/desktop/events", { signal: controller.signal });
  assert.match(events.headers.get("content-type"), /text\/event-stream/);
  const reader = events.body.getReader();
  await reader.read();
  const captured = await get("/api/desktop/capture", { method: "POST", headers: { Origin: runtime.origin, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "text", content: "这是一条来自原收新弹窗的真实本地收藏，不需要共享展示账号。" }) });
  assert.equal(captured.status, 200);
  const event = await reader.read();
  assert.match(new TextDecoder().decode(event.value), /event: state/);
  controller.abort();
  const state = await (await get("/api/desktop/state")).json();
  assert.equal(state.collections.length, 1);
  assert.deepEqual(state.workspace.studioNotes, []);
});
