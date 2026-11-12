import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fault } from "./errors.mjs";

export function publicIP(ip) {
  if (isIP(ip) === 6) return /^[23][0-9a-f]{3}:/i.test(ip) && !/^(?:2001:(?:0*:|db8:)|2002:)/i.test(ip);
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}
export function validURL(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fault("UNSAFE_URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw fault("UNSAFE_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (isIP(host) && !publicIP(host))) throw fault("UNSAFE_URL");
  return url;
}
const proxyFakeIP = (ip) => /^198\.(?:18|19)\./.test(ip);

// Some desktop VPNs use the reserved benchmark range as a DNS routing token.
// Never connect to that token from the public-content reader. Resolve only
// this exact case through a fixed TLS-authenticated DNS endpoint, then retain
// the same public-address validation and connection pinning used below.
async function cloudflareDNS(hostname, { signal } = {}) {
  signal?.throwIfAborted();
  const endpoint = new URL("https://cloudflare-dns.com/dns-query");
  endpoint.search = new URLSearchParams({ name: hostname, type: "A" }).toString();
  const source = await new Promise((resolve, reject) => {
    const request = https.get(endpoint, { headers: { Accept: "application/dns-json", "Accept-Encoding": "identity" }, ...(signal ? { signal } : {}) }, (response) => {
      if (response.statusCode !== 200 || !/^application\/(?:dns-)?json\b/i.test(response.headers["content-type"] || "")) { response.destroy(); reject(fault("FETCH_FAILED", 422)); return; }
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > 32768) response.destroy(fault("BODY_TOO_LARGE", 413)); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    const timer = setTimeout(() => request.destroy(fault("FETCH_FAILED", 422)), 5000);
    request.on("close", () => clearTimeout(timer)); request.on("error", reject);
  });
  let data;
  try { data = JSON.parse(source); } catch { throw fault("FETCH_FAILED", 422); }
  if (data.Status !== 0 || !Array.isArray(data.Answer) || data.Answer.length > 64) throw fault("FETCH_FAILED", 422);
  return data.Answer.filter((record) => record.type === 1).map((record) => ({ address: record.data, family: 4 }));
}

export async function resolvePublicAddresses(hostname, { lookupAddress = lookup, queryPublicDNS = cloudflareDNS, signal } = {}) {
  signal?.throwIfAborted();
  let addresses = await lookupAddress(hostname.replace(/^\[|\]$/g, ""), { all: true });
  signal?.throwIfAborted();
  if (Array.isArray(addresses) && addresses.length && addresses.every((record) => record?.family === 4 && typeof record.address === "string" && proxyFakeIP(record.address))) {
    addresses = await queryPublicDNS(hostname, { signal });
  }
  signal?.throwIfAborted();
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((record) => typeof record?.address !== "string" || !publicIP(record.address) || isIP(record.address) !== record.family)) throw fault("UNSAFE_URL");
  return addresses;
}

const RESPONSE_TYPES = {
  page: { accept: "text/html,text/plain", match: /^text\/(html|plain)\b/i, maxBytes: 2_000_000 },
  metadata: { accept: "application/json", match: /^application\/json\b/i, maxBytes: 64_000 },
  "youtube-captions": { accept: "application/json,text/plain", match: /^(?:application\/json|text\/(?:plain|json))\b/i, maxBytes: 2_000_000 },
  cover: { accept: "image/jpeg,image/png,image/webp,image/avif,image/gif", match: /^image\/(?:jpeg|png|webp|avif|gif)\b/i, maxBytes: 3_000_000 },
};

