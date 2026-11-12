const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_QUERY_LENGTH = 300;
const chineseCounts = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const localScope = /我的|本机|附件|(?:已有的?|已保存的?|现有的?|这些)\s*(?:收藏|知识库|资料)|(?:收藏|知识库)(?:里|中|内)|(?:这|本|当前(?:的)?)(?:篇|页|段|条|个网页|个页面|个文件)|(?:上面|刚才|之前)(?:这|的)|\b(?:my|saved|local)\s+(?:collection|library|bookmarks?|files?|notes?)\b/iu;
const webScope = /(?:^|[，,；;。\s])(?:联网|上网|全网|(?:在|从)网上)|(?:搜索|搜搜|搜一下|搜一搜|查找|找找)(?:一下)?\s*(?:网上|网络上|互联网上)|\b(?:the web|online|on the internet)\b/iu;
const chineseRequest = /^(?:(?:可以|能不能|能|可不可以)\s*)?(?:请\s*)?(?:(?:帮我|给我|麻烦你|替我)\s*)?(?:(?:联网|上网|全网|(?:在|从)网上)\s*)?(?:搜索|搜一搜|搜一下|搜搜|检索|找找|找一下|查一查|查一下|查查|查找|找|查|搜)(?!(?:错|看|收|阅|证|出|到|了|房|人))/u;
const englishRequest = /^(?:please\s+|(?:can|could|would) you\s+)?(?:search(?: the web)?(?: for)?|look up|find(?: me)?)\s+/iu;
const newsPattern = /新闻|报道|头条|热点|快讯|\b(?:news|headlines)\b/iu;
export const todayPattern = /今天|今日(?!头条)|\btoday(?:'s)?\b/iu;
export const yesterdayPattern = /昨天|昨日|\byesterday(?:'s)?\b/iu;

/** Only the submitted search request supplies query terms. No page or library context is used. */
export function parseWebSearchRequest(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (localScope.test(text) && !webScope.test(text)) return null;
  const prefix = chineseRequest.exec(text) || englishRequest.exec(text);
  if (!prefix) return null;

  let query = text.slice(prefix[0].length).replace(/^(?:(?:一下|一些|几条|有关|关于|网上的?)\s*|[：:，,\s])+/u, "").trim();
  const quantity = /(?:^|[，,;；\s])(?:给我|列出|返回|找)?\s*(\d{1,3}|[一二两三四五六七八九十])\s*(?:条|篇|个|项)\s*/u.exec(query);
  const englishQuantity = /^\s*(\d{1,3})\s+(?:(?:top|relevant)\s+)?/iu.exec(query);
  const amount = quantity?.[1] ?? englishQuantity?.[1];
  const count = amount === undefined ? DEFAULT_LIMIT : chineseCounts[amount] ?? Number(amount);
  const limit = Math.max(1, Math.min(MAX_LIMIT, count));
  const news = newsPattern.test(query);
  const dateScope = todayPattern.test(query) ? "today" : yesterdayPattern.test(query) ? "yesterday" : null;
  const recency = dateScope === "today" ? "oneDay" : dateScope || news || /最新|最近|近期|本周|过去一周|\b(?:latest|recent|this week)\b/iu.test(query) ? "oneWeek" : "noLimit";

  if (quantity || englishQuantity) {
    const match = quantity ?? englishQuantity;
    query = `${query.slice(0, match.index)} ${query.slice(match.index + match[0].length)}`.trim();
  }
  query = query.replace(/[。！？?!]+$/u, "").replace(/\s+/gu, " ").trim();
  return { query, limit, news, dateScope, recency };
}

export function validateWebSearchQuery(request) {
  return Boolean(request.query && request.query.length <= MAX_QUERY_LENGTH);
}
