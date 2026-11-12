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
