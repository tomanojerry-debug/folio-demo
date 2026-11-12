import { closeGlassDialog, frameGlassDialog } from './glass-dialogs.js';
import { icon } from '../prototype/immersive-exhibition/light-workspace.js';

const list = value => Array.isArray(value) ? value : [];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const readableError = error => typeof error?.message === 'string' && /[\u3400-\u9fff]/u.test(error.message) ? error.message : '暂时无法加载，请重试。';
const identifier = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 150) throw new Error('请先选择一条有效收藏。');
  return value.trim();
};

/** Request state belongs to the visible panel; closed or replaced requests cannot repaint it. */
export function createKnowledgeController({ api, onChange = () => {} }) {
  let revision = 0;
  const history = [];
  let state = { view:'search', status:'idle', query:'', items:[], mode:'', error:'', document:null, anchor:null };
  const publish = patch => { state = { ...state, ...patch }; onChange(structuredClone(state)); };
  const navigation = () => ({ canGoBack:Boolean(history.length), backLabel:({ search:'返回搜索结果', similar:'返回相似收藏', connections:'返回关联图', read:'返回原文' })[history.at(-1)?.view] || '返回上一页' });
  function remember() {
    if (!['ready', 'page_error'].includes(state.status)) return;
    history.push(structuredClone(state));
    if (history.length > 16) history.shift();
  }
  function resetHistory() { history.length = 0; state = { ...state, status:'idle' }; }
  async function perform(view, body, append = false, rememberCurrent = false) {
    const requestRevision = ++revision;
    const previous = append ? state.document : null;
    if (rememberCurrent) remember();
    publish({ view, ...navigation(), status:append ? 'loading_more' : 'loading', error:'', ...(append ? {} : { items:[], document:null, anchor:null, mode:'', conceptFilter:'', requestBody:structuredClone(body) }) });
    try {
      const result = await api(`knowledge/${view}`, body);
      if (requestRevision !== revision) return;
      if (view === 'read') {
        const document = result?.document;
        if (!document || document.collectionId !== body.collectionId) throw new Error('这条收藏的原文暂时不可用，请稍后重试。');
        if (previous && document.documentVersionId !== previous.documentVersionId) throw new Error('原文已经更新，请重新打开后继续阅读。');
        if (document.hasMore && (!Number.isSafeInteger(document.nextOffset) || document.nextOffset <= (body.offset || 0))) throw new Error('后续原文暂时没有读取成功，请重试。');
        const merged = previous ? {
          ...document,
          chunks:[...list(previous.chunks), ...list(document.chunks)],
          text:String(previous.text || '') + String(document.text || ''),
        } : document;
        publish({ status:'ready', document:merged });
      } else {
        if (view === 'connections' && (!result?.anchor || result.anchor.collectionId !== body.collectionId)) throw new Error('这条收藏的关联暂时不可用，请稍后重试。');
        publish({ status:'ready', items:list(result?.items).slice(0, view === 'connections' ? 8 : 20), mode:result?.mode || '', semanticStatus:result?.semanticStatus || '', anchor:result?.anchor || null });
      }
    } catch (error) {
      if (requestRevision === revision) publish({ status:append ? 'page_error' : 'error', error:readableError(error) });
    }
  }
  return {
    getState:() => structuredClone(state),
    cancel() { revision++; },
    showSearch(query = '') { revision++; resetHistory(); publish({ view:'search', ...navigation(), status:'idle', query:String(query), items:[], document:null, anchor:null, mode:'', error:'', conceptFilter:'', requestBody:null }); },
    back() { if (!history.length) return; revision++; const prior = history.pop(); publish({ ...prior, ...navigation() }); },
    search(query) {
      const value = String(query ?? '').trim();
      if (!value || value.length > 2000) { revision++; publish({ view:'search', status:'error', query:value, error:value ? '搜索内容过长，请缩短后重试。' : '写下想找的主题、问题或原文中的一句话。', items:[], document:null, anchor:null, requestBody:null }); return Promise.resolve(); }
      resetHistory();
      publish({ query:value });
      return perform('search', { query:value, limit:5 });
    },
    read(collectionId, { offset = 0, documentVersionId, resetHistory = false } = {}) {
      try {
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('原文位置无效，请重新查找。');
        if (resetHistory) { history.length = 0; state = { ...state, status:'idle' }; }
        const rememberCurrent = state.view !== 'read' || state.document?.collectionId !== collectionId;
        return perform('read', { collectionId:identifier(collectionId), ...(offset ? { offset } : {}), ...(documentVersionId ? { documentVersionId:identifier(documentVersionId) } : {}) }, false, rememberCurrent);
      }
      catch (error) { revision++; publish({ view:'read', status:'error', error:readableError(error), document:null, requestBody:null }); return Promise.resolve(); }
    },
    more() {
      if (!['ready', 'page_error'].includes(state.status) || !state.document?.hasMore) return Promise.resolve();
      return perform('read', { collectionId:state.document.collectionId, offset:state.document.nextOffset, ...(state.document.documentVersionId ? { documentVersionId:state.document.documentVersionId } : {}) }, true);
    },
    similar(collectionId, { resetHistory:clearHistory = false } = {}) {
      try {
        if (clearHistory) resetHistory();
        return perform('similar', { collectionId:identifier(collectionId), limit:5 }, false, state.view !== 'similar' || state.anchor?.collectionId !== collectionId);
      }
      catch (error) { revision++; publish({ view:'similar', status:'error', error:readableError(error), items:[], document:null, anchor:null, requestBody:null }); return Promise.resolve(); }
    },
    connections(collectionId, { resetHistory:clearHistory = false } = {}) {
      try {
        if (clearHistory) resetHistory();
        return perform('connections', { collectionId:identifier(collectionId), limit:8 }, false, state.view !== 'connections' || state.anchor?.collectionId !== collectionId);
      }
      catch (error) { revision++; publish({ view:'connections', status:'error', error:readableError(error), items:[], document:null, anchor:null, requestBody:null }); return Promise.resolve(); }
    },
    filterConcept(conceptId = '') {
      if (state.view !== 'connections' || state.status !== 'ready') return;
      const value = String(conceptId);
      if (value && !state.items.some(item => list(item.concepts).some(concept => concept.id === value))) return;
      publish({ conceptFilter:state.conceptFilter === value ? '' : value });
    },
    retry() { return state.status === 'error' && state.requestBody ? perform(state.view, state.requestBody) : Promise.resolve(); },
  };
}

