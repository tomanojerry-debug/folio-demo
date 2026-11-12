import { createHash } from "node:crypto";
import { fault } from "./errors.mjs";
import { sharedStateConfigured, stateCommand } from "./state-client.mjs";

const local = new Map();
const script = `local n=tonumber(redis.call('GET',KEYS[1]) or '0'); if n+tonumber(ARGV[1])>tonumber(ARGV[2]) then return 0 end; redis.call('INCRBY',KEYS[1],ARGV[1]); redis.call('EXPIRE',KEYS[1],ARGV[3]); return 1`;
// Atomic shared quotas in production; local memory only for local development.
async function consume(key, cost, limit, ttl) {
  if (!sharedStateConfigured()) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") throw fault("QUOTA_NOT_CONFIGURED", 503);
    const now = Date.now();
    for (const [k, v] of local) if (v.exp < now) local.delete(k);
    const entry = local.get(key) || { count: 0, exp: now + ttl * 1000 };
    if (entry.count + cost > limit) throw fault("RATE_LIMITED", 429);
    entry.count += cost; local.set(key, entry); return;
  }
  try {
    const result = await stateCommand(["EVAL", script, "1", key, String(cost), String(limit), String(ttl)]);
    if (![0, 1].includes(result)) throw fault("QUOTA_UNAVAILABLE", 503);
    if (result === 0) throw fault("RATE_LIMITED", 429);
  } catch (error) { throw error.code === "RATE_LIMITED" ? error : fault("QUOTA_UNAVAILABLE", 503); }
}
export async function quota(req, cost = 1) {
  // Vercel replaces this header. Never trust arbitrary forwarded headers locally.
  const ip = process.env.VERCEL ? req.headers["x-vercel-forwarded-for"] || "unknown" : req.socket?.remoteAddress || "local";
  const hash = createHash("sha256").update(String(ip)).digest("hex").slice(0, 24);
  const day = Math.floor(Date.now() / 86400000);
  const minute = Math.floor(Date.now() / 60000);
  await consume(`forme:minute:${hash}:${minute}`, cost, 12, 120);
  await consume(`forme:visitor:${hash}:${day}`, cost, Number(process.env.FORME_VISITOR_DAILY_LIMIT) || 30, 172800);
  await consume(`forme:global:${day}`, cost, Number(process.env.FORME_DAILY_LIMIT) || 100, 172800);
}
