const collectionText = '[data-collection-reading] :is(p, h2, h3, li, blockquote, [data-reading-paragraph])';
const exhibitionText = '.folio-curation-story :is(.folio-story-main, .folio-story-drawer-body, .folio-story-heading) :is(p, h2, h3, li, blockquote)';
const collectionImages = '.collection-glass :is(.collection-briefing-cover, .collection-glass__media img, [data-collection-reading] img)';
const exhibitionImages = '.folio-curation-story :is(.folio-story-photo img, [data-curation-media-id] img, .folio-story-feature img)';
const imageSelector = [collectionImages, exhibitionImages].join(',');
const textSelector = [collectionText, exhibitionText].join(',');
const ignored = 'button, summary, [contenteditable="true"], [aria-hidden="true"], .forme-reading-hint, .forme-reading-eyebrow, .folio-story-caption';
const parentElement = node => node?.nodeType === 1 ? node : node?.parentElement;
const hasLayout = element => Boolean(element?.getClientRects().length && !element.closest('[hidden], [inert]')
  && (!element.closest('details:not([open])') || element.closest('summary')));
const limit = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
const localCover = /^\/api\/desktop\/covers\/[a-f0-9]{64}$/u;
const localAsset = /^(?:\/prototype\/(?:immersive-exhibition|folio-reader)\/|\/curator\/|\/)assets\/[\w./-]+\.(?:jpe?g|png|webp|gif|avif)$/iu;
const assetRoot = new URL('../', import.meta.url);

export function readingNoteImageUrl(value, base) {
  if (typeof value !== 'string' || !value || value.length > 2_500_000) return '';
  if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(value)) return value;
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    if (url.origin === new URL(base).origin) {
      const path = assetRoot.origin === url.origin
        ? (url.pathname.startsWith(assetRoot.pathname) ? '/' + url.pathname.slice(assetRoot.pathname.length) : '')
        : url.pathname;
      return localCover.test(path) || localAsset.test(path) ? url.pathname : '';
    }
    return url.href.length <= 4000 ? url.href : '';
  } catch {
    return '';
  }
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function rangeText(range) {
  const content = range.cloneContents();
  content.querySelectorAll('[aria-hidden="true"], button').forEach(node => node.remove());
  // Range.toString concatenates adjacent blocks. Keep line boundaries in a
  // multi-paragraph excerpt, while preserving every character inside a block.
  for (const block of content.querySelectorAll('p, li, h2, h3, blockquote, br')) {
    block.after(content.ownerDocument.createTextNode('\n'));
  }
  return content.textContent;
}

function paragraphLocation(range, start, end, article, text) {
  const original = start.closest('[data-reading-paragraph]');
  if (!original) return {};
  const paragraph = article?.paragraphs?.find(item => item.id === original.dataset.readingParagraph);
  if (!paragraph || !Number.isSafeInteger(paragraph.start)) return {};
  const before = range.cloneRange();
  before.selectNodeContents(original);
  before.setEnd(range.startContainer, range.startOffset);
  const first = range.cloneRange();
  const multiParagraph = original !== end.closest('[data-reading-paragraph]');
  if (multiParagraph) first.setEnd(original, original.childNodes.length);
  const raw = rangeText(first);
  const leadingText = multiParagraph ? raw.trim() : text;
  if (!leadingText) return {};
  const localOffset = rangeText(before).length + raw.length - raw.trimStart().length;
  if (paragraph.text.slice(localOffset, localOffset + leadingText.length) !== leadingText) return {};
  return { paragraphId: paragraph.id, offset: paragraph.start + localOffset };
}

function textBlock(node) {
  const element = parentElement(node);
  return element && !element.closest(ignored) ? element.closest(textSelector) : null;
}

function imageFrom(target) {
  if (target?.matches?.(imageSelector)) return target;
  return target?.closest?.('.folio-story-photo')?.querySelector('img') || null;
}

function hostFor(element) {
  return element.closest('dialog[open], .collection-glass-overlay');
}

function actionBounds(element, host) {
  const frame = element.closest('.collection-glass__content, .folio-story-drawer-panel, .forme-live-body') || host;
  const rect = frame.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  return {
    left: Math.max(0, rect.left), right: Math.min(view.innerWidth, rect.right),
    top: Math.max(0, rect.top), bottom: Math.min(view.innerHeight, rect.bottom),
  };
}

