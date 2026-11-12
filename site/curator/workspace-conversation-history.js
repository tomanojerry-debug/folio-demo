import { conversationGroups } from './workspace-chat.js';

const PAGE_SIZE = 5;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
let nextHistoryId = 0;

/** Page across date groups, rather than showing five entries in every group. */
export function conversationHistoryPage(state, { query = '', visibleCount = PAGE_SIZE, now = Date.now() } = {}) {
  const all = conversationGroups(state, { query, now });
  const total = all.reduce((count, group) => count + group.conversations.length, 0);
  let remaining = Number.isFinite(visibleCount) ? Math.max(0, Math.floor(visibleCount)) : PAGE_SIZE;
  const groups = [];
  for (const group of all) {
    if (!remaining) break;
    const conversations = group.conversations.slice(0, remaining);
    if (conversations.length) groups.push({ title:group.title, conversations });
    remaining -= conversations.length;
  }
  const shown = groups.reduce((count, group) => count + group.conversations.length, 0);
  return { groups, total, visibleCount:shown, hasMore:shown < total };
}

/** A physical wheel gesture can emit dozens of events, but reveals one page. */
export function createHistoryWheelGate({ onReveal, setTimer = setTimeout, clearTimer = clearTimeout, quietMs = 180 } = {}) {
  let timer, revealed = false, destroyed = false;
  const reset = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; revealed = false; };
  return {
    handle(event) {
      const deltaY = Number(event?.deltaY), deltaX = Number(event?.deltaX) || 0;
      if (destroyed || event?.ctrlKey || !Number.isFinite(deltaY) || !deltaY || Math.abs(deltaX) > Math.abs(deltaY)) return false;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(() => { timer = undefined; revealed = false; }, quietMs);
      if (deltaY <= 0 || revealed) return false;
      revealed = true;
      onReveal?.();
      return true;
    },
    reset,
    destroy() { reset(); destroyed = true; },
  };
}

const icons = {
  history:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 8a6.5 6.5 0 1 1 .6 5.3M3.5 3.8V8h4.2M10 6.5v4l2.6 1.5"/></svg>',
  chat:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4.5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>',
  plus:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  search:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.1 3.1"/></svg>',
  close:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  more:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>',
};

/**
 * Mount once in the shared workspace sidebar. The caller owns persistence,
 * navigation and creation; rendering this component never creates a chat.
 */
