import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodePageBytes, readableHTMLText } from "../server/safe-fetch.mjs";
import { cleanPageText, pageContentFromResponse, readPageContent } from "../desktop/server/page-content.mjs";
import { startDesktopServer } from "../desktop/server/index.mjs";

const paragraph = "这是一段可以核对来源的中文正文。有效阅读需要保留论述中的条件、例子和分段，而不是把导航、广告和推荐内容拼在一起。";
const html = [
  '<title>一篇关于阅读的公开长文 &mdash; 测试来源</title>',
  '<header>站点口号，不是正文。</header><nav>首页 / 产品 / 登录</nav>',
  '<main><div class="translation-banner">语言切换提示，不是正文。</div><header><h1>阅读与来源</h1></header><article>',
  '<ul class="prev-next"><li>上一页：另一课</li><li>下一页：后一课</li></ul>',
  '<p>' + paragraph + '</p><h2>保留段落与链接</h2>',
  '<p>中文正文里的<a href="/source">来源链接</a>应该连续保留，不能被导航过滤误删。</p>',
  '<div class="advertisement"><p>点击广告即可领取优惠券。</p></div>',
  '<div role="navigation">移动端菜单不应进入正文。</div>',
  '<div hidden>隐藏副本不应进入正文。</div><p style="display: none !important">不可见文字。</p>',
  '<aside><h2>猜你喜欢</h2><p>另一篇文章的推荐。</p></aside>',
  '<script>const fake = "</main><article>伪造正文</article>";</script>',
  '<style>.ghost::after { content: "CSS里的秘密"; }</style>',
  '<p data-example="</main> >">' + paragraph + '</p>',
  '<h2>可以引用代码</h2><p>例如 &lt;article&gt; 标签仍然是文章中可以讨论的有效文字。</p><h3>复制链接</h3><p>这是正文中的操作说明小节，不应按关键词丢弃。</p>',
  '<div class="related-posts">更多推荐。</div><div class="cookie-banner">接受 Cookie。</div>',
  '<form><textarea>编辑框里的草稿不采集。</textarea></form>',
  '</article></main><footer>版权与联系页脚。</footer>',
].join("");

test("semantic HTML extraction preserves the article while dropping chrome, ads, hidden controls and script examples", () => {
  const page = pageContentFromResponse({ url: "https://example.org/article", type: "text/html", text: html }, { url: "https://example.org/article", attachmentId: "window-a" });
  assert.equal(page.readStatus, "public_page");
  assert.equal(page.title, "一篇关于阅读的公开长文 — 测试来源");
  assert.match(page.text, /阅读与来源\n\n/);
  assert.match(page.text, /保留段落与链接/);
  assert.match(page.text, /里的来源链接应该连续保留/);
  assert.match(page.text, /<article> 标签/);
  assert.match(page.text, /复制链接\n\n这是正文中的操作说明/);
  assert.doesNotMatch(page.text, /站点口号|首页|移动端菜单|隐藏副本|不可见文字|点击广告|猜你喜欢|另一篇文章|伪造正文|CSS里的秘密|更多推荐|接受 Cookie|草稿|版权与联系|语言切换提示|另一课|后一课/);
  assert.equal(page.text.split(paragraph).length - 1, 1);
  assert.equal(page.attachmentId, "window-a");
  assert.equal(page.contentQuality.scope, "main");
  assert.equal(page.contentQuality.removedLines, 1);
  assert.equal(page.contentQuality.characterCount, page.text.length);
  assert.ok(page.contentQuality.paragraphCount >= 6);
});

test("marked legacy articles work without main/article and an explicit empty main never falls back to unrelated content", () => {
  const result = readableHTMLText('<body><div class="sidebar">别的栏目</div><div id="post-body"><h2>旧页面正文</h2><p>' + paragraph + '</p></div><p>模板尾部的其他文字</p></body>');
  assert.match(result.text, /旧页面正文/);
  assert.match(result.text, /可以核对/);
  assert.doesNotMatch(result.text, /别的栏目|模板尾部/);
  assert.equal(result.scope, "marked-article");
  const empty = pageContentFromResponse({ type: "text/html", text: "<main></main><article>" + paragraph + "</article>" }, { url: "https://example.org/empty" });
  assert.equal(empty.readStatus, "unavailable");
  assert.equal(empty.text, "");
});

