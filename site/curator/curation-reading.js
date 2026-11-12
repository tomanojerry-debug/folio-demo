import { icon } from '../prototype/immersive-exhibition/light-workspace.js';
import { TOPIC_EDITORIAL_MODES, TOPIC_PRESET_MODES } from './curation-mode-definitions.js';

const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
export const safeSourceURL = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
export const CURATION_MODES = Object.freeze({ overview:'速览', compare:'来源对照', full:'脉络深读' });
export const CURATION_READING_MODES = Object.freeze({ ...TOPIC_EDITORIAL_MODES, ...TOPIC_PRESET_MODES });

function readingModeMenu(preparedModes) {
  const modes = Object.entries(TOPIC_PRESET_MODES).filter(([id]) => !preparedModes || preparedModes.includes(id));
  return `<div class="dropdown-menu folio-story-model-picker" data-curation-model-menu>
    <button type="button" class="btn folio-story-model-picker-trigger" data-variant="outline" data-size="sm" id="folio-story-mode-trigger" aria-haspopup="menu" aria-controls="folio-story-mode-menu" aria-expanded="false" aria-describedby="folio-story-mode-disclosure"><span data-curation-model-label>更多读法</span>${icon('chevron')}</button>
    <div class="folio-story-model-picker-options" data-popover aria-hidden="true">
      <p class="folio-story-caption folio-story-mode-disclosure" id="folio-story-mode-disclosure">${preparedModes ? '策展读稿已整理好，每节可打开对应的原文。' : '缺少读稿时自动生成，并向已配置的模型发送本展原文片段。'}</p>
      <div role="menu" id="folio-story-mode-menu" aria-labelledby="folio-story-mode-trigger">
        ${modes.map(([mode, { label }]) => `<button type="button" id="folio-story-mode-${mode}" class="folio-story-model-picker-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-curation-action="mode" data-curation-mode="${mode}">${esc(label)}<span data-indicator aria-hidden="true">${icon('check')}</span></button>`).join('')}
      </div>
    </div>
  </div>`;
}

export function readingTabs({ model = false, preparedModes } = {}) {
  const picker = model || preparedModes?.length ? readingModeMenu(preparedModes) : '';
  const style = picker ? ' class="btn" data-size="sm" data-variant="ghost"' : '';
  const tabs = Object.entries(CURATION_MODES).map(([mode, label]) => {
    const selected = mode === 'overview';
    return `<button type="button" role="tab" id="folio-story-tab-${mode}" aria-controls="folio-story-panel-${mode}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-curation-action="mode" data-curation-mode="${mode}"${style}>${label}</button>`;
  }).join('');
  return `<div class="collection-glass__tabs folio-story-modes" role="tablist" aria-orientation="horizontal" aria-label="展览阅读方式">${tabs}</div>${picker}<button type="button" class="btn ws-button folio-story-default" data-size="sm" data-variant="ghost" data-curation-action="default-mode">设为默认</button><span class="folio-story-sr-only" data-curation-mode-status role="status"></span>`;
}

export function readingPanel(mode, content, extra = '') {
  return `<section class="folio-story-${mode === 'full' ? 'rooms' : mode}" id="folio-story-panel-${mode}" data-curation-panel="${mode}" role="tabpanel" aria-labelledby="folio-story-tab-${mode}" ${extra}${mode === 'overview' ? '' : ' hidden'}>${content}</section>`;
}

const citation = ({ id, label, number, badge }) => `<button class="folio-story-citation" type="button" data-curation-action="evidence" data-curation-evidence="${esc(id)}" aria-label="查看原文：${esc(label)}${badge ? `，${esc(badge)}` : ''}"><span aria-hidden="true">${esc(number)}</span>${esc(label)}${badge ? ` · ${esc(badge)}` : ''}<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 2h6v6M10 2 3 9"/></svg></button>`;
export const readingCitations = refs => refs.length ? `<div class="folio-story-citations">${refs.map(citation).join('')}</div>` : '';

