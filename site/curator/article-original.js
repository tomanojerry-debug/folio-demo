const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const clean = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const navLabel = /^(?:skip to (?:main )?content|documentation|docs|navigation|main menu|table of contents|on this page|search(?: documentation| the docs)?|api reference|getting started|release notes|platform updates|网站导航|文档中心|跳到正文|页面目录|搜索|导航|目录)(?:\b|$)/iu;
const sectionLabel = /^(?:abstract|overview|introduction|background|context|challenge|the challenge|solution|the solution|methods?|methodology|results?|key findings|discussion|impact|conclusions?|limitations|references|resources|prerequisites|requirements|quickstart|installation|configuration|examples?|use cases?|users and stakeholders|how it works|(?:how to|implement a similar|step \d+[:.]) .+|摘要|简介|概述|背景|挑战|解决方案|方法|研究方法|结果|发现|讨论|影响|结论|局限|参考资料|安装|配置|示例|(?:第[一二三四五六七八九十\d]+[章节]).*)$/iu;
const titleDivider = /\s*[•|｜»›]\s*|\s+(?:\\|—|–|-)\s+/u;
const arrow = /^[←→‹›«»↗]+$/u;

function titleHints(article) {
  const title = String(article.title || '');
  let slug = '';
  try {
    const path = new URL(article.url).pathname.split('/').filter(Boolean).at(-1);
    if (path) slug = decodeURIComponent(path).replace(/\.(?:html?|aspx|md)$/iu, '');
  } catch {}
  return new Set([title, ...title.split(titleDivider), slug].map(clean).filter(hint => hint.length >= 6));
}

function looksLikeProse(paragraph) {
  const text = paragraph.text.trim();
  return text.length >= 65 && (/[。！？.!?]$/u.test(text) || text.length >= 110);
}

function articleTitleIndex(paragraphs, article) {
  const hints = titleHints(article);
  for (const [index, paragraph] of paragraphs.slice(0, 60).entries()) {
    if (paragraph.text.length > 150 || !hints.has(clean(paragraph.text))) continue;
    const following = paragraphs.slice(index + 1, index + 7);
    if (!following.some(looksLikeProse)) continue;
    if (index <= 2) return index;
    const before = paragraphs.slice(0, index);
    // A matching title alone is common in a table of contents. Require
    // recognizable navigation and a complete run of short labels before it.
    if (before.length >= 4 && before.some(row => navLabel.test(row.text.trim()))
      && before.every(row => row.text.length <= 100 && !looksLikeProse(row))) return index;
  }
  return -1;
}

function direction(text) {
  if (/^PREVIOUS(?=[A-Z\s]|$)|^(?:Previous (?:article|page)\b|上一篇|上一页)/u.test(text)) return 'previous';
  if (/^NEXT(?=[A-Z\s]|$)|^(?:Next (?:article|page)\b|下一篇|下一页)/u.test(text)) return 'next';
  return '';
}

function footerIndex(paragraphs, start) {
  const tail = paragraphs.slice(Math.max(start + 1, paragraphs.length - 10));
  const first = tail.findIndex(paragraph => direction(paragraph.text.trim()));
  if (first < 0) return paragraphs.length;
  const following = tail.slice(first);
  const directions = new Set(following.map(row => direction(row.text.trim())).filter(Boolean));
  if (directions.size !== 2 || !following.every(row => row.text.length <= 150 && (direction(row.text.trim()) || arrow.test(row.text.trim())))) return paragraphs.length;
  const previousIsArrow = first > 0 && arrow.test(tail[first - 1].text.trim());
  return paragraphs.length - tail.length + first - Number(previousIsArrow);
}

function blockHTML(paragraph, index, selected, tag = 'p', modifier = '') {
  const start = selected?.paragraphId === paragraph.id ? selected.start : -1;
  const end = start + (selected?.quote?.length || 0);
  const exact = Number.isSafeInteger(start) && start >= 0 && end > start && paragraph.text.slice(start, end) === selected.quote;
  const content = exact ? `${escape(paragraph.text.slice(0, start))}<mark class="forme-reading-source-mark">${escape(paragraph.text.slice(start, end))}</mark>${escape(paragraph.text.slice(end))}` : escape(paragraph.text);
  const id = escape(paragraph.id);
  return `<${tag} id="forme-reading-paragraph-${id}" data-reading-paragraph="${id}"${modifier} tabindex="-1"><span class="forme-reading-paragraph-number" aria-hidden="true">${index + 1}</span>${content}</${tag}>`;
}

function rawHTML(rows, offset, kind, label, selected) {
  if (!rows.length) return '';
  const selectedInside = rows.some(row => row.id === selected?.paragraphId);
  return `<details class="forme-reading-original-raw" data-reading-raw data-reading-details="original-${kind}"${selectedInside ? ' open' : ''}><summary>${label} <span>${rows.length} 段</span></summary><div>${rows.map((row, index) => blockHTML(row, index + offset, selected)).join('')}</div></details>`;
}

export function renderArticleOriginal(article, selected) {
  const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
  if (!paragraphs.length) return '';
  const webpage = article.sourceKind === 'body_text' && /^https?:\/\//iu.test(article.url || '');
  const title = webpage ? articleTitleIndex(paragraphs, article) : -1;
  const start = title >= 4 ? title : 0;
  const end = webpage ? footerIndex(paragraphs, start) : paragraphs.length;
  const groups = [];
  for (let index = start; index < end; index++) {
    const paragraph = paragraphs[index];
    const value = paragraph.text.trim();
    const heading = index === title ? 'h2'
      : webpage && (/^#{1,5}\s+\S/u.test(value) || (index + 1 < end && value.length <= 85 && sectionLabel.test(value))) ? 'h3' : '';
    if (!groups.length || heading) groups.push({ heading:heading ? paragraph.id : '', content:[] });
    const modifier = `${index === start ? ' data-reading-article-start' : ''}${heading ? ' class="forme-reading-original-heading"' : ''}`;
    groups.at(-1).content.push(blockHTML(paragraph, index, selected, heading || 'p', modifier));
  }
  const body = groups.map(({ heading, content }) => heading
    ? `<section class="forme-reading-original-group" aria-labelledby="forme-reading-paragraph-${escape(heading)}">${content.join('')}</section>`
    : `<div class="forme-reading-original-group">${content.join('')}</div>`).join('');
  return `<div class="forme-reading-prose forme-reading-original">${rawHTML(paragraphs.slice(0, start), 0, 'header', '原网页导航', selected)}${body}${rawHTML(paragraphs.slice(end), end, 'footer', '原网页翻页链接', selected)}</div>`;
}
