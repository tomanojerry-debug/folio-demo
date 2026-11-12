import { buildArticleReadingNote } from './article-reading.js';
import { icon } from '../prototype/immersive-exhibition/light-workspace.js';
import { curationColor } from './curation-theme.js';
import { CURATION_MODES, CURATION_READING_MODES, editorialSourceLinks, exampleSourceCards, localTopicEvidence, localTopicSourceCards, modelReadingPanel, readingCitations, readingPanel, readingTabs, renderLocalTopic, renderModelReading, renderPreparedReading, renderReadingExample, sourceEvidence } from './curation-reading.js';
import { TOPIC_EDITORIAL_MODES, TOPIC_PRESET_MODES } from './curation-mode-definitions.js';

const array = value => Array.isArray(value) ? value : [];
const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const text = value => typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : '';
const sourceCaches = new WeakMap();
const CACHE_MAX_AGE = 30000;
const mounted = new WeakMap();
const modelReadingRequests = new WeakMap();
const modelReadingCaches = new WeakMap();
const modelReadingCacheLimit = 24;
const safeImage = value => typeof value === 'string' && /^(?:https?:\/\/|data:image\/(?:png|jpeg|jpg|webp|gif);base64,|\/(?!\/)|\.\.?\/)/iu.test(value) ? value : '';
const safeURL = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const short = (value, length = 130) => value.length > length ? `${value.slice(0, length)}…` : value;
const date = value => { const parsed = new Date(value); return value && Number.isFinite(parsed.valueOf()) ? new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', timeZone:'Asia/Shanghai' }).format(parsed) : ''; };
const button = (action, label, attributes = '', className = '') => `<button type="button" class="btn ws-button folio-story-button ${className}" data-variant="ghost" data-size="sm" data-curation-action="${action}" ${attributes}>${label.replace(/↗/gu, icon('external'))}</button>`;
const closeButton = () => `<button type="button" class="btn ws-icon-button" data-variant="ghost" data-size="icon-sm" data-curation-action="close-drawer" aria-label="关闭侧栏">${icon('close')}</button>`;

function storyItems(exhibition, collections) {
  const snapshots = array(exhibition.items);
  const ids = [...new Set([...array(exhibition.collectionIds), ...array(exhibition.sourceCollectionIds), ...array(exhibition.rooms).flatMap(room => array(room.exhibit_ids))])];
  return ids.map(id => {
    const snapshot = snapshots.find(item => item.id === id);
    const current = array(collections).find(item => item.id === id);
    return snapshot || current ? { ...snapshot, ...current, id, summary:current?.summary || snapshot?.summary || '', thumbnail:safeImage(current?.thumbnail || snapshot?.thumbnail) } : null;
  }).filter(Boolean);
}

export function curationStoryKey(exhibition, collections) {
  return JSON.stringify([exhibition, storyItems(exhibition, collections)]);
}

function localEvidence(items, ids, exhibition) {
  if (exhibition.sourceReviewPending) return [];
  return items.flatMap((item, i) => array(item.extraction?.evidenceBundle).filter(entry => ids.includes(entry.evidence_id) && text(entry.text) && item.understandingDocumentVersionId).slice(0, 2).map(entry => ({ id:entry.evidence_id, label:item.source || item.title || '收藏原文', number:i + 1, item, entry })));
}

function matchingPassage(paragraphs, { start, end, quote }) {
  let cursor = start, excerpt = '', first;
  for (const paragraph of paragraphs) {
    if (paragraph.end <= cursor) continue;
    if (paragraph.start > cursor) return null;
    first ||= paragraph;
    const next = Math.min(paragraph.end, end);
    excerpt += paragraph.text.slice(cursor - paragraph.start, next - paragraph.start);
    cursor = next;
    if (cursor === end) return excerpt === quote ? first : null;
  }
  return null;
}

export function curationCardStyle(item) {
  return `--folio-story-accent:${curationColor(item)};--folio-exhibition-color:${curationColor(item)}`;
}

function titleKeyword(exhibition) {
  const title = text(exhibition.title);
  const candidates = [text(exhibition.theme?.name), text(exhibition.theme?.title), text(exhibition.themeTitle), ...array(exhibition.rooms).map(room => text(room.title))];
  const named = candidates.find(value => value.length > 1 && value.length < 15 && title.includes(value));
  if (named) return named;
  const segment = title.split(/[：:·，、—–：！？!?]/u).find(value => value.trim().length > 1)?.trim() || title;
  if (segment.length <= 12) return segment;
  return segment.match(/[A-Za-z][A-Za-z0-9+.-]{2,}/u)?.[0] || segment.slice(0, 4);
}

function titleHTML(exhibition, title) {
  const keyword = titleKeyword(exhibition);
  const offset = keyword ? title.indexOf(keyword) : -1;
  if (offset < 0) return esc(title);
  return `${esc(title.slice(0, offset))}<button type="button" class="folio-story-keyword" data-curation-action="theme" data-curation-theme="${esc(keyword)}" aria-label="查看与${esc(keyword)}相关的本展收藏">${esc(keyword)}</button>${esc(title.slice(offset + keyword.length))}`;
}

function collectionButton(item, compact = false) {
  return `<button type="button" class="folio-story-source${compact ? ' is-compact' : ''}" data-desktop="collection" data-id="${esc(item.id)}">${item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="" loading="lazy">` : `<span class="folio-story-source-mark" aria-hidden="true">${icon('records')}</span>`}<span><small>${esc(item.source || '我的收藏')}</small><b>${esc(item.title || '未命名收藏')}</b>${!compact && item.summary ? `<span>${esc(short(item.summary, 150))}</span>` : ''}</span><i aria-hidden="true">${icon('external')}</i></button>`;
}

function claimHTML(claim, items, exhibition) {
  if (!text(claim)) return '';
  const labels = { fact:'来源事实', extraction:'内容提取', hypothesis:'策展假设', question:'开放问题' };
  const refs = array(claim.evidence_ids || claim.evidenceIds);
  const matches = localEvidence(items, refs, exhibition);
  return `<div class="folio-story-claim"><small>${labels[claim.statement_type] || '策展解读'}</small><p>${esc(text(claim))}</p>${matches.length ? readingCitations(matches) : refs.length ? '<p class="folio-story-caption">这段解读的来源关联仍需核对。</p>' : ''}</div>`;
}

const backToExhibitions = '<button type="button" class="btn ws-button folio-story-back" data-variant="ghost" data-size="sm" data-desktop="back"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 10H4m5-5-5 5 5 5"/></svg>我的展览</button>';

function reflectionHTML(exhibition) {
  const id = esc(exhibition.id);
  return `<section class="folio-story-reflection">
    <header class="folio-story-section-head"><h2>我的思考</h2></header>
    <label class="folio-story-sr-only" for="folio-story-note-${id}">展览想法</label>
    <textarea class="textarea" id="folio-story-note-${id}" data-desktop-exhibition-note rows="4" placeholder="看完之后，我想留下什么？">${esc(exhibition.note || '')}</textarea>
    <button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-desktop="save-exhibition-note" data-id="${id}">保存想法</button>
  </section>`;
}

/** A reading surface inside the existing Folio dialog. All editorial text is stored exhibition content. */
export function renderCurationStory(exhibition = {}, collections = [], example = null) {
  if (example) return renderReadingExample(example, curationCardStyle(exhibition));
  if (exhibition.kind === 'local-topic' && exhibition.curationReading) {
    return renderLocalTopic(exhibition, curationCardStyle(exhibition), { back:backToExhibitions, note:reflectionHTML(exhibition) });
  }
  const items = storyItems(exhibition, collections);
  const editorial = exhibition.kind === 'editorial';
  const itemsById = new Map(items.map(item => [item.id, item]));
  const prepared = editorial ? Object.entries(exhibition.editorialReadings || {}) : [];
  const photos = items.filter(item => item.thumbnail);
  const rooms = array(exhibition.rooms);
  const stamp = date(exhibition.generatedAt || exhibition.createdAt);
  const deck = text(exhibition.subtitle) || text(exhibition.curatorial_note);
  const title = text(exhibition.title) || '未命名展览';
  const countLabel = `${items.length} 条相关收藏`;
  const sourcePreviews = photos.slice(0, 3).map(item => `<img src="${esc(item.thumbnail)}" alt="">`).join('');
  const relatedCollections = items.length
    ? `<button type="button" class="folio-story-related" data-curation-action="collections"><span class="folio-story-related-previews" aria-hidden="true">${sourcePreviews || icon('inbox')}</span><span>${countLabel}</span></button>`
    : `<span>${countLabel}</span>`;
  const overview = rooms.map((room, index) => ({ room, index })).filter(({ room }) => text(room.introduction) || array(room.claims).length);
  const connections = array(exhibition.connection_claims);
  const references = claim => localEvidence(items, array(claim.evidence_ids || claim.evidenceIds), exhibition);
  const claims = rooms.flatMap(room => array(room.claims)).filter(claim => text(claim) && references(claim).length);
  const score = new Map();
  for (const claim of [...claims, ...connections]) for (const id of new Set(references(claim).map(ref => ref.item.id))) score.set(id, (score.get(id) || 0) + 1);
  const featured = [...items].sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0)).slice(0, 3);
  const comparison = connections.flatMap(claim => {
    const sources = [...new Map(references(claim).map(ref => [ref.item.id, ref])).values()];
    return sources.length < 2 || !text(claim) ? [] : [`<section class="folio-story-comparison"><small>策展连接</small><h3>${esc(text(claim))}</h3><div class="folio-story-compare-grid">${sources.map(ref => `<article><h4>${esc(ref.label)}</h4><p>${esc(ref.item.title)}</p>${readingCitations([ref])}</article>`).join('')}</div></section>`];
  }).join('');
  const editorialComparison = editorial ? rooms.map(room => {
    const sources = array(room.exhibit_ids).map(id => itemsById.get(id)).filter(Boolean);
    if (!sources.length) return '';
    return `<section class="folio-story-comparison"><h3>${esc(room.title)}</h3><p>${esc(text(room.introduction))}</p><div class="folio-story-compare-grid">${sources.map(item => `<article><h4>${esc(item.title)}</h4><p>${esc(item.summary)}</p>${editorialSourceLinks([item], { showTitle:false })}</article>`).join('')}</div></section>`;
  }).join('') : '';
  return `<section class="folio-curation-story folio-story-personal" data-curation-id="${esc(exhibition.id)}" data-curation-mode="overview" style="${curationCardStyle(exhibition)}">
    <div class="folio-story-topline">${backToExhibitions}</div>
    <div class="folio-story-hero${photos.length ? '' : ' is-without-media'}"><div class="folio-story-heading">
      <div class="folio-story-meta">${relatedCollections}${stamp ? `<span aria-hidden="true">·</span><time>${esc(stamp)}</time>` : ''}${exhibition.status === 'needs_review' ? '<span aria-hidden="true">·</span><span>待核对草稿</span>' : ''}</div>
      <h1 id="folio-story-title" aria-label="${esc(title)}">${titleHTML(exhibition, title)}</h1>${deck ? `<p class="folio-story-deck">${esc(deck)}</p>` : ''}</div>
    ${photos.length ? `<div class="folio-story-collage" aria-label="本展收藏图片">${photos.slice(0, 4).map((item, index) => `<button type="button" class="folio-story-photo photo-${index + 1}" data-curation-action="media" data-curation-item="${esc(item.id)}" aria-label="查看图片：${esc(item.title)}"><img src="${esc(item.thumbnail)}" alt="${esc(item.title || '收藏图片')}"></button>`).join('')}${button('media', `查看全部图片 <span aria-hidden="true">↗</span>`, '', 'folio-story-view-all')}</div>` : ''}</div>
    <div class="folio-story-toolbar">${readingTabs({ model:Boolean(exhibition.id) && !editorial, preparedModes:editorial ? prepared.map(([mode]) => mode) : undefined })}</div>
    <div class="folio-story-columns"><main class="folio-story-main">${readingPanel('overview', `<header class="folio-story-section-head"><h2>${claims.length ? '策展速览' : '章节导览'}</h2></header>${claims.length ? claims.slice(0, 3).map(claim => claimHTML(claim, items, exhibition)).join('') : overview.length ? `<ul>${overview.map(({ room, index }) => `<li><button type="button" data-curation-action="room" data-curation-room="${index}">${esc(text(room.title) || `章节 ${index + 1}`)}</button><p>${esc(text(room.introduction) || text(array(room.claims)[0]))}</p></li>`).join('')}</ul>` : text(exhibition.curatorial_note) ? claimHTML(exhibition.curatorial_note, items, exhibition) : '<p class="folio-story-empty">这场展览还没有保存策展说明。</p>'}`)}
    ${readingPanel('compare', `<header class="folio-story-section-head"><h2>来源对照</h2>${editorial ? '<span>策展导读</span>' : ''}</header>${editorialComparison || comparison || '<p class="folio-story-empty">这场展览还没有足够的可定位证据来对照不同收藏。</p>'}`)}
    ${readingPanel('full', `${rooms.map((room, index) => `<section class="folio-story-room" data-curation-room-panel="${index}"><p class="folio-story-eyebrow">章节 ${String(index + 1).padStart(2, '0')}</p><h2>${esc(room.title || `章节 ${index + 1}`)}</h2>${text(room.introduction) ? `<p class="folio-story-room-intro">${esc(text(room.introduction))}</p>` : ''}${array(room.exhibit_ids).map(id => items.find(item => item.id === id)).filter(Boolean).map(item => collectionButton(item)).join('')}${array(room.claims).map(claim => claimHTML(claim, items, exhibition)).join('')}</section>`).join('') || '<p class="folio-story-empty">这场展览还没有保存章节。</p>'}${connections.length ? `<section class="folio-story-connections"><header class="folio-story-section-head"><h2>收藏之间的连接</h2></header>${connections.map(claim => claimHTML(claim, items, exhibition)).join('')}</section>` : ''}`)}
    ${exhibition.id && !editorial ? modelReadingPanel() : ''}
    ${prepared.map(([mode, entries]) => renderPreparedReading(mode, entries, itemsById)).join('')}
    ${editorial ? '' : `<section class="folio-story-reading-section" data-curation-excerpts><header class="folio-story-section-head"><h2>原文摘录</h2></header><p class="folio-story-empty">正在读取收藏中的可核对摘录…</p></section>
    <section class="folio-story-reading-section" data-curation-questions><header class="folio-story-section-head"><h2>带着问题读</h2></header><p class="folio-story-empty">正在读取已有的阅读问答…</p></section>`}
    ${text(exhibition.open_question) ? `<section class="folio-story-open-question"><small>这场展览留下的问题</small><h2>${esc(text(exhibition.open_question))}</h2>${editorial ? '' : button('ask-open', '带着这个问题和 Tag 聊聊 ↗')}</section>` : ''}
    ${reflectionHTML(exhibition)}</main>
    <aside class="folio-story-sidebar"><header class="folio-story-section-head"><h2>收藏来源 <span>${items.length}</span></h2>${button('collections', '查看全部 ↗')}</header>${featured.map(item => collectionButton(item, true)).join('') || '<p class="folio-story-empty">暂时没有可用的收藏来源。</p>'}${editorial ? '' : `<div class="folio-story-ask-box"><h3>继续阅读</h3><p>带上本展收藏和 Tag 讨论。</p>${button('ask', '向这场展览提问 ↗')}</div>`}</aside></div>
    <p class="folio-story-feedback" data-curation-feedback role="status" aria-live="polite"></p><div class="folio-story-drawer-mount" data-curation-drawer-mount></div>
  </section>`;
}

function cacheKey(exhibition, items) {
  return JSON.stringify([exhibition.id, items.map(item => [item.id, item.updatedAt, item.sourceRevision, item.documentVersionId, item.understandingDocumentVersionId])]);
}

async function readSources(exhibition, items, api, force = false) {
  let sourceCache = sourceCaches.get(api);
  if (!sourceCache) { sourceCache = new Map(); sourceCaches.set(api, sourceCache); }
  const key = cacheKey(exhibition, items);
  if (force || Date.now() - (sourceCache.get(key)?.createdAt || 0) > CACHE_MAX_AGE) sourceCache.delete(key);
  if (!sourceCache.has(key)) {
    const promise = (async () => {
      const settled = await Promise.allSettled(items.map(item => api('reading/article', { collectionId:item.id })));
      const quotes = [], questions = [], failed = [];
      settled.forEach((result, index) => {
        const article = result.status === 'fulfilled' ? result.value?.article : null;
        if (!article || article.collectionId !== items[index].id || !Array.isArray(article.paragraphs)) { failed.push(items[index].id); return; }
        const state = { article, mode:'overview', promptDraft:'' };
        for (const [kind, target, limit] of [['quote', quotes, 6], ['question', questions, 8]]) for (let i = 0; i < limit; i++) {
          const note = buildArticleReadingNote(state, kind, i);
          if (note?.source.paragraphIds.length && note.documentVersionId) target.push({ note, article, item:items[index] });
        }
      });
      return { quotes, questions, failed };
    })();
    sourceCache.set(key, { promise, createdAt:Date.now() });
    if (sourceCache.size > 20) sourceCache.delete(sourceCache.keys().next().value);
  }
  return sourceCache.get(key).promise;
}

function quoteHTML(entry, index, full = false) {
  const { note, article } = entry;
  const url = safeURL(article.url);
  return `<figure class="folio-story-quote"><figcaption><span>${esc(article.title)}</span><small>${article.sourceKind === 'image_description' ? '图片描述摘录' : '原文摘录'}</small></figcaption><blockquote>${esc(note.source.originalText || note.source.text)}</blockquote><div class="folio-story-entry-actions">${button('source', '语境与出处', `data-curation-kind="quote" data-curation-index="${index}"`)}${button('note', '写进手记 ↗', `data-curation-kind="quote" data-curation-index="${index}"`)}</div>${full ? `<p class="folio-story-caption">${esc(url ? new URL(url).hostname : '本机收藏')}</p>` : ''}</figure>`;
}

function questionHTML(entry, index) {
  return `<details class="folio-story-question"><summary>${esc(entry.note.source.text)}<span aria-hidden="true">${icon('chevron')}</span></summary><div><p class="folio-story-answer">${esc(entry.note.source.answer || '这个问题尚没有保存回答。')}</p><p class="folio-story-caption">AI 整理回答 · 依据《${esc(entry.article.title)}》</p><div class="folio-story-entry-actions">${button('source', '依据原文', `data-curation-kind="question" data-curation-index="${index}"`)}${button('note', '带入手记思考 ↗', `data-curation-kind="question" data-curation-index="${index}"`)}</div></div></details>`;
}

/** Opens saved reading results and requests a draft when the selected reading mode needs one. */
export function mountCurationStory({ container, exhibition = {}, collections = [], example, api, onCreateNote, openChat, openCollection, openOriginal, initialMode } = {}) {
  const root = container?.matches?.('.folio-curation-story') ? container : container?.querySelector?.('.folio-curation-story');
  if (!root) return { destroy() {}, refreshSources:async () => {} };
  mounted.get(root)?.destroy();
  const items = storyItems(exhibition, collections);
  const topic = exhibition.kind === 'local-topic' ? exhibition.curationReading : null;
  const pickerMenu = root.querySelector('[data-curation-model-menu]');
  const pickerLabel = pickerMenu?.querySelector('[data-curation-model-label]');
  const pickerOptions = pickerMenu?.querySelectorAll('[role="menuitemradio"]');
  const modelPanel = root.querySelector('[data-curation-model-panel]');
  const modelHome = modelPanel?.parentElement;
  const modelHomeNext = modelPanel?.nextSibling;
  const modelOutput = root.querySelector('[data-curation-model-result]');
  const generateButton = root.querySelector('[data-curation-model-generate]');
  const modelActions = root.querySelector('[data-curation-model-actions]');
  const modelDisclosure = root.querySelector('[data-curation-model-disclosure]');
  const modelStatus = root.querySelector('[data-curation-model-status]');
  const reloadModel = root.querySelector('[data-curation-action="reload-model-reading"]');
  const defaultButton = root.querySelector('[data-curation-action="default-mode"]');
  const edition = JSON.stringify([exhibition.id, exhibition.title, exhibition.kind, exhibition.curationVersion,
    array(topic?.sources).map(source => [source.id, source.documentVersionId]), array(topic?.evidence).map(ref => [ref.id, ref.start, ref.end, ref.quote]),
    items.map(item => [item.id, item.sourceRevision, item.knowledgeDocumentVersionId, item.documentVersionId])]);
  const requests = modelPanel && typeof api === 'function' ? modelReadingRequests.get(api) || new Map() : null;
  if (requests) modelReadingRequests.set(api, requests);
  const prepared = exhibition.kind === 'editorial' ? exhibition.editorialReadings || {} : {};
  const supportsMode = mode => Object.hasOwn(CURATION_MODES, mode) || Object.hasOwn(prepared, mode) || (modelPanel && Object.hasOwn(TOPIC_PRESET_MODES, mode));
  const openingMode = supportsMode(initialMode) ? initialMode : undefined;
  let disposed = false, sourceData = { quotes:[], questions:[], failed:[] }, drawer = null, returnFocus = null;
  let loadRevision = 0, modePicked = Boolean(openingMode), savingMode = false, evidenceRevision = 0;
  let preferredMode, preferenceChanged = false, lastPrimaryMode = 'overview', modelResult = null, modelRevision = 0;
  let modelAvailable = false, modelLoading = false, modelRetry = false, activeModelMode = '';
  const feedback = value => { const target = root.querySelector('[data-curation-feedback]'); if (target) target.textContent = value; };
  const entryFor = control => sourceData[control.dataset.curationKind === 'question' ? 'questions' : 'quotes'][Number(control.dataset.curationIndex)];
  const live = () => !disposed && root.isConnected;
  function updateDefaultButton() {
    if (defaultButton) defaultButton.textContent = preferredMode === root.dataset.curationMode ? '已设为默认' : '设为默认';
  }
  function updateGenerateButton() {
    const mode = root.dataset.curationMode;
    const automatic = Object.hasOwn(TOPIC_PRESET_MODES, mode);
    generateButton.disabled = Boolean(modelLoading) || (!modelAvailable && !modelRetry);
    generateButton.hidden = automatic && !modelRetry;
    modelActions.hidden = automatic ? modelLoading !== 'generate' && !modelRetry : Boolean(modelResult) || (!modelAvailable && !modelLoading);
    generateButton.textContent = modelRetry ? '重新生成' : modelLoading === 'generate' ? '正在生成…' : '生成读稿';
  }
  function primaryPanel(mode) {
    return topic && Object.hasOwn(TOPIC_EDITORIAL_MODES, mode) ? root.querySelector(`[data-curation-panel="${mode}"]`) : null;
  }
  function modelCache() {
    let cache = modelReadingCaches.get(api);
    if (!cache) { cache = new Map(); modelReadingCaches.set(api, cache); }
    return cache;
  }
  async function requestModelReading(generate = false) {
    const mode = root.dataset.curationMode;
    if (!modelPanel || activeModelMode !== mode || !Object.hasOwn(CURATION_READING_MODES, mode)) return;
    if (generate && (!modelAvailable || modelLoading || modelResult)) return;
    if (typeof api !== 'function') {
      modelStatus.textContent = '专题阅读暂未连接。';
      return;
    }
    const revision = ++modelRevision;
    const key = JSON.stringify([edition, mode]);
    const automatic = Object.hasOwn(TOPIC_PRESET_MODES, mode);
    const pending = requests.get(key);
    let generating = generate || Boolean(pending);
    const body = { exhibitionId:exhibition.id, mode };
    const cache = modelCache();
    const cached = !generating && cache.get(key);
    let cachedHTML = cached ? renderModelReading(cached.result, mode) : '';
    const alreadyShown = cachedHTML && modelResult === cached.result;
    modelLoading = generating ? 'generate' : 'read';
    modelRetry = false;
    modelResult = cachedHTML ? cached.result : null;
    if (cachedHTML) modelAvailable = cached.available;
    if (!alreadyShown) modelOutput.innerHTML = cachedHTML;
    const excerpts = primaryPanel(mode)?.querySelector('[data-curation-excerpts-fallback]');
    if (excerpts && !alreadyShown) excerpts.open = !cachedHTML;
    reloadModel.hidden = true;
    modelStatus.textContent = generating ? '正在按此读法生成内容…' : automatic && !cachedHTML ? '正在读取已保存的读稿…' : '';
    updateGenerateButton();
    const generateOrJoin = () => {
      const running = requests.get(key);
      if (running) return running;
      const task = Promise.resolve(api('curation/reading', { ...body, generate:true })).finally(() => requests.delete(key));
      requests.set(key, task);
      return task;
    };
    try {
      let response = await (generating ? generateOrJoin() : api('curation/reading', body));
      if (!live() || revision !== modelRevision) return;
      if (automatic && !generating && response?.available === true && !response.result) {
        generating = true;
        modelLoading = 'generate';
        modelAvailable = true;
        modelResult = null;
        cache.delete(key);
        if (cachedHTML) { modelOutput.innerHTML = ''; cachedHTML = ''; }
        modelStatus.textContent = '正在按此读法生成内容…';
        updateGenerateButton();
        response = await generateOrJoin();
        if (!live() || revision !== modelRevision) return;
      }
      const { available, result } = response || {};
      modelAvailable = available === true;
      const html = renderModelReading(result, mode);
      if (html) {
        cache.delete(key);
        cache.set(key, { available:modelAvailable, result });
        if (cache.size > modelReadingCacheLimit) cache.delete(cache.keys().next().value);
        modelResult = result;
        if (html !== cachedHTML) modelOutput.innerHTML = html;
        if (excerpts && !cachedHTML) excerpts.open = false;
        if (generate && root.ownerDocument.activeElement === generateButton && modelOutput.firstElementChild) {
          modelOutput.firstElementChild.tabIndex = -1;
          modelOutput.firstElementChild.focus({ preventScroll:true });
        }
        modelStatus.textContent = generating ? '已生成并保存到本机。' : '';
      } else {
        cache.delete(key);
        modelResult = null;
        if (cachedHTML) { modelOutput.innerHTML = ''; if (excerpts) excerpts.open = true; }
        modelRetry = automatic && generating && modelAvailable;
        modelStatus.textContent = result ? '已保存的内容暂时无法核对出处。' : !modelAvailable
          ? (excerpts ? '' : '本展当前无法生成此读法。') : generating ? '模型没有返回可核对的内容，请重试。' : '';
      }
    } catch {
      if (!live() || revision !== modelRevision) return;
      modelRetry = automatic && generating;
      modelStatus.textContent = generating ? '生成暂未完成，请重试。' : cachedHTML ? '' : '暂时无法读取已保存的内容。';
      reloadModel.hidden = generating;
    } finally {
      if (live() && revision === modelRevision) {
        modelLoading = false;
        updateGenerateButton();
      }
    }
  }
  function setMode(mode) {
    if (!supportsMode(mode)) return;
    const primary = Object.hasOwn(CURATION_MODES, mode);
    const more = Object.hasOwn(TOPIC_PRESET_MODES, mode);
    const slot = primaryPanel(mode)?.querySelector('[data-curation-editorial-slot]');
    const model = Boolean(modelPanel && (more || slot));
    const changed = root.dataset.curationMode !== mode;
    if (changed) { ++evidenceRevision; ++modelRevision; }
    root.dataset.curationMode = mode;
    if (primary) lastPrimaryMode = mode;
    root.querySelectorAll('[data-curation-panel]').forEach(panel => { panel.hidden = panel.dataset.curationPanel !== mode; });
    root.querySelectorAll('[role="tab"][data-curation-mode]').forEach(tab => {
      tab.setAttribute('aria-selected', String(tab.dataset.curationMode === mode));
      tab.tabIndex = tab.dataset.curationMode === lastPrimaryMode ? 0 : -1;
    });
    updateDefaultButton();
    if (pickerLabel) pickerLabel.textContent = more ? TOPIC_PRESET_MODES[mode].label : '更多读法';
    pickerOptions?.forEach(option => option.setAttribute('aria-checked', String(option.dataset.curationMode === mode)));
    if (!modelPanel) return;
    modelPanel.hidden = !model;
    if (!model) { activeModelMode = ''; return; }
    if (activeModelMode === mode && !changed) return;
    activeModelMode = mode;
    if (slot) slot.append(modelPanel);
    else if (modelHome && modelPanel.parentElement !== modelHome) modelHome.insertBefore(modelPanel, modelHomeNext);
    if (modelPanel.dataset) modelPanel.dataset.modeGroup = slot ? 'editorial' : 'more';
    root.querySelector('[data-curation-model-heading]').textContent = CURATION_READING_MODES[mode].label;
    root.querySelector('[data-curation-model-description]').textContent = CURATION_READING_MODES[mode].description;
    if (modelDisclosure) modelDisclosure.textContent = more
      ? '生成读稿时，Folio 会把本展的收藏原文片段发送给已配置的模型。'
      : '点击生成后，Folio 会把本展的收藏原文片段发送给已配置的模型。';
    modelAvailable = false;
    void requestModelReading();
  }
  function closeDrawer() { drawer?.remove(); drawer = null; returnFocus?.focus?.({ preventScroll:true }); }
  function openDrawer(kind, options = {}) {
    if (!drawer) returnFocus = options.trigger || root.ownerDocument.activeElement;
    drawer?.remove();
    const doc = root.ownerDocument;
    drawer = doc.createElement('div'); drawer.className = 'folio-story-drawer';
    let content;
    if (kind === 'media') content = items.filter(item => item.thumbnail).map(item => `<figure data-curation-media-id="${esc(item.id)}"><img src="${esc(item.thumbnail)}" alt="${esc(item.title)}"><figcaption>${esc(item.title)}<div>${button('open-collection', '打开收藏 ↗', `data-curation-item="${esc(item.id)}"`)}</div></figcaption></figure>`).join('') || '<p class="folio-story-empty">本展收藏暂时没有保存图片。</p>';
    else if (kind === 'quotes') content = sourceData.quotes.map((entry, index) => quoteHTML(entry, index, true)).join('') || '<p class="folio-story-empty">还没有可核对的原文摘录。</p>';
    else if (kind === 'questions') content = sourceData.questions.map(questionHTML).join('') || '<p class="folio-story-empty">还没有保存的阅读问答。打开一篇收藏，可以根据它的原文提问。</p>';
    else if (kind === 'source') {
      const entry = options.entry, url = safeURL(entry.article.url);
      content = `<p class="folio-story-eyebrow">${entry.article.sourceKind === 'image_description' ? '图片描述 · 已保存版本' : '原文语境 · 已保存版本'}</p><h3>${esc(entry.article.title)}</h3>${entry.note.source.paragraphs.map(paragraph => `<blockquote class="folio-story-source-context"><small>段落 ${esc(paragraph.id)}</small><p>${esc(paragraph.text)}</p></blockquote>`).join('')}<div class="folio-story-entry-actions">${button('open-collection', '打开完整收藏 ↗', `data-curation-item="${esc(entry.article.collectionId)}"`)}${url ? `<a class="btn ws-button" data-variant="ghost" data-size="sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">访问原始来源${icon('external')}</a>` : ''}</div>`;
    } else if (kind === 'evidence') {
      const { evidence } = options, url = safeURL(evidence.url);
      content = `<p class="folio-story-eyebrow">${example ? '报道原文 · 节选' : '收藏原文 · 已保存版本'}</p><h3>${esc(evidence.title)}</h3><p class="folio-story-caption">${esc(evidence.locator)}</p><blockquote class="folio-story-source-context" ${example ? 'lang="en"' : ''}><p>${esc(evidence.quote)}</p></blockquote><div class="folio-story-entry-actions">${evidence.collectionId ? button('open-local-evidence', '在本机原文中定位 ↗') : ''}${url ? `<a class="btn ws-button" data-variant="outline" data-size="sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${example ? '跳转报道原文' : '访问原始来源'}${icon('external')}</a>` : ''}</div>`;
      drawer.evidence = evidence;
    } else if (example) {
      content = exampleSourceCards(example);
    } else if (topic) {
      content = localTopicSourceCards(topic);
    } else {
      const filtered = options.theme ? items.filter(item => `${item.title} ${item.summary}`.includes(options.theme)) : items;
      content = `${options.theme ? `<p class="folio-story-eyebrow">标题主题 · ${esc(options.theme)}</p>${!filtered.length && items.length ? '<p class="folio-story-caption">暂未匹配到包含这个主题词的收藏。以下是本展全部收藏。</p>' : ''}` : ''}${(filtered.length ? filtered : items).map(item => collectionButton(item)).join('') || '<p class="folio-story-empty">暂时没有可用来源。</p>'}`;
    }
    const names = { media:'全部图片', collections:example ? '全部报道来源' : '本展收藏', quotes:'原文摘录', questions:'阅读问答', source:'语境与出处', evidence:'原文依据' };
    const navigation = example ? [['collections','报道']] : topic ? [['collections','收藏']] : [['media','图片'],['collections','收藏'],['quotes','摘录'],['questions','提问']];
    drawer.innerHTML = `<button class="folio-story-scrim" type="button" data-curation-action="close-drawer" aria-label="关闭侧栏" tabindex="-1"></button><section class="folio-story-drawer-panel" role="dialog" aria-modal="true" aria-label="${names[kind]}" tabindex="-1"><nav aria-label="展览内容">${navigation.map(([key, label]) => `<button type="button" class="btn ws-button" data-variant="ghost" data-size="sm" data-curation-action="${key}" aria-pressed="${key === kind}">${icon(({media:'gallery',collections:'inbox',quotes:'records',questions:'chat'})[key])}<span>${label}</span></button>`).join('')}</nav><div class="folio-story-drawer-body"><header><h2>${names[kind]}</h2>${closeButton()}</header>${content}</div></section>`;
    root.querySelector('[data-curation-drawer-mount]').append(drawer);
    drawer.querySelector('[role="dialog"]').focus({ preventScroll:true });
    if (options.itemId) {
      const media = [...drawer.querySelectorAll('[data-curation-media-id]')];
      const selected = media.find(element => element.dataset.curationMediaId === options.itemId);
      if (selected && selected !== media[0]) selected.scrollIntoView({ block:'start' });
    }
  }
  async function showEvidence(control) {
    modePicked = true;
    const id = control.dataset.curationEvidence;
    if (example) {
      const match = sourceEvidence(example, id);
      if (match) openDrawer('evidence', { evidence:{ ...match, title:match.source.title }, trigger:control });
      return;
    }
    const fromModel = modelOutput && control.closest?.('[data-curation-model-result]') === modelOutput;
    const pinnedReading = fromModel ? modelResult : topic;
    const ref = (fromModel || topic) ? localTopicEvidence(pinnedReading, id) : localEvidence(items, [id], exhibition)[0];
    if (!ref || typeof api !== 'function') return;
    const request = ++evidenceRevision;
    feedback('');
    try {
      if (pinnedReading) {
        const { sourceId, documentVersionId, start, quote, locator } = ref;
        const { article } = await api('reading/article', { collectionId:sourceId, documentVersionId });
        if (!live() || request !== evidenceRevision) return;
        if (article?.collectionId !== sourceId || article.documentVersionId !== documentVersionId) throw new Error('unresolved citation');
        const passage = matchingPassage(array(article.paragraphs), ref);
        if (!passage) throw new Error('unresolved citation');
        openDrawer('evidence', { evidence:{
          title:article.title, quote, locator:locator || `段落 ${passage.id}`, url:article.url,
          collectionId:sourceId, documentVersionId, offset:start,
        }, trigger:control });
        return;
      }
      const { item, entry } = ref;
      const documentVersionId = item.understandingDocumentVersionId;
      const { article } = await api('reading/article', { collectionId:item.id, documentVersionId });
      if (!live() || request !== evidenceRevision) return;
      const normalize = value => value.replace(/\s+/gu, ' ').trim();
      const snippet = normalize(entry.text);
      const passages = array(article?.paragraphs).filter(row => typeof row.text === 'string');
      let paragraph = passages.find(row => normalize(row.text).includes(snippet));
      if (!paragraph) paragraph = passages.find((row, i) => {
        const start = normalize(passages.slice(i, i + 4).map(part => part.text).join('\n')).indexOf(snippet);
        return start >= 0 && start < normalize(row.text).length;
      });
      if (article?.collectionId !== item.id || article.documentVersionId !== documentVersionId || !paragraph) throw new Error('unresolved citation');
      openDrawer('evidence', { evidence:{ title:article.title, quote:entry.text, locator:entry.locator || `段落 ${paragraph.id}`, url:article.url, collectionId:item.id, documentVersionId, offset:paragraph.start }, trigger:control });
    } catch { if (live() && request === evidenceRevision) feedback('这条依据暂时无法定位到原文，可能是来源已变化。'); }
  }
  async function saveMode(control) {
    if (savingMode || typeof api !== 'function') return;
    const mode = root.dataset.curationMode;
    if (!supportsMode(mode)) return;
    const { label } = CURATION_READING_MODES[mode];
    modePicked = true; savingMode = true;
    control.setAttribute('aria-busy', 'true');
    try {
      await api('reading/preferences', { curationMode:mode });
      if (!live()) return;
      preferenceChanged = true;
      preferredMode = mode;
      const target = root.querySelector('[data-curation-mode-status]');
      if (target) target.textContent = `已将${label}设为默认`;
      updateDefaultButton();
      feedback('');
    } catch { if (live()) feedback('默认阅读方式暂未保存，请再试一次。'); }
    finally { savingMode = false; control.removeAttribute('aria-busy'); }
  }
  async function load(force = false) {
    if (example || topic || exhibition.kind === 'editorial') return;
    const revision = ++loadRevision;
    if (typeof api !== 'function') { feedback('阅读来源暂时没有连接。'); return; }
    try {
      const data = await readSources(exhibition, items, api, force);
      if (!live() || revision !== loadRevision) return;
      sourceData = data;
      root.querySelector('[data-curation-excerpts]').innerHTML = `<header class="folio-story-section-head"><h2>原文摘录 <span>${data.quotes.length ? ` · ${data.quotes.length}` : ''}</span></h2>${data.quotes.length > 3 ? button('quotes', '查看全部 ↗') : ''}</header><div class="folio-story-quotes">${data.quotes.slice(0, 3).map((entry, index) => quoteHTML(entry, index)).join('') || '<p class="folio-story-empty">收藏原文中暂时没有可核对的引语。</p>'}</div>${data.failed.length ? `<p class="folio-story-caption">${data.failed.length} 件收藏的原文暂未读取成功。${button('refresh-sources', '重新读取')}</p>` : ''}`;
      root.querySelector('[data-curation-questions]').innerHTML = `<header class="folio-story-section-head"><h2>带着问题读 <span>${data.questions.length ? ` · ${data.questions.length}` : ''}</span></h2>${data.questions.length > 3 ? button('questions', '查看全部 ↗') : ''}</header>${data.questions.slice(0, 3).map(questionHTML).join('') || '<p class="folio-story-empty">还没有保存的阅读问答。可以打开一篇收藏，按原文提问。</p>'}<div class="folio-story-entry-actions">${button('ask', '向这场展览提问 ↗')}${button('refresh-sources', '刷新已保存问答')}</div>`;
    } catch { if (live() && revision === loadRevision) feedback('收藏原文暂时没有读取成功，请稍后重新打开。'); }
  }
  async function chat(message = '') {
    if (!openChat) { feedback('Tag 对话暂时没有连接，请稍后重试。'); return; }
    try {
      const result = await openChat({ exhibitionId:exhibition.id, collectionIds:[], message, submit:false });
      if (result?.accepted === false) feedback(result.error || '对话暂时没有打开，请重试。');
    } catch { feedback('Tag 对话暂时没有打开，请重试。'); }
  }
  async function click(event) {
    const control = event.target.closest?.('[data-curation-action]');
    if (!control && drawer && event.target.closest?.('[data-desktop="collection"]')) { closeDrawer(); return; }
    if (!control || !root.contains(control)) return;
    event.preventDefault(); event.stopPropagation();
    const action = control.dataset.curationAction;
    if (action === 'mode') { modePicked = true; setMode(control.dataset.curationMode); }
    else if (action === 'default-mode') await saveMode(control);
    else if (action === 'reload-model-reading' && !modelLoading) await requestModelReading();
    else if (action === 'evidence') await showEvidence(control);
    else if (action === 'open-local-evidence') {
      const evidence = drawer?.evidence;
      if (!evidence || !openOriginal) return;
      closeDrawer();
      openOriginal(evidence.collectionId, { documentVersionId:evidence.documentVersionId, offset:evidence.offset });
    }
    else if (action === 'room') { modePicked = true; setMode('full'); root.querySelector(`[data-curation-room-panel="${Number(control.dataset.curationRoom)}"]`)?.scrollIntoView({ behavior:'smooth', block:'start' }); }
    else if (['media','collections','quotes','questions'].includes(action)) openDrawer(action, { itemId:control.dataset.curationItem, trigger:control });
    else if (action === 'theme') openDrawer('collections', { theme:control.dataset.curationTheme, trigger:control });
    else if (action === 'close-drawer') closeDrawer();
    else if (action === 'source') { const entry = entryFor(control); if (entry) openDrawer('source', { entry, trigger:control }); }
    else if (action === 'open-collection') { const id = control.dataset.curationItem; closeDrawer(); if (openCollection) openCollection(id); else feedback('收藏阅读器暂时没有连接。'); }
    else if (action === 'note') {
      const entry = entryFor(control); if (!entry) return;
      if (!onCreateNote) { feedback('手记编辑器暂时没有连接，请稍后重试。'); return; }
      closeDrawer();
      try { await onCreateNote({ ...structuredClone(entry.note), exhibitionId:exhibition.id, exhibitionTitle:exhibition.title }); feedback(''); }
      catch { feedback('手记暂时没有打开，原文引用仍保留，请重试。'); }
    } else if (action === 'refresh-sources') await load(true);
    else if (action === 'ask-open') await chat(text(exhibition.open_question));
    else if (action === 'ask') await chat();
  }
  function keydown(event) {
    if (drawer && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDrawer(); return; }
    if (drawer && event.key === 'Tab') {
      const focusable = [...drawer.querySelectorAll('[role="dialog"] button:not(:disabled), [role="dialog"] a[href], [role="dialog"] [tabindex="0"]')].filter(element => element.offsetParent !== null);
      const first = focusable[0], last = focusable.at(-1), active = root.ownerDocument.activeElement;
      if (event.shiftKey && (active === first || active === drawer.querySelector('[role="dialog"]'))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    const tab = event.target.closest?.('[role="tab"][data-curation-mode]');
    if (tab && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault(); modePicked = true;
      const modes = [...root.querySelectorAll('[role="tab"][data-curation-mode]')].map(item => item.dataset.curationMode);
      const i = modes.indexOf(tab.dataset.curationMode);
      const mode = event.key === 'Home' ? modes[0] : event.key === 'End' ? modes.at(-1) : modes[(i + (event.key === 'ArrowRight' ? 1 : -1) + modes.length) % modes.length];
      setMode(mode); root.querySelector(`[role="tab"][data-curation-mode="${mode}"]`)?.focus();
    }
  }
  function pickerKeydown(event) {
    if (!event.target.closest?.('[aria-expanded="true"]')) return;
    // Basecoat handles Escape on the trigger. Prevent the native dialog cancel as well.
    if (event.key === 'Escape') event.preventDefault();
    if (event.key === 'Tab') pickerMenu.close?.(false);
  }
  function submit(event) {
    if (event.target !== root.querySelector('[data-curation-model-form]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (Object.hasOwn(TOPIC_PRESET_MODES, root.dataset.curationMode)) {
      if (modelRetry && !modelLoading) return requestModelReading();
      return;
    }
    return requestModelReading(true);
  }
  const listeners = { click, keydown, submit };
  for (const [type, listener] of Object.entries(listeners)) root.addEventListener(type, listener);
  pickerMenu?.addEventListener('keydown', pickerKeydown, true);
  const instance = { refreshSources:() => load(true), destroy() {
    disposed = true; ++loadRevision;
    for (const [type, listener] of Object.entries(listeners)) root.removeEventListener(type, listener);
    pickerMenu?.removeEventListener('keydown', pickerKeydown, true);
    drawer?.remove(); mounted.delete(root);
  } };
  mounted.set(root, instance); void load();
  if (openingMode) setMode(openingMode);
  else if (root.querySelector('[data-curation-editorial-slot]')) setMode(root.dataset.curationMode);
  if (typeof api === 'function' && defaultButton) void api('reading/preferences', {}).then(result => {
    if (!live() || preferenceChanged) return;
    const savedMode = result.preferences?.curationMode;
    preferredMode = supportsMode(savedMode) ? savedMode : undefined;
    if (!modePicked) setMode(preferredMode ?? 'overview');
    updateDefaultButton();
  }).catch(() => {});
  return instance;
}
