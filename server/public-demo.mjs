import { randomUUID } from "node:crypto";
import { loadConfig } from "./ai/config.mjs";
import { fault, messages } from "./errors.mjs";
import { claim } from "./idempotency.mjs";
import { ingest, model } from "./pipeline.mjs";
import { publicDemoQuota } from "./quota.mjs";
import { sign, verify } from "./receipts.mjs";
import { workerRequest } from "./worker-client.mjs";

export const publicDemoSample = Object.freeze({
  id: "folio-first-collection",
  title: "同一条路的两种声音",
  text: "我沿同一条河岸走了两次。清晨，脚步和鸟鸣断断续续，录音里留着不少空白。傍晚，桥上的车声持续不断，水声几乎听不见。剪辑时，我保留清晨的停顿，让观众有时间看水面；进入傍晚镜头前，我先放进一小段车声，画面还没切换，听觉已经抵达下一处。两段画面拍的是同一条路，声音却让它们有了不同的节奏。",
});

const sessionTtl = 86400;
const cookieName = "folio_public_session";
const account = "Folio 在线体验";

export function loadPublicDemoConfig(env = process.env) {
  const sessionSecret = env.FOLIO_PUBLIC_SESSION_SECRET?.trim();
  const workerKey = env.FOLIO_PUBLIC_WORKER_TOKEN?.trim();
  const workerBase = env.FOLIO_PUBLIC_WORKER_URL?.trim();
  const dailyLimit = Number(env.FOLIO_PUBLIC_DAILY_LIMIT || "30");
  if (!sessionSecret || sessionSecret.length < 32 || !workerKey || workerKey.length < 32 || !workerBase) return null;
  if (sessionSecret === workerKey || sessionSecret === env.FORME_SESSION_SECRET?.trim() || workerKey === env.FORME_WORKER_TOKEN?.trim()) return null;
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 30) return null;
  let url;
  try { url = new URL(workerBase); } catch { return null; }
  const secure = env.NODE_ENV === "production";
  if (secure && env.FOLIO_PUBLIC_TRUST_LOOPBACK_PROXY !== "1") return null;
  if (env.VERCEL || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "8791" || url.pathname !== "/") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const modelConfig = loadConfig({
    ZHIPU_CODING_API_KEY: env.FOLIO_PUBLIC_MODEL_API_KEY,
    ZHIPU_TEXT_MODEL: env.FOLIO_PUBLIC_TEXT_MODEL,
    ZHIPU_REASONING_EFFORT: "low",
    AI_TEXT_MAX_TOKENS: "3072",
    AI_REQUEST_TIMEOUT_MS: "45000",
    KNOWLEDGE_EMBEDDING_BACKEND: "disabled",
  });
  if (!modelConfig.zhipuApiKey || modelConfig.zhipuApiKey === env.ZHIPU_CODING_API_KEY?.trim()) return null;
  return { dailyLimit, modelConfig, secure, sessionSecret, worker: { base: url.href, key: workerKey } };
}

function currentVisitor(req, config) {
  const cookie = /(?:^|;\s*)folio_public_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  if (!cookie || cookie.length > 1024) return null;
  try { return verify(cookie, "public-session", config.sessionSecret); } catch { return null; }
}

export function publicDemoSession(req, res, config, apiPath = "/api/forme") {
  const capabilities = { publicDemo: true, mode: "sample", sampleId: publicDemoSample.id, worker: false, vision: false };
  if (!config) return { enabled: false, account, message: messages.SERVICE_NOT_CONFIGURED, ...capabilities };
  const visitor = currentVisitor(req, config) || randomUUID();
  const cookie = sign(visitor, "public-session", sessionTtl, config.sessionSecret);
  res.setHeader("Set-Cookie", `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=${apiPath}; Max-Age=${sessionTtl}${config.secure ? "; Secure" : ""}`);
  return { enabled: true, account, csrf: sign(visitor, "public-csrf", sessionTtl, config.sessionSecret), ...capabilities };
}

export function authorizePublicDemo(req, config) {
  if (!config) throw fault("SERVICE_NOT_CONFIGURED", 503);
  if (!req.headers.origin || (config.secure && !req.headers.origin.startsWith("https://"))) throw fault("INVALID_REQUEST", 403);
  const visitor = currentVisitor(req, config);
  const csrf = req.headers["x-forme-csrf"];
  if (!visitor || typeof csrf !== "string" || csrf.length > 1024) throw fault("REQUEST_EXPIRED", 401);
  try { if (verify(csrf, "public-csrf", config.sessionSecret) === visitor) return visitor; } catch {}
  throw fault("REQUEST_EXPIRED", 401);
}

export async function runPublicDemo(req, config, visitor, body) {
  const allowed = ["mode", "content", "sampleId", "requestId"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))
    || body.mode !== "text" || body.sampleId !== publicDemoSample.id || body.content !== publicDemoSample.text
    || typeof body.requestId !== "string" || !/^[a-z0-9-]{16,80}$/i.test(body.requestId)) throw fault("INVALID_REQUEST");

  const command = async (args) => {
    try { return (await workerRequest("/state", { command: args }, config.worker)).result; }
    catch { throw fault("QUOTA_UNAVAILABLE", 503); }
  };
  const day = Math.floor(Date.now() / 86400000);
  const sampleRequest = { mode: "text", content: publicDemoSample.text, title: publicDemoSample.title, requestId: `public-sample-${day}` };
  const reservation = await claim(visitor, "ingest", sampleRequest, { prefix: "forme:public", command });
  if (reservation.cached) return reservation.cached;

  let result;
  try {
    await publicDemoQuota(req, day, { ...config, command });
    const call = (callId, context) => model(callId, context, { config: config.modelConfig });
    result = await ingest(sampleRequest, { model: call, issueReceipt: false });
    await reservation.complete(result);
    return result;
  } catch (error) {
    // Keep the pending lease if the model completed but caching its result failed.
    if (!result) await reservation.fail().catch(() => {});
    throw error;
  }
}
