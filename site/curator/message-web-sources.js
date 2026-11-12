const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const text = (value, limit) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, limit) : '';
// Local source markers avoid loading images from external sites.
const favicons = Object.freeze({
  'github.com':'github.svg',
  'anthropic.com':'anthropic.png',
  'google.com':'google.png',
  'wikipedia.org':'wikipedia.png',
});

function sourceIcon(host) {
  if (host === 'mp.weixin.qq.com') return '<span class="message-web-icon is-wechat" aria-hidden="true"></span>';
  const site = Object.keys(favicons).find(domain => host === domain || host.endsWith(`.${domain}`));
  if (site) return `<span class="message-web-icon has-favicon" aria-hidden="true"><img src="/curator/assets/search-sources/${favicons[site]}" alt="" width="16" height="16"></span>`;
  return `<span class="message-web-icon" aria-hidden="true">${escape(host.at(0)?.toUpperCase() || '↗')}</span>`;
}

function webSources(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.webSources)) return [];
  return message.webSources.flatMap(row => {
    const title = text(row?.title, 300);
    if (!title || typeof row?.url !== 'string' || row.url.length > 4000) return [];
    let url;
    try { url = new URL(row.url); } catch { return []; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
    const host = url.hostname.replace(/^www\./u, '');
    const source = text(row.source, 100) || host;
    const date = typeof row.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(row.publishedAt) ? row.publishedAt : '';
    return [{ title, url:url.href, source, date, host, snippet:text(row.snippet, 300) }];
  });
}

export function renderMessageWebSources(message) {
  const sources = webSources(message);
  if (!sources.length) return '';
  const results = sources.map(({ title, url, source, date, host, snippet }) => `
    <li class="message-web-result">
      <a class="message-web-link" href="${escape(url)}" data-external target="_blank" rel="noopener noreferrer">
        <span class="message-web-origin">${sourceIcon(host)}<span>${escape(source)}</span>${date ? `<time datetime="${date}">${date}</time>` : ''}</span>
        <strong class="message-web-title">${escape(title)}</strong>
      </a>
      ${snippet ? `<p class="message-web-snippet">${escape(snippet)}</p>` : ''}
    </li>`).join('');
  return `<ul class="message-web-sources" role="list" aria-label="网页搜索结果">${results}</ul>`;
}

export function messageWebSourcesText(message) {
  return webSources(message).map(({ title, url, source, date, snippet }) =>
    [title, [source, date].filter(Boolean).join(' · '), snippet, url].filter(Boolean).join('\n'),
  ).join('\n\n');
}