function saveRequest(win, action, detail) {
  return new Promise((resolve, reject) => {
    win.dispatchEvent(new win.CustomEvent('folio:' + action, { detail: { ...detail, resolve, reject } }));
  });
}

export function revealReadingNoteSource(root, source) {
  if (!root) return false;
  let target;
  if (source.kind === 'image') {
    const match = element => readingNoteImageUrl(element.currentSrc || element.getAttribute('src'), element.baseURI) === source.imageUrl;
    const candidates = [...root.querySelectorAll(imageSelector)].filter(match);
    target = candidates.find(hasLayout);
    if (!target && source.surface === 'collection') {
      const folded = candidates.find(element => element.closest('details:not([open])'));
      for (let details = folded?.closest('details:not([open])'); details && root.contains(details); details = details.parentElement.closest('details:not([open])')) {
        details.open = true;
      }
      if (hasLayout(folded)) target = folded;
    }
    if (!target && source.surface === 'exhibition') {
      const media = root.querySelector('.folio-story-view-all[data-curation-action="media"]');
      if (media && !root.querySelector('.folio-story-drawer')) {
        media.click();
        target = [...root.querySelectorAll(imageSelector)].find(element => hasLayout(element) && match(element));
      }
    }
  } else if (source.text) {
    const normalize = value => value.replace(/\s+/gu, ' ').trim();
    const text = normalize(source.text);
    const blocks = [...root.querySelectorAll(textSelector)];
    const matches = blocks.filter(element => normalize(element.textContent).includes(text));
    target = matches.find(hasLayout);
    if (!target && source.surface === 'exhibition') {
      const mode = matches[0]?.closest('[data-curation-panel]')?.dataset.curationPanel;
      const control = mode && [...root.querySelectorAll('[data-curation-action="mode"][data-curation-mode]')].find(item => item.dataset.curationMode === mode);
      control?.click();
      target = matches.find(hasLayout);
    }
  }
  if (!target) return false;
  target.scrollIntoView({ block: 'center', behavior: 'auto' });
  const focus = target.closest('button') || target;
  if (!focus.hasAttribute('tabindex') && !focus.matches('button, a[href]')) focus.tabIndex = -1;
  focus.focus({ preventScroll: true });
  return true;
}

