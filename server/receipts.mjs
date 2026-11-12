import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { fault } from "./errors.mjs";

function secret() {
  const value = process.env.FORME_SESSION_SECRET;
  if (!value || value.length < 32) throw fault("SERVICE_NOT_CONFIGURED", 503);
  return value;
}
export function sign(value, purpose, ttl = 30 * 86400, signingSecret = secret()) {
  const body = Buffer.from(JSON.stringify({ purpose, value, exp: Math.floor(Date.now() / 1000) + ttl })).toString("base64url");
  return `${body}.${createHmac("sha256", signingSecret).update(body).digest("base64url")}`;
}
export function verify(token, purpose, signingSecret) {
  if (typeof token !== "string" || token.length > 1_500_000) throw fault("RECEIPT_INVALID", 401);
  const [body, signature, extra] = token.split(".");
  const expected = createHmac("sha256", signingSecret ?? secret()).update(body || "").digest();
  const actual = Buffer.from(signature || "", "base64url");
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fault("RECEIPT_INVALID", 401);
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { throw fault("RECEIPT_INVALID", 401); }
  if (payload.purpose !== purpose || payload.exp < Date.now() / 1000) throw fault("RECEIPT_INVALID", 401);
  return payload.value;
}
export function session(req) {
  const token = /(?:^|;\s*)forme_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  try { return { id: verify(token, "session"), token }; } catch { return null; }
}
export function newSession() {
  const id = randomUUID();
  return { id, token: sign(id, "session", 86400) };
}
