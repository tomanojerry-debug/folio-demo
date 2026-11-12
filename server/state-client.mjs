import { fault } from "./errors.mjs";
import { workerRequest } from "./worker-client.mjs";
export function sharedStateConfigured() {
  return Boolean((process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) || (process.env.FORME_WORKER_URL && process.env.FORME_WORKER_TOKEN));
}
export async function stateCommand(command) {
  if (!process.env.UPSTASH_REDIS_REST_URL) {
    try { return (await workerRequest("/state", { command })).result; } catch { throw fault("QUOTA_UNAVAILABLE", 503); }
  }
  try {
    const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, { method: "POST", headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error();
    return data.result;
  } catch { throw fault("QUOTA_UNAVAILABLE", 503); }
}