export function editorialSourceLinks(items, { showTitle = true } = {}) {
  const links = items.flatMap(item => {
    const url = safeSourceURL(item?.url);
    if (!url) return [];
    return [`<a class="folio-story-citation" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="打开原文：${esc(item.title)}" title="${esc(item.title)}">${esc(showTitle ? item.title : item.source || item.title)} ${icon('external')}</a>`];
  });
  return links.length ? `<div class="folio-story-citations">${links.join('')}</div>` : '';
}

export function renderPreparedReading(mode, entries, items) {
  const template = TOPIC_PRESET_MODES[mode];
  const terms = mode === 'five-ws' || mode === 'concepts';
  const lang = mode === 'english' ? ' lang="en"' : '';
  const body = template.slots.map(({ id, label }) => {
    const entry = entries[id];
    const refs = editorialSourceLinks(entry.collectionIds.map(collectionId => items.get(collectionId)));
    const content = `<p${lang}>${esc(entry.text)}</p>${refs}`;
    const slot = `data-curation-model-slot="${esc(id)}"`;
    return terms ? `<div ${slot}><dt>${esc(label)}</dt><dd>${content}</dd></div>` : `<section ${slot}><h3${lang}>${esc(label)}</h3>${content}</section>`;
  }).join('');
  const list = terms ? `<dl class="folio-story-model-entries">${body}</dl>` : `<div class="folio-story-model-entries">${body}</div>`;
  return `<section class="folio-story-model" data-curation-panel="${mode}" aria-labelledby="folio-story-prepared-${mode}" hidden>
    <header class="folio-story-model-heading"><h2 id="folio-story-prepared-${mode}">${esc(template.label)}</h2><p>策展读稿 · 附原文链接</p></header>
    <div class="folio-story-model-copy" data-curation-model-template="${mode}">${list}</div>
  </section>`;
}

export function exampleSourceCards(example) {
  return example.sources.map((source, i) => `<a class="folio-story-reading-source" href="${esc(safeSourceURL(source.url))}" target="_blank" rel="noopener noreferrer"><span class="folio-story-source-index" aria-hidden="true">0${i + 1}</span><span><small>${esc(source.publisher)} <span>·</span> <time datetime="${esc(source.date)}">${esc(source.date)}</time></small><strong lang="en">${esc(source.title)}</strong><em>${esc(source.role)}${source.contribution ? ` · ${esc(source.contribution)}` : ''}</em></span><span aria-hidden="true">↗</span></a>`).join('');
}

export function sourceEvidence(reading, id) {
  if (typeof id !== 'string' || !id || !Array.isArray(reading?.evidence) || !Array.isArray(reading.sources)) return null;
  const item = reading.evidence.find(row => row?.id === id);
  if (typeof item?.sourceId !== 'string' || !item.sourceId) return null;
  const index = reading.sources.findIndex(row => row?.id === item.sourceId);
  if (index < 0) return null;
  const source = reading.sources[index];
  return { ...item, source, label:source.publisher || source.title, number:index + 1 };
}

const lead = (label, title, description) => `<header class="folio-story-reading-lead"><p>${label}</p><h2>${title}</h2><span>${description}</span></header>`;

export function localTopicSourceCards(reading) {
  return reading.sources.map(source => `<button class="folio-story-reading-source" type="button" data-curation-action="open-collection" data-curation-item="${esc(source.id)}">
    <span><small>${esc(source.publisher)}${source.publishedAt ? ` · <time datetime="${esc(source.publishedAt)}">${esc(source.publishedAt.slice(0, 10))}</time>` : ''}</small>
    <strong>${esc(source.title)}</strong>${source.role ? `<em>${esc(source.role)}</em>` : ''}</span><span aria-hidden="true">↗</span>
  </button>`).join('');
}

