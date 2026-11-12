import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readYouTubeCaptions } from "../desktop/server/video-source.mjs";

const landing = "https://example.com/resources/forms/demos/video";
const videoId = "HkKyxbhKJe8";
const watch = `https://www.youtube.com/watch?v=${videoId}`;
const text = "A real caption from the public video.";
const payload = { events: [{ tStartMs: 1250, dDurationMs: 2500, segs: [{ utf8: text }] }] };
const expectedSegments = [{ start_ms: 1250, end_ms: 3750, text }];
const response = (url, text, type = "text/html") => ({ url, text, type });
const captionURL = (id = videoId, lang = "en") => `https://www.youtube.com/api/timedtext?v=${id}&lang=${lang}`;
const player = (tracks, id = videoId) => `<script>var ytInitialPlayerResponse = ${JSON.stringify({
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: id, title: 'Public video with {"quotes"}' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
})};var extraCode = {};</script>`;

test("reads iframe and lazy-player embeds as the same YouTube video and fetches an actual manual caption track", async () => {
  for (const markup of [
    `<iframe allow="x>y" src="//www.youtube-nocookie.com/embed/${videoId}?autoplay=0&amp;mute=1"></iframe>`,
    `<div data-yt-mode="player" data-youtube-id="${videoId}"></div><iframe data-src="https://www.youtube.com/embed/${videoId}"></iframe>`,
  ]) {
    const calls = [];
    const tracks = [
      { baseUrl: captionURL(videoId, "en"), languageCode: "en", kind: "asr" },
      { baseUrl: captionURL(videoId, "zh"), languageCode: "zh" },
      { baseUrl: "https://unrelated.example/captions", languageCode: "en" },
    ];
    const result = await readYouTubeCaptions(landing, { async fetchPage(url, _redirects, options) {
      calls.push([url, options.representation]);
      options.signal.throwIfAborted();
      if (url === landing) return response(url, markup);
      if (url === watch) return response(url, player(tracks));
      if (url === captionURL(videoId, "zh") + "&fmt=json3") return response(url, JSON.stringify(payload), "application/json");
      throw new Error("Unexpected fetch");
    } });
    assert.deepEqual(calls, [[landing, undefined], [watch, undefined], [captionURL(videoId, "zh") + "&fmt=json3", "youtube-captions"]]);
    assert.deepEqual(result, { url: watch, title: 'Public video with {"quotes"}', type: "video",
      segments: expectedSegments, transcriptSource: "platform_manual" });
  }
});

test("ignores unrelated links, lookalike hosts and inactive markup and reports multiple actual players", async () => {
  const fake = `<iframe src="https://www.youtube.com/embed/${videoId}"></iframe>`;
  const unrelated = `
    <a href="${watch}">YouTube</a><!-- ${fake} -->
    <template>${fake}</template><script>const html = '${fake}';</script>
    <iframe srcdoc="" src="https://www.youtube.com/embed/${videoId}"></iframe>
    <iframe src="https://youtube.com.example/embed/${videoId}"></iframe>
    <div data-youtube-id="${videoId}"></div>`;
  const cases = [[unrelated, "YOUTUBE_EMBED_NOT_FOUND"],
    [`${fake}<div data-yt-mode="player" data-youtube-id="video123456"></div>`, "YOUTUBE_MULTIPLE_EMBEDS"]];
  for (const [markup, code] of cases) {
    const calls = [];
    await assert.rejects(readYouTubeCaptions(landing, { async fetchPage(url) {
      calls.push(url);
      return response(url, markup);
    } }), { code });
    assert.deepEqual(calls, [landing]);
  }
});

test("canonicalizes direct YouTube URLs and cancels caption retrieval when the caller aborts", async () => {
  const controller = new AbortController();
  const cancelled = new Error("Cancelled by caller");
  const calls = [];
  await assert.rejects(readYouTubeCaptions(`https://youtu.be/${videoId}?t=10`, {
    signal: controller.signal,
    async fetchPage(url) {
      calls.push(url);
      controller.abort(cancelled);
      return response(url, "");
    },
  }), error => error === cancelled);
  assert.deepEqual(calls, [watch]);
});

test("uses the local extractor only for captions when the web track is unavailable", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "folio-video-source-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "extractor");
  const log = path.join(directory, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) console.log("1.0.0");
else if (args.includes("--dump-single-json")) console.log(JSON.stringify({ title: "Public captions", subtitles: { en: [{ ext: "json3" }] } }));
else if (args.includes("--skip-download") && args.includes("--write-subs")) {
  const directory = args[args.indexOf("--paths") + 1];
  fs.writeFileSync(path.join(directory, "source.en.json3"), ${JSON.stringify(JSON.stringify(payload))});
} else process.exitCode = 1;
`, { mode: 0o700 });
  const keys = ["YT_DLP_BIN", "YT_COOKIES_FILE"];
  const previous = keys.map(key => process.env[key]);
  process.env.YT_DLP_BIN = executable;
  process.env.YT_COOKIES_FILE = "/unused-browser-cookies";
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }));
  const webCalls = [];
  const result = await readYouTubeCaptions(watch, { async fetchPage(url) {
    webCalls.push(url);
    return response(url, url === watch ? player([
      { baseUrl: captionURL("video123456"), languageCode: "en" },
      { baseUrl: captionURL(), languageCode: "en" },
    ]) : "");
  } });
  assert.deepEqual(result, { url: watch, title: "Public captions", type: "video",
    segments: expectedSegments, transcriptSource: "platform_manual" });
  assert.deepEqual(webCalls, [watch, captionURL() + "&fmt=json3"]);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls[0], ["--version"]);
  assert.equal(calls.length, 3);
  for (const args of calls.slice(1)) {
    assert.ok(args.includes("--skip-download") && args.includes("--ignore-config"));
    assert.ok(!args.includes("--cookies") && !args.includes("bestaudio/best"));
    assert.equal(args.at(-1), watch);
  }
});
