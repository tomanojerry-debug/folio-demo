import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createPublicHttpServer } from "../server/public-http.mjs";

test("the public workspace serves the exact client fixture and browser assets under its own prefix", async (t) => {
  const prefix = "/folio-demo";
  const server = createPublicHttpServer(prefix);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options) => fetch(origin + route, options);
  const entry = `${prefix}/prototype/immersive-exhibition/light.html`;
  for (const alias of [`${prefix}/workspace/`, `${prefix}/try`, `${prefix}/try/`]) {
    const redirect = await request(alias, { redirect: "manual" });
    assert.equal(redirect.status, 308, alias);
    assert.equal(redirect.headers.get("location"), `${entry}#home`, alias);
  }

  const response = await request(entry);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html\b[^>]*data-public-workspace="true"/u);
  assert.match(html, /src="\/folio-demo\/curator\/desktop-legacy-bridge\.js"/u);
  const referencedFiles = new Set([...html.matchAll(/(?:src|href)="([^"#]+)"/gu)]
    .map(([, value]) => new URL(value, origin + entry).pathname));
  for (const file of referencedFiles) assert(file.startsWith(`${prefix}/`), file);

  const catalogResponse = await request(`${prefix}/api/library`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.state.collections.length, 41);
  assert.equal(catalog.state.exhibitions.length, 5);
  assert.equal(Object.keys(catalog.articles).length, 41);
  assert.deepEqual(catalog.state.messages, []);
  assert.equal(catalog.state.capabilities.aiEnabled, false);
  const covers = catalog.state.collections.map(item => item.thumbnail);
  assert(covers.some(cover => cover.endsWith("/folio-login-monet.jpg")));
  for (const cover of covers) {
    assert(cover.startsWith(`${prefix}/curator/assets/`), cover);
    referencedFiles.add(cover);
  }
  referencedFiles.add(`${prefix}/prototype/immersive-exhibition/assets/fonts/quicksand-bold-latin.woff2`);
  referencedFiles.add(`${prefix}/curator/article-original.js`);
  referencedFiles.add(`${prefix}/curator/curation-mode-definitions.js`);
  referencedFiles.add(`${prefix}/curator/public-library.js`);
  const samplePath = `${prefix}/try/sample/`;
  const sample = await request(samplePath);
  assert.equal(sample.status, 200);
  const sampleHtml = await sample.text();
  assert.match(sampleHtml, /src="\.\.\/\.\.\/curator\/assets\/demo-art\//u);
  referencedFiles.add(`${prefix}/try/sample/app.js`);
  referencedFiles.add(`${prefix}/try/sample/styles.css`);
  const assetChecks = await Promise.all([...referencedFiles].map(async file => [file, (await request(file, { method: "HEAD" })).status]));
  for (const [file, status] of assetChecks) assert.equal(status, 200, file);

  const catalogHead = await request(`${prefix}/api/library`, { method: "HEAD" });
  assert.equal(catalogHead.status, 200);
  assert.equal(await catalogHead.text(), "");
  assert.equal((await request(`${prefix}/api/library`, { method: "POST" })).status, 405);
  for (const route of [
    "/api/library", "/curator/ink-avatar.svg", `${prefix}/api/desktop/state`, `${prefix}/api/desktop/workspace`,
    `${prefix}/curator/login.html`, `${prefix}/curator/index.html`, `${prefix}/curator/main.js`, `${prefix}/prototype/immersive-exhibition/index.html`,
    `${prefix}/.env`, `${prefix}/curator/%2e%2e/.git/config`, `${prefix}/curator/%2e%2e%2f.env`,
    `${prefix}/curator/assets/demo-art/.hidden.png`, `${prefix}/server/public-workspace.mjs`,
  ]) {
    assert.equal((await request(route)).status, 404, route);
  }
});
