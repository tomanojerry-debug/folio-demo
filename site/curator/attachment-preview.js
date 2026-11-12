import { samePageReadTarget } from './page-reader.js';

const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const readStatuses = new Set(['attached_text', 'public_page', 'selection_only']);
const idle = () => ({ status: 'idle', source: null, error: '' });

function canRead(context) {
  const genericTitle = [context?.appName, `${context?.appName} · 当前页面`, '微信窗口'];
  return context?.contextStatus === 'ready' && nonempty(context.attachmentId)
    && nonempty(context.pageRevision) && nonempty(context.title) && !genericTitle.includes(context.title)
    && samePageReadTarget(context, context);
}

function hasReadableContent(source) {
  if (!readStatuses.has(source?.readStatus) || source.contentQuality?.status === 'unavailable') return false;
  return source.readStatus === 'selection_only' ? nonempty(source.selection) : nonempty(source.text);
}

/** Identifying an attached page and reading it require separate actions. */
export function createAttachmentPreview({ capture, read, onChange = () => {} }) {
  const retired = new Set();
  let view = idle(), observed = null, pending = null, destroyed = false;

  function publish(status, source = null, error = '') {
    if (view.status === status && view.source === source && view.error === error) return;
    view = { status, source, error };
    onChange({ ...view });
  }

  function cancel() {
    pending?.controller.abort();
    pending = null;
  }

  function start(context) {
    const expected = { ...context };
    const operation = { controller: new AbortController(), promise: null };
    const { signal } = operation.controller;
    const current = () => pending === operation && !signal.aborted && samePageReadTarget(expected, observed);
    const changed = () => new Error('页面已变化，请重新吸附或读取当前页。');
    pending = operation;
    publish('reading');
    operation.promise = (async () => {
      try {
        if (!current()) return null;
        const captured = await capture(expected, signal);
        if (!current()) return null;
        if (!samePageReadTarget(expected, captured)) throw changed();
        const source = await read(captured, signal);
        if (!current()) return null;
        if (!samePageReadTarget(expected, source)) throw changed();
        if (!hasReadableContent(source)) throw new Error('暂未读到正文，可以粘贴原文链接或正文。');
        publish('ready', source);
        return source;
      } catch (error) {
        if (current()) publish('error', null, nonempty(error?.message) ? error.message : '暂未读到正文。');
        return null;
      } finally {
        if (pending === operation) pending = null;
      }
    })();
    return operation.promise;
  }

  return {
    get view() { return { ...view }; },
    observe(context) {
      if (destroyed) return;
      const id = nonempty(context?.attachmentId) ? context.attachmentId : '';
      const previous = observed?.attachmentId;
      if (id && retired.has(id)) return;
      if (previous && previous !== id) retired.add(previous);
      const next = id ? { ...context } : null;
      const same = samePageReadTarget(observed, next);
      observed = next;
      if (canRead(next) && same && view.status !== 'idle') return;
      cancel();
      publish(canRead(next) ? 'identified' : 'idle');
    },
    decline() {
      if (!destroyed && ['identified', 'error'].includes(view.status)) publish('declined');
    },
    cancelRead() {
      if (view.status !== 'reading') return;
      cancel();
      publish(canRead(observed) ? 'identified' : 'idle');
    },
    read() {
      if (destroyed || !canRead(observed)) return Promise.resolve(null);
      if (pending) return pending.promise;
      if (view.status === 'ready') return Promise.resolve(view.source);
      return start(observed);
    },
    destroy() { destroyed = true; cancel(); observed = null; retired.clear(); view = idle(); },
  };
}