export function localTopicEvidence(reading, id) {
  const item = sourceEvidence(reading, id);
  if (!item || !item.documentVersionId || item.source.documentVersionId !== item.documentVersionId
    || !Number.isSafeInteger(item.start) || item.start < 0 || !Number.isSafeInteger(item.end)
    || typeof item.quote !== 'string' || !item.quote.trim() || item.end - item.start !== item.quote.length) return null;
  return item;
}

export function modelReadingPanel() {
  return `<section class="folio-story-model" id="folio-story-model-panel" data-curation-model-panel aria-labelledby="folio-story-model-heading" hidden>
    <header class="folio-story-model-heading"><h2 id="folio-story-model-heading" data-curation-model-heading></h2><p data-curation-model-description></p></header>
    <div data-curation-model-result></div>
    <form data-curation-model-form>
      <div class="folio-story-model-actions" data-curation-model-actions>
        <button class="btn ws-button" data-variant="primary" data-size="sm" type="submit" data-curation-model-generate aria-describedby="folio-story-model-disclosure" disabled>生成</button>
        <p class="folio-story-caption" id="folio-story-model-disclosure" data-curation-model-disclosure>点击生成后，Folio 会把本展的收藏原文片段发送给已配置的模型。</p>
      </div>
      <p class="folio-story-model-status" role="status" data-curation-model-status></p>
      <button class="btn ws-button" data-variant="outline" data-size="sm" type="button" data-curation-action="reload-model-reading" hidden>重新读取</button>
    </form>
  </section>`;
}

export function renderModelReading(result, mode) {
  if (!Object.hasOwn(CURATION_READING_MODES, mode)) return '';
  const { slots } = CURATION_READING_MODES[mode];
  if (!Array.isArray(result?.entries) || result.entries.length !== slots.length) return '';
  const entries = new Map();
  for (const entry of result.entries) {
    if (typeof entry?.slot !== 'string' || entries.has(entry.slot)) return '';
    entries.set(entry.slot, entry);
  }

  const terms = mode === 'five-ws' || mode === 'concepts';
  const english = mode === 'english';
  const lang = english ? ' lang="en"' : '';
  const missingText = english
    ? (result.truncated ? 'Not specified in the provided excerpts.' : 'Not specified in the provided sources.')
    : (result.truncated ? '所给原文片段未说明。' : '所给原文未说明。');
  const coverage = english
    ? (result.truncated ? 'Based on excerpts from this exhibition’s saved sources.' : 'Based on this exhibition’s saved sources.')
    : (result.truncated ? '根据本展收藏的原文片段整理。' : '根据本展收藏的原文整理。');
  const body = [];
  for (const { id, label } of slots) {
    const entry = entries.get(id);
    if (!entry || entry.label !== label || !Array.isArray(entry.evidenceIds)) return '';
    const missing = entry.status === 'missing';
    if (missing ? entry.evidenceIds.length !== 0 : entry.status !== undefined || typeof entry.text !== 'string' || !entry.text.trim() || !entry.evidenceIds.length) return '';
    const refs = entry.evidenceIds.map(evidenceId => localTopicEvidence(result, evidenceId));
    if (refs.some(ref => !ref)) return '';
    const sources = readingCitations(refs);
    const slot = `data-curation-model-slot="${esc(id)}"${missing ? ' class="folio-story-model-missing"' : ''}`;
    const content = `<p${lang}>${esc(missing ? missingText : entry.text)}</p>${sources}`;
    body.push(terms ? `<div ${slot}><dt${lang}>${esc(label)}</dt><dd>${content}</dd></div>`
      : `<section ${slot}><h3${lang}>${esc(label)}</h3>${content}</section>`);
  }
  const caption = `<p class="folio-story-caption"${lang}>${esc(coverage)}</p>`;
  const entriesHTML = terms ? `<dl class="folio-story-model-entries">${body.join('')}</dl>` : `<div class="folio-story-model-entries">${body.join('')}</div>`;
  const editorial = Object.hasOwn(TOPIC_EDITORIAL_MODES, mode);
  return `<div class="folio-story-model-copy" data-curation-model-template="${mode}">${editorial ? entriesHTML + caption : caption + entriesHTML}</div>`;
}

