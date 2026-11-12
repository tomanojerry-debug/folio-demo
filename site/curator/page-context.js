import { parseVideoCaptureCommand } from './video-capture-command.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const pageURLKey = value => { try { const url = new URL(value); if (!/^#(?:\/|!)/.test(url.hash)) url.hash = ''; return url.href; } catch { return ''; } };
const readStatuses = new Set(['public_page', 'attached_text', 'selection_only', 'unavailable', 'not_read']);

function normalizedQuality(value) {
  if (!value || typeof value !== 'object' || !['ready', 'partial', 'unavailable'].includes(value.status)) return null;
  const count = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? Math.min(value[key], 2_000_000) : 0;
  return {
    version: 1, status: value.status, method: text(value.method).slice(0, 100), scope: text(value.scope).slice(0, 100),
    characterCount: count('characterCount'), paragraphCount: count('paragraphCount'), removedLines: count('removedLines'),
    truncated: Boolean(value.truncated),
    warnings: Array.isArray(value.warnings) ? value.warnings.filter(item => typeof item === 'string').slice(0, 16).map(item => item.slice(0, 100)) : [],
    fallbackFrom: text(value.fallbackFrom).slice(0, 100), fallbackReason: text(value.fallbackReason).slice(0, 100),
    fallbackError: text(value.fallbackError).slice(0, 100),
  };
}

export function normalizePageContext(value) {
  if (!value || typeof value !== 'object') return null;
  let url = '';
  try {
    const parsed = new URL(value.url);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href;
  } catch {}
  const context = {
    attachmentId: text(value.attachmentId).slice(0, 200),
    title: text(value.title).slice(0, 500),
    appName: text(value.appName).slice(0, 100), url,
    text: text(value.text).slice(0, 40000), selection: text(value.selection).slice(0, 12000),
    pageRevision: text(String(value.pageRevision ?? '')).slice(0, 100),
    contextVersion: Number.isSafeInteger(value.contextVersion) && value.contextVersion > 0 ? value.contextVersion : 0,
    requiresConfirmation: Boolean(value.requiresConfirmation),
    contentSource: text(value.contentSource).slice(0, 100),
    ...(value.sourceType === 'wechat-article' || value.sourceType === 'wechat-window' ? { sourceType: value.sourceType } : {}),
    textTruncated: Boolean(value.textTruncated) || text(value.text).length > 40000,
    browserWindowId: text(String(value.browserWindowId ?? '')).slice(0, 100),
    browserTabId: text(String(value.browserTabId ?? '')).slice(0, 100),
    browserProfileId: text(value.browserProfileId).slice(0, 150),
    contextStatus: text(value.contextStatus).slice(0, 50), contextHint: text(value.contextHint).slice(0, 1000),
    captureNeeded: Boolean(value.captureNeeded), error: text(value.error).slice(0, 1000),
    readStatus: readStatuses.has(value.readStatus) ? value.readStatus : '',
    contentQuality: normalizedQuality(value.contentQuality),
    resolvedUrl: '',
  };
  try {
    const resolved = new URL(value.resolvedUrl);
    if (['http:', 'https:'].includes(resolved.protocol) && !resolved.username && !resolved.password) context.resolvedUrl = resolved.href;
  } catch {}
  return context.url || context.title || context.appName ? context : null;
}

export function advanceContextVersion(highWater, payload) {
  const incoming = Number.isSafeInteger(payload?.contextVersion) && payload.contextVersion > 0 ? payload.contextVersion : 0;
  return { accepted: highWater === 0 || incoming >= highWater, highWater: Math.max(highWater, incoming) };
}

