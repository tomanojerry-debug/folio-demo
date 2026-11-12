import { createHash } from "node:crypto";
import { fault } from "./errors.mjs";
import { sharedStateConfigured, stateCommand as redis } from "./state-client.mjs";
const local = new Map();
export async function claim(sessionId, action, body, { prefix = "forme", command } = {}) {
  if (!/^[a-z0-9-]{16,80}$/i.test(body.requestId || "")) throw fault("INVALID_REQUEST");
  const key = `${prefix}:request:${sessionId}:${action}:${body.requestId}`;
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const shared = Boolean(command) || sharedStateConfigured();
  const execute = command || redis;
  if (!shared && (process.env.VERCEL || process.env.NODE_ENV === "production")) throw fault("QUOTA_NOT_CONFIGURED", 503);
  const pending = { fingerprint, status: "pending" };
  let existing;
  if (shared) {
    const acquired = await execute(["SET", key, JSON.stringify(pending), "NX", "EX", 240]);
    if (!acquired) { const raw = await execute(["GET", key]); if (!raw) throw fault("REQUEST_RUNNING", 409); existing = JSON.parse(raw); }
  } else {
    for (const [k, v] of local) if (v.exp < Date.now()) local.delete(k);
    existing = local.get(key);
    if (!existing) local.set(key, { ...pending, exp: Date.now() + 240000 });
  }
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw fault("INVALID_REQUEST", 409);
    if (existing.status === "pending") throw fault("REQUEST_RUNNING", 409);
    return { cached: existing.data };
  }
  return {
    async complete(data) {
      const result = { fingerprint, status: "complete", data };
      if (shared) await execute(["SET", key, JSON.stringify(result), "EX", 86400]);
      else local.set(key, { ...result, exp: Date.now() + 86400000 });
    },
    async fail() { if (shared) await execute(["DEL", key]); else local.delete(key); },
  };
}