export function youtubeCaptionURL(raw, videoId) {
  const url = validURL(raw);
  if (url.protocol !== "https:" || url.port || !["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname)
    || url.pathname !== "/api/timedtext" || !/^[\w-]{11}$/.test(videoId || "")
    || url.searchParams.getAll("v").length !== 1 || url.searchParams.get("v") !== videoId) throw fault("UNSAFE_URL");
  return url;
}

export function createSafeFetcher({ lookupAddress = lookup, queryPublicDNS = cloudflareDNS, httpClient = http, httpsClient = https } = {}) {
  return async function readPublicPage(raw, redirects = 0, { signal, representation = "page" } = {}) {
    if (!Object.hasOwn(RESPONSE_TYPES, representation)) throw fault("FETCH_FAILED", 422);
    const format = RESPONSE_TYPES[representation];
    // Retry only a failed public read connection, once per URL across this whole
    // redirect chain. Model requests and validation failures never enter this loop.
    const retries = new Set();
    const captionVideoId = representation === "youtube-captions" ? validURL(raw).searchParams.get("v") : undefined;
    async function readHop(raw, redirects) {
      signal?.throwIfAborted();
      const url = representation === "youtube-captions" ? youtubeCaptionURL(raw, captionVideoId) : validURL(raw);
      if (representation !== "page" && url.protocol !== "https:") throw fault("UNSAFE_URL");
      if (redirects > 4) throw fault("FETCH_FAILED", 422);
      const retryKey = url.href.split("#", 1)[0];
      let result;
      for (;;) {
        signal?.throwIfAborted();
        try {
          const addresses = await resolvePublicAddresses(url.hostname, { lookupAddress, queryPublicDNS, signal });
          signal?.throwIfAborted();
          // Pin the validated address; do not re-resolve between validation and connection.
          const { address, family } = addresses[0];
          result = await new Promise((resolve, reject) => {
            const request = (url.protocol === "https:" ? httpsClient : httpClient).get(url, {
              headers: { "User-Agent": "FORME/1.0 (user-requested content reader)", Accept: format.accept, "Accept-Encoding": "identity" },
              lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
              ...(signal ? { signal } : {}),
            }, (response) => {
              if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume(); resolve({ redirect: new URL(response.headers.location, url).href }); return;
              }
              if (response.statusCode !== 200 || !format.match.test(response.headers["content-type"] || "")) { response.destroy(); reject(fault("FETCH_FAILED", 422)); return; }
              const chunks = []; let size = 0;
              response.on("data", (chunk) => { size += chunk.length; if (size > format.maxBytes) response.destroy(fault("BODY_TOO_LARGE", 413)); else chunks.push(chunk); });
              response.on("error", reject);
              response.on("end", () => {
                const type = response.headers["content-type"];
                try {
                  const bytes = Buffer.concat(chunks);
                  resolve({ ...(representation === "cover" ? { bytes } : { text: decodePageBytes(bytes, type) }), url: url.href, type });
                }
                catch { reject(fault("FETCH_FAILED", 422)); }
              });
            });
            const timer = setTimeout(() => request.destroy(fault("FETCH_FAILED", 422)), 15000);
            request.on("close", () => clearTimeout(timer));
            request.on("error", reject);
          });
          break;
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error;
          if (!["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code) || retries.has(retryKey)) throw error;
          retries.add(retryKey);
          // Start from DNS again; an earlier validated address is never reused.
        }
      }
      signal?.throwIfAborted();
      return result.redirect ? readHop(result.redirect, redirects + 1) : result;
    }
    return readHop(raw, redirects);
  };
}
export const safeFetch = createSafeFetcher();

// Decode the declared document encoding before text extraction. In particular,
// older Chinese articles may be GBK/GB2312 rather than UTF-8. No script runs.
export function decodePageBytes(bytes, contentType = "") {
  const declared = /\bcharset\s*=\s*["']?([^\s;"'>]+)/i.exec(contentType)?.[1];
  const head = Buffer.from(bytes).subarray(0, 4096).toString("latin1");
  const meta = /<meta\b[^>]*\bcharset\s*=\s*["']?([^\s;"'>]+)/i.exec(head)?.[1];
  const label = declared || meta || "utf-8";
  try { return new TextDecoder(label).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}
function entities(text) {
  return text.replace(/&(?:[a-z][a-z\d]{1,31}|#\d+|#x[a-f\d]+);/gi, (value) => {
    if (value.startsWith("&#")) { const n = value[2].toLowerCase() === "x" ? parseInt(value.slice(3), 16) : parseInt(value.slice(2), 10); return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ""; }
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&ensp;": " ", "&emsp;": " ", "&thinsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&lsquo;": "‘", "&rsquo;": "’", "&ldquo;": "“", "&rdquo;": "”", "&bull;": "•", "&copy;": "©", "&reg;": "®", "&trade;": "™", "&times;": "×", "&divide;": "÷", "&zwj;": "", "&zwnj;": "", "&zerowidthspace;": "" })[value.toLowerCase()] ?? value;
  });
}
const RAW_TEXT_TAGS = new Set(["script", "style", "title", "textarea", "noscript", "xmp", "iframe", "noembed", "noframes"]);
const OMIT_TEXT_TAGS = new Set(["script", "style", "nav", "footer", "header", "noscript", "svg"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function tagAttributes(source) {
  const values = Object.create(null);
  const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
  for (const match of source.matchAll(expression)) {
    const name = match[1].toLowerCase();
    if (!(name in values)) values[name] = entities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return values;
}

// HTML boundary scanning, not a DOM implementation. Quoted attributes and
// comments cannot create closing tags; raw-text elements only end at their own
// closing tag. These are the boundaries a content extractor must preserve.
function tagEnd(html, start) {
  let quote = "";
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index + 1;
  }
  return -1;
}

export function htmlTokens(html) {
  const tokens = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) { tokens.push({ text: html.slice(cursor) }); break; }
    if (start > cursor) tokens.push({ text: html.slice(cursor, start) });
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    if (/^<[/]?[a-zA-Z]/.test(html.slice(start, start + 3))) {
      const name = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(start))[1].toLowerCase();
      const end = tagEnd(html, start + name.length + 1);
      if (end < 0) break;
      const closing = html[start + 1] === "/";
      // In HTML, a trailing slash does not close ordinary elements such as
      // main, script or nav. Only void elements and foreign roots can do so.
      const selfClosing = VOID_TAGS.has(name) || (["svg", "math"].includes(name) && /\/\s*>$/.test(html.slice(start, end)));
      tokens.push({ name, closing, selfClosing, attributes: closing ? {} : tagAttributes(html.slice(start + name.length + 1, end - 1)) });
      cursor = end;
      if (!closing && !selfClosing && RAW_TEXT_TAGS.has(name)) {
        const terminator = new RegExp(`<\\/${name}(?=[\\s/>])`, "ig");
        terminator.lastIndex = cursor;
        const match = terminator.exec(html);
        const rawEnd = match?.index ?? html.length;
        tokens.push({ text: html.slice(cursor, rawEnd) });
        cursor = rawEnd;
      }
    } else if (html[start + 1] === "!" || html[start + 1] === "?") {
      const end = tagEnd(html, start + 2);
      cursor = end < 0 ? html.length : end;
    } else {
      tokens.push({ text: "<" });
      cursor = start + 1;
    }
  }
  return tokens;
}

function withoutOmittedText(tokens) {
  const visible = [], omitted = [];
  for (const token of tokens) {
    if (OMIT_TEXT_TAGS.has(token.name)) {
      if (!token.closing && !token.selfClosing) omitted.push(token.name);
      else if (token.closing) {
        const index = omitted.lastIndexOf(token.name);
        if (index >= 0) omitted.splice(index);
      }
      continue;
    }
    if (!omitted.length) visible.push(token);
  }
  return visible;
}

function containerTokens(tokens, name) {
  const start = tokens.findIndex((token) => token.name === name && !token.closing && !token.selfClosing);
  if (start < 0) return null;
  let depth = 1;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.name !== name || token.selfClosing) continue;
    depth += token.closing ? -1 : 1;
    if (!depth) return tokens.slice(start + 1, index);
  }
  // An unclosed container still owns the remaining document; do not switch to
  // some nested article and silently discard the rest of the available text.
  return tokens.slice(start + 1);
}

function tokensText(tokens) {
  return tokens.map((token) => token.text !== undefined ? token.text
    : token.name === "br" || (token.closing && /^(?:p|div|section|article|main|h[1-6]|li|tr)$/.test(token.name)) ? "\n" : " ").join("");
}

export function htmlText(html) {
  const tokens = htmlTokens(html);
  const titleTokens = containerTokens(tokens, "title");
  const title = entities((titleTokens ? tokensText(titleTokens) : "") || "网页收藏").trim();
  const visible = withoutOmittedText(tokens);
  const body = containerTokens(visible, "main") ?? containerTokens(visible, "article") ?? visible;
  const text = entities(tokensText(body)).replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
  return { title: title.slice(0, 200), text };
}

const PAGE_NOISE_TAGS = new Set(["script", "style", "nav", "aside", "footer", "noscript", "svg", "form", "button", "input", "textarea", "select", "dialog", "iframe", "canvas", "template", "menu"]);
const PAGE_NOISE_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar", "toolbar"]);
const PAGE_NOISE_NAMES = /(?:^|[\s_-])(?:ad|ads|advert|advertisement|advertising|adslot|cookie-banner|consent-banner|translation-banner|prev-next|article-footer|document-footer|page-footer|newsletter|social-links|share-tools|sharing-tools|related-posts|related-content|recommended-articles|comments|comment-list|comment-form|sidebar|breadcrumbs?|navigation|pagination|toolbar)(?:$|[\s_-])/i;
const PAGE_BODY_NAMES = /(?:^|[\s_-])(?:article-content|article-body|post-content|post-body|entry-content|story-body|asset-content|markdown-body)(?:$|[\s_-])/i;
const PAGE_DECORATION = /(?:^|[\s_.-])(?:logo|avatar|icon|qrcode|tracking|pixel|spacer|placeholder)(?:$|[\s_.-])/i;

function readableTokens(tokens, { scoped = false } = {}) {
  const visible = [], stack = [], positions = new Map();
  let omitted = 0;
  for (const token of tokens) {
    if (token.text !== undefined) {
      if (!omitted) visible.push(token);
      continue;
    }
    if (token.closing) {
      const index = positions.get(token.name)?.at(-1);
      if (!omitted) visible.push(token);
      if (index !== undefined) while (stack.length > index) {
        const entry = stack.pop();
        if (entry.omit) omitted--;
        positions.get(entry.name).pop();
      }
      continue;
    }
    const attributes = token.attributes || {};
    const omit = PAGE_NOISE_TAGS.has(token.name)
      || (!scoped && token.name === "header")
      || "hidden" in attributes || "inert" in attributes
      || attributes["aria-hidden"]?.toLowerCase() === "true"
      || PAGE_NOISE_ROLES.has((attributes.role || "").toLowerCase())
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i.test(attributes.style || "")
      || PAGE_NOISE_NAMES.test([attributes.id || "", attributes.class || ""].join(" "));
    if (!omit && !omitted) visible.push(token);
    if (!token.selfClosing) {
      const indices = positions.get(token.name) || [];
      indices.push(stack.length); positions.set(token.name, indices);
      stack.push({ name: token.name, omit });
      if (omit) omitted++;
    }
  }
  return visible;
}

function markedBody(tokens) {
  const index = tokens.findIndex((token) => !token.closing && !token.selfClosing
    && (/(?:^|\s)articleBody(?:$|\s)/i.test(token.attributes?.itemprop || "")
      || token.attributes?.id === "js_content"
      || PAGE_BODY_NAMES.test([token.attributes?.id || "", token.attributes?.class || ""].join(" "))));
  if (index < 0) return null;
  const name = tokens[index].name;
  let depth = 1;
  for (let cursor = index + 1; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if (token.name !== name || token.selfClosing) continue;
    depth += token.closing ? -1 : 1;
    if (!depth) return tokens.slice(index + 1, cursor);
  }
  return tokens.slice(index + 1);
}

function pagePreview(tokens, body, { wechat } = {}) {
  const head = containerTokens(tokens, "head") ?? tokens;
  const meta = (key) => head.filter(token => token.name === "meta" && !token.closing
    && [token.attributes.property, token.attributes.name, token.attributes.itemprop].some(value => value?.toLowerCase() === key))
    .map(token => token.attributes.content).filter(Boolean);
  const images = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"].flatMap(meta);
  if (wechat) {
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].name !== "script" || tokens[index].closing) continue;
      // Read only a quoted WeChat cover variable. Page scripts never execute.
      const cover = /\b(?:msg_cdn_url|cdn_url_1_1)\s*[:=]\s*["']((?:https:)?\/\/mmbiz\.qpic\.cn\/[^"'<>\s]+)["']/i.exec(tokens[index + 1]?.text || "")?.[1];
      if (cover) { images.push(entities(cover)); break; }
    }
  }
  for (const token of body || []) {
    if (token.name !== "img") continue;
    const { alt, id, class: className, width, height, src, "data-src": dataSrc, "data-original": dataOriginal } = token.attributes;
    if ((Number(width) > 0 && Number(width) < 48) || (Number(height) > 0 && Number(height) < 48)
      || PAGE_DECORATION.test([alt, id, className, dataSrc || dataOriginal || src].filter(Boolean).join(" "))) continue;
    images.push(dataSrc, dataOriginal, src);
    if (images.filter(Boolean).length >= 12) break;
  }
  return { title: meta("og:title")[0] || meta("twitter:title")[0] || "", images: [...new Set(images.filter(Boolean))].slice(0, 12) };
}

