import { fault } from "./errors.mjs";
import { sign, verify } from "./receipts.mjs";
export async function workerRequest(route, body) {
  const base = process.env.FORME_WORKER_URL;
  const key = process.env.FORME_WORKER_TOKEN;
  if (!base || !key) throw fault("WORKER_NOT_CONFIGURED", 503);
  const url = new URL(base);
  if (url.protocol !== "https:" && !(["127.0.0.1", "localhost"].includes(url.hostname) && !process.env.VERCEL)) throw fault("WORKER_NOT_CONFIGURED", 503);
  try {
    const target = new URL(route.replace(/^\//, ""), `${url.href.replace(/\/$/, "")}/`);
    const response = await fetch(target, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000), redirect: "error" });
    const data = await response.json();
    if (!response.ok) throw fault(data.error || "WORKER_UNAVAILABLE", response.status);
    return data;
  } catch (error) { throw error.statusCode ? error : fault("WORKER_UNAVAILABLE", 503); }
}
export async function startWorker(url, sessionId) {
  const job = await workerRequest("/jobs", { url });
  return { status: "processing", job: sign({ id: job.id, sessionId }, "worker-job", 86400), stage: job.stage };
}
export async function pollWorker(token, sessionId) {
  const job = verify(token, "worker-job");
  if (job.sessionId !== sessionId || !/^[a-f0-9-]{36}$/.test(job.id)) throw fault("RECEIPT_INVALID", 401);
  return workerRequest(`/jobs/${job.id}`);
}