function displayLocator(value) {
  const locator = String(value || '').replace(/(?:原文)?字符\s*\d+\s*[–—−-]\s*\d+/gu, '').replace(/^[\s·]+|[\s·]+$/gu, '');
  return /^(?:保存的原文|原文|正文|原文片段)$/u.test(locator) ? '' : locator.slice(0, 100);
}

function excerpts(chunks, label = '', maximum = 1, terms = [], characterLimit = 200) {
  const entries = list(chunks).filter(chunk => typeof chunk?.text === 'string' && chunk.text.trim()).slice(0, maximum);
  if (!entries.length) return '';
  return `<div class="forme-knowledge-evidence">${entries.map(chunk => {
    const body = chunk.text.trim();
    const positions = list(terms).map(term => body.toLocaleLowerCase().indexOf(String(term).toLocaleLowerCase())).filter(index => index >= 0);
    const start = body.length > characterLimit && positions.length ? Math.max(0, Math.min(...positions) - 70) : 0;
    const excerpt = body.length > characterLimit ? `${start ? '…' : ''}${body.slice(start, start + characterLimit)}${start + characterLimit < body.length ? '…' : ''}` : body;
    const location = displayLocator(chunk.locator);
    const caption = [label, location, body.length > characterLimit ? '节选' : ''].filter(Boolean).join(' · ');
    return `<blockquote>${caption ? `<small>${escape(caption)}</small>` : ''}<p>${escape(excerpt)}</p></blockquote>`;
  }).join('')}</div>`;
}