function renderSourceReading(reading, style, { local = false, back, media, title, subtitle, note = '' }) {
  const resolve = local ? localTopicEvidence : sourceEvidence;
  const refs = entry => entry.evidenceIds.map(id => resolve(reading, id)).filter(Boolean);
  const verified = entries => entries.filter(entry => Array.isArray(entry.evidenceIds)
    && entry.evidenceIds.length && refs(entry).length === entry.evidenceIds.length);
  const cite = entry => readingCitations(refs(entry));
  const sourceControl = `<button class="folio-story-related" type="button" data-curation-action="collections">${local ? '' : `<span class="folio-story-publishers" aria-hidden="true">${reading.sources.map(source => `<i>${esc(source.publisher)}</i>`).join('')}</span>`}${reading.sources.length} 篇${local ? '收藏原文' : '原始报道'}</button>`;
  const overview = `${local ? '' : lead('01 / 快速了解', '三条要点', '先读结果，再决定要追哪条证据。')}
    <ol class="folio-story-brief">${verified(reading.overview).map((entry, i) => `<li>${local ? '' : `<span class="folio-story-brief-index" aria-hidden="true">0${i + 1}</span>`}
      <div>${entry.title ? `<h3>${esc(entry.title)}</h3>` : ''}<p>${esc(entry.text)}</p>${cite(entry)}</div>
    </li>`).join('')}</ol>`;
  const comparison = `${local ? '' : lead('02 / 看各家怎么说', '同一件事，三个视角', '沿着同一个问题读，看看每家来源提供了什么。')}
    ${reading.comparison.map(group => {
      const entries = verified(group.entries);
      if (!entries.length) return '';
      return `<section class="folio-story-comparison"><h3>${esc(group.title)}</h3>${group.prompt ? `<p>${esc(group.prompt)}</p>` : ''}
        <div class="folio-story-compare-grid">${entries.map(entry => `<article>${entry.title ? `<h4>${esc(entry.title)}</h4>` : ''}<p>${esc(entry.text)}</p>${cite(entry)}</article>`).join('')}</div>
      </section>`;
    }).join('')}`;
  const timeline = verified(reading.timeline);
  const deep = `${local ? '' : lead('03 / 顺着线索读', '从撞击到后续勘测', '把观测、确认和后续任务放到同一条时间线上。')}
    ${local && timeline.length ? '<header class="folio-story-section-head"><h2>报道时间</h2></header>' : ''}
    ${timeline.length ? `<ol class="folio-story-timeline">${timeline.map(entry => `<li><time datetime="${esc(entry.date)}">${esc(entry.date)}</time>${entry.title ? `<h3>${esc(entry.title)}</h3>` : ''}<p>${esc(entry.text)}</p>${cite(entry)}</li>`).join('')}</ol>` : ''}
    ${verified(reading.deepDive).map(entry => `<section class="folio-story-deep-note">${entry.title ? `<h3>${esc(entry.title)}</h3>` : ''}<p>${esc(entry.text)}</p>${cite(entry)}</section>`).join('')}`;
  const primary = content => local
    ? `<div data-curation-editorial-slot></div><details class="folio-story-original-excerpts" data-curation-excerpts-fallback open><summary>原文摘录</summary>${content}</details>`
    : content;
  return `<section class="folio-curation-story ${local ? 'folio-story-personal folio-story-local-topic' : 'folio-story-example'}" data-curation-id="${esc(reading.id)}" data-curation-mode="overview" style="${esc(style)}">
    <div class="folio-story-topline">${back}${local ? '' : '<span class="folio-story-example-badge">公开阅读样例</span>'}</div>
    <div class="folio-story-hero ${local ? 'is-without-media' : 'folio-story-example-hero'}"><div class="folio-story-heading">
      <div class="folio-story-meta">${reading.kicker ? `<span>${esc(reading.kicker)}</span><span aria-hidden="true">·</span>` : ''}${sourceControl}</div>
      <h1 id="folio-story-title">${esc(title)}</h1>${subtitle ? `<p class="folio-story-deck">${esc(subtitle)}</p>` : ''}
    </div>${media || ''}</div>
    ${local ? renderTopicUpdate(reading.update, reading.version) : ''}
    <div class="folio-story-toolbar">${readingTabs({ model:local })}</div>
    <div class="folio-story-columns"><main class="folio-story-main">
      ${readingPanel('overview', primary(overview))}${readingPanel('compare', primary(comparison))}${readingPanel('full', primary(deep))}${local ? modelReadingPanel() : ''}${note}
    </main><aside class="folio-story-sidebar"><header class="folio-story-section-head">
      <h2>${local ? '收藏来源' : '报道来源'} <span>${reading.sources.length}</span></h2>
      <button class="btn ws-button" type="button" data-size="sm" data-variant="ghost" data-curation-action="collections">查看全部 ↗</button>
    </header>${local ? localTopicSourceCards(reading) : exampleSourceCards(reading)}${reading.reason ? `<p class="folio-story-reading-reason"><strong>为什么放在一起？</strong>${esc(reading.reason)}</p>` : ''}
    ${reading.updatedLabel ? `<p class="folio-story-caption">${esc(reading.updatedLabel)}</p>` : ''}</aside></div>
    <p class="folio-story-feedback" data-curation-feedback role="status"></p><div data-curation-drawer-mount></div>
  </section>`;
}