// A URL arriving after an initial window-only association enriches that page;
// it must not undo a user's "not now". A real page/window change starts anew.
export function samePageContext(previous, current) {
  if (!previous || !current) return false;
  if (text(previous.browserProfileId) !== text(current.browserProfileId)) return false;
  if (previous.attachmentId && current.attachmentId && previous.attachmentId !== current.attachmentId) return false;
  if (previous.appName && current.appName && previous.appName !== current.appName) return false;
  if (previous.pageRevision && current.pageRevision && previous.pageRevision !== current.pageRevision) return false;
  if (previous.url && current.url) return pageURLKey(previous.url) === pageURLKey(current.url);
  if (previous.attachmentId && previous.attachmentId === current.attachmentId) return true;
  return previous.title === current.title;
}

export function isFreshContextUpdate(active, incoming) {
  if (!incoming) return false;
  if (!active?.contextVersion) return true;
  return Boolean(incoming.contextVersion && incoming.contextVersion >= active.contextVersion);
}

// The source shown when an operation began is authoritative for that operation.
// A late reply may enrich that source, or reveal a changed page, but never undo
// an already-observed switch in the active conversation.
export function captureReplyDisposition(expected, active, incoming, purpose = 'conversation') {
  if (!samePageContext(expected, active)) return 'superseded';
  if (!isFreshContextUpdate(active, incoming)) return 'stale';
  if (!samePageContext(expected, incoming)) return 'changed';
  if (purpose === 'collect' && incoming.requiresConfirmation) return 'confirm';
  return 'accepted';
}

export function sourceForMessage(message, state) {
  if (message.pageSource) return message.pageSource;
  if (message.context) return message.context;
  const sourceId = message.sourceMessageId || state.jobs?.find(job => job.id === message.jobId)?.messageId;
  return sourceId ? state.messages?.find(item => item.id === sourceId)?.context || null : null;
}

export function pageReadEvidence(context, state) {
  if (!context) return null;
  for (const message of [...(state?.messages || [])].reverse()) {
    const source = sourceForMessage(message, state);
    const sameVersion = !context.contextVersion || source?.contextVersion === context.contextVersion;
    const sameBrowser = ['browserWindowId', 'browserTabId'].every(key => !context[key] || !source?.[key] || String(context[key]) === String(source[key]));
    if (source && sameVersion && sameBrowser && samePageContext(source, context) && source.readStatus && source.readStatus !== 'not_read') return source;
  }
  if (context.contentQuality && context.readStatus && context.readStatus !== 'not_read') return context;
  if (context.text || context.selection) return { ...context, readStatus: context.text ? 'attached_text' : 'selection_only' };
  return null;
}

export function isDirectLinkCapture(value) {
  const command = text(value);
  if (parseVideoCaptureCommand(command)) return true;
  if (/^(?:https?:\/\/\S+\s*)+$/iu.test(command)) return true;
  return /^(?:请帮我|帮我|请|麻烦你)?\s*(?:收藏|保存|收下|收好)(?:一下)?\s*[:：]?\s*(?:https?:\/\/\S+\s*)+[。！!]?$/iu.test(command);
}

export function collectionForPage(context, collections = []) {
  if (!context?.url) return null;
  const target = pageURLKey(context.url);
  return collections.find(item => !item.videoCaptions && (pageURLKey(item.url) === target || pageURLKey(item.content) === target)) || null;
}

export function isPageCollectionCommand(value) {
  const command = text(value);
  const page = '(?:这篇文章|这篇|这个页面|这个网页|这个|这页|这条链接|当前页面|当前网页|当前文章|本页面|本页|文章|页面|网页|它)';
  const prefix = '(?:(?:请帮我|帮我|麻烦你|麻烦|请|我要|我想)\\s*)?';
  return new RegExp('^' + prefix + '(?:收藏|收下|保存|留下|收好)(?:一下)?\\s*' + page + '(?:一下|吧)?[。！!]?$', 'u').test(command)
    || new RegExp('^' + prefix + '(?:把|将)' + page + '(?:收藏|保存|收起来|存下)(?:起来|下来)?(?:吧|一下)?[。！!]?$', 'u').test(command);
}
