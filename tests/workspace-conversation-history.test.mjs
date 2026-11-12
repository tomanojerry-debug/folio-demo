import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationHistoryPage, createHistoryWheelGate, mountWorkspaceConversationHistory } from '../site/curator/workspace-conversation-history.js';

const now = new Date(2026, 10, 10, 15).getTime();
const at = (days, index = 0) => new Date(2026, 10, 10 - days, 12, 59 - index).toISOString();
function historyState() {
  const conversations = Array.from({ length: 16 }, (_, index) => ({
    id: `conversation-${index + 1}`,
    title: index === 0 ? '窗边的自然光' : `真实问题 ${index + 1}`,
    createdAt: at(index < 6 ? 0 : index < 12 ? 1 : 20, index),
    updatedAt: at(index < 6 ? 0 : index < 12 ? 1 : 20, index),
  }));
  return {
    conversations: conversations.toReversed(),
    activeConversationId: 'conversation-3',
    messages: conversations.map((item, index) => ({ id: `message-${index}`, role: 'user', conversationId: item.id, text: index % 2 ? '一段关于质感的真实提问' : '另一段关于自然的真实提问' })),
    jobs: [{ id: 'running', conversationId: 'conversation-2', status: 'running' }, { id: 'failed', conversationId: 'conversation-3', status: 'failed' }],
  };
}
const rows = page => page.groups.flatMap(group => group.conversations);

test('shared history begins with the five most recent real conversations', () => {
  const page = conversationHistoryPage(historyState(), { now });
  assert.equal(page.total, 16);
  assert.equal(page.hasMore, true);
  assert.deepEqual(rows(page).map(item => item.id), ['conversation-1', 'conversation-2', 'conversation-3', 'conversation-4', 'conversation-5']);
  assert.deepEqual(page.groups.map(group => group.title), ['今天']);
  assert.equal(rows(page)[1].working, true);
  assert.equal(rows(page)[2].failed, true);
});

test('five-row expansion crosses actual date groups without repeating or inventing rows', () => {
  const state = historyState();
  const ten = conversationHistoryPage(state, { visibleCount: 10, now });
  assert.deepEqual(ten.groups.map(group => [group.title, group.conversations.length]), [['今天', 6], ['昨天', 4]]);
  assert.equal(new Set(rows(ten).map(item => item.id)).size, 10);
  const all = conversationHistoryPage(state, { visibleCount: 20, now });
  assert.equal(rows(all).length, 16);
  assert.equal(all.hasMore, false);
  assert.deepEqual(all.groups.map(group => group.title), ['今天', '昨天', '更早']);
});

test('search pages the matching conversations and can find message content', () => {
  const state = historyState();
  const first = conversationHistoryPage(state, { query: '质感', now });
  assert.equal(first.total, 8);
  assert.equal(first.hasMore, true);
  assert.deepEqual(rows(first).map(item => item.id), ['conversation-2', 'conversation-4', 'conversation-6', 'conversation-8', 'conversation-10']);
  const rest = conversationHistoryPage(state, { query: '质感', visibleCount: 10, now });
  assert.equal(rows(rest).length, 8);
  assert.equal(rest.hasMore, false);
  assert.equal(conversationHistoryPage(state, { query: '未曾存在的内容', now }).total, 0);
  assert.deepEqual(rows(conversationHistoryPage({}, { now })), []);
});

function timers() {
  let clock = 0, next = 0;
  const pending = new Map();
  return {
    setTimer(callback, delay) { const id = ++next; pending.set(id, { callback, due: clock + delay }); return id; },
    clearTimer(id) { pending.delete(id); },
    advance(duration) {
      clock += duration;
      for (const [id, entry] of [...pending]) if (entry.due <= clock) { pending.delete(id); entry.callback(); }
    },
    get size() { return pending.size; },
  };
}

test('one trackpad burst reveals only one page and a later downward gesture reveals the next', () => {
  const timing = timers(); let calls = 0;
  const gate = createHistoryWheelGate({ onReveal: () => { calls++; }, setTimer: timing.setTimer, clearTimer: timing.clearTimer, quietMs: 180 });
  gate.handle({ deltaY: 1 });
  for (let index = 0; index < 35; index++) { timing.advance(12); gate.handle({ deltaY: 2 }); }
  assert.equal(calls, 1);
  timing.advance(179); gate.handle({ deltaY: 1 });
  assert.equal(calls, 1, 'momentum events extend the same gesture');
  timing.advance(180); gate.handle({ deltaY: 18 });
  assert.equal(calls, 2);
  gate.destroy();
  assert.equal(timing.size, 0);
});

