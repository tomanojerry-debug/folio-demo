import { readFile, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "./handler.mjs";

const assets = new Map([
  ["/try/sample/", ["/try/index.html", "text/html; charset=utf-8"]],
  ["/try/sample/app.js", ["/try/app.js", "text/javascript; charset=utf-8"]],
  ["/try/sample/styles.css", ["/try/styles.css", "text/css; charset=utf-8"]],
  ["/curator/ink-avatar.svg", ["/curator/ink-avatar.svg", "image/svg+xml"]],
]);
const siteRoot = fileURLToPath(new URL("../site/", import.meta.url));
const workspaceRoot = "/prototype/immersive-exhibition";
const workspacePage = `${workspaceRoot}/light.html`;
const curatorModules = new Set([
  "article-original", "article-reading", "chat-launch", "collection-card-color", "collection-headline", "companion-avatar",
  "curation-mode-definitions", "curation-reading", "curation-story", "curation-theme", "desktop-legacy-bridge",
  "exhibition-row-layout", "glass-dialogs", "home-recommendation-scroll", "knowledge-panel", "public-library",
  "reading-settings", "task-view", "video-capture-command",
  "workspace-chat-launch", "workspace-chat", "workspace-conversation-history", "workspace-conversation-shell",
]);
const curatorStyles = new Set([
  "article-reading", "companion-avatar", "curation-story", "glass-dialogs", "reading-settings", "task-progress", "ui-system",
  "workspace-conversation-history", "workspace-conversation-shell",
]);
const workspaceModules = new Set([
  "app", "collection-recommendations", "extraction", "fixtures", "home-dashboard", "light-workspace",
  "live-ai", "live-ai-request", "refresh-mode", "serendipity", "store",
]);
const workspaceStyles = new Set(["styles", "live-ai", "light", "light-workspace"]);
const basecoat = new Set(["/vendor/basecoat/basecoat-scoped.css", "/vendor/basecoat/js/basecoat.min.js", "/vendor/basecoat/js/dropdown-menu.min.js"]);
const contentTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
};

function workspaceAsset(relative) {
  if (relative === workspacePage || basecoat.has(relative)) return relative;
  if (/^\/curator\/assets\/(?:demo-art\/[a-z0-9-]+\.(?:png|jpg)|folio-login-monet\.jpg)$/u.test(relative)) return relative;
  const asset = relative.startsWith("/assets/") ? workspaceRoot + relative : relative;
  if (asset.startsWith(`${workspaceRoot}/assets/`)) {
    const file = asset.slice(workspaceRoot.length + 8);
    if (file === "generated/p001-sample-results.js" || /^(?:demo|fonts|scenes|illustrated-street|waterfront-parallax)\/[a-z0-9-]+\.(?:svg|png|jpg|webp|woff2)$/u.test(file)) return asset;
  }
  const module = /^\/(curator|prototype\/immersive-exhibition)\/([a-z0-9-]+)\.(js|css)$/u.exec(relative);
  if (module) {
    const [, group, name, extension] = module;
    const entries = group === "curator" ? (extension === "js" ? curatorModules : curatorStyles) : (extension === "js" ? workspaceModules : workspaceStyles);
    if (entries.has(name)) return relative;
  }
  return null;
}

function mountWorkspaceHtml(html, basePath) {
  return html.replace(/<html(?=\s)/u, '<html data-public-workspace="true"')
    .replace(/\b(src|href)="(\/(?:curator|vendor|assets|prototype\/immersive-exhibition)\/[^"\s]+)"/gu, `$1="${basePath}$2"`);
}

async function loadAsset(file, route, basePath) {
  const source = path.join(siteRoot, file);
  // The HTTP allowlist selects regular shipped files, including when a symlink appears in the tree.
  const actual = await realpath(source);
  if (!actual.startsWith(siteRoot) || actual !== source) throw new Error("Asset is outside the public bundle");
  const data = await readFile(actual);
  if (file === workspacePage) return Buffer.from(mountWorkspaceHtml(data.toString("utf8"), basePath));
  if (file === "/curator/ui-system.css") {
    return Buffer.from(data.toString("utf8").replace('url("/prototype/immersive-exhibition/', 'url("../prototype/immersive-exhibition/'));
  }
  if (route === "/try/sample/") return Buffer.from(data.toString("utf8").replaceAll('"../curator/', '"../../curator/'));
  return data;
}

export function createPublicHttpServer(basePath = "/folio-demo") {
  if (basePath && !/^\/[a-z][a-z0-9-]{0,63}$/.test(basePath)) throw new Error("Invalid FOLIO_PUBLIC_BASE_PATH");
  const apiPath = `${basePath}/api/forme`;
  const handler = createHandler({ publicApiPath: apiPath });
  const catalogPath = `${basePath}/api/library`;
  const entryAliases = new Set([basePath, `${basePath}/`, `${basePath}/try`, `${basePath}/try/`, `${basePath}/workspace`, `${basePath}/workspace/`]);
  let catalog;
  return http.createServer(async (req, res) => {
    const requestPath = URL.parse(req.url, "http://localhost")?.pathname;
    if (!requestPath) { res.writeHead(404).end(); return; }
    if (requestPath === apiPath) return handler(req, res);
    if (requestPath === catalogPath) {
      if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
      try {
        catalog ||= import("./public-workspace.mjs")
          .then(({ publicWorkspaceCatalog }) => publicWorkspaceCatalog(basePath))
          .then(value => JSON.stringify(value));
        const body = await catalog;
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        }).end(req.method === "HEAD" ? undefined : body);
      } catch { catalog = undefined; res.writeHead(503).end(); }
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(404).end(); return; }
    if (entryAliases.has(requestPath)) {
      res.writeHead(308, { Location: `${basePath}${workspacePage}#home`, "Cache-Control": "no-store" }).end();
      return;
    }
    if (requestPath === `${basePath}/try/sample`) {
      res.writeHead(308, { Location: `${basePath}/try/sample/` }).end();
      return;
    }
    const relative = requestPath.startsWith(`${basePath}/`) && requestPath.slice(basePath.length);
    const workspaceFile = relative && workspaceAsset(relative);
    const asset = relative && (assets.get(relative) || (workspaceFile && [workspaceFile, contentTypes[path.extname(workspaceFile)]]));
    if (!asset) { res.writeHead(404).end(); return; }
    const [file, contentType] = asset;
    try {
      const data = await loadAsset(file, relative, basePath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": data.length,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": file === workspacePage
          ? "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
          : "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      }).end(req.method === "HEAD" ? undefined : data);
    } catch { res.writeHead(404).end(); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPublicHttpServer(process.env.FOLIO_PUBLIC_BASE_PATH ?? "/folio-demo");
  server.listen(Number(process.env.PORT || 4186), "127.0.0.1");
}
