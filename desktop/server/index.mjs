import http from "node:http";
import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopService } from "./service.mjs";
import { acquireDataLock } from "./lock.mjs";
import { loadDemoLibrary } from "./demo-library.mjs";
import { createDemoSession, demoPassword, demoStage, demoUsername, isWorkspacePage } from "./demo-session.mjs";
import { checkModelProfile, loadModelProfile, modelConfig, saveModelProfile } from "./model-setup.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const uiRoot = path.join(projectRoot, "site/curator");
const setupRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "setup");
const setupFiles = new Set(["model-setup.html", "model-setup.css", "model-setup.js"]);
const assetRoot = path.join(projectRoot, "site/prototype/immersive-exhibition/assets");
const legacyRoot = path.dirname(assetRoot);
const vendorRoot = path.join(projectRoot, "site/vendor/ogl/src");
const controlsRoot = path.join(projectRoot, "site/vendor/basecoat");
const controlsFiles = new Set(["basecoat-scoped.css", "js/basecoat.min.js", "js/dropdown-menu.min.js"]);
const legacyFiles = new Set(["light.html", "light.css", "light-workspace.js", "home-dashboard.js", "collection-recommendations.js", "light-workspace.css", "app.js", "styles.css", "live-ai.css", "live-ai.js", "live-ai-request.js", "fixtures.js", "store.js", "gates.js", "extraction.js", "serendipity.js", "refresh-mode.js", "refresh-worker.js", "grainient.js", "text-pressure.js", "galaxy.js", "noomo3d.js", "inbox-scene3d.js", "elastic-mesh.js", "sample-registry.js", "public-hero.css", "bgm.js"]);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".webm": "video/webm", ".mp4": "video/mp4", ".m4a": "audio/mp4" };

