import { closeGlassDialog } from './glass-dialogs.js';

const list = value => Array.isArray(value) ? value : [];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const plain = value => String(value || '').replace(/[`#*_>]/g, '').replace(/\s+/g, ' ').trim();
const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

export function resolveConversation(state, preferred) {
  const conversations = list(state?.conversations);
  if (conversations.some(item => item.id === preferred)) return preferred;
  if (conversations.some(item => item.id === state?.activeConversationId)) return state.activeConversationId;
  return conversations[0]?.id || '';
}

export function conversationMessages(state, conversationId) {
  const messages = list(state?.messages);
  if (!list(state?.conversations).length || !conversationId) return messages;
  const legacyId = state.conversations.find(item => item.id === 'conversation-legacy')?.id || state.conversations[0]?.id;
  return messages.filter(item => item.conversationId === conversationId || (!item.conversationId && conversationId === legacyId));
}

export function conversationJobs(state, conversationId) {
  const jobs = list(state?.jobs);
  if (!list(state?.conversations).length || !conversationId) return jobs;
  const messages = new Set(conversationMessages(state, conversationId).map(item => item.id));
  return jobs.filter(item => item.conversationId === conversationId || (!item.conversationId && messages.has(item.messageId)));
}

export function conversationGroups(state, { query = '', now = Date.now() } = {}) {
  const today = new Date(now); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today); week.setDate(week.getDate() - 7);
  const groups = new Map();
  const needle = plain(query).toLocaleLowerCase();
  for (const item of [...list(state?.conversations)].sort((a,b) => stamp(b.updatedAt || b.createdAt) - stamp(a.updatedAt || a.createdAt) || String(a.id).localeCompare(String(b.id)))) {
    const messages = conversationMessages(state, item.id);
    const first = messages.find(message => message.role === 'user');
    const last = messages.at(-1);
    const baseTitle = plain(item.title) || plain(first?.text || first?.content).slice(0,42) || '新对话';
    const pageTime = item.pageSession && stamp(item.createdAt) ? new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(item.createdAt)) : '';
    const title = pageTime ? `${baseTitle} · ${pageTime}` : baseTitle;
    if (needle && !`${title} ${messages.map(message => message.text || message.content || '').join(' ')}`.toLocaleLowerCase().includes(needle)) continue;
    const jobs = conversationJobs(state, item.id);
    const working = jobs.some(job => ['queued','running'].includes(job.status));
    const latest = jobs.at(-1);
    const preview = working ? 'Tag 正在处理…' : plain(last?.text || last?.content).slice(0,90) || '从一个问题开始';
    const time = stamp(item.updatedAt || item.createdAt);
    const group = time >= today.getTime() ? '今天' : time >= yesterday.getTime() ? '昨天' : time >= week.getTime() ? '过去 7 天' : '更早';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ ...item, title, preview, working, failed: !working && latest?.status === 'failed' });
  }
  return [...groups].map(([title, conversations]) => ({ title, conversations }));
}

export function createConversationDraftStore(storage) {
  const key = 'forme.conversation-drafts.v1';
  let drafts = Object.create(null);
  try {
    const parsed = JSON.parse(storage?.getItem(key) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const [id, draft] of Object.entries(parsed)) {
      if (draft && typeof draft === 'object') drafts[id] = { text: typeof draft.text === 'string' ? draft.text.slice(0,60000) : '', scope: draft.scope || null, scrollTop: Math.max(0, Number(draft.scrollTop) || 0), scrolled: draft.scrolled === true };
    }
  } catch {}
  let timer;
  const flush = () => { clearTimeout(timer); try { storage?.setItem(key, JSON.stringify(drafts)); } catch {} };
  return {
    get: id => drafts[id] ? { ...drafts[id] } : null,
    set(id, value) { if (!id) return; drafts[id] = { ...(drafts[id] || {}), ...value }; clearTimeout(timer); timer = setTimeout(flush, 180); },
    flush,
  };
}

export function mountConversationSidebar({ getState, getActiveId, onSelect, onNew }) {
  const sidebar = document.getElementById('chat-history');
  const panel = document.getElementById('chat-panel');
  const search = document.getElementById('conversation-search');
  const container = document.getElementById('conversation-list');
  const toggles = [...document.querySelectorAll('[data-chat-toggle-history]')];
  const shade = document.querySelector('[data-chat-history-shade]');
  const mobile = matchMedia('(max-width:820px)');
  let signature = '', lastTrigger = null, focusFrame = 0;
  const cancelFocus = () => { if (focusFrame) cancelAnimationFrame(focusFrame); focusFrame = 0; };
  const focusDrawer = () => {
    focusFrame = 0;
    if (!mobile.matches || !document.body.classList.contains('chat-history-open') || sidebar.inert || document.querySelector('dialog[open]') || sidebar.contains(document.activeElement)) return;
    if (!sidebar.getClientRects().length || getComputedStyle(sidebar).visibility !== 'visible') return;
    search.focus({ preventScroll:true });
  };
  const setOpen = open => {
    const show = mobile.matches && open;
    const wasOpen = document.body.classList.contains('chat-history-open');
    cancelFocus();
    // Capture the opener before inert blurs a focused element in the main pane.
    if (show && !wasOpen) lastTrigger = document.activeElement !== document.body ? document.activeElement : toggles.find(button => panel.contains(button));
    document.body.classList.toggle('chat-history-open', show);
    sidebar.inert = mobile.matches && !show;
    panel.inert = show;
    shade.hidden = !show;
    toggles.forEach(button => button.setAttribute('aria-expanded', String(show || !mobile.matches)));
    // Visibility changes with the drawer transition; focus only after painting.
    if (show) focusFrame = requestAnimationFrame(focusDrawer);
    else {
      const target = lastTrigger; lastTrigger = null;
      if (mobile.matches && target?.isConnected && target.getClientRects().length && getComputedStyle(target).visibility === 'visible' && !target.closest('[hidden],[inert]')) target.focus({ preventScroll:true });
    }
  };
  sidebar.addEventListener('transitionend', event => { if (event.target === sidebar) focusDrawer(); });
  mobile.addEventListener('change', () => setOpen(false));
  toggles.forEach(button => button.addEventListener('click', () => setOpen(!document.body.classList.contains('chat-history-open'))));
  shade.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => {
    if (!document.body.classList.contains('chat-history-open') || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
    if (event.key === 'Tab') {
      const elements = [...sidebar.querySelectorAll('a[href],button:not(:disabled),input')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility === 'visible');
      if (!elements.includes(document.activeElement)) { event.preventDefault(); (event.shiftKey ? elements.at(-1) : elements[0])?.focus(); }
      else if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
    }
  });
  function render() {
    const state = getState(), activeId = getActiveId();
    const groups = conversationGroups(state, { query:search.value });
    const next = JSON.stringify([groups,activeId]);
    if (next === signature) return;
    signature = next;
    const focusedId = document.activeElement?.dataset.conversationId;
    container.innerHTML = groups.length ? groups.map(group => `<section class="conversation-group"><h2>${escape(group.title)}</h2><ul>${group.conversations.map(item => `<li><button type="button" class="conversation-row${item.id === activeId ? ' is-current' : ''}" data-conversation-id="${escape(item.id)}"${item.id === activeId ? ' aria-current="page"' : ''} title="${escape(item.title)}"><span class="conversation-row-heading"><span>${escape(item.title)}</span>${item.working ? '<i class="conversation-state is-working" aria-label="处理中"></i>' : item.failed ? '<i class="conversation-state is-failed" aria-label="处理未完成"></i>' : ''}</span><small>${escape(item.preview)}</small></button></li>`).join('')}</ul></section>`).join('') : `<div class="conversation-empty"><span>${search.value.trim() ? '没有找到这段对话' : '这里留给我们的对话'}</span><p>${search.value.trim() ? '试试标题或消息中的关键词。' : '从一个问题，或一件喜欢的东西开始。'}</p></div>`;
    if (focusedId) [...container.querySelectorAll('[data-conversation-id]')].find(button => button.dataset.conversationId === focusedId)?.focus({ preventScroll:true });
  }
  search.addEventListener('input', render);
  container.addEventListener('click', event => { const button = event.target.closest('[data-conversation-id]'); if (button) { setOpen(false); onSelect(button.dataset.conversationId); } });
  const newButton = sidebar.querySelector('[data-chat-new]');
  newButton.addEventListener('click', async () => {
    if (newButton.disabled) return;
    newButton.disabled = true; newButton.setAttribute('aria-busy','true');
    try { await onNew(); setOpen(false); }
    finally { newButton.disabled = false; newButton.removeAttribute('aria-busy'); }
  });
  setOpen(false);
  return { render, close: () => setOpen(false) };
}

export function openConversationReferences(state, selectedScope, onApply, parent = document.body) {
  const dialog = document.createElement('dialog');
  dialog.className = 'chat-reference-dialog';
  dialog.setAttribute('aria-labelledby','chat-reference-title');
  const collections = list(state?.collections);
  const selected = new Set(list(selectedScope?.collectionIds).filter(id => collections.some(item => item.id === id)).slice(0,6));
  dialog.innerHTML = `<header><div><small>这次对话的参考</small><h2 id="chat-reference-title">带上几件收藏</h2></div><button type="button" class="small-button icon-button" data-reference-close aria-label="关闭收藏选择">×</button></header><p>选择这次想一起看的内容，最多 6 件。</p><label class="reference-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="搜索引用收藏" placeholder="搜索标题、来源或线索" autocomplete="off"></label><div class="reference-list">${collections.map(item => `<label data-reference-row><input type="checkbox" value="${escape(item.id)}"${selected.has(item.id) ? ' checked' : ''}><span><strong>${escape(item.title || '未命名收藏')}</strong><small>${escape(item.source || '我的收藏')}</small></span><i aria-hidden="true">✓</i></label>`).join('')}</div><p class="reference-empty" data-reference-empty hidden>没有找到匹配收藏。试试其他关键词。</p><footer><span data-reference-count aria-live="polite"></span><div><button type="button" class="small-button" data-reference-close>取消</button><button type="button" class="solid-button" data-reference-apply>带上这些收藏</button></div></footer>`;
  const update = () => {
    dialog.querySelector('[data-reference-count]').textContent = `已选 ${selected.size} / 6 件`;
    dialog.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = selected.size >= 6 && !input.checked; });
    dialog.querySelector('[data-reference-apply]').textContent = selected.size ? `带上 ${selected.size} 件收藏` : '暂不引用';
  };
  dialog.addEventListener('change', event => { if (!event.target.matches('input[type="checkbox"]')) return; if (event.target.checked && selected.size < 6) selected.add(event.target.value); else selected.delete(event.target.value); update(); });
  dialog.querySelector('input[type="search"]').addEventListener('input', event => {
    const query = event.target.value.trim().toLocaleLowerCase(); let visible = 0;
    dialog.querySelectorAll('[data-reference-row]').forEach((row,index) => { const item=collections[index]; row.hidden = !`${item.title} ${item.source} ${list(item.extraction?.tags).join(' ')}`.toLocaleLowerCase().includes(query); if (!row.hidden) visible++; });
    dialog.querySelector('[data-reference-empty]').hidden = visible > 0;
  });
  let applied = false;
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-reference-close]')) void closeGlassDialog(dialog);
    if (event.target.closest('[data-reference-apply]') && !applied) { applied = true; void closeGlassDialog(dialog).then(() => onApply([...selected])); }
  });
  dialog.addEventListener('close', () => dialog.remove(), {once:true});
  parent.append(dialog); update();
  if (!collections.length) { dialog.querySelector('[data-reference-empty]').hidden=false; dialog.querySelector('[data-reference-empty]').textContent='还没有收藏，先在收藏馆留下一件喜欢的内容。'; }
  dialog.showModal(); dialog.querySelector('input[type="search"]').focus();
}
