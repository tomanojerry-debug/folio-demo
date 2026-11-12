import { fault } from "../errors.mjs";

export async function postModelJson(url, key, body, { signal, timeoutMs = 60_000 } = {}) {
  signal?.throwIfAborted();
  const timer = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timer]) : timer;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
      redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429) throw fault("MODEL_RATE_LIMITED", 429);
      throw fault("MODEL_PROVIDER_ERROR", 502);
    }
    const data = await response.json();
    requestSignal.throwIfAborted();
    return data;
  } catch (error) {
    signal?.throwIfAborted();
    if (timer.aborted || error?.name === "TimeoutError") throw fault("MODEL_TIMEOUT", 504);
    if (["MODEL_RATE_LIMITED", "MODEL_PROVIDER_ERROR"].includes(error?.code)) throw error;
    if (error instanceof SyntaxError) throw fault("MODEL_OUTPUT_INVALID", 502);
    throw fault("MODEL_PROVIDER_ERROR", 502);
  }
}
