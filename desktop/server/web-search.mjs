import { validURL } from "../../server/safe-fetch.mjs";
import { todayPattern, yesterdayPattern } from "../../site/curator/web-search-intent.js";

export { parseWebSearchRequest, validateWebSearchQuery } from "../../site/curator/web-search-intent.js";

const MAX_CANDIDATES = 30;
const dateFormat = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" });
const words = new Intl.Segmenter("zh", { granularity: "word" });
const genericTerms = new Set(["关于", "有关", "相关", "今天", "今日", "昨天", "昨日", "最近", "最新", "新闻", "报道", "热点", "快讯", "网站",
  "about", "an", "for", "in", "latest", "news", "of", "on", "recent", "the", "to", "today", "today's", "yesterday"]);
const tracking = /^(?:utm_\w+|fbclid|gclid|msclkid)$/iu;

function targetDay(scope, at) {
  if (!scope) return null;
  const date = new Date(at);
  if (scope === "yesterday") date.setDate(date.getDate() - 1);
  return dateFormat.format(date);
}

export function providerQuery(request, requestedAt, now) {
  const day = targetDay(request.dateScope, requestedAt);
  if (!day) return { query: request.query, recency: request.recency };
  const query = request.query.replace(request.dateScope === "today" ? todayPattern : yesterdayPattern, ` ${day} `).replace(/\s+/gu, " ").trim();
  const recency = dateFormat.format(requestedAt) === dateFormat.format(now) ? request.recency : "noLimit";
  return { query, recency };
}

function publishDay(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|(?=$|[ T]))/u.exec(value.trim());
  if (!match) return null;
  const day = [match[1], match[2].padStart(2, "0"), match[3].padStart(2, "0")].join("-");
  const canonical = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(+canonical) || canonical.toISOString().slice(0, 10) !== day) return null;
  if (/(?:T|\s)\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/iu.test(value)) {
    const time = new Date(value);
    if (Number.isFinite(+time)) return dateFormat.format(time);
  }
  return day;
}

const clean = (value, max) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max) : "";
const normalize = value => value.normalize("NFKC").toLowerCase();
const titleKey = value => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function queryTerms(query) {
  const terms = new Set();
  for (const word of words.segment(normalize(query))) {
    if (word.isWordLike && word.segment.length > 1 && !genericTerms.has(word.segment)) terms.add(word.segment);
    if (terms.size >= 16) break;
  }
  return [...terms];
}

function topicalScore(terms, title, snippet) {
  const heading = normalize(title);
  const summary = normalize(snippet);
  return terms.reduce((score, term) => score + (heading.includes(term) ? 2 : Number(summary.includes(term))), 0);
}

function canonicalLink(url) {
  const key = new URL(url);
  key.hash = "";
  for (const name of [...key.searchParams.keys()]) if (tracking.test(name)) key.searchParams.delete(name);
  key.searchParams.sort();
  return `${key.hostname.replace(/^www\./u, "")}${key.pathname.replace(/\/$/u, "")}${key.search}`;
}

/** Start with provider ranking, then favor topical matches and independent news sources. */
export function selectWebSources(candidates, request, at, { allowUndated = false } = {}) {
  const dated = targetDay(request.dateScope, at);
  const terms = queryTerms(request.query);
  const verified = [];
  const undated = [];
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const title = clean(candidate?.title, 240);
    if (!title || typeof candidate.url !== "string" || candidate.url.length > 3000) continue;
    let url;
    try { url = validURL(candidate.url); } catch { continue; }
    if (!url.hostname.includes(".")) continue;
    const publishedAt = publishDay(candidate.publishedAt);
    if (dated && publishedAt !== dated && !(allowUndated && !publishedAt)) continue;
    const domain = url.hostname.replace(/^www\./u, "");
    const label = clean(candidate.source, 100);
    const source = !label || label === url.hostname
      ? (domain === "mp.weixin.qq.com" ? "微信公众号" : domain)
      : label;
    const snippet = clean(candidate.snippet, 320);
    const row = { title, url: url.href, source, ...(publishedAt ? { publishedAt } : {}), ...(snippet ? { snippet } : {}) };
    const publisher = domain === "mp.weixin.qq.com" ? `${domain}:${source}` : domain;
    const destination = dated && !publishedAt ? undated : verified;
    destination.push({ row, publisher, score: topicalScore(terms, title, snippet) });
  }
  const seenUrls = new Set();
  const seenTitles = new Set();
  const publishers = new Set();
  const ordered = [];
  for (const group of [verified, undated]) {
    group.sort((a, b) => b.score - a.score);
    const remaining = [];
    const lowRelevance = [];
    for (const { row, publisher, score } of group) {
      const identity = canonicalLink(row.url);
      const heading = titleKey(row.title);
      if (seenUrls.has(identity) || (heading && seenTitles.has(heading))) continue;
      seenUrls.add(identity);
      if (heading) seenTitles.add(heading);
      if (!score && terms.length) { lowRelevance.push(row); continue; }
      if (request.news && publishers.has(publisher)) remaining.push(row);
      else ordered.push(row);
      publishers.add(publisher);
    }
    ordered.push(...remaining, ...lowRelevance);
  }
  return ordered.slice(0, request.limit);
}

export function webSearchReply(request, sources) {
  const scope = request.dateScope === "today" ? "今天" : request.dateScope === "yesterday" ? "昨天" : "";
  const kind = request.news ? "报道" : "网页";
  const found = sources.length;
  if (!found) return scope ? `暂时没找到能确认发布日期为${scope}的相关${kind}。` : `暂时没找到相关${kind}，可以换个关键词再搜。`;
  const confirmed = sources.filter(source => source.publishedAt).length;
  if (request.dateScope === "today" && confirmed < found) {
    return confirmed
      ? `找到 ${confirmed} 条标注为今天发布的${kind}，另有 ${found - confirmed} 条来自近 24 小时搜索，发布日期未标注。`
      : `按近 24 小时筛选找到 ${found} 条相关${kind}。来源未标注发布日期。`;
  }
  if (found < request.limit) return `找到 ${found} 条${scope}相关${kind}，附上来源和原文链接。`;
  return `为你选了 ${found} 条${scope}相关${kind}，附上来源和原文链接。`;
}
