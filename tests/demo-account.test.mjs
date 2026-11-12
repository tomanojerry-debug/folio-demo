import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startDesktopServer } from "../desktop/server/index.mjs";
import { initialState, openState } from "../desktop/server/state.mjs";
import { importStarterContent, removeStarterContent } from "../desktop/server/starter-content.mjs";
import { renderCurationStory } from "../site/curator/curation-story.js";
import { TOPIC_PRESET_MODES } from "../site/curator/curation-mode-definitions.js";
import { importDemoLibrary, loadDemoLibrary } from "../desktop/server/demo-library.mjs";

test("the local demo login gates the workspace and keeps its curated catalog isolated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "folio-demo-account-"));
  const personalDirectory = path.join(root, "personal");
  const demoDirectory = path.join(root, "demo");
  const config = { zhipuApiKey: "", embeddingBackend: "disabled" };
  let runtime;
  try {
    const personal = await openState(personalDirectory);
    await personal.update(state => { state.profile.preferences = "private test preferences"; });
    runtime = await startDesktopServer({ presentation:true, directory:demoDirectory, config });
    const { origin } = runtime;
    const request = (route, options) => fetch(origin + route, options);
    const login = body => request("/api/desktop/session", {
      method:"POST", headers:{ Origin:origin, "Content-Type":"application/json" }, body:JSON.stringify(body),
    });
    const first = await request("/", { redirect:"manual" });
    assert.equal(first.status, 303);
    assert.equal(first.headers.get("location"), "/login");
    assert.match(await (await request("/login")).text(), /登录演示账号/u);
    for (const route of ["state", "events", "harness", "memories", "covers/invalid"]) {
      assert.equal((await request(`/api/desktop/${route}`)).status, 401);
    }
    const prefill = await (await request("/api/desktop/session")).json();
    assert.equal(prefill.signedIn, false);
    assert.equal((await request("/api/desktop/session", { method:"POST", headers:{ Origin:"https://example.org" } })).status, 403);
    assert.equal((await login({ ...prefill, password:"invalid" })).status, 401);
    const signed = await login({ ...prefill, next:"https://example.org" });
    assert.equal(signed.status, 200);
    assert.match(signed.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/u);
    assert.match((await signed.json()).next, /^\/prototype\/.*#gallery$/u);
    const Cookie = signed.headers.get("set-cookie").split(";")[0];
    const headers = { Cookie };
    const state = await (await request("/api/desktop/state", { headers })).json();
    assert.equal(state.collections.length, 41);
    assert.equal(state.exhibitions.length, 5);
    for (const collection of state.collections) {
      assert.match(collection.thumbnail, /^\/curator\/assets\//);
      assert((await stat(new URL(`../site${collection.thumbnail}`, import.meta.url))).isFile());
    }
    assert(state.exhibitions.every(exhibition => exhibition.image.startsWith("/curator/assets/")));
    assert.equal((await request(state.collections[0].thumbnail, { headers })).headers.get("content-type"), "image/png");
    assert.deepEqual(prefill.catalog, { collectionCount:41, exhibitionCount:5 });
    assert.equal(state.profile.preferences, "");
    assert.equal(state.capabilities.demoAccount, true);
    assert.equal(state.capabilities.aiEnabled, false);
    assert.deepEqual(state.jobs, []);
    const ids = new Set(state.collections.map(item => item.id));
    assert.equal(ids.size, 41);
    assert(state.collections.every(item => /^#[a-f\d]{6}$/u.test(item.coverColor)));
    assert.equal(state.collections.find(item => item.id.endsWith("-memgpt")).coverColor, "#394d87");
    const editionCounts = new Map([
      ["folio-demo-agent-memory", 10], ["folio-demo-impressionism-modern-life", 10], ["folio-demo-patagonia-worn-longer", 10],
      ["folio-demo-anime-music", 5], ["folio-demo-ai-3d-modeling", 6],
    ]);
    for (const exhibition of state.exhibitions) {
      assert(exhibition.rooms.length >= 2);
      assert.equal(exhibition.collectionIds.length, editionCounts.get(exhibition.id));
      const roomIds = exhibition.rooms.flatMap(room => room.exhibit_ids);
      assert(roomIds.every(id => ids.has(id)));
      assert.deepEqual(new Set(roomIds), new Set(exhibition.collectionIds));
      const html = renderCurationStory(exhibition, state.collections);
      for (const mode of ["overview", "compare", "full", ...Object.keys(TOPIC_PRESET_MODES)]) {
        assert(html.includes(`data-curation-panel="${mode}"`));
      }
      for (const [mode, { slots }] of Object.entries(TOPIC_PRESET_MODES)) {
        const entries = exhibition.editorialReadings[mode];
        assert.deepEqual(Object.keys(entries), slots.map(slot => slot.id));
        for (const entry of Object.values(entries)) {
          assert(entry.text && entry.collectionIds.every(id => exhibition.collectionIds.includes(id)));
        }
      }
      assert.match(html, /策展读稿 · 附原文链接/u);
      assert.doesNotMatch(html, /data-curation-model-generate|发送本展原文片段/u);
    }
    const article = state.collections[0];
    const read = await request("/api/desktop/reading/article", {
      method:"POST", headers:{ ...headers, Origin:origin, "Content-Type":"application/json" },
      body:JSON.stringify({ collectionId:article.id }),
    });
    const reader = (await read.json()).article;
    assert.equal(reader.editorial.summary, article.summary);
    assert.deepEqual(reader.paragraphs, []);
    const chat = await request("/api/desktop/messages", {
      method:"POST", headers:{ ...headers, Origin:origin, "Content-Type":"application/json" },
      body:JSON.stringify({ text:"在吗" }),
    });
    assert.equal(chat.status, 200);
    const demoChat = await chat.json();
    assert.match(demoChat.message.text, /演示模式.*智能对话请使用 Folio 的个人模式/u);
    assert.deepEqual(demoChat.state.jobs, []);
    const note = await request("/api/desktop/notes", {
      method:"POST", headers:{ ...headers, Origin:origin, "Content-Type":"application/json" },
      body:JSON.stringify({ exhibitionId:state.exhibitions[0].id, text:"Demo account annotation" }),
    });
    assert.equal(note.status, 200);
    assert.equal((await request("/api/desktop/session", { method:"DELETE", headers:{ ...headers, Origin:origin } })).status, 200);
    assert.equal((await request("/api/desktop/state", { headers })).status, 401);
    await runtime.close();
    runtime = await startDesktopServer({ presentation:true, directory:demoDirectory, config });
    assert.equal(runtime.service.state().collections.length, 41);
    assert.equal(runtime.service.state().exhibitions[0].note, "Demo account annotation");
    assert.equal((await openState(personalDirectory)).read().profile.preferences, "private test preferences");
  } finally {
    await runtime?.close();
    await rm(root, { recursive:true, force:true });
  }
});

test("a version-one demo library receives only the new exhibitions and keeps local edits", async () => {
  const catalog = await loadDemoLibrary();
  const existing = initialState();
  importDemoLibrary(existing, catalog.filter(edition => !edition.introducedIn));
  assert.equal(existing.demoCatalogVersion, 1);
  existing.exhibitions[0].note = "Existing demo annotation";
  const earlier = structuredClone(existing);
  importDemoLibrary(existing, catalog);
  assert.equal(existing.demoCatalogVersion, 2);
  assert.deepEqual(existing.exhibitions.slice(0, 3), earlier.exhibitions);
  assert.deepEqual(existing.collections.slice(0, 30), earlier.collections);
  assert.equal(existing.exhibitions.length, 5);
  assert.equal(existing.collections.length, 41);
  const updated = structuredClone(existing);
  importDemoLibrary(existing, catalog);
  assert.deepEqual(existing, updated);

  const changedCover = existing.collections.find(item => item.id.endsWith("-frieren-anytime-anywhere"));
  const olderExhibitionItem = existing.exhibitions.flatMap(exhibition => exhibition.items).find(item => item.id === changedCover.id);
  const oldCover = "https://publisher.example/previous-cover.jpg";
  delete changedCover.editorial.imagePath;
  changedCover.editorial.imageUrl = oldCover;
  changedCover.thumbnail = oldCover;
  olderExhibitionItem.thumbnail = oldCover;
  importDemoLibrary(existing, catalog);
  assert.equal(changedCover.thumbnail, updated.collections.find(item => item.id === changedCover.id).thumbnail);
  assert.equal(olderExhibitionItem.thumbnail, changedCover.thumbnail);
  assert.equal(changedCover.editorial.imageUrl, undefined);
  changedCover.manualThumbnail = true;
  changedCover.thumbnail = oldCover;
  importDemoLibrary(existing, catalog);
  assert.equal(changedCover.thumbnail, oldCover);
});

test("retiring the bundled samples preserves real collections and edited sample notes", () => {
  const state = initialState();
  state.collections.push({ id:"personal", url:"https://example.org/article" });
  importStarterContent(state);
  const changed = state.exhibitions[0];
  changed.note = "A personal annotation";
  removeStarterContent(state);
  assert.deepEqual(state.exhibitions.map(item => item.id), [changed.id]);
  assert.equal(state.exhibitions[0].note, "A personal annotation");
  assert(state.collections.some(item => item.id === "personal"));
  assert.equal(state.workspace.exhibitionRecords.length, 0);
  assert.equal(state.starterContent, undefined);
});
