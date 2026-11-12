import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "../server/pipeline.mjs";
import { fault } from "../server/errors.mjs";
import { json3Segments } from "../server/youtube-captions.mjs";

export { json3Segments };

export function run(binary, args, options = {}) {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let size = 0, expired = false;
    const kill = () => { expired = true; try { process.platform !== "win32" ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch {} };
    const timer = setTimeout(kill, options.timeout || 180000);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
    };
    options.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > 12_000_000) kill(); else chunks.push(chunk); });
    child.stderr.resume(); // Never log platform credentials or signed media URLs.
    child.on("error", () => {
      cleanup();
      reject(options.signal?.reason || fault("WORKER_UNAVAILABLE", 503));
    });
    child.on("close", (code) => {
      cleanup();
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (expired) reject(fault("PROCESSING_TIMEOUT", 504));
      else if (code !== 0) reject(fault("NEEDS_INPUT", 422));
      else resolve(Buffer.concat(chunks).toString());
    });
  });
}
async function transcribe(file, dir, stage) {
  const info = await stat(file);
  if (info.size > 150_000_000) throw fault("BODY_TOO_LARGE", 413);
  stage("transcribing");
  const audio = path.join(dir, "audio.wav"), output = path.join(dir, "transcript.json");
  await run(process.env.FFMPEG_BIN || "ffmpeg", ["-nostdin", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", audio], { timeout: 120000 });
  await run(process.env.WHISPER_PYTHON || "python3", [fileURLToPath(new URL("./transcribe.py", import.meta.url)), audio, output, "--model", process.env.WHISPER_MODEL || "small"], { timeout: 900000 });
  return JSON.parse(await readFile(output, "utf8"));
}
export async function youtube(raw, dir, stage, { captionsOnly = false, signal, command = [process.env.YT_DLP_BIN || "yt-dlp"] } = {}) {
  const url = new URL(raw);
  const videoId = url.hostname === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v") || /^\/(?:shorts|embed)\/([\w-]+)/.exec(url.pathname)?.[1];
  if (!/^[\w-]{11}$/.test(videoId || "")) throw fault("INVALID_REQUEST");
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const [bin, ...prefix] = command;
  const execute = (args, options) => run(bin, [...prefix, ...args], { cwd: dir, signal, ...options });
  const common = ["--ignore-config", "--no-playlist", "--socket-timeout", "20", "--retries", "1", "--max-filesize", "150M", "--match-filters", "duration <= 3600", "--paths", dir, "-o", "source.%(ext)s"];
  // Explicitly supplied, exported cookie file only; never harvest a visitor's browser session.
  if (!captionsOnly && process.env.YT_COOKIES_FILE) common.push("--cookies", process.env.YT_COOKIES_FILE);
  stage("fetching_captions");
  const rawInfo = await execute([...common, "--skip-download", "--dump-single-json", canonical]);
  let info; try { info = JSON.parse(rawInfo); } catch { throw fault("NEEDS_INPUT", 422); }
  const source = { url: canonical, title: String(info.title || "YouTube 视频"), type: "video" };
  const languages = ["en-orig", "en", "zh-Hans", "zh-Hant"];
  const captionGroups = [
    [info.subtitles, "--write-subs", "platform_manual"],
    [info.automatic_captions, "--write-auto-subs", "platform_auto"],
  ];
  let captionError;
  for (const [tracks, writeFlag, transcriptSource] of captionGroups) {
    const extras = captionsOnly ? Object.keys(tracks || {}).filter(language =>
      /^[\w-]{1,32}$/.test(language) && (transcriptSource === "platform_manual" || language.endsWith("-orig"))) : [];
    for (const language of new Set([...languages, ...extras])) {
      if (!tracks?.[language]?.some((format) => format.ext === "json3")) continue;
      const subtitleFile = path.join(dir, `source.${language}.json3`);
      try {
        await execute([...common, "--skip-download", "--no-simulate", writeFlag,
          "--sub-langs", `^${language}$`, "--sub-format", "json3", canonical]);
      } catch (error) { captionError = error; }
      signal?.throwIfAborted();
      // yt-dlp can exit nonzero after writing a usable subtitle file.
      let segments;
      try {
        if (captionsOnly && (await stat(subtitleFile)).size > 2_000_000) throw fault("CONTENT_TOO_LONG", 413);
        const file = await readFile(subtitleFile, { encoding: "utf8", signal });
        segments = json3Segments(JSON.parse(file));
      } catch (error) {
        if (error.code && error.code !== "ENOENT") throw error;
      }
      if (segments?.length) return { ...source, segments, transcriptSource };
    }
  }
  if (captionError) throw captionError;
  if (captionsOnly) throw fault("NEEDS_INPUT", 422);
  stage("downloading_audio");
  await execute([...common, "-f", "bestaudio/best", canonical], { timeout: 300000 });
  const audio = (await readdir(dir)).find((f) => /^source\.(m4a|webm|mp4|opus|mp3|ogg)$/.test(f));
  if (!audio) throw fault("NEEDS_INPUT", 422);
  const { segments } = await transcribe(path.join(dir, audio), dir, stage);
  if (!segments?.length) throw fault("NEEDS_INPUT", 422);
  return { ...source, segments, transcriptSource: "local_faster_whisper" };
}
export async function xiaohongshu(raw, dir, stage) {
  const url = new URL(raw);
  const noteId = /\/(?:explore|discovery\/item)\/([a-f0-9]{24})/.exec(url.pathname)?.[1];
  const token = url.searchParams.get("xsec_token") || "";
  if (!noteId) throw fault("NEEDS_INPUT", 422); // Require full note URL; no unverified short-link redirect.
  if (token.length > 2048 || /[\r\n\0]/.test(token)) throw fault("INVALID_REQUEST");
  stage("reading_note");
  let output;
  try { output = JSON.parse(await run(process.env.SOCAI_BIN || "socai", ["xhs", "get-notes", "--note", `${noteId}=${token}`, "--num-comments", "0", "--download-media", "--ocr"], { cwd: dir })); }
  catch { throw fault("AUTH_REQUIRED", 422); }
  const note = output.notes?.[0]?.entity;
  if (!note || !note.title) throw fault("AUTH_REQUIRED", 422);
  let manifest = [];
  if (output.media_manifest_path) manifest = JSON.parse(await readFile(output.media_manifest_path, "utf8"));
  const video = manifest.find((m) => m.note_id === noteId && m.local_path && (m.type === "video" || /\.(mp4|webm|mov)$/i.test(m.local_path)));
  const canonical = `https://www.xiaohongshu.com/explore/${noteId}`;
  if (video) {
    const result = await transcribe(video.local_path, dir, stage);
    return { url: canonical, title: note.title, type: "video", segments: result.segments, transcriptSource: "local_faster_whisper" };
  }
  // Use only actual text. Image/OCR data is not inferred from captions.
  const content = String(note.content || "");
  if (content.trim().length < 80) throw fault("NEEDS_INPUT", 422);
  return { url: canonical, title: note.title, type: "image_note", content, transcriptSource: null };
}
export async function collect(raw, dir, stage) {
  const kind = platform(raw);
  if (kind === "youtube") return youtube(raw, dir, stage);
  if (kind === "xiaohongshu") return xiaohongshu(raw, dir, stage);
  throw fault("INVALID_REQUEST");
}