test("the existing nested-container and quoted-close guarantees also hold for readable text", () => {
  const result = readableHTMLText('<main data-close="</main> >"><p>第一段有效正文</p><article><p>嵌套示例正文</p></article><p>文章最后有效段落</p></main><p>不应混入的外部内容</p>');
  assert.match(result.text, /第一段有效正文/);
  assert.match(result.text, /嵌套示例正文/);
  assert.match(result.text, /文章最后有效段落/);
  assert.doesNotMatch(result.text, /外部内容|data-close/);
});

test("plain browser content cleans duplicates and boilerplate without parsing editorial HTML examples", async () => {
  const result = await readPageContent({ url: "https://example.org/article", text: "\u200b" + paragraph + "\r\n复制链接\r\n" + paragraph + "\n\n讨论 <script> 这种标签的文章示例，应当作为文字保留。",
    selection: "  选中的内容保留来源关系。  ", contentSource: "browser-accessibility", browserWindowId: "12", browserTabId: "23" },
  { fetchPage: () => { throw new Error("An attached readable body must not make a network request."); } });
  assert.equal(result.readStatus, "attached_text");
  assert.equal(result.contentSource, "browser-accessibility");
  assert.match(result.text, /<script>/);
  assert.equal(result.text.split(paragraph).length - 1, 1);
  assert.doesNotMatch(result.text, /复制链接|\u200b/);
  assert.equal(result.browserWindowId, "12");
  assert.equal(result.browserTabId, "23");
  assert.equal(result.selection, "选中的内容保留来源关系。");
  assert.ok(result.contentQuality.warnings.includes("BROWSER_TEXT_HEURISTICS"));
});

test("selection-only and truncation are explicit quality states, not full-page claims", async () => {
  const selected = await readPageContent({ selection: paragraph, attachmentId: "selected" }, { fetchPage: assert.fail });
  assert.equal(selected.readStatus, "selection_only");
  assert.equal(selected.text, "");
  assert.equal(selected.contentQuality.status, "partial");
  assert.ok(selected.contentQuality.warnings.includes("SELECTION_ONLY"));
  const long = cleanPageText("正文内容".repeat(15000));
  assert.equal(long.text.length, 40000);
  assert.equal(long.truncated, true);
  const clipped = await readPageContent({ text: paragraph, textTruncated: true }, { fetchPage: assert.fail });
  assert.ok(clipped.contentQuality.warnings.includes("TRUNCATED"));
});

test("truncated browser text is completed from the same public URL while retaining identity and the final section", async () => {
  let reads = 0;
  const result = await readPageContent({ url: "https://example.org/article", title: "当前页",
    text: paragraph, textTruncated: true, contentSource: "browser-accessibility",
    attachmentId: "window-a", pageRevision: "revision-a", contextVersion: 7, browserWindowId: "12", browserTabId: "23" },
  { fetchPage: async (url) => { reads++; assert.equal(url, "https://example.org/article"); return { url, type: "text/html", text: "<main><p>" + paragraph + "</p><h2>结尾小结</h2><p>" + paragraph.replace("这是一段", "完整原文保留这一段") + "</p></main>" }; } });
  assert.equal(reads, 1);
  assert.equal(result.readStatus, "public_page");
  assert.equal(result.contentSource, "public-page");
  assert.equal(result.textTruncated, false);
  assert.match(result.text, /结尾小结/);
  assert.equal(result.contentQuality.fallbackReason, "TRUNCATED_BROWSER_TEXT");
  assert.equal(result.contextVersion, 7);
  assert.equal(result.attachmentId, "window-a");
  assert.equal(result.browserTabId, "23");
});

test("sparse browser navigation cannot be called ready; public completion is preferred and failure stays partial", async () => {
  const context = { url: "https://example.org/article", title: "当前页", contentSource: "browser-accessibility",
    text: ["首页", "文章", "教程", "CSS", "JavaScript", "Web APIs", "关于我们", "帮助中心", "浏览器参考"].join("\n") };
  const completed = await readPageContent(context, { fetchPage: async (url) => ({ url, type: "text/html", text: "<main><p>" + paragraph.repeat(5) + "</p><h2>最后一节</h2></main>" }) });
  assert.equal(completed.readStatus, "public_page");
  assert.equal(completed.contentQuality.fallbackReason, "SPARSE_BROWSER_TEXT");
  assert.match(completed.text, /最后一节/);
  const partial = await readPageContent(context, { fetchPage: async () => { throw Object.assign(new Error("blocked"), { code: "FETCH_FAILED" }); } });
  assert.equal(partial.contentQuality.status, "partial");
  assert.ok(partial.contentQuality.warnings.includes("PUBLIC_FALLBACK_UNAVAILABLE"));
  assert.ok(partial.contentQuality.warnings.includes("SPARSE_BROWSER_TEXT"));
});

