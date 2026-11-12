import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDesktopServer } from "../desktop/server/index.mjs";

test("knowledge routes read real stored sources and share desktop origin and identity boundaries", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-knowledge-http-"));
  const runtime = await startDesktopServer({ directory, port: 0, aiEnabled: false, autoCurate: false, knowledgeEmbedder: null, config: { zhipuApiKey: "", timeoutMs: 1000 } });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const { origin, service } = runtime;
  const a = await service.capture({ mode: "text", title: "自然光与建筑", content: "自然光进入建筑的方式与窗户朝向有关，使用者可以通过空间观察光影节律。" });
  const b = await service.capture({ mode: "text", title: "建筑采光", content: "建筑空间中的自然光会随时间变化，窗户布局影响光影和室内活动。" });
  const post = (route, body, allowed = true) => fetch(`${origin}/api/desktop/knowledge/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(allowed ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  const search = await post("search", { query: "自然光 建筑" });
  assert.equal(search.status, 200);
  const searched = await search.json();
  assert.deepEqual(new Set(searched.items.map(item => item.collectionId)), new Set([a.collectionId, b.collectionId]));
  assert.equal(searched.mode, "full_text");
  const read = await post("read", { collectionId: a.collectionId, offset: 0, limit: 12 });
  assert.equal(read.status, 200);
  const page = await read.json();
  assert.equal(page.document.text.length, 12);
  assert.equal(page.document.hasMore, true);
  const similar = await post("similar", { collectionId: a.collectionId });
  assert.equal(similar.status, 200);
  const related = await similar.json();
  assert.ok(related.items.some(item => item.collectionId === b.collectionId));
  assert.ok(related.anchor.chunks.length && related.items[0].chunks.length);
  const connections = await post("connections", { collectionId:a.collectionId });
  assert.equal(connections.status, 200);
  assert.equal((await connections.json()).anchor.collectionId, a.collectionId);
  for (const route of ["search", "read", "similar", "connections"]) assert.equal((await post(route, {}, false)).status, 403, route);
  assert.equal((await post("connections", { collectionId:"forged" })).status, 404);
  assert.equal((await post("read", { collectionId: "forged" })).status, 404);
  assert.equal((await post("read", { collectionId: a.collectionId, offset: -1 })).status, 400);
  assert.equal((await post("search", { query: "自然光", limit: 99 })).status, 400);
  const forgedVersion = await post("read", { collectionId: b.collectionId, documentVersionId: page.document.documentVersionId });
  assert.equal(forgedVersion.status, 404);
  for (const asset of ["knowledge-panel.js", "knowledge-panel.css"]) {
    const response = await fetch(`${origin}/curator/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.doesNotMatch(await response.text(), /embeddingApiKey|Bearer\s+[^'"\s]+/);
  }
});