// Structured page reading is stricter than the lossless htmlText compatibility
// extractor: remove explicit page chrome, hidden controls, ads and related feeds.
export function readableHTMLText(html, { preview = false, wechat = false } = {}) {
  const tokens = htmlTokens(String(html || ""));
  const titleTokens = containerTokens(tokens, "title");
  const title = entities((titleTokens ? tokensText(titleTokens) : "") || "网页收藏").replace(/\s+/g, " ").trim().slice(0, 300);
  const visible = readableTokens(tokens, { scoped: true });
  const main = containerTokens(visible, "main");
  const article = containerTokens(visible, "article");
  const marked = markedBody(visible);
  const selected = main ?? article ?? marked ?? containerTokens(visible, "body") ?? visible;
  const scope = main ? "main" : article ? "article" : marked ? "marked-article" : "body";
  const body = readableTokens(selected, { scoped: scope !== "body" });
  const plain = body.map((token) => token.text !== undefined ? token.text
    : token.name === "br" || /^(?:p|div|section|article|main|header|h[1-6]|li|tr|blockquote|pre|hr)$/.test(token.name) ? "\n"
      : token.name === "td" || token.name === "th" ? "\t" : "").join("");
  const articleImages = preview ? article ?? marked ?? main : null;
  return { title, text: entities(plain), scope, ...(preview ? { preview: pagePreview(tokens, articleImages, { wechat }) } : {}) };
}
