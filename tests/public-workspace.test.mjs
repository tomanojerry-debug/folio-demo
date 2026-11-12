import assert from "node:assert/strict";
import test from "node:test";
import { demoReadingsByExhibition, importDemoLibrary, loadDemoLibrary } from "../desktop/server/demo-library.mjs";
import { initialState } from "../desktop/server/state.mjs";
import { publicWorkspaceCatalog } from "../server/public-workspace.mjs";

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
