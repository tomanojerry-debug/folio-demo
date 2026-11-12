import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { youtube } from "../worker/adapters.mjs";

test("YouTube downloads one real caption track at a time and transcribes when none exists", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "folio-youtube-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stub = path.join(root, "media-tool");
  await writeFile(stub, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const yt = args.includes("--paths");
const ffmpeg = args[0] === "-nostdin";
const dir = yt ? args[args.indexOf("--paths") + 1] : path.dirname(ffmpeg ? args.at(-1) : args[2]);
const fixture = path.basename(dir);
const log = value => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(value) + "\\n");
if (args.includes("--dump-single-json")) {
  log({ action: "metadata", download: args.includes("--no-simulate") });
  const supported = [{ ext: "json3" }];
  console.log(JSON.stringify({ title: "Sample video", subtitles: fixture === "no-captions" ? {} : { en: supported },
    automatic_captions: fixture === "no-captions" ? {} : { "en-orig": supported } }));
} else if (args.includes("--skip-download")) {
  const manual = args.includes("--write-subs");
  const language = args[args.indexOf("--sub-langs") + 1];
  log({ action: "caption", manual, language, download: args.includes("--no-simulate") });
  if (fixture === "inaccessible" || manual && fixture === "auto" || !args.includes("--no-simulate")) process.exit(1);
  fs.writeFileSync(path.join(dir, manual ? "source.en.json3" : "source.en-orig.json3"), JSON.stringify({ events: [
    { tStartMs: 1250, dDurationMs: 2500, segs: [{ utf8: manual ? "Manual caption" : "Automatic caption" }] },
  ] }));
  if (manual) process.exitCode = 1;
} else if (yt) {
  log({ action: "audio" });
  fs.writeFileSync(path.join(dir, "source.m4a"), "audio fixture");
} else if (ffmpeg) {
  log({ action: "ffmpeg" });
  fs.writeFileSync(args.at(-1), "wave fixture");
} else {
  log({ action: "whisper" });
  fs.writeFileSync(args[2], JSON.stringify({ segments: [{ start_ms: 0, end_ms: 1750, text: "Spoken fixture" }] }));
}
`, { mode: 0o700 });

  const variables = ["YT_DLP_BIN", "FFMPEG_BIN", "WHISPER_PYTHON", "YT_COOKIES_FILE"];
  const previous = variables.map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  for (const key of variables.slice(0, 3)) process.env[key] = stub;
  delete process.env.YT_COOKIES_FILE;

  const metadata = { action: "metadata", download: false };
  const manual = { action: "caption", manual: true, language: "^en$", download: true };
  const auto = { action: "caption", manual: false, language: "^en-orig$", download: true };
  const scenarios = [
    { name: "manual", provenance: "platform_manual", text: "Manual caption", calls: [metadata, manual] },
    { name: "auto", provenance: "platform_auto", text: "Automatic caption", calls: [metadata, manual, auto] },
    { name: "no-captions", provenance: "local_faster_whisper", text: "Spoken fixture", calls: [metadata, { action: "audio" }, { action: "ffmpeg" }, { action: "whisper" }] },
    { name: "inaccessible", calls: [metadata, manual, auto] },
  ];
  const url = "https://www.youtube.com/watch?v=fixture1234";
  for (const { name, provenance, text, calls } of scenarios) {
    const dir = path.join(root, name);
    await mkdir(dir);
    const stages = [];
    const result = youtube(url, dir, stage => stages.push(stage));
    if (provenance) {
      const video = await result;
      assert.equal(video.url, url);
      assert.equal(video.transcriptSource, provenance);
      assert.deepEqual(video.segments, name === "no-captions" ? [{ start_ms: 0, end_ms: 1750, text }] : [{ start_ms: 1250, end_ms: 3750, text }]);
    } else await assert.rejects(result, { code: "NEEDS_INPUT" });
    assert.deepEqual(stages, name === "no-captions" ? ["fetching_captions", "downloading_audio", "transcribing"] : ["fetching_captions"]);
    assert.deepEqual((await readFile(path.join(dir, "calls.jsonl"), "utf8")).trimEnd().split("\n").map(line => JSON.parse(line)), calls);
  }
});
