import { normalizePageContext } from './page-context.js';

const safeSource = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};

// A read is a snapshot of this exact association. Passive metadata versions may
// advance while HTTP is in flight; identity fields and the original URL may not.
export function samePageReadTarget(expected, active) {
  if (!expected || !active) return false;
  const sourceKey = value => {
    const source = safeSource(value);
    if (!source) return '';
    const url = new URL(source); if (!/^#(?:\/|!)/.test(url.hash)) url.hash = ''; return url.href;
  };
  const url = sourceKey(expected.url);
  return Boolean(url && url === sourceKey(active.url)
    && ['attachmentId', 'pageRevision', 'browserWindowId', 'browserTabId', 'browserProfileId', 'appName']
      .every(key => String(expected[key] ?? '') === String(active[key] ?? '')));
}

/** Owns only a read-only preview; it never applies a response to native context. */
export function createPageReadController({ getContext, fetchPage, onRead, show }) {
  let generation = 0, pending = null, destroyed = false;
  let requestSequence = 0;
  const changed = () => new Error('页面已经变化，请读取当前页面后再试。');
  function invalidate() { generation++; pending?.controller.abort(); pending = null; }
  function read(context) {
    if (destroyed) return Promise.resolve(null);
    const expected = normalizePageContext(context);
    if (!samePageReadTarget(expected, getContext())) return Promise.reject(changed());
    if (pending && samePageReadTarget(expected, pending.context)) return pending.promise;
    invalidate();
    const version = generation;
    const controller = new AbortController();
    const requestId = `read-page-${Date.now()}-${++requestSequence}`;
    const operation = { context: expected, controller, promise: null };
    pending = operation;
    operation.promise = (async () => {
      try {
        const result = await fetchPage(expected, requestId, controller.signal);
        if (destroyed || version !== generation || controller.signal.aborted) return null;
        const incoming = normalizePageContext(result?.context);
        if (result?.requestId !== requestId || !samePageReadTarget(expected, incoming)
          || incoming.contextVersion !== expected.contextVersion
          || !samePageReadTarget(expected, getContext())) throw changed();
        if (result.readable !== true || incoming.readStatus === 'unavailable'
          || incoming.contentQuality?.status === 'unavailable' || (!incoming.text && !incoming.selection)) {
          throw new Error('这页暂时没有可读取的正文，可以粘贴公开链接或选中的段落。');
        }
        onRead?.(incoming);
        if (destroyed || version !== generation || !samePageReadTarget(expected, getContext())) return null;
        show(incoming);
        return incoming;
      } catch (error) {
        if (destroyed || version !== generation || controller.signal.aborted) return null;
        throw error;
      } finally { if (pending === operation) pending = null; }
    })();
    return operation.promise;
  }
  return { read, invalidate, destroy() { destroyed = true; invalidate(); } };
}

/** Page preview can hand an already confirmed snapshot to the existing explicit save action. */
export function mountPageTextReader(doc = document, root = doc.body, { canSave, onSave } = {}) {
  let dialog, destroyed = false;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function hide() { dialog?.remove(); dialog = null; }
  function show(context) {
    if (destroyed) return;
    const content = String(context?.text || context?.selection || '').slice(0, 40000);
    if (!content.trim() || context?.readStatus === 'unavailable' || context?.contentQuality?.status === 'unavailable') throw new Error('这页暂时没有可查看的正文。');
    hide();
    dialog = make('dialog', 'page-text-dialog');
    const current = dialog;
    dialog.setAttribute('aria-label', '页面正文');
    const style = make('style');
    style.textContent = `.page-text-dialog{box-sizing:border-box;width:calc(100% - 24px);max-width:640px;max-height:calc(100dvh - 28px);padding:18px;border:1px solid #ffffff25;border-radius:18px;background:#232528;color:#f4eee4;font:13px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 16px 60px #0006}.page-text-dialog::backdrop{background:#10111488;backdrop-filter:blur(5px)}.page-text-dialog header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.page-text-dialog h2{margin:0;font-size:16px;line-height:1.5;font-weight:600}.page-text-dialog button{flex:none;border:1px solid #ffffff25;border-radius:8px;padding:5px 10px;background:#ffffff0c;color:inherit;font:inherit;cursor:pointer}.page-text-dialog button:focus-visible,.page-text-dialog a:focus-visible{outline:2px solid #e4c5a0;outline-offset:3px}.page-text-dialog .page-text-summary{margin:10px 0 4px;color:#c9bfb2;font-size:12px}.page-text-dialog .page-text-source{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:14px;color:#b4a89a;font-size:11px}.page-text-dialog article{box-sizing:border-box;max-height:min(56dvh,440px);overflow:auto;margin:0;padding:12px 0 2px;border-top:1px solid #ffffff18;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}`;
    const header = make('header');
    header.append(make('h2', '', context.title || '当前页面正文'));
    const close = make('button', '', '关闭正文'); close.type = 'button';
    close.addEventListener('click', () => current.close()); header.append(close);
    current.addEventListener('close', () => { current.remove(); if (dialog === current) dialog = null; });
    const count = Array.from(content).length;
    const paragraphs = content.split(/\n\s*\n/).filter(part => part.trim()).length;
    const partial = context.textTruncated || context.contentQuality?.truncated || context.contentQuality?.status === 'partial' || String(context.text || '').length > 40000;
    const selectionOnly = context.readStatus === 'selection_only' || (!context.text && Boolean(context.selection));
    const summary = make('p', 'page-text-summary', `${selectionOnly ? '已提取所选文字' : partial ? '已提取部分正文' : '已清洗正文'} · ${count.toLocaleString('zh-CN')} 字 · ${paragraphs.toLocaleString('zh-CN')} 段`);
    summary.setAttribute('role', 'status');
    dialog.append(style, header, summary);
    const url = safeSource(context.resolvedUrl || context.url);
    if (url) { const link = make('a', 'page-text-source', url); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.setAttribute('data-external', ''); dialog.append(link); }
    const article = make('article', '', content); article.setAttribute('aria-label', '已提取的页面文字'); dialog.append(article);
    if (typeof onSave === 'function' && canSave?.(context)) {
      const footer = make('footer'); footer.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:13px';
      const save = make('button', '', '收藏这一版'); save.type = 'button';
      const status = make('span'); status.setAttribute('role', 'status');
      save.addEventListener('click', async () => {
        if (save.disabled) return;
        save.disabled = true; save.textContent = '正在保存…'; status.textContent = '';
        try { save.textContent = await onSave(context); status.textContent = '已保存到这台电脑的知识库。'; }
        catch (error) {
          const expired = error?.code === 'PAGE_PREVIEW_EXPIRED';
          save.disabled = expired;
          save.textContent = expired ? '重新预览后收藏' : '重试保存';
          status.textContent = error?.message || '正文暂未保存。';
        }
      });
      footer.append(save, status); dialog.append(footer);
    }
    (root.body || root).append(dialog);
    dialog.showModal();
    close.focus();
  }
  return { show, hide, destroy() { destroyed = true; hide(); } };
}
