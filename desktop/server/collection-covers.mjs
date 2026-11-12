import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validURL } from "../../server/safe-fetch.mjs";
import { pickCollectionCardColor } from "../../site/curator/collection-card-color.js";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const COVER_PATH = "/api/desktop/covers/";

export function youtubePreview(raw) {
  const url = validURL(raw);
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  const videoId = url.hostname === "youtu.be" ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
    : url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  if (!/^[\w-]{11}$/.test(videoId || "")) return null;
  const videoURL = `https://www.youtube.com/watch?v=${videoId}`;
  const imageBase = `https://i.ytimg.com/vi/${videoId}/`;
  return { videoURL, thumbnail: `${imageBase}mqdefault.jpg`, images: [`${imageBase}mqdefault.jpg`, `${imageBase}hqdefault.jpg`] };
}

export function previewTitle(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200) : "";
}

function coverURL(value, baseURL) {
  if (typeof value !== "string" || !value.trim() || value.length > 4000 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = validURL(new URL(value, baseURL).href);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function rasterType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > 3_000_000) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.toString("ascii", 4, 12) === "ftypavif" || bytes.toString("ascii", 4, 12) === "ftypavis") return "image/avif";
  return null;
}

export function createCollectionCovers(directory, fetchPage) {
  const cache = path.join(directory, "collection-covers");

  async function acquire(images, baseURL, signal) {
    const limited = AbortSignal.timeout(8000);
    const fetchSignal = signal ? AbortSignal.any([signal, limited]) : limited;
    const urls = [...new Set(images.map(value => coverURL(value, baseURL)).filter(Boolean))].slice(0, 4);
    for (const url of urls) {
      try {
        const page = await fetchPage(url, 0, { signal: fetchSignal, representation: "cover" });
        fetchSignal.throwIfAborted();
        const type = rasterType(page.bytes);
        if (!type || type !== page.type?.split(";", 1)[0].trim().toLowerCase()) continue;
        const key = createHash("sha256").update(page.bytes).digest("hex");
        await mkdir(cache, { recursive: true, mode: 0o700 });
        const temp = path.join(cache, `${key}.${randomUUID()}.tmp`);
        try {
          await writeFile(temp, page.bytes, { mode: 0o600, flag: "wx" });
          await rename(temp, path.join(cache, key));
        } finally { await rm(temp, { force: true }); }
        return COVER_PATH + key;
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        if (limited.aborted) break;
      }
    }
    return "";
  }

  async function video(preview, signal) {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.search = new URLSearchParams({ url: preview.videoURL, format: "json" }).toString();
    const limited = AbortSignal.timeout(6500);
    const fetchSignal = signal ? AbortSignal.any([signal, limited]) : limited;
    const [title, thumbnail] = await Promise.all([
      (async () => {
        try {
          const result = await fetchPage(endpoint.href, 0, { signal: fetchSignal, representation: "metadata" });
          fetchSignal.throwIfAborted();
          const info = JSON.parse(result.text);
          return info.provider_name === "YouTube" ? previewTitle(info.title) : "";
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error;
          return "";
        }
      })(),
      acquire(preview.images, preview.videoURL, signal),
    ]);
    return { title, thumbnail: thumbnail || preview.thumbnail };
  }

  async function read(key) {
    if (!/^[a-f\d]{64}$/.test(key)) return null;
    try {
      const bytes = await readFile(path.join(cache, key));
      const type = rasterType(bytes);
      return type ? { bytes, type } : null;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function color(url, signal) {
    const file = await acquire([url], undefined, signal);
    if (!file) return null;
    const cover = await read(file.slice(COVER_PATH.length));
    if (!cover) return null;
    try {
      const { default: sharp } = await import("sharp");
      const pixels = await sharp(cover.bytes, { limitInputPixels: 25_000_000 })
        .autoOrient().resize(32, 32, { fit: "fill" }).toColourspace("srgb").ensureAlpha().raw().toBuffer();
      return pickCollectionCardColor(pixels, 32);
    } catch { return null; }
  }

  return { acquire, video, read, color };
}
