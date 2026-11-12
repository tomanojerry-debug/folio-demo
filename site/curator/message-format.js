// A deliberately small, escaped Markdown renderer for ordinary chat replies.
const escape = (text) => String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
function inline(text) {
  return String(text).split(/(`[^`\n]+`)/g).map(part => {
    if (part.startsWith('`') && part.endsWith('`')) return `<code>${escape(part.slice(1, -1))}</code>`;
    return escape(part).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }).join('');
}
export function formatMessage(text = '') {
  const output = [];
  let paragraph = [], list = [], listTag = '', code = null;
  const flushParagraph = () => { if (paragraph.length) output.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; };
  const flushList = () => { if (list.length) output.push(`<${listTag}>${list.map(value => `<li>${inline(value)}</li>`).join('')}</${listTag}>`); list = []; listTag = ''; };
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      flushParagraph(); flushList();
      if (code === null) code = [];
      else { output.push(`<pre aria-label="代码片段"><code>${escape(code.join('\n'))}</code></pre>`); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); output.push(`<p class="message-section-title">${inline(heading[1])}</p>`); continue; }
    const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (bullet) {
      flushParagraph();
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (listTag && listTag !== tag) flushList();
      listTag = tag; list.push(bullet[1]); continue;
    }
    flushList(); paragraph.push(line);
  }
  flushParagraph(); flushList();
  if (code !== null) output.push(`<pre aria-label="代码片段"><code>${escape(code.join('\n'))}</code></pre>`);
  return output.join('');
}
