import { randomUUID } from "node:crypto";
import { visionCredential } from "./ai/config.mjs";
import { ingest, revise, platform, discover, curate, evaluate } from "./pipeline.mjs";
import { session, newSession, sign, verify } from "./receipts.mjs";
import { quota } from "./quota.mjs";
import { messages, fault } from "./errors.mjs";
import { startWorker, pollWorker } from "./worker-client.mjs";
import { claim } from "./idempotency.mjs";
import { sharedStateConfigured } from "./state-client.mjs";

export async function readBody(req) {
  if (req.body !== undefined) {
    const value = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(value) > 3_500_000) throw fault("BODY_TOO_LARGE", 413);
    try { return JSON.parse(value); } catch { throw fault("INVALID_REQUEST"); }
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 3_500_000) throw fault("BODY_TOO_LARGE", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fault("INVALID_REQUEST"); }
}
export function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(data));
}
function sameOrigin(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") throw fault("INVALID_REQUEST", 403);
  if (req.headers.origin) {
    const origin = new URL(req.headers.origin);
    if (origin.host !== req.headers.host) throw fault("INVALID_REQUEST", 403);
  }
}
export function createHandler(deps = {}) {
  return async function handler(req, res) {
    const traceId = randomUUID();
    let reservation;
    try {
      const action = new URL(req.url, "http://localhost").searchParams.get("action") || "session";
      sameOrigin(req);
      if (action === "session" && req.method === "GET") {
        const quotaReady = !(process.env.VERCEL || process.env.NODE_ENV === "production") || sharedStateConfigured();
        const configured = Boolean(process.env.FORME_SESSION_SECRET?.length >= 32 && process.env.ZHIPU_CODING_API_KEY && quotaReady);
        if (!configured) return send(res, 200, { enabled: false, account: "Folio 展示账号", message: messages.SERVICE_NOT_CONFIGURED });
        const auth = session(req) || newSession();
        const secure = process.env.VERCEL || process.env.NODE_ENV === "production";
        res.setHeader("Set-Cookie", `forme_session=${auth.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? "; Secure" : ""}`);
        return send(res, 200, { enabled: true, account: "Folio 展示账号", csrf: sign(auth.id, "csrf", 86400), worker: Boolean(process.env.FORME_WORKER_URL), vision: Boolean(visionCredential()), storage: "browser" });
      }
      if (req.method !== "POST" || !["ingest", "revise", "worker-status", "worker-result", "themes", "curate", "evaluate"].includes(action)) throw fault("INVALID_REQUEST", 404);
      const auth = session(req);
      if (!auth || verify(req.headers["x-forme-csrf"], "csrf") !== auth.id) throw fault("REQUEST_EXPIRED", 401);
      if (!(req.headers["content-type"] || "").startsWith("application/json")) throw fault("INVALID_REQUEST", 415);
      const body = await readBody(req);
      if (!body || Array.isArray(body) || typeof body !== "object") throw fault("INVALID_REQUEST");
      if (action !== "worker-status") {
        reservation = await claim(auth.id, action, body);
        if (reservation.cached) return send(res, 200, reservation.cached);
      }
      if (action !== "worker-status") await (deps.quota || quota)(req, body.mode === "image" ? 2 : 1);
      let data;
      if (action === "ingest") {
        if (!["text", "link", "image"].includes(body.mode)) throw fault("INVALID_REQUEST");
        if (body.mode === "link" && platform(body.content) !== "generic") data = await startWorker(body.content, auth.id);
        else data = await (deps.ingest || ingest)(body);
      } else if (action === "worker-status" || action === "worker-result") {
        const job = await pollWorker(body.job, auth.id);
        if (job.status === "failed") throw fault(job.error || "NEEDS_INPUT", 422);
        if (action === "worker-result" && job.status !== "complete") throw fault("REQUEST_RUNNING", 409);
        if (action === "worker-result") data = await ingest({ ...job.result, mode: "parsed" }, { trustedWorker: true });
        else data = { status: job.status, stage: job.stage };
      } else if (action === "revise") data = await revise(body.receipt, body.correction);
      else if (action === "themes") data = await discover(body.receipts);
      else if (action === "curate") data = await curate(body.receipt);
      else data = await evaluate(body.receipt);
      const result = { ...data, traceId };
      if (reservation?.complete) await reservation.complete(result);
      send(res, 200, result);
    } catch (error) {
      if (reservation?.fail) { try { await reservation.fail(); } catch {} }
      const code = error.name === "TimeoutError" || error.name === "AbortError" ? "PROCESSING_TIMEOUT" : error.code || "INTERNAL_ERROR";
      // No source text, model output, URLs with tokens or secrets in logs/errors.
      console.warn(JSON.stringify({ traceId, code }));
      send(res, error.statusCode || (code === "PROCESSING_TIMEOUT" ? 504 : 500), { error: code, message: messages[code] || "处理暂时失败，请稍后重试。", traceId });
    }
  };
}
export default createHandler();