export function renderReadingExample(example, style) {
  const { hero } = example;
  const media = hero?.src?.startsWith('/assets/') ? `<figure class="folio-story-feature"><img src="${esc(hero.src)}" alt="${esc(hero.alt)}"><figcaption>艺术示意 · ${esc(hero.credit)}${safeSourceURL(hero.sourceUrl) ? ` · <a href="${esc(safeSourceURL(hero.sourceUrl))}" target="_blank" rel="noopener noreferrer">图源</a>` : ''}${safeSourceURL(hero.licenseUrl) ? ` · <a href="${esc(safeSourceURL(hero.licenseUrl))}" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>` : ''}</figcaption></figure>` : '<div class="folio-story-orbit" role="img" aria-label="DART 任务轨道示意，非比例图"><i></i><i></i><span>DART / 2022—24</span><small>轨道示意 · 非比例图</small></div>';
  const back = '<button type="button" class="btn ws-button folio-story-back" data-variant="ghost" data-size="sm" data-desktop="back">← 我的展览</button>';
  return renderSourceReading(example, style, { back, media, title:example.title, subtitle:example.subtitle });
}

const legacyTopicReasons = new Set([
  '这些收藏回答同一个具体问题，并提供了不同的资料。',
  '这些收藏聚焦同一件事，并提供了不同的资料。',
]);
const localTopicCopy = value => typeof value === 'string' && !legacyTopicReasons.has(value.trim()) ? value.trim() : '';

function renderTopicUpdate(update, version) {
  const added = Array.isArray(update?.addedSources) ? update.addedSources.length : 0;
  return Number.isSafeInteger(version) && version > 1 && added
    ? `<p class="folio-story-topic-update">本专题已加入 ${added} 篇新资料。</p>`
    : '';
}

export function renderLocalTopic(exhibition, style, { back, note }) {
  const reason = localTopicCopy(exhibition.curationReading.reason);
  const reading = { ...exhibition.curationReading, reason, id:exhibition.id,
    update:exhibition.curationUpdate, version:exhibition.curationVersion };
  if (reading.topicKind === 'question') reading.kicker = '共同问题';
  if (reading.topicKind === 'event') reading.kicker = '同一事件';
  if (exhibition.curationScope === 'selected') reading.kicker = '指定收藏';
  const subtitle = localTopicCopy(exhibition.subtitle);
  return renderSourceReading(reading, style, { local:true, back, note, title:exhibition.title, subtitle:subtitle === reason ? '' : subtitle });
}