function json(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

async function readJSON(req, maxBytes = 250000) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw Object.assign(new Error("请使用 JSON 提交。"), { statusCode: 415, code: "JSON_REQUIRED" });
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw Object.assign(new Error("消息或图片过大，请缩小后提交。"), { statusCode: 413, code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("提交格式不正确。"), { statusCode: 400, code: "INVALID_JSON" }); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw Object.assign(new Error("请提交 JSON 对象。"), { statusCode: 400, code: "INVALID_REQUEST" });
  return result;
}

export async function startDesktopServer(options = {}) {
  const presentation = options.presentation === true;
  const packaged = process.env.FORME_PACKAGED_CLIENT === "1";
  const modelSetup = !presentation && (options.modelSetup ?? packaged);
  const dataDirectory = (packaged || !presentation) && process.env.FORME_DESKTOP_DATA_DIR;
  const directory = options.directory || dataDirectory || path.join(projectRoot, presentation ? ".data/folio-demo" : ".data/desktop");
  const port = options.port ?? Number(process.env.FORME_DESKTOP_PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("FORME_DESKTOP_PORT must be between 0 and 65535");
  const lock = await acquireDataLock(directory);
  let service;
  let server;
  let closing = false;
  let closePromise;
  let configuring = false;
  const streams = new Map();
  const sessions = presentation ? createDemoSession() : null;
  const broadcast = () => { for (const stream of streams.keys()) if (!stream.destroyed) stream.write("event: state\ndata: {}\n\n"); };
  try {
  const demoLibrary = presentation ? await loadDemoLibrary() : null;
  const demoCatalog = demoLibrary ? {
    collectionCount: demoLibrary.reduce((count, edition) => count + edition.articles.length, 0),
    exhibitionCount: demoLibrary.length,
  } : null;
  const demoOptions = presentation ? { aiEnabled:false, searchWeb:null, autoCurate:false, seedStarterContent:false, knowledgeEmbedder:null, knowledgeReranker:null } : {};
  const initialize = profile => createDesktopService({
    ...options,
    ...demoOptions,
    ...(profile ? { config: modelConfig(profile), aiEnabled: true } : {}),
    directory,
    demoLibrary,
    onChange: () => { broadcast(); options.onChange?.(); },
  });
  const profile = modelSetup ? await loadModelProfile(directory) : null;
  if (!modelSetup || profile) service = await initialize(profile);
  let origin;
  server = http.createServer(async (req, res) => {
    if (closing) return json(res, 503, { error: "本地服务正在退出，请稍后重试。", code: "SERVICE_STOPPING" });
    // Exact loopback Host also protects the local service from DNS rebinding.
    if (!origin || req.headers.host !== new URL(origin).host) return json(res, 403, { error: "请求地址不受支持。", code: "INVALID_HOST" });
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "不接受其他网站的请求。", code: "INVALID_ORIGIN" });
    if (req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, { error: "不接受跨站请求。", code: "INVALID_ORIGIN" });
    try {
      const url = new URL(req.url, origin);
      const pathname = decodeURIComponent(url.pathname);
      const session = sessions?.current(req);
      if (modelSetup && pathname === "/api/desktop/model-setup") {
        if (req.method === "GET") return json(res, 200, { configured: Boolean(service) });
        if (req.method !== "POST") return json(res, 405, { error: "不支持这个请求。" });
        if (req.headers.origin !== origin) return json(res, 403, { error: "本地操作必须来自当前页面。", code: "INVALID_ORIGIN" });
        if (service || configuring) return json(res, 409, { error: "模型已配置或正在验证。", code: "MODEL_SETUP_CONFLICT" });
        configuring = true;
        try {
          const candidate = await checkModelProfile(await readJSON(req, 8192));
          const next = await initialize(candidate);
          try { await saveModelProfile(directory, candidate); }
          catch (error) { await next.close(); throw error; }
          service = next;
          return json(res, 200, { configured: true });
        } finally { configuring = false; }
      }
      if (sessions && pathname === "/api/desktop/session") {
        if (req.method === "GET") return json(res, 200, { signedIn:Boolean(session), username:demoUsername, password:demoPassword, catalog:demoCatalog });
        if (req.method !== "POST" && req.method !== "DELETE") return json(res, 405, { error:"不支持这个请求。" });
        if (req.headers.origin !== origin) return json(res, 403, { error:"本地操作必须来自当前页面。", code:"INVALID_ORIGIN" });
        if (req.method === "DELETE") {
          sessions.signOut(req, res);
          for (const [stream, token] of streams) if (session && token === session) {
            stream.write("event: signed-out\ndata: {}\n\n"); stream.end();
          }
          return json(res, 200, { signedIn:false });
        }
        const body = await readJSON(req, 4096);
        const next = sessions.signIn(req, res, body);
        return next ? json(res, 200, { signedIn:true, next }) : json(res, 401, { error:"账号或密码不正确。", code:"INVALID_CREDENTIALS" });
      }
      if (url.pathname.startsWith("/api/desktop/")) {
        if (req.method === "GET" && url.pathname === "/api/desktop/health") return json(res, 200, { ok: true });
        if (sessions && !session) return json(res, 401, { error:"请先登录 Folio。", code:"SIGN_IN_REQUIRED" });
        if (!service) return json(res, 409, { error: "请先连接模型。", code: "MODEL_SETUP_REQUIRED" });
        if (["GET", "HEAD"].includes(req.method) && url.pathname.startsWith("/api/desktop/covers/")) {
          const cover = await service.readCover(url.pathname.slice("/api/desktop/covers/".length));
          if (!cover) return json(res, 404, { error: "找不到收藏封面。", code: "NOT_FOUND" });
          res.writeHead(200, { "Content-Type": cover.type, "Content-Length": cover.bytes.length, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
          return res.end(req.method === "GET" ? cover.bytes : undefined);
        }
        if (req.method === "GET" && url.pathname === "/api/desktop/events") {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" });
          res.write(": connected\n\n"); streams.set(res, session);
          req.on("close", () => streams.delete(res));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/desktop/state") return json(res, 200, service.state());
        if (req.method === "GET" && url.pathname === "/api/desktop/harness") return json(res, 200, await service.harness());
        if (req.method === "GET" && url.pathname === "/api/desktop/memories") return json(res, 200, service.memories());
        if (req.method !== "POST" && !(req.method === "PATCH" && url.pathname === "/api/desktop/workspace")) return json(res, 405, { error: "不支持这个请求。", code: "METHOD_NOT_ALLOWED" });
        if (req.headers.origin !== origin) return json(res, 403, { error: "本地操作必须来自当前页面。", code: "INVALID_ORIGIN" });
        const body = await readJSON(req, ["/api/desktop/workspace", "/api/desktop/capture"].includes(url.pathname) ? 10_000_000 : 250000);
        if (closing) return json(res, 503, { error: "本地服务正在退出，请稍后重试。", code: "SERVICE_STOPPING" });
        const routes = {
          "/api/desktop/collection-cover": () => service.setCollectionCover(body),
          "/api/desktop/collection-cover/color": () => service.collectionCoverColor(body),
          "/api/desktop/reading/article": () => service.readingArticle(body),
          "/api/desktop/reading/generate": () => service.readingGenerate(body),
          "/api/desktop/reading/preferences": () => service.readingPreferences(body),
          "/api/desktop/reading/cancel": () => service.readingCancel(body),
          "/api/desktop/knowledge/search": () => service.knowledgeSearch(body),
          "/api/desktop/knowledge/read": () => service.knowledgeRead(body),
          "/api/desktop/knowledge/similar": () => service.knowledgeSimilar(body),
          "/api/desktop/curation/related": () => service.curationRelated(body),
          "/api/desktop/curation/reading": () => service.curationReading(body),
          "/api/desktop/curation/accept-update": () => service.acceptCurationUpdate(body),
          "/api/desktop/knowledge/connections": () => service.knowledgeConnections(body),
          "/api/desktop/page-read": () => service.readPage(body),
          "/api/desktop/pages/resolve": () => service.resolvePage(body),
          "/api/desktop/pages/open": () => service.openPage(body),
          "/api/desktop/pages/source": () => service.pageSource(body),
          "/api/desktop/surfaces/select": () => service.selectSurface(body),
          "/api/desktop/memories": () => service.updateMemory(body),
          "/api/desktop/memories/conversation": () => service.conversationMemory(body),
          "/api/desktop/profile": () => service.profile(body), "/api/desktop/messages": () => service.send(body), "/api/desktop/conversations": () => service.createConversation(body), "/api/desktop/conversations/select": () => service.selectConversation(body), "/api/desktop/retry": () => service.retry(body), "/api/desktop/jobs/retry": () => service.retryJob(body), "/api/desktop/curate": () => service.curate(body), "/api/desktop/notes": () => service.note(body), "/api/desktop/workspace": () => service.workspace(body), "/api/desktop/capture": () => service.capture(body), "/api/desktop/revise": () => service.revise(body), "/api/desktop/refresh-source": () => service.refreshSource(body),
        };
        const route = routes[url.pathname];
        if (!route) return json(res, 404, { error: "没有这个接口。", code: "NOT_FOUND" });
        return json(res, 200, await route());
      }
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "不支持这个请求。" });
      if (modelSetup && !service && isWorkspacePage(pathname)) return redirect(res, "/curator/model-setup.html");
      if (sessions && isWorkspacePage(pathname)) {
        if (!session) return redirect(res, pathname === "/" ? "/login" : `/login?${new URLSearchParams({ next:pathname + url.search })}`);
        if (pathname === "/") return redirect(res, `${demoStage}#gallery`);
      }
      const login = Boolean(sessions && pathname === "/login");
      const assets = pathname.startsWith("/assets/");
      const legacy = pathname.startsWith("/prototype/immersive-exhibition/");
      const vendor = pathname.startsWith("/vendor/ogl/src/");
      const controls = pathname.startsWith("/vendor/basecoat/");
      let root = assets ? assetRoot : uiRoot;
      let relative = login ? "login.html" : assets ? pathname.slice(8) : pathname.replace(/^\/(?:curator\/?)?/, "");
      if (modelSetup && pathname === `/curator/${relative}` && setupFiles.has(relative)) {
        root = setupRoot;
      } else if (legacy) {
        relative = pathname.slice("/prototype/immersive-exhibition/".length);
        if (relative.startsWith("assets/")) {
          root = assetRoot; relative = relative.slice(7);
          if (![".js", ".json", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".woff2", ".woff", ".ttf", ".otf", ".webm", ".mp4", ".m4a"].includes(path.extname(relative))) throw Object.assign(new Error("Not found"), { statusCode: 404 });
          if (path.extname(relative) === ".js" && relative !== "generated/p001-sample-results.js") throw Object.assign(new Error("Not found"), { statusCode: 404 });
        } else {
          root = legacyRoot;
          if (!legacyFiles.has(relative)) throw Object.assign(new Error("Not found"), { statusCode: 404 });
        }
      } else if (controls) {
        root = controlsRoot; relative = pathname.slice("/vendor/basecoat/".length);
        if (!controlsFiles.has(relative)) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      } else if (vendor) {
        root = vendorRoot; relative = pathname.slice("/vendor/ogl/src/".length);
        if (!relative.endsWith(".js")) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      } else if (!assets && !login && pathname !== "/" && !pathname.startsWith("/curator/")) {
        throw Object.assign(new Error("Not found"), { statusCode: 404 });
      }
      if (relative.split(/[\\/]/).some((part) => part.startsWith(".")) || relative.includes("\0")) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      let file = path.resolve(root, relative || "index.html");
      if (!file.startsWith(root + path.sep)) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      const info = await stat(file);
      if (!info.isFile()) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      file = await realpath(file);
      if (!file.startsWith(root + path.sep)) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; media-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      if (req.method === "HEAD") return res.end();
      const stream = createReadStream(file); stream.on("error", () => res.destroy()); stream.pipe(res);
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, error.statusCode || (error.code === "ENOENT" ? 404 : 400), { error: error.code === "ENOENT" ? "页面不存在。" : (error.statusCode ? error.message : "这次操作没有完成，请检查提交内容。"), code: error.code || "REQUEST_FAILED" });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, server,
    get service() { return service; },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const stream of streams.keys()) stream.end();
      streams.clear();
      // Stop accepting requests before flushing so no new POST can write after
      // the final flush or after a replacement process acquires the lock.
      const httpClosed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      closePromise = (async () => {
        const serviceClosed = modelSetup ? httpClosed.finally(() => service?.close()) : service.close();
        const results = await Promise.allSettled([serviceClosed, httpClosed]);
        await lock.release();
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      })();
      return closePromise;
    },
  };
  } catch (error) {
    closing = true;
    for (const stream of streams.keys()) stream.end();
    streams.clear();
    // Closing a partially initialized service still waits for already running
    // state writes; the process owns its lock until all possible writes end.
    try {
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      await service?.close();
    } finally { await lock.release(); }
    throw error;
  }
}

