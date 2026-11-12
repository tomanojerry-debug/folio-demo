import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "./handler.mjs";

const assets = new Map([
  ["/try/", ["/try/index.html", "text/html; charset=utf-8"]],
  ["/try/app.js", ["/try/app.js", "text/javascript; charset=utf-8"]],
  ["/try/styles.css", ["/try/styles.css", "text/css; charset=utf-8"]],
  ["/curator/ink-avatar.svg", ["/curator/ink-avatar.svg", "image/svg+xml"]],
]);
for (const item of ["spirited-away-one-summers-day", "chainsaw-kick-back", "frieren-anytime-anywhere", "abyss-faith", "bebop-tank"]) {
  const asset = `/curator/assets/demo-art/anime-music-${item}.png`;
  assets.set(asset, [asset, "image/png"]);
}

export function createPublicHttpServer(basePath = "/folio-demo") {
  if (basePath && !/^\/[a-z][a-z0-9-]{0,63}$/.test(basePath)) throw new Error("Invalid FOLIO_PUBLIC_BASE_PATH");
  const apiPath = `${basePath}/api/forme`;
  const handler = createHandler({ publicApiPath: apiPath });
  return http.createServer(async (req, res) => {
    const requestPath = URL.parse(req.url, "http://localhost")?.pathname;
    if (!requestPath) { res.writeHead(404).end(); return; }
    if (requestPath === apiPath) return handler(req, res);
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(404).end(); return; }
    if ([basePath, `${basePath}/`, `${basePath}/try`].includes(requestPath)) {
      res.writeHead(308, { Location: `${basePath}/try/` }).end();
      return;
    }
    const asset = requestPath.startsWith(`${basePath}/`) && assets.get(requestPath.slice(basePath.length));
    if (!asset) { res.writeHead(404).end(); return; }
    const [file, contentType] = asset;
    try {
      const data = await readFile(new URL(`../site${file}`, import.meta.url));
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": data.length,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      }).end(req.method === "HEAD" ? undefined : data);
    } catch { res.writeHead(404).end(); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPublicHttpServer(process.env.FOLIO_PUBLIC_BASE_PATH ?? "/folio-demo");
  server.listen(Number(process.env.PORT || 4186), "127.0.0.1");
}
