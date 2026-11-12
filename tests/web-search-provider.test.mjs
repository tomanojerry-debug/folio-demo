import test from "node:test";
import assert from "node:assert/strict";
import { createWebSearchProvider } from "../desktop/server/web-search-provider.mjs";
import { loadConfig } from "../server/ai/config.mjs";

const chinaEndpoint = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
const globalEndpoint = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const config = loadConfig({
  ZHIPU_CODING_API_KEY:"fixture-text-key",
  ZHIPU_WEB_SEARCH_API_KEY:"fixture-search-key",
  ZHIPU_WEB_SEARCH_MCP_URL:chinaEndpoint,
});
const json = (id, result, headers) => Response.json({ jsonrpc:"2.0", id, result }, { headers });
const tool = rows => ({
  isError:false,
  content:[{ type:"text", text:JSON.stringify(JSON.stringify(rows)) }],
});

function fixture({ endpoint = chinaEndpoint, output = () => json(2, tool([])) } = {}) {
  const requests = [];
  const search = createWebSearchProvider({ ...config, webSearchMcpUrl:endpoint }, {
    async fetch(url, request) {
      const payload = request.body ? JSON.parse(request.body) : undefined;
      requests.push({ url, request, payload });
      if (request.method === "DELETE") return new Response(null, { status:200 });
      if (payload.method === "initialize") {
        return json(1, { protocolVersion:"2024-11-05" }, { "Mcp-Session-Id":"session-fixture" });
      }
      if (payload.method === "notifications/initialized") return new Response(null, { status:202 });
      return output();
    },
  });
  return { requests, search };
}

test("official Coding Plan handshake carries the negotiated version and sends only the scoped query", async () => {
  const { requests, search } = fixture();
  assert.deepEqual(await search({ query:"今天 AI 模型发布", recency:"oneDay" }), []);
  assert.deepEqual(requests.map(row => row.payload?.method ?? row.request.method), [
    "initialize", "notifications/initialized", "tools/call", "DELETE",
  ]);
  for (const { url, request } of requests) {
    assert.equal(url, chinaEndpoint);
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.Authorization, "Bearer fixture-search-key");
  }
  assert.equal(requests[0].request.headers["Mcp-Session-Id"], undefined);
  for (const { request } of requests.slice(1)) {
    assert.equal(request.headers["Mcp-Session-Id"], "session-fixture");
    assert.equal(request.headers["MCP-Protocol-Version"], "2024-11-05");
  }
  assert.deepEqual(requests[2].payload.params, {
    name:"web_search_prime",
    arguments:{ search_query:"今天 AI 模型发布", search_recency_filter:"oneDay", content_size:"medium" },
  });
});

test("a live-shaped chunked SSE result preserves rank and date metadata and rejects unsafe links", async () => {
  let canceled = false;
  const result = tool([
    { title:"  第一条  ", link:"https://official.example/release", content:"片段  A", publish_date:"2026-11-12" },
    { title:"拒绝", link:"javascript:alert(1)" },
    { title:"拒绝", link:"https://user:secret@official.example/release" },
    { title:"第二条", link:"https://news.example/item", media:"示例新闻" },
  ]);
  const { requests, search } = fixture({
    endpoint:globalEndpoint,
    output() {
      const encode = value => new TextEncoder().encode(value);
      const notification = JSON.stringify({ jsonrpc:"2.0", method:"notifications/message" });
      const reply = JSON.stringify({ jsonrpc:"2.0", id:2, result });
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encode(`: ping\r\n\r\ndata: ${notification}\r\n\r\nevent: message\r\nda`));
          controller.enqueue(encode(`ta: ${reply}\r\n\r\n`));
        },
        cancel() { canceled = true; },
      });
      return new Response(body, { headers:{ "content-type":"text/event-stream;charset=UTF-8" } });
    },
  });
  assert.deepEqual(await search({ query:"模型发布" }), [
    { title:"第一条", url:"https://official.example/release", snippet:"片段 A", source:"official.example", publishedAt:"2026-11-12" },
    { title:"第二条", url:"https://news.example/item", snippet:"", source:"示例新闻", publishedAt:"" },
  ]);
  assert.equal(canceled, true);
  assert.ok(requests.every(row => row.url === globalEndpoint));
  assert.equal(requests[2].payload.params.arguments.search_recency_filter, "noLimit");
});

test("provider distinguishes a bad response or provider rate limit from empty results", async () => {
  for (const [output, code] of [
    [() => json(2, { isError:true, content:[] }), "WEB_SEARCH_PROVIDER_ERROR"],
    [() => json(2, { isError:false, content:[{ type:"text", text:"unstructured provider error" }] }), "WEB_SEARCH_PROVIDER_ERROR"],
    [() => new Response("fixture error", { status:429 }), "WEB_SEARCH_RATE_LIMITED"],
  ]) {
    const { search } = fixture({ output });
    await assert.rejects(search({ query:"模型发布" }), { code });
  }
});

test("web search requires both its own key and an exact official search endpoint", () => {
  assert.equal(createWebSearchProvider(loadConfig({ ZHIPU_CODING_API_KEY:"fixture-text-key" })), null);
  assert.equal(createWebSearchProvider({ ...config, webSearchApiKey:"" }), null);
  assert.equal(createWebSearchProvider({ ...config, webSearchMcpUrl:"" }), null);
  assert.equal(createWebSearchProvider({ ...config, webSearchApiKey:config.zhipuApiKey }), null);
  for (const endpoint of ["https://proxy.example/api", "https://open.bigmodel.cn.evil.example/api", "https://open.bigmodel.cn/api/paas/v4", `${chinaEndpoint}?query=bad`]) {
    assert.equal(createWebSearchProvider({ ...config, webSearchMcpUrl:endpoint }), null);
  }
});

test("provider bounds streamed responses and cancels oversized responses", async () => {
  let canceled = false;
  const { search } = fixture({
    output() {
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
        cancel() { canceled = true; },
      });
      return new Response(body, { headers:{ "content-type":"text/event-stream" } });
    },
  });
  await assert.rejects(search({ query:"模型发布" }), { code:"WEB_SEARCH_PROVIDER_ERROR" });
  assert.equal(canceled, true);
});