// Atomic rename keeps state.json intact if a provider call outlives this deadline.
// Its persisted running job becomes an interrupted, retryable job on next launch.
export function shutdownWithDeadline(runtime, { timeoutMs = 4000, exit = (code) => process.exit(code) } = {}) {
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true; clearTimeout(timer); exit(code);
  };
  const timer = setTimeout(() => finish(0), timeoutMs);
  Promise.resolve().then(() => runtime.close()).then(() => finish(0), () => finish(1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDesktopServer({ presentation: !process.argv.includes("--personal"), modelSetup: process.argv.includes("--setup-model") || undefined, onEvent: (event) => {
    if (event.type === "exhibition-ready" && typeof event.exhibitionId === "string") console.log(`FORME_DESKTOP_EVENT ${JSON.stringify({ type: event.type, exhibitionId: event.exhibitionId })}`);
  } }).then((runtime) => {
    console.log(`FORME_DESKTOP_READY ${runtime.origin}`);
    let closing = false;
    const close = () => { if (closing) return; closing = true; shutdownWithDeadline(runtime); };
    process.on("SIGTERM", close); process.on("SIGINT", close);
  }).catch((error) => { console.error(`FORME_DESKTOP_ERROR ${error.code === "DATA_DIRECTORY_LOCKED" ? error.message : "本地服务未能启动，请检查资料目录和配置。"}`); process.exitCode = 1; });
}
