import { resolveConversation } from './workspace-chat.js';
import { mountWorkspaceConversationHistory } from './workspace-conversation-history.js';

const pages = { '#top':'home', '#home':'home', '#inbox':'inbox', '#gallery':'gallery', '#notes':'records' };

export function conversationWorkspaceURL(id) {
  return `/prototype/immersive-exhibition/light.html?conversation=${encodeURIComponent(id)}#chat`;
}

export function conversationRoute(url) {
  const parsed = new URL(url, 'http://localhost');
  return parsed.hash === '#chat' ? { conversationId:parsed.searchParams.get('conversation') || '' } : null;
}

const mountConversationView = async (host, options) => {
  const { mountEmbeddedConversation } = await import('./embedded-conversation.js');
  return mountEmbeddedConversation(host,options);
};

/** One persistent conversation surface beside #app; the product sidebar stays mounted. */
export function mountWorkspaceConversationShell({ getState, navigatePage, openCollection, openExhibition, onState, onError, sample = false, mountConversation = mountConversationView, mountHistory = mountWorkspaceConversationHistory }) {
  const host = document.querySelector('[data-workspace-conversation-host]');
  const app = document.getElementById('app');
  const historyRoot = document.querySelector('[data-workspace-conversations]');
  let snapshot = getState(), controller = null, mounting = null;
  let visible = false, activeId = '', revision = 0, disposed = false, selecting = false;
  const lifetime = new AbortController();
  const report = error => onError?.(error?.message || '对话暂时没有打开，请稍后再试。');
  const history = mountHistory({
    root:historyRoot, getState:() => snapshot, getActiveId:() => visible ? activeId : '',
    onSelect:id => { void show(id).catch(report); },
    onNew:async () => {
      if (sample) return;
      history.close();
      const current = ++revision;
      try {
        const chat = await ensureController();
        if (current !== revision || disposed) return;
        visible = true; applyVisibility(); chat.update(snapshot); chat.setVisible(true);
        const id = await chat.create();
        if (current !== revision || disposed) return;
        activeId = id || activeId || resolveConversation(snapshot);
        writeRoute(activeId, 'push'); applyVisibility();
      } catch (error) { report(error); }
    },
  });
  historyRoot.hidden = sample;

  function notifyNative() {
    const title = snapshot?.conversations?.find(item => item.id === activeId)?.title || '和 Tag 对话';
    window.webkit?.messageHandlers?.forme?.postMessage({action:'workspaceConversation',visible,title});
  }
  function applyVisibility() {
    app.hidden = visible;
    host.hidden = !visible;
    document.body.classList.toggle('workspace-chat-open',visible);
    if (visible) {
      document.querySelectorAll('[data-workspace-nav] [data-nav]').forEach(link => { link.classList.remove('active'); link.setAttribute('aria-current','false'); });
      const title = snapshot?.conversations?.find(item => item.id === activeId)?.title;
      document.title = `${title || '和 Tag 对话'} · Folio`;
    }
    history.render(); notifyNative();
  }
  function writeRoute(id, mode = 'replace') {
    if (!id) return;
    const destination = conversationWorkspaceURL(id);
    if (`${location.pathname}${location.search}${location.hash}` !== destination) window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state,'',destination);
  }
  function clearConversationURL(page = 'home', push = false) {
    const url = new URL(location.href);
    url.searchParams.delete('conversation');
    url.hash = ({home:'top',records:'notes'})[page] || page;
    window.history[push ? 'pushState' : 'replaceState'](window.history.state,'',url);
  }
  async function ensureController() {
    if (!mounting) mounting = Promise.resolve().then(async () => {
      controller = await mountConversation(host, {
        onState:state => { onState?.(state); update(state); },
        onConversationChange:id => {
          activeId = id;
          if (visible && !selecting) { writeRoute(id); applyVisibility(); }
        },
        onOpenCollection:id => { leave('inbox'); openCollection(id); },
        onOpenExhibition:id => { leave('gallery'); openExhibition(id); },
        onClose:() => leave('home'),
      });
      if (disposed) { controller.destroy(); return controller; }
      controller.update(snapshot); controller.setVisible(visible);
      return controller;
    }).catch(error => { mounting = null; throw error; });
    return mounting;
  }
  async function show(id, { historyMode = 'push' } = {}) {
    if (sample || disposed) return;
    const current = ++revision;
    const selected = resolveConversation(snapshot,id);
    if (!selected) throw new Error('还没有可打开的对话。可以从首页开始。');
    const chat = await ensureController();
    if (current !== revision || disposed) return;
    activeId = selected; visible = true;
    chat.update(snapshot); chat.setVisible(true); applyVisibility();
    selecting = true;
    try { await chat.select(selected); }
    finally { selecting = false; }
    if (current !== revision || disposed) return;
    writeRoute(selected,historyMode); applyVisibility();
  }
  function hide() {
    revision++; visible = false;
    history.close();
    controller?.setVisible(false);
    applyVisibility();
  }
  function leave(page) {
    hide(); clearConversationURL(page,true); navigatePage(page);
    document.title = 'Folio · 私人收藏馆';
  }
  function update(state = getState()) {
    snapshot = state;
    controller?.update(state);
    history.render();
    if (visible) applyVisibility();
  }
  async function route() {
    if (sample) return;
    const request = conversationRoute(location.href);
    if (request && !sample) {
      if (visible && request.conversationId === activeId) return;
      await show(request.conversationId,{historyMode:'replace'});
    } else {
      const wasVisible = visible;
      hide();
      if (wasVisible || pages[location.hash]) navigatePage(pages[location.hash] || 'home');
      document.title = 'Folio · 私人收藏馆';
    }
  }
  // Run before the four-page click handler; its existing navigation then owns the right view.
  document.addEventListener('click',event => {
    if (sample) return;
    if (visible && event.target.closest?.('.ws-skip')) { event.preventDefault(); host.focus({preventScroll:true}); return; }
    const target = event.target.closest?.('[data-nav]');
    if (!target || !['home','inbox','gallery','records'].includes(target.dataset.nav)) return;
    const wasVisible = visible;
    hide();
    if (wasVisible) clearConversationURL(target.dataset.nav,true);
    document.title = 'Folio · 私人收藏馆';
  },{capture:true,signal:lifetime.signal});
  window.addEventListener('popstate',() => { void route().catch(report); },{signal:lifetime.signal});
  window.addEventListener('hashchange',() => { void route().catch(report); },{signal:lifetime.signal});
  document.addEventListener('keydown',event => {
    if (!visible || document.querySelector('dialog[open]') || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault(); historyRoot.querySelector('[data-history-new]')?.click();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      const opener = historyRoot.querySelector('[data-ws-history-open]');
      if (opener && getComputedStyle(opener).display !== 'none') opener.click();
      else historyRoot.querySelector('input[type="search"]')?.focus();
    }
  },{signal:lifetime.signal});
  return {
    update, show, hide, leave, route, isVisible:() => visible, getRevision:() => revision,
    syncVisibility:() => { if (visible) applyVisibility(); },
    destroy() { disposed=true; revision++; lifetime.abort(); history.destroy(); controller?.destroy(); },
  };
}
