import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDesktopServer } from "../desktop/server/index.mjs";
import { youtubePreview } from "../desktop/server/collection-covers.mjs";
import sharp from "sharp";

const config = { zhipuApiKey: "", textModel: "cover-fixture", timeoutMs: 1000 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9W2ioAAAAASUVORK5CYII=", "base64");
const coverPath = /^\/api\/desktop\/covers\/[a-f0-9]{64}$/;
const failure = (code) => Object.assign(new Error(code), { code });

async function fixture(t, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forme-covers-"));
  const runtime = await startDesktopServer({ directory, port: 0, config, aiEnabled: true, autoCurate: false, ...options });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return runtime;
}

test("news image candidates are fetched safely, served locally and retained after understanding fails", async (t) => {
  const reads = [];
  const { service, origin } = await fixture(t, {
    fetchPage: async (url, _, { representation } = {}) => {
      reads.push(url);
      if (representation === "cover") {
        if (url.endsWith("empty.png")) return { type: "image/png", bytes: Buffer.from("not an image") };
        assert.equal(url, "https://news.example/pictures/model.png?x=1&y=2");
        return { type: "image/png", bytes: png };
      }
      return { url: "https://news.example/story/read", type: "text/html", text: `<html><head><title>页面标题</title>
        <meta property="og:title" content="AI 模型知识"><meta property="og:image:secure_url" content="https://127.0.0.1/no.png">
        <meta name="twitter:image" content="/empty.png"></head><main><nav><img src="/menu.png"></nav>
        <article><img src="/pixel.png" width="1" height="1"><img data-src="../pictures/model.png?x=1&amp;y=2" src="data:image/png;base64,AA">
        <p>这段原始正文讨论人工智能模型如何理解上下文，并为读者提供可核对的证据。</p></article></main></html>` };
    },
    model: () => { throw failure("MODEL_PROVIDER_ERROR"); },
  });
  const saved = await service.capture({ mode: "link", content: "https://news.example/story" });
  await service.idle();
  const item = service.state().collections[0];
  assert.equal(item.status, "failed");
  assert.equal(item.title, "AI 模型知识");
  assert.match(item.thumbnail, coverPath);
  assert.deepEqual(reads, ["https://news.example/story", "https://news.example/empty.png", "https://news.example/pictures/model.png?x=1&y=2"]);
  const served = await fetch(origin + item.thumbnail);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  assert.equal((await fetch(origin + item.thumbnail, { headers: { Origin: "https://elsewhere.example" } })).status, 403);
  const retry = await service.retry({ collectionId: saved.collectionId });
  await service.idle();
  assert.equal(service.state().collections[0].thumbnail, item.thumbnail);
  assert.equal(service.state().jobs.find(job => job.id === retry.job.id).harness.steps[0].reused, true);
  assert.equal(reads.length, 3);
});

test("WeChat covers can use original lazy article images without AI; a challenge is not an article", async (t) => {
  const reads = [];
  const { service, origin } = await fixture(t, { aiEnabled: false,
    fetchPage: async (url, _, { representation } = {}) => {
      reads.push(url);
      if (representation === "cover") return { type: "image/png", bytes: png };
      const visible = `<title>RAG 原理</title><script>var msg_cdn_url = 'https://mmbiz.qpic.cn/real-cover/0?wx_fmt=png';</script>
        <div id="js_content"><img data-src="https://mmbiz.qpic.cn/first-figure/0"><p>大模型使用外部检索结果，把原始材料提供给模型作为生成答案的参考。</p></div>`;
      const challenge = `<title>环境异常</title><meta property="og:image" content="https://mmbiz.qpic.cn/challenge-banner/0"><p>当前环境异常，请完成安全验证后再试。</p>`;
      return { url, type: "text/html", text: url.endsWith("/visible") ? visible : challenge };
    },
    model: () => { throw new Error("AI disabled"); },
  });
  await service.send({ text: "https://mp.weixin.qq.com/s/visible\nhttps://mp.weixin.qq.com/s/challenge" });
  await service.idle();
  const [visible, challenge] = service.state().collections;
  assert.equal(visible.title, "RAG 原理");
  assert.equal(visible.source, "微信公众号");
  assert.equal(visible.status, "saved");
  assert.match(visible.thumbnail, coverPath);
  assert.equal(challenge.thumbnail, undefined);
  assert.deepEqual(reads, ["https://mp.weixin.qq.com/s/visible", "https://mmbiz.qpic.cn/real-cover/0?wx_fmt=png", "https://mp.weixin.qq.com/s/challenge"]);
  const result = await fetch(origin + "/api/desktop/collection-cover", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ collectionId: challenge.id, coverUrl: "https://publisher.example/original.png" }) });
  assert.equal(result.status, 200);
  const after = service.state().collections[1];
  assert.match(after.thumbnail, coverPath);
  assert.equal(after.title, challenge.title);
  assert.equal(after.knowledgeDocumentVersionId, undefined);
  assert.equal(service.state().jobs.length, 0);
});

test("only recognized YouTube video routes can produce a platform cover", () => {
  assert.equal(youtubePreview("https://youtu.be/wjZofJX0v4M?t=1").videoURL, "https://www.youtube.com/watch?v=wjZofJX0v4M");
  assert.equal(youtubePreview("https://www.youtube.com/shorts/wjZofJX0v4M").thumbnail, "https://i.ytimg.com/vi/wjZofJX0v4M/mqdefault.jpg");
  for (const url of ["https://youtube.com.evil.example/watch?v=wjZofJX0v4M", "https://www.youtube.com/results?v=wjZofJX0v4M", "https://youtu.be/too-short", "https://youtu.be/wjZofJX0v4M/extra"]) assert.equal(youtubePreview(url), null);
});

test("the stored remote cover supplies a swatch when the client cannot read its pixels", async t => {
  const image = await sharp({ create: { width:32, height:32, channels:3, background:"#37b23d" } }).png().toBuffer();
  const video = youtubePreview("https://youtu.be/wjZofJX0v4M");
  let coverAvailable = false;
  const reads = [];
  const { service, origin } = await fixture(t, { aiEnabled:false,
    fetchPage: async (url, _, { representation } = {}) => {
      if (representation === "metadata") return { text:JSON.stringify({ provider_name:"YouTube", title:"Video" }) };
      reads.push(url);
      if (!coverAvailable) throw failure("COVER_UNAVAILABLE");
      return { type:"image/png", bytes:image };
    },
  });
  const saved = await service.capture({ mode:"link", content:video.videoURL });
  await service.idle();
  assert.equal(service.state().collections[0].thumbnail, video.thumbnail);
  coverAvailable = true;
  reads.length = 0;
  const response = await fetch(origin + "/api/desktop/collection-cover/color", {
    method:"POST", headers:{ "Content-Type":"application/json", Origin:origin },
    body:JSON.stringify({ collectionId:saved.collectionId }),
  });
  assert.deepEqual(await response.json(), { color:"#426338" });
  assert.deepEqual(reads, [video.thumbnail]);
  assert.equal(service.state().collections[0].thumbnail, video.thumbnail);
});
