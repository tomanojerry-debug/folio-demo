import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fault } from "../../server/errors.mjs";
import { htmlTokens, safeFetch, validURL, youtubeCaptionURL } from "../../server/safe-fetch.mjs";
import { json3Segments } from "../../server/youtube-captions.mjs";
import { run, youtube } from "../../worker/adapters.mjs";
import { previewTitle, youtubePreview } from "./collection-covers.mjs";

const VIDEO_ID = /^[\w-]{11}$/;
const EMBED_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"]);
const LANGUAGE_PREFERENCE = ["en-orig", "en", "zh-Hans", "zh-Hant", "zh"];
const MAX_SEGMENTS = 15_000;
const MAX_TRANSCRIPT_LENGTH = 2_000_000;

function embedId(value, baseURL) {
  if (!value) return "";
  let url;
  try { url = validURL(new URL(value, baseURL).href); }
  catch { return ""; }
  if (url.port || !EMBED_HOSTS.has(url.hostname)) return "";
  return /^\/embed\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] || "";
}

function canonicalVideoURL(raw) {
  const preview = youtubePreview(raw);
  if (preview) return preview.videoURL;
  const id = embedId(raw, raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : "";
}

function embeddedVideoIds(page, url) {
  if (typeof page.text !== "string" || !/^text\/html\b/i.test(page.type || "")) return [];
  const ids = new Set();
  let templateDepth = 0;
  for (const { name, attributes, closing } of htmlTokens(page.text)) {
    if (name === "template") templateDepth = Math.max(0, templateDepth + (closing ? -1 : 1));
    if (!attributes || closing || templateDepth) continue;
    // Some public pages render the iframe on interaction, but publish the
    // player's YouTube video ID as an HTML data attribute.
    const lazyPlayerId = attributes["data-youtube-id"];
    const id = attributes["data-yt-mode"] === "player" && VIDEO_ID.test(lazyPlayerId || "") ? lazyPlayerId
      : name === "iframe" && !("srcdoc" in attributes) ? embedId(attributes.src, url) || embedId(attributes["data-src"], url) : "";
    if (id) ids.add(id);
  }
  return [...ids];
}

function playerJSON(script) {
  const assignment = /^\s*(?:(?:var|let|const)\s+)?(?:ytInitialPlayerResponse|window\[["']ytInitialPlayerResponse["']\])\s*=\s*(?=\{)/.exec(script);
  if (!assignment) return null;
  const start = assignment[0].length;
  let depth = 0, quoted = false;
  for (let i = start; i < script.length; i++) {
    const char = script[i];
    if (quoted && char === "\\") { i++; continue; }
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) {
      try { return JSON.parse(script.slice(start, i + 1)); }
      catch { return null; }
    }
  }
  return null;
}

function playerResponse(html, videoId) {
  const tokens = htmlTokens(String(html || ""));
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].name !== "script" || tokens[i].closing) continue;
    const player = playerJSON(tokens[i + 1]?.text || "");
    if (player?.videoDetails?.videoId === videoId && player.playabilityStatus?.status === "OK") return player;
  }
  return null;
}

function languageRank(language) {
  const index = LANGUAGE_PREFERENCE.indexOf(language);
  return index < 0 ? LANGUAGE_PREFERENCE.length : index;
}

function hasBoundedTranscript(segments) {
  const length = segments.reduce((size, segment) => size + segment.text.length + 1, 0) - 1;
  if (segments.length > MAX_SEGMENTS || length > MAX_TRANSCRIPT_LENGTH) throw fault("CONTENT_TOO_LONG", 413);
  return segments.length > 0;
}

