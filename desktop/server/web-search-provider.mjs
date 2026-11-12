const officialSearchEndpoints = new Set([
  "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
  "https://api.z.ai/api/mcp/web_search_prime/mcp",
]);
const maxResponseBytes = 1_048_576;
const maxCandidates = 30;
const recencyOptions = new Set(["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"]);
const protocolVersions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

function searchError(code = "WEB_SEARCH_PROVIDER_ERROR") {
  return Object.assign(new Error("Web search provider request failed"), { code });
}

function parseJSON(raw) {
  try { return JSON.parse(raw); }
  catch { throw searchError(); }
}

function rpcResult(message, id) {
  if (message?.jsonrpc !== "2.0" || message.id !== id || message.error || !Object.hasOwn(message, "result")) {
    throw searchError();
  }
  return message.result;
}

// Stop reading an SSE response at the matching JSON-RPC reply. The server can
// keep a stream open after it has delivered the result.
async function readReply(response, id, signal) {
  const length = Number(response.headers.get("content-length"));
  if (length > maxResponseBytes || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw searchError();
  }
  const stream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw searchError();
      pending += decoder.decode(value, { stream:true });
      if (!stream) continue;
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/u.exec(pending))) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r\n|\r|\n/u)
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /u, "")).join("\n");
        if (!data) continue;
        const message = parseJSON(data);
        if (message?.id === id) return rpcResult(message, id);
      }
    }
    if (!stream) return rpcResult(parseJSON(pending + decoder.decode()), id);
    throw searchError();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function boundedText(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, limit) : "";
}

function candidate(item) {
  const title = boundedText(item?.title, 240);
  const url = typeof item?.link === "string" ? item.link.trim() : "";
  if (!title || !url || url.length > 2048) return null;
  let address;
  try { address = new URL(url); } catch { return null; }
  if (!["https:", "http:"].includes(address.protocol) || address.username || address.password) return null;
  return {
    title,
    url:address.href,
    snippet:boundedText(item.content, 800),
    source:boundedText(item.media, 100) || address.hostname,
    publishedAt:boundedText(item.publish_date, 80),
  };
}

function extractRows(result) {
  if (!result || result.isError) throw searchError();
  const structured = result.structuredContent?.search_result;
  if (Array.isArray(structured)) return structured;
  const rows = [];
  let decoded = false;
  for (const block of result.content || []) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    // The Coding Plan endpoint currently wraps its JSON result in a JSON string.
    let payload = parseJSON(block.text);
    if (typeof payload === "string") payload = parseJSON(payload);
    if (Array.isArray(payload)) rows.push(...payload);
    else if (Array.isArray(payload?.search_result)) rows.push(...payload.search_result);
    else if (typeof payload?.link === "string") rows.push(payload);
    else continue;
    decoded = true;
  }
  if (!decoded) throw searchError();
  return rows;
}

/** Return ranked provider candidates. The caller owns filtering and presentation. */
export function createWebSearchProvider(config, { fetch:fetchImpl = globalThis.fetch } = {}) {
  const endpoint = config?.webSearchMcpUrl;
  const key = config?.webSearchApiKey;
  if (!key || key === config.zhipuApiKey || !officialSearchEndpoints.has(endpoint)) return null;
  const timeoutMs = Math.min(config.timeoutMs || 20000, 20000);
  return async ({ query, recency, signal }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = {
      Authorization:`Bearer ${key}`,
      "Content-Type":"application/json",
      Accept:"application/json, text/event-stream",
    };
    const options = { method:"POST", redirect:"error", signal:requestSignal };
    async function send(method, params, id) {
      const payload = { jsonrpc:"2.0", ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) };
      const response = await fetchImpl(endpoint, { ...options, headers:{ ...headers }, body:JSON.stringify(payload) });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status)) throw searchError("WEB_SEARCH_AUTH");
        throw searchError(response.status === 429 ? "WEB_SEARCH_RATE_LIMITED" : undefined);
      }
      if (method === "initialize") {
        const session = response.headers.get("mcp-session-id");
        if (session && /^[!-~]{1,256}$/u.test(session)) headers["Mcp-Session-Id"] = session;
      }
      if (id === undefined) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      return readReply(response, id, requestSignal);
    }

    try {
      const initialized = await send("initialize", {
        protocolVersion:"2025-03-26", capabilities:{}, clientInfo:{ name:"Folio", version:"1.0.0" },
      }, 1);
      if (!protocolVersions.has(initialized?.protocolVersion)) throw searchError();
      headers["MCP-Protocol-Version"] = initialized.protocolVersion;
      await send("notifications/initialized");
      const result = await send("tools/call", {
        name:"web_search_prime",
        arguments:{
          search_query:query,
          search_recency_filter:recencyOptions.has(recency) ? recency : "noLimit",
          content_size:"medium",
        },
      }, 2);
      return extractRows(result).map(candidate).filter(Boolean).slice(0, maxCandidates);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (timeout.aborted) throw searchError("WEB_SEARCH_TIMEOUT");
      throw error?.code?.startsWith("WEB_SEARCH_") ? error : searchError();
    } finally {
      if (headers["Mcp-Session-Id"] && !requestSignal.aborted) {
        // Cleanup is best effort and never delays the search response.
        const cleanup = { ...options, method:"DELETE", headers:{ ...headers }, signal:AbortSignal.timeout(2000) };
        void Promise.resolve().then(() => fetchImpl(endpoint, cleanup)).then(response => response.body?.cancel()).catch(() => {});
      }
    }
  };
}
