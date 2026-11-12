import { readableHTMLText, validURL } from "../../server/safe-fetch.mjs";

const MAX_TEXT = 40000;
const MAX_SELECTION = 12000;
const BOILERPLATE_LINE = /^(?:返回顶部|回到顶部|跳(?:转)?到(?:正文|主要内容)|跳过导航|复制(?:本文|页面)?链接|分享到(?:微信|微博|朋友圈|QQ|Facebook|Twitter|X)|分享此(?:文|页)|扫码关注|扫描二维码|关注公众号|订阅(?:新闻|邮件|周刊)|接受所有(?:Cookie|cookies)|拒绝所有(?:Cookie|cookies)|管理(?:Cookie|cookies)|(?:上一页|下一页)\s*[|｜·•/]\s*(?:上一页|下一页))[\s。.!！…]*$/i;

/** Clean text supplied by the associated browser without treating code as HTML. */
export function cleanPageText(value, { limit = MAX_TEXT, dropActions = true } = {}) {
  const original = String(value || "").replace(/\r\n?/g, "\n");
  const lines = original.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .split("\n").map((line) => line.replace(/[\t \u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, " ").trim());
  const retained = [], seenParagraphs = new Set();
  let removedLines = 0, last = "";
  for (const line of lines) {
    if (!line) continue;
    // Long identical paragraphs commonly come from duplicated desktop/mobile
    // layouts. Short repeated words/headings may be editorial, so retain them.
    if ((dropActions && BOILERPLATE_LINE.test(line)) || line === last || (line.length >= 40 && seenParagraphs.has(line))) { removedLines++; continue; }
    retained.push(line); last = line;
    if (line.length >= 40) seenParagraphs.add(line);
  }
  const complete = retained.join("\n\n");
  const text = complete.slice(0, limit).trimEnd();
  return { text, characterCount: text.length, paragraphCount: text ? text.split("\n\n").length : 0,
    removedLines, truncated: complete.length > limit, originalCharacterCount: original.length };
}

function quality(cleaned, { method, scope, truncated = false, selectionOnly = false } = {}) {
  const warnings = [];
  if (cleaned.characterCount < 200) warnings.push("SHORT_CONTENT");
  if (truncated || cleaned.truncated) warnings.push("TRUNCATED");
  if (scope === "body") warnings.push("BODY_FALLBACK");
  if (method === "browser-accessibility") warnings.push("BROWSER_TEXT_HEURISTICS");
  if (selectionOnly) warnings.push("SELECTION_ONLY");
  return { version: 1, status: cleaned.characterCount === 0 ? "unavailable" : warnings.some((value) => ["SHORT_CONTENT", "TRUNCATED", "SELECTION_ONLY"].includes(value)) ? "partial" : "ready",
    method, scope, characterCount: cleaned.characterCount, paragraphCount: cleaned.paragraphCount,
    removedLines: cleaned.removedLines, truncated: Boolean(truncated || cleaned.truncated), warnings };
}

function sparseBrowserText(value) {
  const lines = value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 8) return false;
  const substantive = lines.filter((line) => line.length >= 60 || (line.length >= 20 && /[。！？.!?，,:：;]/u.test(line)));
  return substantive.reduce((count, line) => count + line.length, 0) < Math.max(40, value.length * .3);
}

function unavailable(context, code = "PAGE_CONTENT_UNAVAILABLE") {
  return { ...context, text: "", selection: "", readStatus: "unavailable", readError: code,
    contentQuality: { version: 1, status: "unavailable", characterCount: 0, paragraphCount: 0, warnings: [code] } };
}

function challengePage({ title, text, requestedURL, resolvedURL }) {
  const authPath = (raw) => /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i.test(new URL(raw).pathname);
  return (!authPath(requestedURL) && authPath(resolvedURL))
    || /^(?:just a moment|attention required|access denied|robot check|安全验证|访问验证|身份验证|环境异常)(?:\b|[，。！：\s]|$)/i.test(title.trim())
    || (text.length < 1500 && /(?:^|\n)\s*(?:javascript is not available|please enable javascript|enable javascript and cookies|checking your browser|verify (?:that )?you are human|请(?:先)?登录后(?:查看|阅读)|请完成(?:安全|身份)验证|当前环境异常|访问环境异常)/i.test(text));
}