test('upward, horizontal and zoom wheel events cannot expand history', () => {
  const timing = timers(); let calls = 0;
  const gate = createHistoryWheelGate({ onReveal: () => { calls++; }, setTimer: timing.setTimer, clearTimer: timing.clearTimer });
  gate.handle({ deltaY: -20 }); gate.handle({ deltaY: 0, deltaX: 40 }); gate.handle({ deltaY: 10, ctrlKey: true });
  assert.equal(calls, 0);
  timing.advance(180); gate.handle({ deltaY: 1 });
  assert.equal(calls, 1);
  gate.handle({ deltaY: -1 }); gate.handle({ deltaY: 1 });
  assert.equal(calls, 1, 'small direction changes inside a gesture do not consume extra pages');
  gate.destroy();
});

test('reset allows the next gesture after a new search, and destroyed gates cannot reveal more', () => {
  const timing = timers(); let calls = 0;
  const gate = createHistoryWheelGate({ onReveal: () => { calls++; }, setTimer: timing.setTimer, clearTimer: timing.clearTimer });
  gate.handle({ deltaY: 2 }); gate.reset(); gate.handle({ deltaY: 2 });
  assert.equal(calls, 2);
  assert.equal(timing.size, 1);
  gate.destroy(); gate.handle({ deltaY: 2 }); timing.advance(180);
  assert.equal(calls, 2);
  assert.equal(timing.size, 0);
});

// A deliberately small DOM for lifecycle and focus behavior. It executes the
// real component and dispatches real registered callbacks without a browser.
function domFixture({ mobile = false } = {}) {
  const listeners = target => {
    target.listeners = new Map();
    target.addEventListener = (type, callback) => { if (!target.listeners.has(type)) target.listeners.set(type, new Set()); target.listeners.get(type).add(callback); };
    target.removeEventListener = (type, callback) => target.listeners.get(type)?.delete(callback);
    target.emit = (type, values = {}) => {
      const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values };
      for (const callback of [...(target.listeners.get(type) || [])]) callback(event);
      return event;
    };
    return target;
  };
  let document;
  const camel = value => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = {}; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this._html = ''; this._text = ''; listeners(this); }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get className() { return this.attributes.get('class') || ''; }
    set className(value) { this.attributes.set('class', value); }
    get classList() { return { contains: value => this.className.split(/\s+/).includes(value), add: value => { this.className = `${this.className} ${value}`.trim(); }, remove: value => { this.className = this.className.split(/\s+/).filter(item => item !== value).join(' '); }, toggle: (value, force) => { const show = force === undefined ? !this.classList.contains(value) : force; if (show) this.classList.add(value); else this.classList.remove(value); return show; } }; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value); if (name === 'id') this.id = String(value); if (name === 'hidden') this.hidden = true; if (name === 'disabled') this.disabled = true; if (name === 'type') this.type = String(value); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))]; if (name === 'hidden') this.hidden = false; if (name === 'disabled') this.disabled = false; }
    append(...nodes) { for (const node of nodes) { node.remove?.(); node.parentElement = this; this.children.push(node); } }
    appendChild(node) { this.append(node); return node; }
    insertBefore(node, reference) { node.remove?.(); const index = this.children.indexOf(reference); node.parentElement = this; this.children.splice(index < 0 ? this.children.length : index, 0, node); return node; }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
    remove() { if (!this.parentElement) return; this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    contains(node) { return this === node || this.children.some(child => child.contains?.(node)); }
    focus() { document.activeElement = this; }
    getClientRects() { return this.hidden || this.closest('[hidden]') || (this.tagName === 'DIALOG' && !this.open) ? [] : [{}]; }
    showModal() { this.open = true; }
    close() { if (!this.open) return; this.open = false; this.emit('close'); }
    matches(selector) {
      return selector.split(',').some(part => {
        let term = part.trim();
        if (!term) return false;
        if (term.includes(':not(:disabled)')) { if (this.disabled) return false; term = term.replace(':not(:disabled)', ''); }
        if (term.includes(':not([hidden])')) { if (this.hidden) return false; term = term.replace(':not([hidden])', ''); }
        const tag = /^([a-z][\w-]*)/i.exec(term)?.[1]; if (tag && this.tagName !== tag.toUpperCase()) return false;
        for (const [, name] of term.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
        const ident = /#([\w-]+)/.exec(term)?.[1]; if (ident && this.id !== ident) return false;
        for (const [, name, value] of term.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
          if (name === 'hidden' ? !this.hidden : !this.hasAttribute(name)) return false;
          if (value !== undefined && this.getAttribute(name) !== value) return false;
        }
        return true;
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get innerHTML() { return this._html; }
    set innerHTML(value) {
      this._html = String(value); this._text = ''; this.replaceChildren();
      const stack = [this], voids = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'path', 'circle', 'line', 'polyline']);
      for (const token of this._html.match(/<[^>]+>|[^<]+/g) || []) {
        if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        if (token.startsWith('<')) {
          const tag = /^<([\w-]+)/.exec(token)?.[1]; if (!tag) continue;
          const child = new Element(tag);
          for (const [, name, double, single, bare] of token.slice(tag.length + 1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)) child.setAttribute(name, double ?? single ?? bare ?? '');
          stack.at(-1).append(child); if (!voids.has(tag) && !token.endsWith('/>')) stack.push(child);
        } else stack.at(-1)._text += token;
      }
    }
  }
  const media = listeners({ matches: mobile });
  const frames = new Map(); let frameId = 0;
  const window = listeners({ matchMedia: () => media, setTimeout, clearTimeout, requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; }, cancelAnimationFrame(id) { frames.delete(id); }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
  document = listeners({ defaultView: window, createElement: tag => new Element(tag), querySelector(selector) { return this.body.querySelector(selector); }, querySelectorAll(selector) { return this.body.querySelectorAll(selector); }, getElementById(id) { return this.body.querySelector(`#${id}`); } });
  document.body = new Element('body'); document.activeElement = document.body;
  const root = new Element('section'); document.body.append(root);
  const dispatch = (target, type, values = {}) => {
    let prevented = false;
    for (let current = target; current; current = current.parentElement) { const event = current.emit(type, { target, ...values }); prevented = event.defaultPrevented || prevented; }
    const event = document.emit(type, { target, ...values }); prevented = event.defaultPrevented || prevented;
    return { defaultPrevented: prevented };
  };
  return { root, document, window, media, dispatch, paint() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } } };
}

