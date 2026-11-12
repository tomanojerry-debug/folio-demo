import assert from "node:assert/strict";
import test from "node:test";
import { demoReadingsByExhibition, importDemoLibrary, loadDemoLibrary } from "../desktop/server/demo-library.mjs";
import { initialState } from "../desktop/server/state.mjs";
import { publicWorkspaceCatalog } from "../server/public-workspace.mjs";
import { createPublicLibrary, savePublicSample } from "../site/curator/public-library.js";

test("the Web workspace projects the complete public desktop catalog and its prepared readings", async () => {
  const library = await loadDemoLibrary();
  const desktop = initialState();
  importDemoLibrary(desktop, library);
  const { state, articles } = await publicWorkspaceCatalog("/folio-demo");

  assert.deepEqual(state.collections.map(item => item.id), desktop.collections.map(item => item.id));
  assert.deepEqual(state.exhibitions.map(item => item.id), desktop.exhibitions.map(item => item.id));
  assert.deepEqual(new Map(state.exhibitions.map(item => [item.id, item.editorialReadings])), demoReadingsByExhibition(library));
  for (const item of desktop.collections) {
    const published = state.collections.find(entry => entry.id === item.id);
    assert.equal(published.thumbnail, `/folio-demo${item.thumbnail}`);
    assert.equal(published.url, item.url);
    assert.ok(!Object.hasOwn(published, "input"));
    assert.equal(articles[item.id].editorial.summary, item.editorial.summary);
    assert.deepEqual(articles[item.id].paragraphs, []);
    assert.equal(articles[item.id].canGenerateUnderstanding, false);
  }
  assert.equal(state.capabilities.publicDemo, true);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.jobs, []);
});

test("Web Tag history lists a real sample result only in the browser that saved it", async () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const catalog = await publicWorkspaceCatalog("/folio-demo");
  const library = createPublicLibrary(catalog, storage);
  assert.deepEqual((await library.api("state")).conversations, []);

  const source = "我沿同一条河岸走了两次。";
  assert.ok(savePublicSample({
    collection: { title: "同一条路的两种声音" },
    extraction: {
      status: "qualified", source: "live_ai", summary: "两次河岸漫步构成对照。",
      summaryEvidence: ["first"], evidenceBundle: [{ evidence_id: "first", text: source }],
    },
  }, source, storage));
  const saved = await library.api("state");
  assert.equal(saved.conversations.length, 1);
  assert.equal(saved.conversations[0].title, "同一条路的两种声音");
  assert.ok(saved.collections.some(item => item.id === saved.conversations[0].id));
  assert.deepEqual((await createPublicLibrary(catalog).api("state")).conversations, []);
});

test("browser storage failure leaves note and preference snapshots unchanged", async () => {
  const storage = { getItem: () => null, setItem() { throw new Error("Quota exceeded"); } };
  const catalog = await publicWorkspaceCatalog("/folio-demo");
  const library = createPublicLibrary(catalog, storage);
  await assert.rejects(library.api("workspace", {
    ops: [{ field: "studioNotes", key: "sample-note", value: { id: "sample-note", body: "一条想法" } }],
  }), /无法保存/);
  await assert.rejects(library.api("reading/preferences", { fontSize: 20 }), /无法保存/);
  assert.deepEqual((await library.api("state")).workspace.studioNotes, []);
  assert.deepEqual((await library.api("reading/preferences")).preferences, catalog.preferences);
});

test("public exhibition reflections save, reopen and clear through the existing workspace records", async () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const catalog = await publicWorkspaceCatalog("/folio-demo");
  const exhibitionId = catalog.state.exhibitions[0].id;
  let library = createPublicLibrary(catalog, storage);
  await assert.rejects(library.api("notes", { exhibitionId: "unknown", text: "待验证" }), /没有找到这场展览/u);
  await assert.rejects(library.api("notes", { exhibitionId, text: null }), /格式不正确/u);
  await assert.rejects(library.api("notes", { exhibitionId, text: "长".repeat(10001) }), /内容过长/u);
  const saved = (await library.api("notes", { exhibitionId, text: "  一条示例观展想法。 " })).state;
  assert.equal(saved.exhibitions[0].note, "一条示例观展想法。");
  assert.equal(saved.workspace.exhibitionRecords[0].content, saved.exhibitions[0].note);
  assert.equal(saved.workspace.exhibitionRecords[0].exhibitionId, exhibitionId);
  assert.equal(catalog.state.exhibitions[0].note, undefined);

  library = createPublicLibrary(catalog, storage);
  assert.equal((await library.api("state")).exhibitions[0].note, saved.exhibitions[0].note);
  assert.equal((await createPublicLibrary(catalog).api("state")).exhibitions[0].note, undefined);
  const cleared = (await library.api("notes", { exhibitionId, text: "" })).state;
  assert.equal(cleared.exhibitions[0].note, undefined);
  assert.deepEqual(cleared.workspace.exhibitionRecords, []);

  const readonly = createPublicLibrary(catalog, { getItem: storage.getItem, setItem: () => { throw new Error("QuotaExceededError"); } });
  await assert.rejects(readonly.api("notes", { exhibitionId, text: "尚未写入" }), /无法保存/u);
  assert.equal((await readonly.api("state")).exhibitions[0].note, undefined);
});
