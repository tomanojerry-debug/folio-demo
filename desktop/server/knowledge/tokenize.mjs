const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const STOP_WORDS = new Set(("a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them there these they this those to us was we were what when where which who why will with would you your should also every rather not using used 请 请问 帮我 这个 那个 这些 那些 这篇 那篇 这页 页面 网页 当前 本轮 收藏 收藏的 文章 内容 关于 什么 怎么 如何 为什么 能否 可以 有没有 一下 看看 聊聊 讨论 观点 之前 以前 最近 已经 记得 告诉 还有 是否 以及 之间 相关 资料 东西 想要 我们 你们 他们 我的 你的 我的收藏 说说 对比 比较 有什么 有哪些 是什么 一篇 一条 哪些 哪个 类似 相似 找到 寻找 找出 帮助 介绍 需要 一个 一种 使用 通过 这里 其中 进行 可能 这样 那样 不同 更多 原文 来源 材料 保留 继续 解释 知道 说明 不能 不要 不用 应该 能够 必须 成为 方式 影响 有关 以便 每次" ).split(" "));
const SINGLE_FUNCTION_WORDS = new Set("的一是在和与及了也都而并或其所把被将让为于要应可不但只等中对从用来去到上下面就很更最".split(""));

export const TOKENIZER_VERSION = "intl-zh-words-bigrams-v2";
export const normalizeSearchText = value => typeof value === "string" ? value.normalize("NFKC").toLowerCase() : "";

// Search text is derived. Never use it to calculate offsets into the original.
function* tokenVariants(term, fragments) {
  if (term.length < 2 || STOP_WORDS.has(term) || !/^[\p{Script=Han}a-z0-9_-]+$/u.test(term)) return;
  yield term;
  if (fragments && /^[\p{Script=Han}]{4,}$/u.test(term)) {
    for (let index = 0; index < term.length - 1; index++) {
      const fragment = term.slice(index, index + 2);
      if (!STOP_WORDS.has(fragment)) yield fragment;
    }
  }
}
function* tokens(value, fragments = true) {
  let singles = "", previousHan = "";
  for (const part of segmenter.segment(normalizeSearchText(value))) {
    const term = part.segment;
    if (part.isWordLike && /^[\p{Script=Han}]$/u.test(term) && !SINGLE_FUNCTION_WORDS.has(term)) {
      singles += term;
      // ICU splits domain words such as 自然/光 and unknown names such as
      // 卡/塔/兰/数. Preserve these short compounds instead of losing them.
      if (previousHan && singles.length <= 2) yield* tokenVariants(previousHan + singles, fragments);
      continue;
    }
    if (singles.length >= 2) yield* tokenVariants(singles, fragments);
    singles = "";
    previousHan = "";
    if (!part.isWordLike) continue;
    yield* tokenVariants(term, fragments);
    if (/^[\p{Script=Han}]{2,6}$/u.test(term) && !STOP_WORDS.has(term)) previousHan = term;
  }
  if (singles.length >= 2) yield* tokenVariants(singles, fragments);
}

export function searchTerms(value, { limit = 64, fragments = true } = {}) {
  const terms = new Set();
  for (const term of tokens(value, fragments)) {
    terms.add(term);
    if (terms.size >= limit) break;
  }
  return [...terms].slice(0, limit);
}

// Coverage counts independent query units, not every bigram of one name.
export function searchUnits(value, { limit = 64 } = {}) {
  const terms = searchTerms(value, { limit, fragments: false });
  return terms.filter(term => !terms.some(other => other.length > term.length && /^[\p{Script=Han}]+$/u.test(other) && other.includes(term)));
}

export function indexText(value) {
  const result = [];
  for (const term of tokens(value)) {
    result.push(term);
    if (result.length >= 200000) break;
  }
  return result.join(" ");
}

export function matchExpression(terms) {
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function canonicalSourceUrl(raw) {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key.toLowerCase())) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return ""; }
}