function mountFixture(options = {}) {
  const h = domFixture(options);
  let state = options.state || historyState(), reads = 0, creates = 0;
  const selections = [];
  const controller = mountWorkspaceConversationHistory({ root: h.root, getState() { reads++; return state; }, getActiveId: () => state.activeConversationId, onSelect(id) { selections.push(id); return options.onSelect?.(id); }, onNew() { creates++; return options.onNew?.(); } });
  return { ...h, controller, selections, get reads() { return reads; }, get creates() { return creates; }, setState(value) { state = value; }, get list() { return h.root.querySelector('[data-ws-history-list]') || h.document.body.querySelector('[data-ws-history-list]'); }, button(selector) { return h.document.body.querySelector(selector); } };
}

test('mounting and rerendering empty history never creates a conversation', () => {
  const h = mountFixture({ state: { conversations: [], messages: [], jobs: [] } });
  h.controller.render(); h.controller.render();
  assert.equal(h.creates, 0);
  assert.ok(h.button('[data-history-new]'));
  assert.ok(h.button('[data-ws-history-search]'));
  assert.equal(h.list.querySelectorAll('[aria-current="page"]').length, 0);
  h.controller.destroy();
  assert.equal(h.root.children.length, 0);
});

test('hidden history never reads private state and closing a hidden mount leaves no body drawer', () => {
  const h = domFixture(); h.root.hidden = true; let reads = 0;
  const controller = mountWorkspaceConversationHistory({ root: h.root, getState() { reads++; return historyState(); }, getActiveId: () => '', onSelect() {}, onNew() { throw new Error('No automatic creation'); } });
  controller.render();
  assert.equal(reads, 0);
  h.root.hidden = false; controller.render();
  assert.ok(reads > 0);
  h.root.hidden = true; const before = reads; controller.render();
  assert.equal(reads, before);
  const list = h.root.querySelector('[data-ws-history-list]');
  assert.equal(list?.children.length || 0, 0);
  controller.destroy();
  assert.equal(h.document.body.querySelectorAll('[data-workspace-conversations]').length, 0);
});

