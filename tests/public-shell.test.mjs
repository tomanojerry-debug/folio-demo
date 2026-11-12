import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

test("the public entry loads the complete styled workspace and web app without the private desktop bridge", async () => {
  const document = new URL("../site/prototype/immersive-exhibition/index.html", import.meta.url);
  const html = await readFile(document, "utf8");
  assert.match(html, /<html\b[^>]*data-presentation="light"/);
  assert.match(html, /<aside\b[^>]*class="[^"]*\bws-sidebar\b/);
  assert.match(html, /data-workspace-nav/);
  assert.doesNotMatch(html, /data-workspace-themes|主题线索/);
  assert.match(html, /class="ws-frame"/);
  assert.doesNotMatch(html, /ws-topbar|data-workspace-storage|data-workspace-breadcrumb/);
  assert.match(html, /<main\b[^>]*id="app"/);
  assert.match(html, /data-workspace-help/);
  assert.match(html, /data-workspace-announcement/);

  const origin = "https://guanxu.invalid/prototype/immersive-exhibition/index.html";
  const stylesheets = [...html.matchAll(/<link\b[^>]*>/g)]
    .filter(([tag]) => /\brel="stylesheet"/.test(tag))
    .map(([tag]) => new URL(/\bhref="([^"]+)"/.exec(tag)[1], origin).pathname);
  for (const required of [
    "/vendor/basecoat/basecoat-scoped.css",
    "/prototype/immersive-exhibition/styles.css",
    "/prototype/immersive-exhibition/live-ai.css",
    "/prototype/immersive-exhibition/light.css",
    "/prototype/immersive-exhibition/light-workspace.css",
    "/curator/ui-system.css",
    "/curator/task-progress.css",
    "/curator/glass-dialogs.css",
  ]) assert.ok(stylesheets.includes(required), `missing public stylesheet ${required}`);

  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
    .map(([, source]) => new URL(source, origin).pathname);
  assert.ok(scripts.includes("/vendor/basecoat/js/basecoat.min.js"));
  assert.ok(scripts.includes("/vendor/basecoat/js/dropdown-menu.min.js"));
  assert.equal(scripts.filter(source => source === "/prototype/immersive-exhibition/app.js").length, 1);
  assert.match(html, /<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="\.\/app\.js(?:\?[^"]*)?")[^>]*>/);
  assert.doesNotMatch(html, /desktop-legacy-bridge\.js|window\.__FORME_DESKTOP__/);
  for (const resource of [...stylesheets, ...scripts]) {
    const file = new URL(`../site${resource}`, import.meta.url);
    assert.equal((await stat(file)).isFile(), true, `public resource must exist: ${resource}`);
  }
});
