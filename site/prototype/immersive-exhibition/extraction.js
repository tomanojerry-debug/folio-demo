// 确定性本地提取模拟器
//
// 本切片不接入模型与网络。此模块为用户手动提交的文本/URL 产出
// 可解释、可复现的结构化提取结果，使 Inbox → 策展 的分支也能跑通。
//
// 设计约束（对齐 PRD FR-002 / GATE-001 与产品哲学）：
// - 不伪造理解：URL 无后端时不抓取，降级为 needs_input 并提示补充；
// - 可解释：summary、concepts、evidence、reliability 全部来自确定性规则；
// - 三档分级：reliability >= 0.75 为 qualified（进入自动策展）；
//   0.50–0.74 为 needs_confirmation（可见但不进入自动策展）；
//   < 0.50 为 needs_input（请求补充或停止处理）。

const STOPWORDS = new Set([
  // 中文虚词与高频结构词
  "的","了","和","是","在","我","有","也","就","都","不","这","那","与","或","而","及","以","为","被","把","让","向","从","到","对","于","由","给","跟","但","却","才","又","并","且",
  "如果","因为","所以","但是","虽然","不过","然后","还是","已经","正在","可以","可能","应该","需要","一个","一种","一些","什么","怎么","为什么","怎样","其实","可能","比如",
  // 英文常见停用词
  "the","a","an","and","or","but","of","to","in","on","for","with","as","is","are","be","by","that","this","it","its","from","at","into","how","why","what","when","which","you","your","we","our","they","their","them","him","her","his","she","him","me","my","do","does","did","can","could","should","would","will",
]);

export function isUrl(content) {
  return /^https?:\/\//i.test((content ?? "").trim());
}

// 切分中英文 token。英文按词，中文按 bigram 以提升概念稳定性。
function tokenize(text) {
  const lower = text.toLowerCase();
  const enTokens = lower.match(/[a-z]{2,}/g) ?? [];
  const zhRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const zhBigrams = [];
  for (const run of zhRuns) {
    if (run.length === 2) {
      zhBigrams.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i += 1) {
        zhBigrams.push(run.slice(i, i + 2));
      }
    }
  }
  return [...enTokens, ...zhBigrams];
}

export function extractConcepts(text, max = 5) {
  const tokens = tokenize(text).filter((token) => !STOPWORDS.has(token) && token.length > 1);
  const freq = new Map();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([token]) => token);
}

export function makeSummary(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 60) return clean;
  const slice = clean.slice(0, 60);
  const lastPunct = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("，"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("."),
    slice.lastIndexOf(","),
  );
  return (lastPunct > 20 ? slice.slice(0, lastPunct) : slice) + "…";
}

// 确定性可靠性：长度与概念丰富度加权，夹在 [0.40, 0.95]。
export function computeReliability(length, conceptCount) {
  const lengthScore = Math.min(1, length / 80);
  const conceptScore = Math.min(1, conceptCount / 4);
  const raw = 0.4 + 0.55 * (0.6 * lengthScore + 0.4 * conceptScore);
  return Math.round(Math.max(0.4, Math.min(0.95, raw)) * 100) / 100;
}

const MIN_LENGTH = 12;

// 返回 extraction 候选（不含 collectionId，由调用方补）。
// status: "qualified" | "needs_confirmation" | "needs_input"
export function simulateExtraction(content) {
  const text = (content ?? "").trim();

  if (!text) {
    return { status: "needs_input", reason: "empty_input", reliability: 0 };
  }

  // URL 无后端：诚实降级，不伪造对未抓取内容的理解。
  if (isUrl(text)) {
    return {
      status: "needs_input",
      reason: "url_requires_backend_or_supplement",
      reliability: 0,
      hint: "本地切片不抓取网络。请补充标题、摘录或文字稿，使其成为可策展材料。",
    };
  }

  if (text.length < MIN_LENGTH) {
    return { status: "needs_input", reason: "content_too_short", reliability: 0 };
  }

  const concepts = extractConcepts(text);
  const summary = makeSummary(text);
  const reliability = computeReliability(text.length, concepts.length);

  if (reliability < 0.5) {
    return {
      status: "needs_input",
      reason: "low_reliability",
      summary,
      concepts,
      evidence: `用户输入 · ${text.length} 字符`,
      reliability,
    };
  }

  return {
    status: reliability >= 0.75 ? "qualified" : "needs_confirmation",
    summary,
    concepts,
    evidence: `用户输入 · ${text.length} 字符`,
    reliability,
    source: "local_deterministic_simulator",
  };
}

// 把模拟器结果映射为 collection 状态。
export function collectionStatusFromExtraction(extraction) {
  if (extraction.status === "qualified") return "ready";
  if (extraction.status === "needs_confirmation") return "needs_confirmation";
  return "needs_input";
}
