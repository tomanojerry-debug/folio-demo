import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./handler.mjs";
const root = fileURLToPath(new URL("../site/", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".woff2": "font/woff2" };
http.createServer(async (req, res) => {
  if (req.url.split("?")[0] === "/api/forme") return handler(req, res);
  try {
    const url = new URL(req.url, "http://localhost");
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`, url.pathname.endsWith("/") ? "index.html" : "");
    if (!file.startsWith(root) || path.relative(root, file).split(path.sep).some((s) => s.startsWith("."))) throw new Error();
    const info = await stat(file); if (!info.isFile()) throw new Error();
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end) { res.writeHead(416); res.end(); return; }
    res.writeHead(range ? 206 : 200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Content-Length": end - start + 1, "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}) });
    createReadStream(file, { start, end }).pipe(res);
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(Number(process.env.PORT || 4176), "127.0.0.1", () => console.log(`FORME http://127.0.0.1:${process.env.PORT || 4176}`));