/** One cleaning path for public HTTP reads, explicit browser text and selection. */
export function pageContentFromResponse(page, context, { limit = MAX_TEXT, includePreview = false } = {}) {
  if (typeof page?.text !== "string") return unavailable(context, "FETCH_FAILED");
  if (page.type && !/^text\/(?:html|plain)\b/i.test(page.type)) return unavailable(context, "FETCH_FAILED");
  const resolvedUrl = validURL(page.url || context.url).href;
  const plain = /^text\/plain\b/i.test(page.type || "");
  const wechat = new URL(resolvedUrl).hostname === "mp.weixin.qq.com";
  const extracted = plain ? { title: page.title || context.title || "网页收藏", text: page.text, scope: "plain-text" } : readableHTMLText(page.text, { preview: includePreview, wechat });
  const cleaned = cleanPageText(extracted.text, { limit, dropActions: false });
  if (challengePage({ title: extracted.title, text: cleaned.text, requestedURL: context.url, resolvedURL: resolvedUrl })) return unavailable(context);
  const preview = includePreview && extracted.preview ? { preview: { ...extracted.preview, baseURL: resolvedUrl } } : {};
  if (cleaned.characterCount < 20) return { ...unavailable(context), ...preview };
  const replacementCount = (cleaned.text.match(/\ufffd/g) || []).length;
  if (replacementCount > 10 && replacementCount / cleaned.text.length > .025) return unavailable(context, "PAGE_ENCODING_ERROR");
  return { ...context, title: context.title || extracted.title, documentTitle: extracted.title,
    text: cleaned.text, resolvedUrl, readStatus: "public_page", contentSource: "public-page", ...preview,
    textTruncated: Boolean(cleaned.truncated), contentQuality: quality(cleaned, { method: plain ? "plain-text" : "semantic-html", scope: extracted.scope }) };
}

export async function readPageContent(context, { fetchPage, signal } = {}) {
  signal?.throwIfAborted();
  const body = cleanPageText(context.text);
  const selection = cleanPageText(context.selection, { limit: MAX_SELECTION });
  if (context.url && context.contentSource === "browser-accessibility" && !selection.text
      && challengePage({ title: context.title || "", text: body.text, requestedURL: context.url, resolvedURL: context.url })) return unavailable(context);
  const sparse = context.contentSource === "browser-accessibility" && sparseBrowserText(body.text);
  const needsPublicCompletion = context.url && context.contentSource === "browser-accessibility"
    && !selection.text && (context.textTruncated || body.truncated || sparse);
  let completionError;
  if (needsPublicCompletion) {
    try {
      const page = await fetchPage(context.url, 0, { signal });
      signal?.throwIfAborted();
      const completed = pageContentFromResponse(page, context);
      if (completed.readStatus !== "unavailable") return { ...completed,
        contentQuality: { ...completed.contentQuality, fallbackFrom: "browser-accessibility",
          fallbackReason: context.textTruncated || body.truncated ? "TRUNCATED_BROWSER_TEXT" : "SPARSE_BROWSER_TEXT" } };
      completionError = completed.readError;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      completionError = error.code || "FETCH_FAILED";
    }
  }
  const usableBody = body.characterCount >= 20 || (body.characterCount > 0 && (!context.url || context.contentSource !== "browser-accessibility"));
  if (usableBody || selection.characterCount > 0) {
    const selectionOnly = !usableBody;
    const source = context.contentSource || "attachment";
    const cleaned = selectionOnly ? selection : body;
    const contentQuality = quality(cleaned, { method: source, scope: selectionOnly ? "selection" : "browser-text",
      truncated: Boolean(context.textTruncated), selectionOnly });
    if (sparse) { contentQuality.status = "partial"; contentQuality.warnings.push("SPARSE_BROWSER_TEXT"); }
    if (completionError) {
      contentQuality.status = "partial"; contentQuality.warnings.push("PUBLIC_FALLBACK_UNAVAILABLE");
      contentQuality.fallbackError = completionError;
    }
    return { ...context, text: selectionOnly ? "" : body.text, selection: selection.text,
      readStatus: selectionOnly ? "selection_only" : "attached_text", contentSource: source,
      textTruncated: Boolean(context.textTruncated || body.truncated),
      contentQuality };
  }
  if (needsPublicCompletion) return unavailable(context, completionError || "PAGE_CONTENT_UNAVAILABLE");
  if (!context.url) return unavailable(context);
  try {
    const page = await fetchPage(context.url, 0, { signal });
    signal?.throwIfAborted();
    return pageContentFromResponse(page, context);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    return unavailable(context, error.code || "FETCH_FAILED");
  }
}