test('mounted history shows title-only rows with active and truthful background states', () => {
  const h = mountFixture();
  const heading = h.root.querySelector('h2');
  assert.equal(heading.textContent, '对话');
  assert.equal(heading.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.ok(heading.querySelector('svg').querySelector('path'), 'the conversation heading has a decorative outline icon');
  const items = h.list.querySelectorAll('[data-ws-conversation]');
  assert.equal(items.length, 5);
  assert.equal(h.list.querySelectorAll('ul').length, 1, 'history renders as one flat list');
  assert.equal(h.list.querySelectorAll('h3').length, 0, 'date labels do not occupy the sidebar');
  assert.equal(h.list.querySelector('[aria-current="page"]').dataset.wsConversation, 'conversation-3');
  assert.equal(h.list.querySelectorAll('.is-working').length, 1);
  assert.equal(h.list.querySelectorAll('.is-failed').length, 1);
  assert.equal(h.list.textContent.includes('一段关于质感的真实提问'), false);
  assert.equal(h.list.querySelectorAll('small').length, 0, 'message previews do not enlarge history rows');
  h.dispatch(items[1], 'click');
  assert.deepEqual(h.selections, ['conversation-2']);
  h.controller.destroy();
});

test('mobile history indicator updates when an undisplayed older conversation starts work', () => {
  const state = historyState(); state.jobs = [];
  const h = mountFixture({ mobile: true, state });
  assert.equal(h.root.querySelector('.ws-history-open-state').hidden, true);
  h.setState({ ...state, jobs: [{ id: 'older-working', conversationId: 'conversation-16', status: 'running' }] });
  h.controller.render();
  assert.equal(h.root.querySelector('.ws-history-open-state').hidden, false);
  assert.match(h.button('[data-ws-history-open]').getAttribute('aria-label'), /1 段正在处理/);
  assert.equal(h.list.querySelectorAll('[data-ws-conversation]').length, 5);
  h.controller.destroy();
});

test('the expand control and search reset keep the mounted list in five-row pages', () => {
  const h = mountFixture();
  h.dispatch(h.button('[data-ws-history-more]'), 'click');
  assert.equal(h.list.querySelectorAll('[data-ws-conversation]').length, 10);
  assert.equal(h.list.querySelectorAll('ul').length, 1, 'expanding across dates keeps one flat list');
  assert.equal(h.list.querySelectorAll('h3').length, 0);
  const input = h.button('[data-ws-history-search]');
  input.value = '质感'; h.dispatch(input, 'input');
  assert.equal(h.list.querySelectorAll('[data-ws-conversation]').length, 5);
  assert.equal(h.button('[data-ws-history-search]'), input, 'polling renders retain the input node');
  h.dispatch(h.button('[data-ws-history-more]'), 'click');
  assert.equal(h.list.querySelectorAll('[data-ws-conversation]').length, 8);
  assert.equal(h.button('[data-ws-history-more]').hidden, true);
  input.value = ''; h.dispatch(input, 'input');
  assert.equal(h.list.querySelectorAll('[data-ws-conversation]').length, 5);
  h.controller.destroy();
});

test('mounted wheel handling expands once during momentum and does not expand from upward scrolling', () => {
  const h = mountFixture();
  const scroll = h.button('[data-ws-history-scroll]');
  h.dispatch(scroll, 'wheel', { deltaY: -30 });
  assert.equal(h.list.querySelectorAll('[data-ws-conversation]').length, 5);
  assert.equal(h.dispatch(scroll, 'wheel', { deltaY: 3 }).defaultPrevented, true);
  for (let index = 0; index < 50; index++) h.dispatch(scroll, 'wheel', { deltaY: 2 });
  assert.equal(h.list.querySelectorAll('[data-ws-conversation]').length, 10);
  h.controller.destroy();
  assert.equal(scroll.listeners.get('wheel').size, 0);
});

test('new history is created only by its button and repeated clicks share one pending callback', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const h = mountFixture({ onNew: () => held });
  const create = h.button('[data-history-new]');
  assert.equal(h.creates, 0);
  h.dispatch(create, 'click'); h.dispatch(create, 'click');
  assert.equal(h.creates, 1);
  assert.equal(create.disabled, true);
  release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(create.disabled, false);
  h.controller.destroy();
});

test('mobile history traps keyboard focus, closes on Escape and returns to its opener', () => {
  const h = mountFixture({ mobile: true });
  const opener = h.button('[data-ws-history-open]');
  opener.focus(); h.dispatch(opener, 'click');
  const drawer = h.document.body.querySelector('[data-workspace-conversations]');
  assert.equal(drawer.open, true);
  assert.equal(h.document.activeElement, drawer.querySelector('[data-ws-history-search]'));
  const focusable = drawer.querySelectorAll('button:not(:disabled),input:not(:disabled)').filter(element => !element.hidden);
  focusable.at(-1).focus();
  assert.equal(h.dispatch(focusable.at(-1), 'keydown', { key: 'Tab' }).defaultPrevented, true);
  assert.equal(h.document.activeElement, focusable[0]);
  assert.equal(h.dispatch(focusable[0], 'keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, true);
  assert.equal(h.document.activeElement, focusable.at(-1));
  assert.equal(h.dispatch(h.document.activeElement, 'keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(drawer.open, false);
  assert.equal(h.document.activeElement, opener);
  h.dispatch(opener, 'click');
  h.controller.destroy();
  assert.equal(h.document.body.querySelectorAll('[data-workspace-conversations]').length, 0);
  assert.equal(h.media.listeners.get('change').size, 0);
  assert.equal([...drawer.listeners.values()].every(callbacks => callbacks.size === 0), true);
});