test("an explicit selection or untruncated body is not replaced by a second anonymous copy", async () => {
  const selected = await readPageContent({ url: "https://example.org/article", text: paragraph, selection: "请只读这一小句。", textTruncated: true, contentSource: "browser-accessibility" }, { fetchPage: assert.fail });
  assert.equal(selected.readStatus, "attached_text");
  assert.equal(selected.contentQuality.status, "partial");
  assert.equal(selected.selection, "请只读这一小句。");
});

test("login redirects, challenge pages, bad encoding and cancellation never become usable article text", async () => {
  for (const page of [
    { type: "application/json", text: JSON.stringify({ text: paragraph }) },
    { type: "text/html", url: "https://example.org/login", text: "<main>" + paragraph + "</main>" },
    { type: "text/html", text: "<title>Just a moment...</title><main>Checking your browser before continuing, please wait a little while.</main>" },
    { type: "text/html", text: "<main>请先登录后阅读此文章，未登录的访客只能看到这个提示。</main>" },
    { type: "text/plain", text: "损坏的文字" + "\ufffd".repeat(30) },
  ]) {
    const result = pageContentFromResponse(page, { url: "https://example.org/article" });
    assert.equal(result.readStatus, "unavailable");
    assert.equal(result.text, "");
  }
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(readPageContent({ url: "https://example.org/article" }, { signal: controller.signal, fetchPage: assert.fail }), /cancelled/);
  const browserChallenge = await readPageContent({ url: "https://example.org/article", title: "访问验证", text: "请完成安全验证才能继续访问，页面正文当前不可用。", contentSource: "browser-accessibility" }, { fetchPage: assert.fail });
  assert.equal(browserChallenge.readStatus, "unavailable");
});

test("declared Chinese encoding is decoded before extraction and unknown encoding falls back safely", () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodePageBytes(gbk, "text/html; charset=gb2312"), "中文");
  assert.match(decodePageBytes(Buffer.concat([Buffer.from('<meta charset="gbk">'), gbk])), /中文$/);
  assert.equal(decodePageBytes(Buffer.from("UTF-8 正文"), "text/plain;charset=not-a-real-encoding"), "UTF-8 正文");
});

test("the local page-read HTTP route returns cleaned source with identity and never writes a chat, job or collection", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guanxu-page-read-"));
  const runtime = await startDesktopServer({ directory, aiEnabled: false, config: { zhipuApiKey: "" }, fetchPage: async (url) => ({ type: "text/html", text: html, url }) });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const before = runtime.service.state();
  const response = await fetch(runtime.origin + "/api/desktop/page-read", { method: "POST", headers: { Origin: runtime.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "read-1", context: { url: "https://example.org/article", attachmentId: "window-a", pageRevision: "revision-a", contextVersion: 9, browserWindowId: 12, browserTabId: 23 } }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.readable, true);
  assert.equal(result.requestId, "read-1");
  assert.equal(result.context.attachmentId, "window-a");
  assert.equal(result.context.contextVersion, 9);
  assert.equal(result.context.browserWindowId, "12");
  assert.equal(result.context.browserTabId, "23");
  assert.match(result.context.text, /有效阅读需要保留/);
  const after = runtime.service.state();
  for (const key of ["messages", "jobs", "collections"]) assert.deepEqual(after[key], before[key]);
  const crossOrigin = await fetch(runtime.origin + "/api/desktop/page-read", { method: "POST", headers: { Origin: "https://other.example", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(crossOrigin.status, 403);
  const privateURL = await fetch(runtime.origin + "/api/desktop/page-read", { method: "POST", headers: { Origin: runtime.origin, "Content-Type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1/private" }) });
  assert.equal(privateURL.status, 400);
});

test("closing the desktop service gives an in-flight page read a terminal response with its request identity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "guanxu-page-read-stop-"));
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const runtime = await startDesktopServer({ directory, aiEnabled: false, config: { zhipuApiKey: "" },
    fetchPage: async (_url, _redirects, { signal }) => {
      began();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const response = fetch(runtime.origin + "/api/desktop/page-read", { method: "POST", headers: { Origin: runtime.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "closing-read", context: { url: "https://example.org/article", attachmentId: "window-a" } }) });
  await started;
  const closing = runtime.close();
  const result = await (await response).json();
  assert.equal(result.requestId, "closing-read");
  assert.equal(result.readable, false);
  assert.equal(result.context.readStatus, "unavailable");
  assert.equal(result.context.readError, "SERVICE_STOPPING");
  assert.equal(result.context.attachmentId, "window-a");
  await closing;
});
