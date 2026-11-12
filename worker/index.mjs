import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { collect } from "./adapters.mjs";
import { platform } from "../server/pipeline.mjs";
import { send } from "../server/handler.mjs";
import { createLedger } from "./state.mjs";
const token = process.env.FORME_WORKER_TOKEN;
if (!token || token.length < 32) throw new Error("FORME_WORKER_TOKEN must contain at least 32 characters");
const root = path.resolve(process.env.FORME_WORKER_DATA || ".data/worker");
await mkdir(root, { recursive: true, mode: 0o700 });
const stateCommand = await createLedger(root);
const jobs = new Map(); const pending = []; let running = false;
async function save(job) { const file = path.join(root, `${job.id}.json`); await writeFile(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 }); await rename(`${file}.tmp`, file); }
for (const file of await readdir(root)) {
  if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
  try {
    const job = JSON.parse(await readFile(path.join(root, file), "utf8"));
    if (Date.now() - job.createdAt > 86400000) { await rm(path.join(root, file)); continue; }
    if (job.status === "processing") { job.status = "failed"; job.error = "PROCESSING_TIMEOUT"; await save(job); }
    jobs.set(job.id, job);
  } catch {}
}
async function drain() {
  if (running) return; running = true;
  try { while (pending.length) {
    const { job, url } = pending.shift(); const dir = path.join(root, job.id);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      job.result = await collect(url, dir, (stage) => { job.stage = stage; });
      job.status = "complete"; job.stage = "complete";
    } catch (error) { job.status = "failed"; job.error = error.code || "NEEDS_INPUT"; }
    try { await save(job); }
    catch { job.status = "failed"; job.error = "WORKER_UNAVAILABLE"; console.warn("Worker result persistence failed"); }
    await rm(dir, { recursive: true, force: true }).catch(() => console.warn("Worker temporary cleanup failed"));
  } } finally { running = false; }
}
http.createServer(async (req, res) => {
  try {
    const actual = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") || ""), expected = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, { error: "UNAUTHORIZED" });
    if (req.method === "POST" && req.url === "/state") {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 1_500_000) return send(res, 413, { error: "BODY_TOO_LARGE" }); }
      const { command } = JSON.parse(raw);
      if (!Array.isArray(command)) return send(res, 400, { error: "INVALID_REQUEST" });
      return send(res, 200, { result: await stateCommand(command) });
    }
    const id = /^\/jobs\/([a-f0-9-]{36})$/.exec(req.url)?.[1];
    if (req.method === "GET" && id) {
      const job = jobs.get(id);
      return send(res, job ? 200 : 404, job || { error: "NOT_FOUND" });
    }
    if (req.method !== "POST" || req.url !== "/jobs") return send(res, 404, { error: "NOT_FOUND" });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, { error: "BODY_TOO_LARGE" }); }
    const input = JSON.parse(raw);
    const source = platform(input.url);
    if (!["youtube", "xiaohongshu"].includes(source)) return send(res, 400, { error: "INVALID_REQUEST" });
    if (source === "youtube" && process.env.FORME_YOUTUBE_ENABLED === "false") return send(res, 503, { error: "YOUTUBE_NOT_READY" });
    if (source === "xiaohongshu" && process.env.FORME_XHS_ENABLED === "false") return send(res, 503, { error: "XHS_NOT_READY" });
    if (pending.length >= 3) return send(res, 429, { error: "RATE_LIMITED" });
    for (const [key, value] of jobs) if (Date.now() - value.createdAt > 86400000) { jobs.delete(key); await rm(path.join(root, `${key}.json`), { force: true }); }
    const job = { id: randomUUID(), status: "processing", stage: "queued", createdAt: Date.now() };
    jobs.set(job.id, job); await save(job); pending.push({ job, url: input.url }); void drain();
    return send(res, 202, { id: job.id, status: job.status, stage: job.stage });
  } catch { return send(res, 400, { error: "INVALID_REQUEST" }); }
}).listen(Number(process.env.WORKER_PORT || 8790), process.env.WORKER_HOST || "127.0.0.1", () => console.log("FORME ingestion worker started"));