async function fetchPublicCaptions(url, { fetchPage, signal }) {
  const videoId = new URL(url).searchParams.get("v");
  const page = await fetchPage(url, 0, { signal });
  signal.throwIfAborted();
  if (new URL(page.url || url).origin !== "https://www.youtube.com") throw fault("YOUTUBE_CAPTIONS_UNAVAILABLE", 422);
  const player = playerResponse(page.text, videoId);
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) throw fault("YOUTUBE_CAPTIONS_UNAVAILABLE", 422);
  const candidates = tracks.filter(track => typeof track?.baseUrl === "string").sort((a, b) =>
    Number(a.kind === "asr") - Number(b.kind === "asr") || languageRank(a.languageCode) - languageRank(b.languageCode));
  for (const track of candidates.slice(0, 4)) {
    let segments;
    try {
      const endpoint = youtubeCaptionURL(track.baseUrl, videoId);
      endpoint.searchParams.set("fmt", "json3");
      const captions = await fetchPage(endpoint.href, 0, { signal, representation: "youtube-captions" });
      signal.throwIfAborted();
      segments = json3Segments(JSON.parse(captions.text));
    } catch (error) {
      signal.throwIfAborted();
      if (error.code === "BODY_TOO_LARGE") throw fault("CONTENT_TOO_LONG", 413);
      continue;
    }
    if (!hasBoundedTranscript(segments)) continue;
    return { url, title: previewTitle(player.videoDetails.title) || "YouTube 视频", type: "video",
      segments, transcriptSource: track.kind === "asr" ? "platform_auto" : "platform_manual" };
  }
  throw fault("YOUTUBE_CAPTIONS_UNAVAILABLE", 422);
}

async function findCaptionExtractor(signal) {
  const executables = [process.env.YT_DLP_BIN, "yt-dlp", "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"];
  const pythons = ["/usr/local/bin/python3", "/opt/homebrew/bin/python3", "python3"];
  const commands = [...new Set(executables.filter(Boolean))].map(binary => [binary]);
  commands.push(...pythons.map(binary => [binary, "-m", "yt_dlp"]));
  for (const [binary, ...args] of commands) {
    try {
      await run(binary, [...args, "--version"], { signal, timeout: 8_000 });
      return [binary, ...args];
    } catch {
      signal.throwIfAborted();
    }
  }
  throw fault("YOUTUBE_CAPTIONS_UNAVAILABLE", 422);
}

async function fetchLocalCaptions(url, signal) {
  const command = await findCaptionExtractor(signal);
  const directory = await mkdtemp(path.join(os.tmpdir(), "folio-youtube-captions-"));
  try {
    const result = await youtube(url, directory, () => {}, { captionsOnly: true, signal, command });
    if (hasBoundedTranscript(result.segments)) return { ...result, title: previewTitle(result.title) || "YouTube 视频" };
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === "CONTENT_TOO_LONG") throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  throw fault("YOUTUBE_CAPTIONS_UNAVAILABLE", 422);
}

async function fetchAvailableCaptions(url, { fetchPage, signal }) {
  const publicSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    return await fetchPublicCaptions(url, { fetchPage, signal: publicSignal });
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === "CONTENT_TOO_LONG") throw error;
    return fetchLocalCaptions(url, signal);
  }
}

export async function readYouTubeCaptions(raw, { fetchPage = safeFetch, signal } = {}) {
  const timeout = AbortSignal.timeout(75_000);
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  readSignal.throwIfAborted();
  try {
    const requested = validURL(raw).href;
    let videoURL = canonicalVideoURL(requested);
    if (!videoURL) {
      const page = await fetchPage(requested, 0, { signal: readSignal });
      readSignal.throwIfAborted();
      const resolved = validURL(page.url || requested).href;
      videoURL = canonicalVideoURL(resolved);
      if (!videoURL) {
        const ids = embeddedVideoIds(page, resolved);
        if (!ids.length) throw fault("YOUTUBE_EMBED_NOT_FOUND", 422);
        if (ids.length > 1) throw fault("YOUTUBE_MULTIPLE_EMBEDS", 422);
        videoURL = `https://www.youtube.com/watch?v=${ids[0]}`;
      }
    }
    const result = await fetchAvailableCaptions(videoURL, { fetchPage, signal: readSignal });
    readSignal.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw fault("PROCESSING_TIMEOUT", 504);
    throw error;
  }
}