export function mountReadingNoteCapture({ getCollection, getExhibition, getArticle, doc = document }) {
  const win = doc.defaultView;
  const stylesheet = doc.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('./reading-note-capture.css', import.meta.url).href;
  doc.head.append(stylesheet);

  const control = doc.createElement('button');
  control.type = 'button';
  control.className = 'folio-note-capture-control';
  control.setAttribute('aria-keyshortcuts', 'Alt+Enter');
  control.innerHTML = '<i aria-hidden="true"></i><span>收进手记</span>';
  const controlLabel = control.querySelector('span');
  const toast = doc.createElement('div');
  toast.className = 'folio-note-capture-toast';
  let action, feedback, pending = false, dragging = false, frame = 0;
  const listeners = new AbortController();
  const on = (target, name, handler, options = {}) => target.addEventListener(name, handler, { ...options, signal: listeners.signal });

  function clearAction() {
    action = null;
    control.remove();
  }

  function clearToast() {
    feedback = null;
    toast.remove();
  }

  function sourceAt(element, kind, image) {
    const host = hostFor(element);
    if (!host) return null;
    const exhibitionRoot = element.closest('.folio-curation-story[data-curation-id]');
    const exhibition = exhibitionRoot && getExhibition(exhibitionRoot.dataset.curationId);
    const media = image?.closest('[data-curation-media-id], [data-curation-item]');
    const itemId = media?.dataset.curationMediaId || media?.dataset.curationItem;
    const collection = exhibition
      ? itemId && getCollection(itemId)
      : element.closest('.collection-glass') && getCollection();
    if (!exhibition && !collection) return null;
    const article = exhibition ? null : getArticle(collection.id);
    const url = externalUrl(article?.url || collection?.url);
    const source = {
      kind, surface: exhibition ? 'exhibition' : 'collection',
      ...(exhibition ? { exhibitionId: exhibition.id } : {}),
      ...(collection ? { collectionId: collection.id } : {}),
      ...(article?.documentVersionId ? { documentVersionId: article.documentVersionId } : {}),
      title: limit(exhibition?.title || collection?.title || article?.title, 300) || (exhibition ? '展览' : '收藏'),
      ...(url ? { url } : {}),
    };
    return { source, article, host };
  }

  function position() {
    if (!action) return;
    const { element, host, range, source } = action;
    if (!hasLayout(element) || !host.isConnected) { clearAction(); return; }
    const bounds = actionBounds(element, host);
    const rects = range ? [...range.getClientRects()] : [element.getBoundingClientRect()];
    const rect = rects.findLast(rect => rect.width && rect.height && rect.bottom > bounds.top && rect.top < bounds.bottom);
    if (!rect || bounds.right <= bounds.left) { clearAction(); return; }
    const box = host.getBoundingClientRect();
    const width = control.offsetWidth;
    const height = control.offsetHeight;
    const image = source.kind === 'image';
    const above = rect.top - height - 8 >= bounds.top + 4;
    const left = image ? rect.right - width - 8 : rect.left + (rect.width - width) / 2;
    const top = image ? rect.top + 8 : above ? rect.top - height - 8 : rect.bottom + 8;
    control.style.left = (clamp(left, bounds.left + 5, bounds.right - width - 5) - box.left - host.clientLeft) + 'px';
    control.style.top = (clamp(top, bounds.top + 5, bounds.bottom - height - 5) - box.top - host.clientTop) + 'px';
  }

  function showAction(next) {
    action = next;
    if (control.parentElement !== next.host) next.host.append(control);
    position();
  }

  function showSelection() {
    if (pending || dragging || doc.activeElement === control) return;
    const selection = win.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
      if (action?.source.kind === 'text') clearAction();
      return;
    }
    const range = selection.getRangeAt(0);
    const start = textBlock(range.startContainer), end = textBlock(range.endContainer);
    if (!start || !end || hostFor(start) !== hostFor(end)) {
      if (action?.source.kind === 'text') clearAction();
      return;
    }
    const context = sourceAt(start, 'text');
    const text = rangeText(range).trim();
    if (!context || !text || text.length > 12_000) {
      if (action?.source.kind === 'text') clearAction();
      return;
    }
    const location = paragraphLocation(range, start, end, context.article, text);
    showAction({ host: context.host, element: start, range: range.cloneRange(), source: { ...context.source, ...location, text } });
  }

  function showImage(target, trigger) {
    if (pending || action?.source.kind === 'text') return false;
    const image = imageFrom(target);
    if (!image || !hasLayout(image)) return false;
    if (action?.element === image) return true;
    const imageUrl = readingNoteImageUrl(image.currentSrc || image.getAttribute('src'), image.baseURI);
    const context = imageUrl && sourceAt(image, 'image', image);
    if (!context) return false;
    showAction({ host: context.host, element: image, trigger: trigger || image.closest('button') || image, source: { ...context.source, imageUrl } });
    return true;
  }

  function toastButton(label, handler, accessibleLabel) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (accessibleLabel) button.setAttribute('aria-label', accessibleLabel);
    button.addEventListener('click', handler);
    toast.append(button);
    return button;
  }

  function showToast(host, message, saved) {
    if (!hasLayout(host) || host.matches('dialog:not([open])')) return;
    toast.replaceChildren();
    const status = doc.createElement('span');
    status.setAttribute('role', 'status');
    status.textContent = message;
    toast.append(status);
    feedback = { host, saved, status };
    if (saved?.id) {
      toastButton('补一句', event => void changeNote('edit-note', event.currentTarget));
      if (!saved.duplicate) toastButton('撤销', event => void changeNote('delete-note', event.currentTarget));
    }
    toastButton('×', clearToast, '关闭保存提示');
    host.append(toast);
  }

  async function changeNote(type, button) {
    const entry = feedback;
    if (!entry?.saved?.id || button.disabled) return;
    const buttons = [...toast.querySelectorAll('button')];
    buttons.forEach(item => { item.disabled = true; });
    try {
      await saveRequest(win, type, { id: entry.saved.id });
      if (feedback !== entry) return;
      if (type === 'delete-note') showToast(entry.host, '已撤销');
      else clearToast();
    } catch {
      if (feedback === entry) entry.status.textContent = type === 'delete-note' ? '撤销失败，请重试。' : '暂时无法打开手记，请重试。';
    } finally {
      buttons.forEach(item => { item.disabled = false; });
    }
  }

  async function capture() {
    if (!action || pending) return;
    const next = action;
    pending = true;
    control.disabled = true;
    controlLabel.textContent = '正在保存…';
    try {
      const result = await saveRequest(win, 'capture-note', { source: next.source });
      if (!result?.id) throw new Error('没有收到保存结果。');
      if (action === next) {
        const keyboardFocus = doc.activeElement === control;
        clearAction();
        if (next.source.kind === 'text') win.getSelection()?.removeAllRanges();
        if (keyboardFocus) next.trigger?.focus({ preventScroll: true });
      }
      showToast(next.host, result.duplicate ? '已在手记里' : '已收进手记', result);
    } catch {
      showToast(next.host, '尚未保存，请再试一次。');
    } finally {
      pending = false;
      control.disabled = false;
      controlLabel.textContent = '收进手记';
    }
  }

  function updateImages() {
    frame = 0;
    for (const image of doc.querySelectorAll(imageSelector)) {
      const trigger = image.closest('button') || image;
      if (!trigger.hasAttribute('tabindex') && trigger === image) trigger.tabIndex = 0;
      trigger.setAttribute('aria-keyshortcuts', 'Alt+Enter');
    }
    if (action && !hasLayout(action.element)) clearAction();
    if (feedback && !hasLayout(feedback.host)) clearToast();
  }

  const observer = new MutationObserver(records => {
    if (!frame && records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
      node.nodeType === 1 && !node.matches('.folio-note-capture-control, .folio-note-capture-toast')))) frame = win.requestAnimationFrame(updateImages);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  updateImages();

  on(control, 'mousedown', event => event.preventDefault());
  on(control, 'click', () => void capture());
  on(doc, 'selectionchange', showSelection);
  on(doc, 'pointerdown', event => {
    if (control.contains(event.target) || toast.contains(event.target) || pending) return;
    dragging = event.button === 0;
    if (action?.source.kind === 'text') clearAction();
  }, { capture: true });
  on(doc, 'pointerup', () => {
    dragging = false;
    win.requestAnimationFrame(showSelection);
  }, { capture: true });
  on(doc, 'pointercancel', () => { dragging = false; }, { capture: true });
  on(doc, 'pointerover', event => {
    if (control.contains(event.target) || event.pointerType === 'touch') return;
    if (!showImage(event.target) && action?.source.kind === 'image' && !action.trigger.contains(event.target) && doc.activeElement !== control) clearAction();
  });
  on(doc, 'contextmenu', event => {
    if (showImage(event.target)) event.preventDefault();
  });
  on(doc, 'focusin', event => {
    const image = event.target.matches?.('.folio-story-photo') ? event.target.querySelector('img') : event.target;
    if (!showImage(image, event.target) && action?.source.kind === 'image' && event.target !== control) clearAction();
  });
  on(doc, 'keydown', event => {
    if (!action || pending) return;
    if (event.altKey && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void capture();
    } else if (event.key === 'Tab' && !event.shiftKey && action.source.kind === 'image' && event.target === action.trigger) {
      event.preventDefault();
      control.focus({ preventScroll: true });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const trigger = action.trigger;
      if (doc.activeElement === control) trigger?.focus({ preventScroll: true });
      clearAction();
    }
  }, { capture: true });
  on(doc, 'scroll', position, { capture: true, passive: true });
  on(win, 'resize', position);
  on(doc, 'close', event => {
    if (action?.host === event.target) clearAction();
    if (feedback?.host === event.target) clearToast();
  }, { capture: true });

  return {
    destroy() {
      listeners.abort();
      observer.disconnect();
      win.cancelAnimationFrame(frame);
      clearAction();
      clearToast();
      stylesheet.remove();
    },
  };
}
