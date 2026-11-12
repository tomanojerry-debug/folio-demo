import { samePageReadTarget } from './page-reader.js';

const text = value => typeof value === 'string' ? value : '';
const list = value => Array.isArray(value) ? value : [];

/** Stable document identity for UI comparisons; authoritative identity is resolved by the service. */
export function companionPageKey(context) {
  try {
    const url = new URL(context?.url);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    if (!/^#(?:\/|!)/.test(url.hash)) url.hash = '';
    return `${text(context?.appName)}|${text(context?.browserProfileId)}|${url.href}`;
  } catch { return ''; }
}

export function companionSurface(state, surface = 'companion') {
  const value = state?.surfaceSessions?.[surface] || {};
  return { ...value, conversationId: text(value.conversationId || value.lastConversationId), drafts: value.drafts || {} };
}

export function companionHistory(state, limit = 5) {
  return [...list(state?.conversations)].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .filter(item => item.messageCount !== 0 || item.pageSession).slice(0, limit);
}

/** A view-state machine. Browser observation never authorizes source reading. */
export function createCompanionSessions({ api, getConversationId, getGuard = () => false, onSelect, onChange = () => {}, onState = () => {}, onError = () => {} }) {
  const view = { observedPage: null, acceptedSource: null, resolution: null, followMode: 'follow', status: 'idle', error: '', visible: true };
  let version = 0, resolving = null, opening = null, openingKey = '', openingVersion = 0, openingSignal, pendingRequest = null, destroyed = false, lastResolvedKey = '', attachmentId = '', entryPending = true;
  const emit = () => { if (!destroyed) onChange({ ...view }); };
  const current = token => !destroyed && token === version;
  const sameAccepted = () => Boolean(companionPageKey(view.acceptedSource) && companionPageKey(view.acceptedSource) === companionPageKey(view.observedPage));
  const hasUnsupportedWindow = () => ['unsupported','needs_window_recognition'].includes(view.observedPage?.contextStatus)
    && Boolean(text(view.observedPage.attachmentId)) && !companionPageKey(view.observedPage);

  async function activate(id, context, state, { pinned = false, token = version } = {}) {
    if (!current(token) || !view.visible) return false;
    view.acceptedSource = context || null;
    view.forceNew = false;
    view.followMode = pinned ? 'pinned' : 'follow';
    view.status = hasUnsupportedWindow() ? 'window-only' : 'idle'; view.error = '';
    await onSelect(id || '', { context:view.acceptedSource, state, pinned });
    if (current(token)) emit();
    return current(token);
  }

  async function resume(resolution, { explicit = false, token = version } = {}) {
    if (!resolution?.conversationId || !current(token)) return false;
    if (!explicit && (view.followMode === 'pinned' || getGuard())) { view.status = 'resume'; emit(); return false; }
    const result = await api('pages/source', { conversationId:resolution.conversationId });
    if (!current(token)) return false;
    return activate(resolution.conversationId, result.context, result.state, { token });
  }

  async function observe(context, { force = false } = {}) {
    if (destroyed) return null;
    const nextAttachment = text(context?.attachmentId);
    if (attachmentId && nextAttachment && attachmentId !== nextAttachment) view.followMode = 'follow';
    attachmentId = nextAttachment;
    view.observedPage = context || null;
    const key = companionPageKey(context);
    if (!key) {
      version++; lastResolvedKey = ''; view.resolution = null; view.error = '';
      view.status = hasUnsupportedWindow() ? 'window-only' : view.acceptedSource ? 'detached' : 'idle';
      emit(); return null;
    }
    if (!force && key === lastResolvedKey && !openingSignal?.aborted) { emit(); return resolving; }
    lastResolvedKey = key;
    const token = ++version;
    view.error = ''; view.status = 'checking'; emit();
    resolving = (async () => {
      try {
        const result = await api('pages/resolve', { context });
        if (!current(token)) return null;
        view.resolution = result;
        if (!view.visible) { view.status = result.status; emit(); return result; }
        if (view.followMode === 'pinned') { view.status = sameAccepted() ? 'idle' : 'pinned'; emit(); return result; }
        if (result.status === 'active' && result.conversationId) {
          if (result.conversationId === getConversationId() && sameAccepted()) view.status = 'idle';
          else await resume(result, { token });
        } else {
          view.status = result.status === 'expired' ? 'expired' : 'unread';
          // Expiry is checked on entry, never by a timer that clears active typing.
          const expiredCurrent = result.status === 'expired' && (sameAccepted() || result.previousConversationId === getConversationId());
          if (expiredCurrent && (!getGuard() || entryPending)) { await activate('', null, null, { token }); if (current(token)) view.status = 'expired'; }
        }
        entryPending = false;
        if (current(token)) emit();
        return result;
      } catch (error) {
        if (current(token)) { view.status = 'error'; view.error = error.message; emit(); onError(error); }
        return null;
      } finally { if (current(token)) resolving = null; }
    })();
    return resolving;
  }

  async function open({ forceNew = false, reread = false, capture, signal } = {}) {
    if (destroyed || signal?.aborted || !view.visible || !view.observedPage || hasUnsupportedWindow()) return null;
    if (opening && openingVersion === version && openingKey === companionPageKey(view.observedPage)) return opening;
    forceNew ||= view.forceNew === true;
    if (!forceNew && !reread && view.resolution?.status === 'active') { await resume(view.resolution, { explicit:true }); return getConversationId(); }
    const expected = { ...view.observedPage }, expectedKey = companionPageKey(expected), token = ++version;
    openingKey = expectedKey; openingVersion = token; openingSignal = signal;
    const isCurrent = () => current(token) && view.visible && !signal?.aborted;
    const attachment = signal && [expected.attachmentId, expected.pageRevision, expected.browserWindowId, expected.browserTabId, expected.url];
    const signature = JSON.stringify([expectedKey,forceNew,reread,attachment]);
    if (pendingRequest?.signature !== signature) pendingRequest = { signature,requestId:`page-session-${Date.now()}-${Math.random().toString(36).slice(2,10)}` };
    const request = pendingRequest;
    view.status = 'reading'; view.error = ''; emit();
    opening = (async () => {
      try {
        const context = request.context || (capture ? await capture(expected) : expected);
        if (!isCurrent()) return null;
        if (!context || companionPageKey(context) !== expectedKey) throw new Error('页面已经变化，请确认当前来源后再试。');
        request.context = context;
        const result = await api('pages/open', { context, requestId:request.requestId, ...(forceNew ? { forceNew:true } : {}), ...(reread ? { reread:true } : {}) }, { signal });
        if (!isCurrent()) return null;
        if (!result.readable) {
          if (pendingRequest === request) pendingRequest = null;
          throw new Error('这页的正文暂时没能读到，可以重试或粘贴正文。');
        }
        if (!result.conversationId) throw new Error('这页的正文暂时没能关联到对话，请重试。');
        if (signal && (result.requestId !== request.requestId || !samePageReadTarget(expected, result.context))) {
          throw new Error('页面已经变化，请确认当前来源后再试。');
        }
        if (result.state) onState(result.state);
        view.resolution = { status:'active', conversationId:result.conversationId, title:result.context?.title, readAt:result.conversation?.pageSession?.readAt, expiresAt:result.conversation?.pageSession?.expiresAt };
        if (!await activate(result.conversationId, result.context, result.state, { token }) || !isCurrent()) return null;
        if (pendingRequest === request) pendingRequest = null;
        return result.conversationId;
      } catch (error) {
        if (isCurrent()) { view.status = 'error'; view.error = error.message; emit(); if (!signal) onError(error); }
        return null;
      } finally { if (openingVersion === token) { opening = null; openingKey = ''; openingSignal = undefined; } }
    })();
    return opening;
  }

  return {
    get view() { return { ...view }; },
    observe, open,
    async newDraft() {
      version++; pendingRequest = null; view.forceNew = true; view.acceptedSource = null; view.resolution = null; view.followMode = 'pinned';
      view.status = hasUnsupportedWindow() ? 'window-only' : view.observedPage ? 'unread' : 'idle';
      await onSelect('', {context:null,pinned:true}); emit();
    },
    async resume() { return resume(view.resolution, { explicit:true }); },
    keep() { version++; view.followMode = 'pinned'; view.status = hasUnsupportedWindow() ? 'window-only' : 'pinned'; view.error = ''; emit(); },
    async follow() { view.followMode = 'follow'; lastResolvedKey = ''; return observe(view.observedPage, { force:true }); },
    async select(id, { state } = {}) {
      const token = ++version;
      let result = { context:null };
      try { if (id) result = await api('pages/source', { conversationId:id }); }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      if (current(token)) await activate(id, result.context, state || result.state, { pinned:true, token });
    },
    async restore(state) {
      const id = companionSurface(state).conversationId;
      if (!id || getConversationId() !== id) return;
      try { const result = await api('pages/source', { conversationId:id }); if (!destroyed && getConversationId() === id && !view.acceptedSource) { view.acceptedSource = result.context || null; await onSelect(id, { context:view.acceptedSource, state:result.state }); emit(); } }
      catch { /* Ordinary conversations do not require a page snapshot. */ }
    },
    async setVisible(visible) {
      if (visible && !view.visible) entryPending = true;
      version++; view.visible = Boolean(visible); opening = null;
      if (!visible) { emit(); return; }
      view.followMode = 'follow'; lastResolvedKey = '';
      if (view.observedPage) await observe(view.observedPage, { force:true }); else emit();
    },
    destroy() { destroyed = true; version++; },
  };
}