export function mountWorkspaceConversationHistory({ root, getState, getActiveId, onSelect, onNew }) {
  if (!root?.ownerDocument || typeof getState !== 'function') throw new TypeError('A history root and state reader are required.');
  const document = root.ownerDocument;
  const window = document.defaultView || globalThis;
  const media = window.matchMedia?.('(max-width:760px)') || { matches:false };
  const identity = `ws-conversation-history-${++nextHistoryId}`;
  const previousRole = root.getAttribute('role'), previousLabel = root.getAttribute('aria-label');
  const cleanups = [];
  let visibleCount = PAGE_SIZE, query = '', signature = '', destroyed = false, creating = false;
  let dialog = null, drawerOpen = false, returnFocus = null;

  root.classList.add('ws-conversation-history');
  root.setAttribute('role','region');
  root.setAttribute('aria-label','对话记录');
  root.innerHTML = `<button type="button" class="ws-history-open" data-ws-history-open aria-label="打开对话记录" aria-haspopup="dialog" aria-controls="${identity}-drawer" aria-expanded="false">${icons.history}<span class="ws-history-visually-hidden">对话记录</span><i class="ws-history-open-state" aria-hidden="true" hidden></i></button><section class="ws-history-panel" data-ws-history-panel aria-labelledby="${identity}-title"><header class="ws-history-heading"><h2 id="${identity}-title">${icons.chat}<span>对话</span></h2><button type="button" class="ws-history-new" data-ws-history-new data-history-new aria-label="新建对话">${icons.plus}<span>新建</span></button><button type="button" class="ws-history-close" data-ws-history-close aria-label="关闭对话记录">${icons.close}</button></header><label class="ws-history-search">${icons.search}<input type="search" data-ws-history-search aria-label="搜索对话" placeholder="搜索对话" autocomplete="off" spellcheck="false"></label><div class="ws-history-scroll" data-ws-history-scroll tabindex="-1"><div class="ws-history-list" data-ws-history-list></div><button type="button" class="ws-history-more" data-ws-history-more hidden><span>展开更多</span><small></small>${icons.more}</button></div><p class="ws-history-error" data-ws-history-error hidden></p></section><span class="ws-history-visually-hidden" data-ws-history-announcement role="status" aria-live="polite" aria-atomic="true"></span>`;

  const find = selector => root.querySelector(selector);
  const opener = find('[data-ws-history-open]');
  const panel = find('[data-ws-history-panel]');
  const search = find('[data-ws-history-search]');
  const list = find('[data-ws-history-list]');
  const scroll = find('[data-ws-history-scroll]');
  const more = find('[data-ws-history-more]');
  const newButton = find('[data-ws-history-new]');
  const closeButton = find('[data-ws-history-close]');
  const error = find('[data-ws-history-error]');
  const announcement = find('[data-ws-history-announcement]');
  const workingIndicator = find('.ws-history-open-state');
  const listen = (target, name, handler, options) => {
    target.addEventListener(name, handler, options);
    cleanups.push(() => target.removeEventListener(name, handler, options));
  };
  const unavailable = () => root.hidden || Boolean(root.closest('[hidden]'));
  const canFocus = element => Boolean(element?.isConnected && !element.closest('[hidden],[inert]') && element.getClientRects().length);
  const reportError = value => { error.hidden = !value; error.textContent = value; announcement.textContent = value; };

  function close({ restoreFocus = true } = {}) {
    if (!drawerOpen) return;
    drawerOpen = false;
    if (dialog?.open) dialog.close();
    root.insertBefore(panel, announcement);
    panel.hidden = media.matches;
    opener.setAttribute('aria-expanded','false');
    const target = returnFocus; returnFocus = null;
    if (restoreFocus && !unavailable()) {
      if (canFocus(target)) target.focus({ preventScroll:true });
      else if (canFocus(opener)) opener.focus({ preventScroll:true });
      else if (!media.matches && canFocus(search)) search.focus({ preventScroll:true });
    }
  }

  function focusable() {
    return [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')].filter(canFocus);
  }

  function openDrawer() {
    if (destroyed || drawerOpen || !media.matches || unavailable()) return;
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = `${identity}-drawer`;
      dialog.className = 'ws-history-drawer';
      dialog.setAttribute('data-workspace-conversations','');
      dialog.setAttribute('aria-labelledby',`${identity}-title`);
      listen(dialog,'cancel',event => { event.preventDefault(); close(); });
      listen(dialog,'click',event => { if (event.target === dialog) close(); });
      listen(dialog,'close',() => { if (drawerOpen && !dialog.open) close(); });
      listen(dialog,'keydown',event => {
        if (!drawerOpen) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key !== 'Tab') return;
        const items = focusable(), current = document.activeElement;
        if (!items.length) { event.preventDefault(); panel.focus(); return; }
        if (!items.includes(current) || (event.shiftKey && current === items[0])) {
          event.preventDefault(); (event.shiftKey ? items.at(-1) : items[0]).focus();
        } else if (!event.shiftKey && current === items.at(-1)) { event.preventDefault(); items[0].focus(); }
      });
      document.body.append(dialog);
    }
    returnFocus = document.activeElement;
    dialog.append(panel);
    panel.hidden = false;
    try { dialog.showModal(); }
    catch {
      root.insertBefore(panel, announcement); panel.hidden = media.matches; returnFocus = null;
      reportError('暂时无法打开对话记录，请再试一次。'); return;
    }
    drawerOpen = true;
    opener.setAttribute('aria-expanded','true');
    search.focus({ preventScroll:true });
  }

  function render() {
    if (destroyed) return;
    if (unavailable()) {
      close({ restoreFocus:false }); list.innerHTML = ''; more.hidden = true;
      workingIndicator.hidden = true; signature = ''; return;
    }
    const state = getState() || {};
    const activeId = typeof getActiveId === 'function' ? getActiveId() : state.activeConversationId;
    const page = conversationHistoryPage(state, { query, visibleCount });
    const entries = page.groups.map(group => [group.title, group.conversations.map(item => [item.id,item.title,item.working,item.failed])]);
    const workingCount = conversationGroups(state).flatMap(group => group.conversations).filter(item => item.working).length;
    const next = JSON.stringify([entries,activeId,page.total,page.visibleCount,query,workingCount]);
    if (next === signature) return page;
    signature = next;
    const focusedId = list.contains(document.activeElement) ? document.activeElement?.dataset.wsConversation : null;
    const items = page.groups.flatMap(group => group.conversations);
    list.innerHTML = items.length ? `<ul>${items.map(item => `<li><button type="button" class="ws-history-row${item.id === activeId ? ' is-current' : ''}" data-ws-conversation="${escape(item.id)}"${item.id === activeId ? ' aria-current="page"' : ''} title="${escape(item.title)}"><span>${escape(item.title)}</span>${item.working ? '<i class="ws-history-state is-working" aria-hidden="true"></i><span class="ws-history-visually-hidden">处理中</span>' : item.failed ? '<i class="ws-history-state is-failed" aria-hidden="true"></i><span class="ws-history-visually-hidden">处理未完成</span>' : ''}</button></li>`).join('')}</ul>` : `<p class="ws-history-empty">${query.trim() ? '没有匹配的对话' : '从一个问题开始'}</p>`;
    const nextCount = Math.min(PAGE_SIZE,page.total - page.visibleCount);
    more.hidden = !page.hasMore;
    more.querySelector('small').textContent = `+${nextCount}`;
    more.setAttribute('aria-label',`再显示 ${nextCount} 条对话，还有 ${page.total - page.visibleCount} 条`);
    workingIndicator.hidden = !workingCount;
    opener.setAttribute('aria-label',`打开对话记录${workingCount ? `，${workingCount} 段正在处理` : ''}`);
    if (focusedId) {
      const replacement = [...list.querySelectorAll('[data-ws-conversation]')].find(button => button.dataset.wsConversation === focusedId);
      (replacement || scroll).focus({ preventScroll:true });
    }
    return page;
  }

  function reveal() {
    if (destroyed || unavailable()) return false;
    const current = conversationHistoryPage(getState() || {}, { query, visibleCount });
    if (!current.hasMore) return false;
    visibleCount += PAGE_SIZE;
    const page = render();
    announcement.textContent = `已显示 ${page.visibleCount} 条对话，共 ${page.total} 条。`;
    return true;
  }

  const wheel = createHistoryWheelGate({ onReveal:reveal });
  listen(scroll,'wheel',event => {
    const before = visibleCount;
    wheel.handle(event);
    if (before !== visibleCount) event.preventDefault();
  },{ passive:false });
  listen(more,'click',() => { wheel.reset(); reveal(); });
  listen(search,'input',() => {
    query = search.value; visibleCount = PAGE_SIZE; wheel.reset(); scroll.scrollTop = 0;
    const page = render();
    if (page) announcement.textContent = query.trim() ? `找到 ${page.total} 条对话，已显示 ${page.visibleCount} 条。` : '';
  });
  listen(opener,'click',openDrawer);
  listen(closeButton,'click',() => close());
  listen(list,'click',async event => {
    const button = event.target.closest('[data-ws-conversation]');
    if (!button || !list.contains(button)) return;
    reportError(''); close();
    try { await onSelect?.(button.dataset.wsConversation); }
    catch { if (!destroyed) reportError('暂时未能打开这段对话，请重试。'); }
  });
  listen(newButton,'click',async () => {
    if (creating || destroyed || unavailable()) return;
    creating = true; newButton.disabled = true; newButton.setAttribute('aria-busy','true'); reportError('');
    try { await onNew?.(); if (!destroyed) close(); }
    catch { if (!destroyed) reportError('暂时未能新建对话，请重试。'); }
    finally { creating = false; newButton.disabled = false; newButton.removeAttribute('aria-busy'); }
  });
  const onMediaChange = () => { close(); panel.hidden = media.matches; };
  if (media.addEventListener) listen(media,'change',onMediaChange);
  else if (media.addListener) { media.addListener(onMediaChange); cleanups.push(() => media.removeListener(onMediaChange)); }
  panel.hidden = media.matches;
  render();

  return {
    render,
    close:() => close(),
    destroy() {
      if (destroyed) return;
      close({ restoreFocus:false }); destroyed = true;
      wheel.destroy(); cleanups.splice(0).forEach(cleanup => cleanup()); dialog?.remove();
      root.replaceChildren(); root.classList.remove('ws-conversation-history');
      for (const [name,value] of [['role',previousRole],['aria-label',previousLabel]]) {
        if (value === null) root.removeAttribute(name); else root.setAttribute(name,value);
      }
    },
  };
}