const shortLabel = (value, maximum) => {
  const characters = Array.from(String(value || '收藏内容'));
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}…` : characters.join('');
};
const conceptsFor = item => list(item?.concepts).filter(concept => typeof concept?.id === 'string' && concept.id && typeof concept.name === 'string' && concept.name.trim()).slice(0, 2);
const imageSource = source => source?.sourceKind === 'image_description';
const sourceLabel = source => imageSource(source) ? '图片的 AI 描述' : '原文节选';

function sourceCaption(source) {
  let host = '';
  try { const url = new URL(source?.url); if (/^https?:$/u.test(url.protocol)) host = url.hostname.replace(/^www\./u, ''); } catch {}
  return [host, imageSource(source) ? '图片的 AI 描述' : ''].filter(Boolean).join(' · ');
}

function readSourceButton(source, chunks, label = '阅读原文') {
  if (!source?.collectionId) return '';
  const start = list(chunks)[0]?.start;
  return `<button type="button" class="btn ws-button" data-variant="ghost" data-size="sm" data-knowledge-action="read" data-knowledge-id="${escape(source.collectionId)}" data-knowledge-offset="${Number.isSafeInteger(start) && start >= 0 ? start : 0}" data-knowledge-version="${escape(source.documentVersionId || '')}">${icon('records')}${escape(imageSource(source) ? '阅读图片描述' : label)}</button>`;
}

function collectionTitle(item) {
  return `<h3><button type="button" data-knowledge-action="collection" data-knowledge-id="${escape(item.collectionId)}">${escape(item.title || '收藏内容')}${icon('arrow')}</button></h3>`;
}

function renderAnchor(anchor) {
  return `<section class="forme-knowledge-anchor"><div><p>当前收藏</p><h3>${escape(anchor.title || '收藏内容')}</h3></div>${readSourceButton(anchor, anchor.chunks)}</section>`;
}

function comparison(anchor, item) {
  const anchorChunks = list(item.anchorChunks).length ? item.anchorChunks : anchor?.chunks;
  if (!anchor || !list(anchorChunks).length || !list(item.chunks).length) return '';
  const terms = conceptsFor(item).map(concept => concept.name);
  const proof = (source, chunks) => `<section class="forme-knowledge-connection-proof"><h4>${escape(source.title || '收藏内容')}</h4>${excerpts(chunks, sourceLabel(source), 1, terms, 240)}${readSourceButton(source, chunks)}</section>`;
  return `<details class="forme-knowledge-comparison"><summary>对照原文${icon('chevron')}</summary><div class="forme-knowledge-connection-pair">${proof(anchor, anchorChunks)}${proof(item, item.chunks)}</div></details>`;
}

/** Keep a compact HTML tree alongside the desktop diagram for narrow panels. */
function connectionNetwork(anchor, items, selectedConcept) {
  const themes = new Map();
  for (const item of items) {
    if (item.relationType === 'related_topic') themes.set('related', { key:'related', name:'内容相近' });
    else for (const concept of conceptsFor(item)) if (!selectedConcept || concept.id === selectedConcept) themes.set(`concept:${concept.id}`, { ...concept, key:`concept:${concept.id}` });
  }
  const nodes = [...themes.values()];
  const height = Math.max(188, nodes.length * 42 + 48, items.length * 64 + 40);
  const position = (index, count) => Math.round((index + 1) * height / (count + 1));
  const themePositions = new Map(nodes.map((node, index) => [node.key, position(index, nodes.length)]));
  const paths = nodes.map(node => `<path d="M 211 ${height / 2} C 252 ${height / 2},252 ${themePositions.get(node.key)},291 ${themePositions.get(node.key)}"/>`);
  items.forEach((item, index) => {
    const keys = item.relationType === 'related_topic' ? ['related'] : conceptsFor(item).map(concept => `concept:${concept.id}`).filter(key => themePositions.has(key));
    for (const key of new Set(keys)) paths.push(`<path d="M 429 ${themePositions.get(key)} C 470 ${themePositions.get(key)},470 ${position(index, items.length)},509 ${position(index, items.length)}"/>`);
  });
  const article = (source, x, y, isAnchor = false) => {
    const body = `<title>${escape(source.title || '收藏内容')}</title><rect x="${x - 98}" y="${y - 24}" width="196" height="48" rx="8"/><text x="${x}" y="${y + 5}">${escape(shortLabel(source.title, 13))}</text>`;
    return isAnchor ? `<g class="forme-knowledge-network-article is-anchor">${body}</g>` : `<a href="#" class="forme-knowledge-network-article" data-knowledge-action="connections" data-knowledge-id="${escape(source.collectionId)}" aria-label="${escape(`查看《${source.title || '收藏内容'}》的关联`)}">${body}</a>`;
  };
  const concepts = nodes.map(node => {
    const y = themePositions.get(node.key);
    const body = `<title>${escape(node.name)}</title><rect x="292" y="${y - 16}" width="136" height="32" rx="6"/><text x="360" y="${y + 5}">${escape(shortLabel(node.name, 9))}</text>`;
    return node.id ? `<a href="#" class="forme-knowledge-network-concept${node.id === selectedConcept ? ' is-selected' : ''}" data-knowledge-action="concept" data-knowledge-concept="${escape(node.id)}" aria-label="${escape(`筛选主题：${node.name}`)}">${body}</a>` : `<g class="forme-knowledge-network-topic">${body}</g>`;
  }).join('');
  const compact = `<div class="forme-knowledge-network-compact"><div class="forme-knowledge-network-root">${icon('records')}<span>${escape(anchor.title || '收藏内容')}</span></div><ul class="forme-knowledge-network-tree">${items.map(item => `<li><p>${escape(item.relationType === 'related_topic' ? '内容相近' : conceptsFor(item).filter(concept => !selectedConcept || selectedConcept === concept.id).map(concept => concept.name).join(' · '))}</p><button type="button" class="btn ws-button forme-knowledge-network-node" data-variant="ghost" data-size="sm" data-knowledge-action="connections" data-knowledge-id="${escape(item.collectionId)}">${escape(item.title || '收藏内容')}${icon('arrow')}</button></li>`).join('')}</ul></div>`;
  return `<figure class="forme-knowledge-network" aria-label="收藏关联图"><div class="forme-knowledge-network-scroll"><svg viewBox="0 0 720 ${height}" role="group" aria-label="收藏与共同主题"><g class="forme-knowledge-network-lines" aria-hidden="true">${paths.join('')}</g>${article(anchor, 112, height / 2, true)}${concepts}${items.map((item, index) => article(item, 608, position(index, items.length))).join('')}</svg></div>${compact}</figure>`;
}

function renderConnections(state) {
  const anchor = state.anchor || {};
  const items = list(state.items).filter(item => item && item.collectionId).slice(0, 8);
  const selectedConcept = state.conceptFilter || '';
  const visible = selectedConcept ? items.filter(item => conceptsFor(item).some(concept => concept.id === selectedConcept)) : items;
  const concepts = [...new Map(items.filter(item => item.relationType === 'shared_concept').flatMap(conceptsFor).map(concept => [concept.id, concept])).values()];
  const header = renderAnchor(anchor);
  if (!items.length) return `${header}<p class="forme-knowledge-empty">暂未找到关联收藏。</p>`;
  const filters = concepts.length ? `<div class="ws-filters forme-knowledge-concept-filters" role="group" aria-label="按主题筛选"><button type="button" class="btn ws-filter${!selectedConcept ? ' is-active' : ''}" data-variant="ghost" data-size="sm" data-knowledge-action="concept" data-knowledge-concept="" aria-pressed="${!selectedConcept}">全部 <span>${items.length}</span></button>${concepts.map(concept => `<button type="button" class="btn ws-filter${concept.id === selectedConcept ? ' is-active' : ''}" data-variant="ghost" data-size="sm" data-knowledge-action="concept" data-knowledge-concept="${escape(concept.id)}" aria-pressed="${concept.id === selectedConcept}">${escape(concept.name)}</button>`).join('')}</div>` : '';
  const evidence = visible.map(item => {
    const names = conceptsFor(item);
    const relation = item.relationType === 'related_topic' ? '内容相近' : names.some(concept => concept.mentionType === 'extracted_topic') ? '相关主题' : '共同主题';
    return `<li><article class="forme-knowledge-result forme-knowledge-connection"><header class="forme-knowledge-result-head"><p class="forme-knowledge-relation-type">${escape([relation, names.map(concept => concept.name).join(' · ')].filter(Boolean).join(' · '))}</p>${collectionTitle(item)}</header>${excerpts(item.chunks, imageSource(item) ? sourceLabel(item) : '', 1, names.map(concept => concept.name), 180)}<div class="forme-knowledge-result-footer">${readSourceButton(item, item.chunks)}<button type="button" class="btn ws-button" data-variant="ghost" data-size="sm" data-knowledge-action="connections" data-knowledge-id="${escape(item.collectionId)}">查看关联${icon('connections')}</button></div>${comparison(anchor, item)}</article></li>`;
  }).join('');
  return `${header}${filters}${visible.length ? connectionNetwork(anchor, visible, selectedConcept) : ''}<p class="forme-knowledge-connection-count" role="status">${visible.length} 篇关联收藏</p><ol class="forme-knowledge-connections" aria-label="关联依据与双方原文">${evidence}</ol>`;
}

export function renderKnowledgeContent(state) {
  const back = state.canGoBack ? `<button type="button" class="btn ws-button forme-knowledge-back" data-variant="ghost" data-size="sm" data-knowledge-action="back"><span class="forme-knowledge-back-icon">${icon('arrow')}</span>${escape(state.backLabel || '返回查找结果')}</button>` : '';
  if (state.status === 'idle') return '<p class="forme-knowledge-empty">输入关键词，或描述想找的内容。</p>';
  if (state.status === 'loading') return `${back}<p class="forme-knowledge-status" role="status">${state.view === 'read' ? '正在打开…' : '正在查找…'}</p>`;
  if (state.status === 'error') return `${back}<p class="forme-knowledge-error" role="alert">${escape(state.error)}</p>${state.requestBody ? '<button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-knowledge-action="retry">重新尝试</button>' : ''}`;
  if (state.view === 'connections') return `${back}${renderConnections(state)}`;
  if (state.view === 'read') {
    const document = state.document || {};
    const chunks = list(document.chunks).filter(chunk => typeof chunk?.text === 'string' && chunk.text.trim());
    const body = typeof document.text === 'string' && document.text ? document.text : chunks.map(chunk => chunk.text).join('\n\n');
    if (!body) return `${back}<article class="forme-knowledge-document"><h3>${escape(document.title || '收藏内容')}</h3><p class="forme-knowledge-empty">暂时没有可阅读的原文。</p>${document.collectionId ? `<button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-knowledge-action="collection" data-knowledge-id="${escape(document.collectionId)}">查看收藏</button>` : ''}</article>`;
    const caption = [imageSource(document) ? '图片的 AI 描述' : '原文', sourceCaption(document).replace('图片的 AI 描述', '').replace(/ · $/u, ''), document.active === false ? '历史版本 · 原文已更新' : ''].filter(Boolean).join(' · ');
    return `${back}<article class="forme-knowledge-document"><header><p class="forme-knowledge-source">${escape(caption)}</p><h3>${escape(document.title || '收藏原文')}</h3>${imageSource(document) ? '<p class="forme-knowledge-note">请结合原图阅读。</p>' : ''}${document.coverage === 'reconstructed' ? '<p class="forme-knowledge-note">仅保存了部分片段，内容可能不完整。</p>' : document.coverage === 'partial' ? '<p class="forme-knowledge-note">仅保存了部分原文。</p>' : ''}${document.offset > 0 ? `<button type="button" class="btn ws-button" data-variant="ghost" data-size="sm" data-knowledge-action="read" data-knowledge-id="${escape(document.collectionId)}" data-knowledge-version="${escape(document.documentVersionId || '')}">从头阅读</button>` : ''}</header><div class="forme-knowledge-reading-text">${escape(body)}</div>${state.error ? `<p class="forme-knowledge-error" role="alert">${escape(state.error)}</p>` : ''}${document.hasMore ? `<button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-knowledge-action="more" ${state.status === 'loading_more' ? 'disabled' : ''}>${state.status === 'loading_more' ? '正在读取…' : '继续阅读'}</button>` : ''}</article>`;
  }
  const items = list(state.items);
  const mode = state.mode === 'full_text' ? '<p class="forme-knowledge-note">按关键词搜索</p>' : '';
  const anchor = state.view === 'similar' && state.anchor ? renderAnchor(state.anchor) : '';
  if (!items.length) return `${anchor}<p class="forme-knowledge-empty">${state.view === 'similar' ? '暂未找到相似收藏。' : '暂时没有找到相关收藏。'}</p>${mode}`;
  return `${anchor}<div class="forme-knowledge-results">${items.map(item => `<article class="forme-knowledge-result"><header class="forme-knowledge-result-head">${collectionTitle(item)}${sourceCaption(item) ? `<p class="forme-knowledge-source">${escape(sourceCaption(item))}</p>` : ''}</header>${excerpts(item.chunks || item.matchedChunks, '', 1, item.matchedTerms)}<div class="forme-knowledge-result-footer">${readSourceButton(item, item.chunks || item.matchedChunks)}</div>${state.view === 'similar' ? comparison(state.anchor, item) : ''}</article>`).join('')}</div>${mode}`;
}

/** Mounted only by the local desktop bridge; no request is made by mounting or rendering. */
export function mountKnowledgePanel({ api, getState, openCollection, openReading, document:doc = globalThis.document }) {
  if (!doc?.body) return { sync() {}, destroy() {} };
  if (!doc.querySelector('link[data-knowledge-panel-style]')) {
    const stylesheet = doc.createElement('link');
    stylesheet.rel = 'stylesheet'; stylesheet.href = '/curator/knowledge-panel.css'; stylesheet.dataset.knowledgePanelStyle = '';
    doc.head.append(stylesheet);
  }
  const dialog = doc.createElement('dialog');
  dialog.className = 'forme-live-dialog forme-knowledge-dialog';
  dialog.dataset.dialogManaged = 'knowledge';
  dialog.innerHTML = `<header class="forme-live-head"><div><small>我的收藏</small><h2>搜索收藏</h2></div><button type="button" class="btn ws-icon-button" data-variant="ghost" data-size="icon-sm" data-knowledge-action="close" aria-label="关闭">${icon('close')}</button></header><form class="forme-knowledge-search" aria-label="搜索收藏"><label class="ws-search" for="forme-knowledge-query">${icon('search')}<input class="input" id="forme-knowledge-query" type="search" name="query" maxlength="2000" aria-label="搜索收藏内容" placeholder="搜索主题、问题或原文" autocomplete="off"></label><button class="btn ws-button ws-button-primary" data-variant="primary" data-size="sm" type="submit">搜索</button></form><div class="forme-knowledge-content" aria-live="polite"></div>`;
  frameGlassDialog(dialog);
  doc.body.append(dialog);
  const title = dialog.querySelector('h2');
  const form = dialog.querySelector('form');
  const input = dialog.querySelector('input');
  const content = dialog.querySelector('.forme-knowledge-content');
  let opener = null, disposed = false;
  const controller = createKnowledgeController({ api, onChange:state => {
    if (disposed) return;
    title.textContent = state.view === 'read' && imageSource(state.document) ? '图片描述' : ({ search:'搜索收藏', similar:'相似收藏', read:'原文', connections:'关联图' })[state.view];
    dialog.dataset.knowledgeView = state.view;
    form.hidden = state.view !== 'search';
    if (input.value !== state.query && doc.activeElement !== input) input.value = state.query;
    content.innerHTML = renderKnowledgeContent(state);
    content.setAttribute('aria-busy', String(['loading', 'loading_more'].includes(state.status)));
  } });
  const show = trigger => {
    opener = trigger || doc.activeElement;
    if (!dialog.open) dialog.showModal();
  };
  const close = () => { controller.cancel(); return closeGlassDialog(dialog); };
  const openSearch = (query = '', trigger) => { controller.showSearch(query); show(trigger); input.value = query; input.focus({ preventScroll:true }); };
  const click = event => {
    const button = event.target.closest?.('[data-knowledge-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.knowledgeAction;
    if (!dialog.contains(button) && !['read', 'similar', 'connections'].includes(action)) return;
    event.preventDefault();
    if (action === 'close') { void close(); return; }
    if (action === 'more') { void controller.more(); return; }
    if (action === 'back') { controller.back(); return; }
    if (action === 'retry') { void controller.retry(); return; }
    if (action === 'concept') {
      const conceptId = button.dataset.knowledgeConcept || '';
      controller.filterConcept(conceptId);
      const selected = controller.getState().conceptFilter || '';
      [...content.querySelectorAll('button[data-knowledge-action="concept"]')].find(element => element.dataset.knowledgeConcept === selected)?.focus({ preventScroll:true });
      return;
    }
    if (action === 'collection') { void close().then(() => openCollection?.(button.dataset.knowledgeId)); return; }
    if (action === 'read' || action === 'similar' || action === 'connections') {
      if (action === 'read' && openReading && button.closest('.collection-glass__content')) {
        openReading(button.dataset.knowledgeId, { documentVersionId:button.dataset.knowledgeVersion || undefined, offset:Number(button.dataset.knowledgeOffset || 0) });
        return;
      }
      const alreadyOpen = dialog.open;
      if (!alreadyOpen) show(button);
      if (action === 'read') void controller.read(button.dataset.knowledgeId, { offset:Number(button.dataset.knowledgeOffset || 0), documentVersionId:button.dataset.knowledgeVersion || undefined, resetHistory:!alreadyOpen });
      else if (action === 'similar') void controller.similar(button.dataset.knowledgeId, { resetHistory:!alreadyOpen });
      else void controller.connections(button.dataset.knowledgeId, { resetHistory:!alreadyOpen });
    }
  };
  const submit = event => { event.preventDefault(); void controller.search(input.value); };
  const cancel = event => { event.preventDefault(); void close(); };
  const restoreFocus = () => {
    controller.cancel();
    const afterLayout = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView) || queueMicrotask;
    afterLayout(() => {
      const target = opener?.isConnected ? opener : [...doc.querySelectorAll('[data-knowledge-action]')].find(element =>
        !dialog.contains(element) && element.dataset.knowledgeAction === opener?.dataset?.knowledgeAction
        && element.dataset.knowledgeId === opener?.dataset?.knowledgeId);
      target?.focus({ preventScroll:true });
    });
  };
  doc.addEventListener('click', click);
  form.addEventListener('submit', submit);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', restoreFocus);
  function sync() {
    if (disposed) return;
    const state = getState?.() || {};
    const detail = doc.querySelector('.collection-glass__content');
    const collectionId = state.ui?.collectionId;
    if (detail && collectionId && !detail.querySelector('.forme-knowledge-actions')) {
      const collectionTools = detail.querySelector('.collection-briefing-tools');
      const originalAction = collectionTools ? '' : `<button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-knowledge-action="read" data-knowledge-id="${escape(collectionId)}">${icon('records')}阅读原文</button>`;
      const actions = `<div class="forme-knowledge-actions" role="group" aria-label="${collectionTools ? '收藏关联' : '阅读与关联'}">${originalAction}<button type="button" class="btn ws-button" data-variant="ghost" data-size="sm" data-knowledge-action="similar" data-knowledge-id="${escape(collectionId)}">${icon('search')}相似收藏</button><button type="button" class="btn ws-button" data-variant="ghost" data-size="sm" data-knowledge-action="connections" data-knowledge-id="${escape(collectionId)}">${icon('connections')}查看关联</button></div>`;
      const hero = detail.querySelector('.collection-glass__hero');
      if (collectionTools) collectionTools.insertAdjacentHTML('afterbegin', actions);
      else if (hero) hero.insertAdjacentHTML('afterend', actions);
      else detail.insertAdjacentHTML('afterbegin', actions);
    }
  }
  const Observer = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
  const observer = Observer ? new Observer(sync) : null;
  observer?.observe(doc.body, { childList:true, subtree:true });
  sync();
  return {
    sync, openSearch,
    destroy() {
      disposed = true; controller.cancel(); observer?.disconnect();
      doc.removeEventListener('click', click); form.removeEventListener('submit', submit);
      dialog.removeEventListener('cancel', cancel); dialog.removeEventListener('close', restoreFocus);
      if (dialog.open) dialog.close();
      dialog.remove();
      for (const element of doc.querySelectorAll('.forme-knowledge-actions')) element.remove();
    },
  };
}
