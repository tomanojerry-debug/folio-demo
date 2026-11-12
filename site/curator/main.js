import { formatMessage } from './message-format.js';
import { messageReferences } from './message-references.js';
import { messageWebSourcesText, renderMessageWebSources } from './message-web-sources.js';
import { CHAT_REPLY_PENDING, conversationActivity } from './chat-activity.js';
import { normalizeWorkspaceChatRequest, workspaceChatScope } from './chat-launch.js';
import { normalizePageContext, samePageContext, collectionForPage, isPageCollectionCommand, isDirectLinkCapture, isFreshContextUpdate, captureReplyDisposition, sourceForMessage, pageReadEvidence, advanceContextVersion } from './page-context.js';
import { installGlassDialogs } from './glass-dialogs.js';
import { mountCompanionAvatar } from './companion-avatar.js';
import { mountPageTextReader, samePageReadTarget, createPageReadController } from './page-reader.js';
import { resolveConversation, conversationMessages, conversationJobs, createConversationDraftStore, mountConversationSidebar, openConversationReferences } from './workspace-chat.js';
import { createCompanionSessions, companionPageKey, companionHistory } from './companion-sessions.js';
import { createAttachmentPreview } from './attachment-preview.js';
import { parseScopedCurationCommand } from './scoped-curation-command.js';
import { parseVideoCaptureCommand } from './video-capture-command.js';
import { parseWebSearchRequest } from './web-search-intent.js';

installGlassDialogs();

export async function mountChatController(root = document, options = {}) {
const embedded = options.embedded === true;
const lifecycle = new AbortController();
let destroyed = false;
const listen = (target, type, handler, settings = {}) => target.addEventListener(type, handler, { ...settings, signal:lifecycle.signal });
const $ = (selector, within = root) => within.querySelector(selector);
const $$ = (selector, within = root) => [...within.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const native = () => window.webkit?.messageHandlers?.forme;
const surface = new URLSearchParams(location.search).get('surface');
const isWorkspaceChat = embedded || surface === 'workspace-chat';
const isChat = surface === 'chat' || isWorkspaceChat;
const isCompanionChat = isChat && !isWorkspaceChat;
const companionGreeting = '你好，我是 Tag。';
const companionStartHint = '发来一条链接，或聊聊你正在看的内容。';
const demoChatNotice = '当前是演示模式。智能对话请使用 Folio 的个人模式。';
const client = { state: null, view: 'exhibitions', selected: null, connected: false, busy: false, context: null, workspaceScope: null, roomSignature: '', readerSignature: '', messageSignatures: new Map(), poll: null, request: null, isWorkspaceChat, visible:!embedded || !root.hidden, conversationId: isWorkspaceChat ? new URLSearchParams(location.search).get('conversation') || '' : '', loadedConversationId: '', sendingConversations: new Set(), sendErrors: new Map(), restoreScroll: null };
let chatStorage;
try { chatStorage = sessionStorage; } catch {}
const conversationDrafts = createConversationDraftStore(chatStorage);
let conversationSidebar = null;
const captureRequests = new Map();
const workspaceRequests = new Map();
let toastTimer;
let copyFeedback;
let selectionVersion = 0;
let preserveEmptySelection = false;
let composing = false;
let compositionEndedAt = -Infinity;
let profileExit = null;
let profileTrigger = null;
let profileSession = 0;
let profileSaving = false;
let profileBackdropPointer = false;
let pageDecision = 'ask';
let collectingPage = false;
let collectingContext = null;
let lastContextVersion = 0;
let currentPageRead = null;
let readingPage = false;
let pageReadCapture = null;
let fallbackPreview = null;
let surfaceSaveTimer, surfaceWrites = Promise.resolve();
let companionMenuOpen = false;
const companionSessions = !isWorkspaceChat ? createCompanionSessions({ api,
  getConversationId: () => client.conversationId,
  getGuard: () => composing || client.busy || readingPage || Boolean($('#chat-input')?.value.trim())
    || Boolean(client.attachmentPreview && client.attachmentPreview.view.status !== 'ready')
    || conversationJobs(client.state, client.conversationId).some(job => ['queued','running'].includes(job.status))
    || Boolean($('#chat-messages')?.dataset.hydrated && $('#chat-messages').scrollHeight - $('#chat-messages').clientHeight - $('#chat-messages').scrollTop > 80),
  onSelect: activateCompanionConversation,
  onState: state => applyState(state),
  onChange: view => { client.observedPage = view.observedPage; client.openingPageSession = view.status === 'reading'; renderContext(); renderCompanionSessionUI(); updateComposer(); },
  onError: error => setError(error.message),
}) : null;
client.pageSessions = companionSessions;
const pageTextReader = mountPageTextReader(root.ownerDocument || document, root, {
  canSave: context => (fallbackPreview?.context === context && canSaveFallbackPreview(fallbackPreview))
    || Boolean(context.snapshotId && context.snapshotId === companionSessions?.view.acceptedSource?.snapshotId && client.context?.snapshotId === context.snapshotId),
  async onSave(context) {
    if (fallbackPreview?.context === context) return saveFallbackPreview(fallbackPreview);
    if (!context.snapshotId || context.snapshotId !== companionSessions?.view.acceptedSource?.snapshotId || context.snapshotId !== client.context?.snapshotId) throw new Error('页面已变化，请重新打开当前正文。');
    const saved = await collectCurrentPage({ reportError:true });
    if (!saved?.sourceSaveStatus || saved.sourceSaveStatus === 'pending') throw new Error('正文暂未保存，请稍后重试。');
    return pageSaveLabel(saved);
  },
});
const pageReadController = createPageReadController({
  getContext: () => client.context,
  fetchPage: (context, requestId, signal) => api('page-read', { requestId, context }, { signal }),
  onRead: context => { currentPageRead = context; renderContext(); },
  show: context => pageTextReader.show(context),
});
const attachmentPreview = isCompanionChat && native() ? createAttachmentPreview({
  capture: (context, signal) => captureContext('attachment-preview', { context, signal }),
  async read(context, signal) {
    if (!samePageReadTarget(context, companionSessions.view.observedPage)) return null;
    const id = await companionSessions.open({ capture: () => context, reread: true, signal });
    if (!id) throw new Error(companionSessions.view.error || '这页暂时没能读到正文。');
    return companionSessions.view.acceptedSource;
  },
  onChange: () => { renderContext(); renderCompanionSessionUI(); updateComposer(); },
}) : null;
client.attachmentPreview = attachmentPreview;
const readingAttachment = () => attachmentPreview?.view.status === 'reading';
const cancelPageRead = () => { pageReadCapture?.abort(); pageReadController.invalidate(); pageTextReader.hide(); };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.reduceMotion === 'true';
const sourceMenu = isCompanionChat ? $('#companion-source-menu') : null;

if (!embedded) {
  document.body.classList.toggle('is-chat', isChat);
  document.body.classList.toggle('is-workspace-chat', isWorkspaceChat);
}
document.documentElement.classList.toggle('is-native', Boolean(native()));
$('#chat-panel').hidden = !isChat;
const companionAvatar = isChat ? mountCompanionAvatar($('.chat-header > .curator-mark')) : null;
if (isWorkspaceChat) {
  $('.workspace-chat-heading').before($('.chat-header > .curator-mark'));
  if ($('#chat-history')) $('#chat-history').hidden = false;
  $('.workspace-chat-heading').hidden = false;
  $('.chat-history-toggle').hidden = embedded;
  $('.conversation-reference-button').hidden = false;
  $('#chat-panel').setAttribute('role', 'main');
  $('#chat-panel').setAttribute('aria-labelledby', 'conversation-title');
  $('#chat-form .composer-actions').append($('#send-button'));
} else if (isCompanionChat) {
  $('.chat-header').after($('#companion-session-heading'));
  $('[data-action="close-chat"]').before($('[data-action="open-conversation"]'));
  const detach = $('#source-context [data-action="detach"]');
  detach.className = 'companion-detach';
  detach.textContent = '取消页面关联';
  delete detach.dataset.tooltip;
  $('.companion-source-menu-items').append($('.companion-read-info'), detach);
}
if ($('#today-label')) $('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());

function bridge(action, extra = {}) {
  if (!native()) return false;
  native().postMessage({ action, ...extra });
  return true;
}

function safeURL(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}

function imageURL(value) {
  if (!value) return '';
  if (/^(\.\/)?assets\/[a-z\d_.\/-]+$/i.test(value)) return '/' + value.replace(/^\.\//, '');
  if (/^\/assets\/[a-z\d_.\/-]+$/i.test(value)) return value;
  return '';
}

function notify(message) {
  if (destroyed) return;
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3800);
}

function setError(message = '', retryable = false) {
  if (destroyed) return;
  $('#chat-error-message').textContent = message;
  $('#chat-error').hidden = !message;
  $('#retry-message').hidden = !message || !retryable;
}

async function withPendingButton(button, label, operation) {
  if (button?.disabled) return;
  const previous = button && { content: button.innerHTML, title: button.getAttribute('title'), minWidth: button.style.minWidth };
  if (button) {
    button.style.minWidth = `${Math.ceil(button.getBoundingClientRect().width)}px`;
    button.disabled = true;
    button.dataset.loading = 'true';
    button.setAttribute('aria-busy', 'true');
    button.textContent = label;
    button.title = label;
  }
  try { return await operation(); }
  finally {
    if (button) {
      button.disabled = false;
      delete button.dataset.loading;
      button.removeAttribute('aria-busy');
      button.innerHTML = previous.content;
      button.style.minWidth = previous.minWidth;
      if (previous.title === null) button.removeAttribute('title'); else button.setAttribute('title', previous.title);
    }
  }
}

function updateComposer() {
  if (destroyed) return;
  const input = $('#chat-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(Math.max(input.scrollHeight, isWorkspaceChat ? 84 : 38), isWorkspaceChat ? 210 : 112)}px`;
  const button = $('#send-button');
  const waiting = client.busy || readingPage || readingAttachment() || client.openingPageSession;
  button.disabled = waiting || composing || !input.value.trim();
  $('#retry-message').disabled = waiting || !input.value.trim();
  button.classList.toggle('is-sending', client.busy);
  button.setAttribute('aria-label', client.busy ? '正在发送消息' : '发送消息');
  button.dataset.tooltip = client.busy ? '正在发送' : '发送（回车键）';
  $('#chat-form').setAttribute('aria-busy', String(client.busy));
  button.innerHTML = client.busy
    ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 10a5.5 5.5 0 1 1-5.5-5.5"/></svg><span class="sr-only">正在发送</span>'
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg><span class="sr-only">发送</span>';
}

async function api(path, body, settings = {}) {
  if (destroyed) throw new Error('聊天界面已经关闭。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  lifecycle.signal.addEventListener('abort', abort, {once:true});
  settings.signal?.addEventListener('abort', abort, {once:true});
  if (settings.signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(), body ? 100000 : 15000);
  try {
    const response = await fetch(`/api/desktop/${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
    let result;
    try { result = await response.json(); } catch { throw new Error('服务暂时没有返回完整结果，请稍后重试。'); }
    if (response.status === 401 && result.code === 'SIGN_IN_REQUIRED') location.reload();
    if (!response.ok) {
      const code = text(result.code) || text(result.error);
      const knownErrors = {
        AI_DISABLED: '智能整理尚未连接，原始收藏会保留。',
        INVALID_ORIGIN: '请回到当前窗口再试一次。',
        INVALID_HOST: '请重新打开私人收藏馆。',
        SERVICE_STOPPING: '本机服务正在退出，请重新打开后再试。',
        JOB_RUNNING: '已经在整理了，完成后会在这里告诉你。',
        MODEL_PROVIDER_ERROR: '智能整理暂时没有回应，内容会保留，可以稍后重试。',
        NOT_FOUND: '暂时没有找到这条内容，请刷新后再试。',
      };
      const message = text(result.message) || text(result.error);
      const readable = knownErrors[code] || (message && !/^[A-Z][A-Z\d_]*$/.test(message) ? message : '暂时没有完成，请稍后再试。');
      throw Object.assign(new Error(readable), { code, status: response.status });
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('这次等待有点久，输入还在。可以稍后再试。');
    if (error instanceof TypeError) throw new Error('暂时没有连上本机服务，输入还在。稍后可以再试。');
    throw error;
  } finally { clearTimeout(timeout); lifecycle.signal.removeEventListener('abort', abort); settings.signal?.removeEventListener('abort', abort); }
}

function applyState(state, external = false) {
  if (destroyed) return;
  if (!state || typeof state !== 'object') return;
  const profile = { ...(state.profile || {}) };
  if (!text(profile.name)) profile.name = 'Tag';
  client.state = { ...state, profile, collections: list(state.collections), exhibitions: list(state.exhibitions), messages: list(state.messages), jobs: list(state.jobs) };
  const surfaceState = state.surfaceSessions?.[isWorkspaceChat ? 'workspace' : 'companion'];
  const preferred = client.conversationId || (!client.selectionInitialized ? surfaceState?.conversationId || surfaceState?.lastConversationId : '') || '';
  const selected = preserveEmptySelection && !client.conversationId ? '' : isWorkspaceChat ? resolveConversation(client.state, preferred) : list(client.state.conversations).find(item => item.id === preferred)?.id || '';
  client.selectionInitialized = true;
  if (selected !== client.loadedConversationId) {
    if (client.loadedConversationId) persistConversationDraft();
    client.conversationId = selected;
    restoreConversationDraft(selected);
  }
  client.busy = client.sendingConversations.has(client.conversationId);
  client.connected = true;
  renderIdentity();
  renderRoom();
  renderMessages();
  renderContext();
  renderConversationShell();
  if (embedded && !external) options.onState?.(client.state);
}

function surfaceDraftPayload() {
  return { surface:isWorkspaceChat ? 'workspace' : 'companion', conversationId:client.conversationId || null,
    draft:{ text:$('#chat-input').value, scrollTop:Math.max(0, $('#chat-messages').scrollTop || 0) },
    ...(!isWorkspaceChat ? { followMode:companionSessions?.view.followMode || 'follow' } : {}) };
}

function queueSurfaceDraft(payload = surfaceDraftPayload()) {
  clearTimeout(surfaceSaveTimer);
  surfaceWrites = surfaceWrites.catch(() => {}).then(() => destroyed ? null : api('surfaces/select',payload)).catch(() => null);
  return surfaceWrites;
}

function scheduleSurfaceDraft() {
  clearTimeout(surfaceSaveTimer);
  const payload = surfaceDraftPayload();
  surfaceSaveTimer = setTimeout(() => { void queueSurfaceDraft(payload); }, 250);
}

async function activateCompanionConversation(id, { context = null, state, pinned = false } = {}) {
  if (destroyed) return;
  persistConversationDraft();
  if (client.loadedConversationId) void queueSurfaceDraft();
  preserveEmptySelection = !id;
  client.conversationId = id;
  if (!state && client.state) state = client.state;
  if (state) applyState(state, true);
  else restoreConversationDraft(id);
  client.context = context;
  client.workspaceScope = null;
  currentPageRead = context && (context.text || context.selection) ? context : null;
  pageDecision = context ? 'declined' : 'ask';
  renderMessages(); renderContext(); renderCompanionSessionUI(); updateComposer();
  await queueSurfaceDraft({ ...surfaceDraftPayload(), followMode:pinned ? 'pinned' : 'follow' });
}

function attachmentSourceLabel(page) {
  let host = '';
  try { host = new URL(page?.url).hostname.replace(/^www\./, ''); } catch {}
  if (page?.sourceType === 'wechat-article' || host === 'mp.weixin.qq.com') return '公众号';
  if (page?.sourceType === 'wechat-window') return '微信窗口';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'YouTube';
  if (['xiaohongshu.com', 'rednote.com'].some(domain => host === domain || host.endsWith(`.${domain}`)) || host === 'xhslink.com') return '小红书';
  return host || page?.appName || '窗口';
}

function closeCompanionPopovers() {
  if (!isCompanionChat) return;
  sourceMenu.open = false;
  if (!companionMenuOpen) return;
  companionMenuOpen = false;
  $('#companion-session-title').setAttribute('aria-expanded', 'false');
  $('#companion-session-menu').hidden = true;
}

function renderCompanionSessionUI() {
  if (!isCompanionChat) return;
  $('#companion-session-heading').hidden = false;
  const current = list(client.state?.conversations).find(item => item.id === client.conversationId);
  const view = companionSessions.view;
  const { observedPage: observed, acceptedSource: accepted } = view;
  const source = attachmentSourceLabel(observed);
  const observedTitle = observed?.url && ![source, observed.appName, `${observed.appName} · 当前页面`].includes(observed.title)
    ? observed.title : '';
  const contextTitle = client.context?.title || client.context?.appName;
  const title = (current?.pageSession && contextTitle) || current?.title || contextTitle || observedTitle || '新对话';
  const history = $('#companion-session-title');
  history.textContent = title;
  history.title = title;
  history.setAttribute('aria-label', `${title} · 最近对话`);
  history.setAttribute('aria-expanded', String(companionMenuOpen));
  $('#context-title').hidden = !client.workspaceScope && contextTitle === title;
  const switching = readingAttachment() || client.openingPageSession;
  history.disabled = switching;
  $('.companion-session-heading [data-action="companion-new"]').disabled = switching;
  $('.chat-window-actions [data-action="open-conversation"]').disabled = switching;
  $('#companion-session-menu').hidden = !companionMenuOpen;
  $('#companion-session-list').innerHTML = companionHistory(client.state).map(item => {
    const stamp = Number.isFinite(Date.parse(item.createdAt)) ? new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(item.createdAt)) : '';
    return `<button type="button" data-companion-conversation="${escape(item.id)}"${item.id === client.conversationId ? ' aria-current="page"' : ''}><span>${escape(item.title || '新的对话')}</span><small>${escape(stamp)}</small></button>`;
  }).join('') || '<p>还没有保存的对话</p>';
  const activeAttachment = samePageReadTarget(observed, accepted) && Boolean(accepted.text || accepted.selection);
  const preview = observed?.contextStatus === 'ready' && observed.url && observed.attachmentId
    ? attachmentPreview?.view : null;
  const previewStatus = preview?.status === 'idle' ? '' : preview?.status;
  const previewSource = samePageReadTarget(observed, preview?.source) ? preview.source : null;
  const windowOnly = view.status === 'window-only';
  const recognitionFailed = Boolean(observed?.attachmentId && (
    !observed.url && ['unsupported','unavailable','needs_permission','needs_window_recognition'].includes(observed.contextStatus)
    || preview?.status === 'idle' && observed.contextStatus === 'ready'));
  const needsWindowRecognition = windowOnly && observed.contextStatus === 'needs_window_recognition';
  const attached = $('#companion-attachment-status');
  attached.hidden = !observed?.attachmentId || activeAttachment;
  if (!attached.hidden) {
    const observedHeading = attached.querySelector('strong');
    observedHeading.textContent = observedTitle;
    observedHeading.hidden = !observedTitle || recognitionFailed || observedTitle === title;
    const status = previewStatus === 'reading' || view.status === 'reading' ? '正在读取'
      : previewSource ? (source === 'YouTube' ? '已读视频页面'
        : previewSource.readStatus === 'selection_only' ? '已读选区'
        : previewSource.textTruncated || previewSource.contentQuality?.status === 'partial' ? '已读部分正文' : '已读正文')
      : previewStatus === 'error' || recognitionFailed ? '未读取到页面'
      : previewStatus === 'declined' ? '暂不读取'
      : observed.contextStatus === 'reading' ? '正在识别'
      : '待读取';
    const otherPage = client.context && !samePageReadTarget(observed, client.context);
    const metadata = [otherPage ? '当前网页' : '', source, status].filter(Boolean).join(' · ');
    attached.querySelector('span').textContent = metadata;
    attached.title = [observedTitle, metadata].filter(Boolean).join(' · ');
  }
  const bar = $('#companion-page-choice'), label = $('#companion-page-choice-label');
  const read = $('#companion-page-start'), keep = $('#companion-page-keep'), follow = $('#companion-page-follow');
  const previewActions = $('#companion-preview-actions');
  const previewButton = $('#companion-preview-action');
  const fallback = $('#companion-link-fallback');
  const pending = Boolean(observed) && (!['idle','detached'].includes(view.status) || Boolean(previewSource && !activeAttachment));
  bar.hidden = (activeAttachment && !switching && view.status === 'idle') || (!pending && !previewStatus && !recognitionFailed);
  bar.setAttribute('aria-label', windowOnly || recognitionFailed ? '窗口读取状态' : '页面读取');
  read.parentElement.hidden = windowOnly || recognitionFailed || !pending || Boolean(previewStatus && !previewSource);
  previewActions.hidden = !previewStatus || Boolean(previewSource);
  previewButton.textContent = previewStatus === 'reading' ? '正在读取…' : previewStatus === 'error' ? '重试读取' : '吸附读取';
  previewButton.disabled = switching || client.busy || readingPage;
  $('#companion-preview-decline').hidden = !['identified','error'].includes(previewStatus);
  $('#companion-window-recognition').hidden = !needsWindowRecognition || !native();
  fallback.hidden = !(previewStatus === 'error' || recognitionFailed || pending && (windowOnly || source === '公众号'));
  if (fallback.dataset.attachmentId !== (observed?.attachmentId || '')) {
    fallback.dataset.attachmentId = observed?.attachmentId || '';
    fallback.open = false;
    $('#companion-link-form').reset();
    $('#companion-link-status').hidden = true;
  }
  if (fallbackPreview && !matchesFallbackWindow(fallbackPreview.expected)) {
    clearFallbackPreview();
    pageTextReader.hide();
  }
  label.hidden = false;
  if (windowOnly || recognitionFailed) label.textContent = observed.contextHint || '这个窗口暂未提供可读取的正文。';
  else if (pending) {
    label.textContent = view.status === 'reading' ? '正在读取这页…' : view.status === 'checking' ? '正在确认页面…'
      : view.status === 'pinned' ? '浏览器已换页，仍在继续之前的话题。'
      : view.status === 'expired' ? '这页上次的对话已超过一天，可以开始新话题。'
      : view.status === 'resume' ? '回到这一页了，可以继续之前的对话。'
      : view.error || (view.acceptedSource ? '浏览器已换页，要切到当前页吗？' : '要让 Tag 读取这页正文吗？');
    read.textContent = view.status === 'resume' || view.resolution?.status === 'active' ? '继续这页的对话' : view.status === 'pinned' ? '切到当前页' : previewSource ? '聊这页' : source === '公众号' ? '读取正文' : '读取并聊这页';
    read.disabled = ['checking','reading'].includes(view.status);
    keep.hidden = !client.conversationId || view.status === 'pinned';
    keep.textContent = '继续之前的话题';
    follow.hidden = view.status !== 'pinned';
  }
  if (previewStatus === 'identified') label.textContent = source === 'YouTube' ? '要读取这个视频页面吗？' : '要让 Tag 读取这页正文吗？';
  else if (previewStatus === 'error') label.textContent = preview.error || '这页暂时没能读到正文。';
  else if (previewStatus === 'reading' || previewStatus === 'declined' || previewSource) label.hidden = true;
  const previousId = view.resolution?.previousConversationId;
  const previousDraft = previousId && (conversationDrafts.get(previousId) || client.state?.surfaceSessions?.companion?.drafts?.[previousId]);
  $('#companion-previous').hidden = !previousId || view.resolution?.status !== 'expired';
  $('#companion-previous').dataset.companionConversation = previousId || '';
  $('#companion-previous').textContent = previousDraft?.text ? '上次有未发送草稿 · 查看' : '查看上次对话';
  const pageSession = current?.pageSession;
  $('#companion-read-time').hidden = !pageSession?.readAt;
  if (pageSession?.readAt) $('#companion-read-time').textContent = `读于 ${new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit'}).format(new Date(pageSession.readAt))}`;
  $('#companion-reread').hidden = windowOnly || !pageSession?.readAt
    || (attachmentPreview ? !activeAttachment : companionPageKey(observed) !== companionPageKey(accepted));
  $('#companion-reread').disabled = switching || client.busy || readingPage;
}

async function startObservedPage(settings = {}) {
  if (!companionSessions) return null;
  if (client.busy || composing || readingPage || readingAttachment()) {
    notify(readingPage ? '正在读取，请稍候。' : '当前操作完成后，可以继续读取正文。');
    return null;
  }
  const capture = native() ? expected => {
    const exact = samePageReadTarget(expected, attachmentPreview?.view.source)
      || (settings.reread && samePageReadTarget(expected, companionSessions.view.acceptedSource));
    const purpose = exact ? 'attachment-preview' : expected.contextStatus === 'needs_permission' ? 'connect' : 'conversation';
    return captureContext(purpose, { context: expected });
  } : undefined;
  return companionSessions.open({ ...settings, capture });
}

async function continueInWorkspace() {
  persistConversationDraft(); conversationDrafts.flush();
  const id = client.conversationId;
  if (id) {
    const existing = client.state?.surfaceSessions?.workspace?.drafts?.[id];
    const draft = $('#chat-input').value;
    await queueSurfaceDraft();
    await api('surfaces/select', { surface:'workspace',conversationId:id,...(draft && !existing?.text ? {draft:{text:draft,scrollTop:$('#chat-messages').scrollTop || 0}} : {}) });
    if (draft && existing?.text && existing.text !== draft) notify('主窗口已有草稿，小窗这份也已保留在原对话。');
  }
  closeCompanionPopovers();
  if (native()) { bridge('openConversation', { conversationId:id || '' }); return; }
  const target = new URL('/prototype/immersive-exhibition/light.html',location.origin);
  if (id) target.searchParams.set('conversation',id);
  target.hash = 'chat'; location.href = target.href;
}

function persistConversationDraft() {
  if (destroyed) return;
  const id = client.loadedConversationId || (!isWorkspaceChat ? 'companion-new-draft' : '');
  if (!id) return;
  const log = $('#chat-messages');
  const saved = conversationDrafts.get(id);
  const measurable = !embedded || (client.visible && !root.hidden && root.getClientRects().length);
  conversationDrafts.set(id, { text:$('#chat-input').value, scope:client.workspaceScope, scrollTop:measurable ? log.scrollTop : saved?.scrollTop || 0, scrolled:measurable ? log.dataset.hydrated === 'true' : saved?.scrolled === true });
  scheduleSurfaceDraft();
}
client.persistDraft = persistConversationDraft;
client.clearSentDraft = (id, message) => {
  const saved = conversationDrafts.get(id);
  if (saved?.text.trim() === message) conversationDrafts.set(id,{text:''});
  try { chatStorage?.removeItem(`forme.workspace-chat.draft:${id}`); } catch {}
  conversationDrafts.flush();
};

function validatedConversationScope(value) {
  if (!value || typeof value !== 'object') return null;
  try { return workspaceChatScope({ collectionIds:list(value.collectionIds).slice(0,6), ...(value.exhibitionId ? {exhibitionId:value.exhibitionId} : {}) }, client.state); }
  catch { return null; }
}

function restoreConversationDraft(id) {
  const saved = conversationDrafts.get(id || (!isWorkspaceChat ? 'companion-new-draft' : '')) || client.state?.surfaceSessions?.[isWorkspaceChat ? 'workspace' : 'companion']?.drafts?.[id || 'new'];
  let draft = saved?.text || '';
  const lastUser = conversationMessages(client.state, id).findLast(message => message.role === 'user');
  let scope = saved ? validatedConversationScope(saved.scope) : validatedConversationScope(lastUser?.workspaceContext);
  if (isWorkspaceChat && id) {
    try {
      const transferredScope = chatStorage?.getItem(`forme.workspace-chat.scope:${id}`);
      if (transferredScope) { scope = validatedConversationScope(JSON.parse(transferredScope)); chatStorage.removeItem(`forme.workspace-chat.scope:${id}`); }
      const transferredDraft = chatStorage?.getItem(`forme.workspace-chat.draft:${id}`);
      if (!saved && typeof transferredDraft === 'string') draft = transferredDraft.slice(0,60000);
      if (transferredDraft !== null) chatStorage?.removeItem(`forme.workspace-chat.draft:${id}`);
    } catch {}
  }
  client.loadedConversationId = id;
  client.workspaceScope = scope;
  if (isWorkspaceChat) client.context = null;
  $('#chat-input').value = draft;
  $('#chat-messages').replaceChildren();
  delete $('#chat-messages').dataset.hydrated;
  delete $('#chat-messages').dataset.welcome;
  client.messageSignatures.clear();
  client.restoreScroll = saved?.scrolled ? saved.scrollTop : null;
  setError(client.sendErrors.get(id) || '', Boolean(client.sendErrors.get(id)));
  conversationDrafts.set(id, { text:draft, scope, scrollTop:saved?.scrollTop || 0, scrolled:saved?.scrolled === true });
  conversationDrafts.flush();
  updateComposer();
}

function renderConversationShell() {
  if (!isWorkspaceChat) { renderCompanionSessionUI(); return; }
  const selected = list(client.state?.conversations).find(item => item.id === client.conversationId);
  $('#conversation-title').textContent = selected?.title || '新对话';
  if (!embedded) {
    document.title = `${selected?.title || '和 Tag 对话'} · Folio`;
    const url = new URL(location.href);
    if (client.conversationId && url.searchParams.get('conversation') !== client.conversationId) { url.searchParams.set('conversation',client.conversationId); history.replaceState(null,'',url); }
  }
  conversationSidebar?.render();
}

async function selectConversation(id, { alreadySelected = false } = {}) {
  if (destroyed) return null;
  const version = ++selectionVersion;
  if (!list(client.state?.conversations).some(item => item.id === id)) await refresh(true);
  if (destroyed || version !== selectionVersion) return null;
  if (!list(client.state?.conversations).some(item => item.id === id)) return null;
  persistConversationDraft(); conversationDrafts.flush();
  preserveEmptySelection = false;
  client.conversationId = id;
  applyState(client.state, true);
  if (embedded) options.onConversationChange?.(id);
  else { const url = new URL(location.href); url.searchParams.set('conversation',id); history.replaceState(null,'',url); }
  focusComposer();
  if (!alreadySelected) {
    try { const result = await api('surfaces/select',{surface:isWorkspaceChat ? 'workspace' : 'companion',conversationId:id}); if (result.state && client.conversationId === id && version === selectionVersion) applyState(result.state); }
    catch (error) { notify(error.message); }
  }
  return id;
}

let creatingConversation = false;
async function newConversation() {
  if (creatingConversation) return null;
  const version = selectionVersion;
  creatingConversation = true;
  try {
    persistConversationDraft(); conversationDrafts.flush();
    const result = await api('conversations',{});
    const id = result.conversation?.id;
    if (!id) throw new Error('暂时没有创建成功，请再试一次。');
    if (destroyed) return null;
    if (version !== selectionVersion) {
      // Creation may finish after another conversation or product page wins.
      // Keep its new history entry, while retaining the latest local timeline
      // and selected conversation instead of applying an older whole snapshot.
      const conversations = new Map(list(result.state?.conversations).map(item => [item.id,item]));
      for (const item of list(client.state?.conversations)) conversations.set(item.id,item);
      if (!conversations.has(id)) conversations.set(id,result.conversation);
      if (!client.conversationId) preserveEmptySelection = true;
      applyState({ ...result.state, ...client.state, conversations:[...conversations.values()] });
      return id;
    }
    preserveEmptySelection = false;
    client.conversationId = id;
    applyState(result.state);
    return await selectConversation(id,{alreadySelected:true});
  } catch (error) { if (version === selectionVersion) notify(error.message); return null; }
  finally { creatingConversation = false; }
}

async function refresh(force = false) {
  if (!force && document.hidden) return;
  if (client.request) return client.request;
  client.request = (async () => {
    try {
      applyState(await api('state'));
      const notice = $('#service-notice');
      if (notice && !client.state.capabilities?.aiEnabled) {
        notice.textContent = client.state.capabilities?.demoAccount ? demoChatNotice : '收藏和专题保存在本机。智能对话与完整展览暂未连接。';
        notice.classList.remove('is-error'); notice.hidden = false;
      } else if (notice) notice.hidden = true;
    } catch (error) {
      if (destroyed) return;
      client.connected = false;
      const notice = $('#service-notice'); if (notice) { notice.textContent = '暂时没有连上本机服务。内容会保留，稍后会自动重连。'; notice.classList.add('is-error'); notice.hidden = false; }
      if (!client.state) {
        if ($('#room-content')) $('#room-content').innerHTML = `<div class="initial-state"><p>还没有连上你的看展台。</p><button class="text-button btn" data-action="refresh" data-variant="outline" data-size="sm">重新连接 →</button></div>`;
        $('#chat-messages').innerHTML = `<div class="chat-welcome"><h2>${isCompanionChat ? companionGreeting : '我在这里。'}</h2><p>本机服务还没连接好。你写下的内容会留在输入框里，连好后再发给我。</p><button class="text-button btn" data-action="refresh" data-variant="outline" data-size="sm">重新连接 →</button></div>`;
      }
    }
  })().finally(() => { client.request = null; });
  return client.request;
}

function schedulePoll() {
  clearTimeout(client.poll);
  if (!document.hidden) client.poll = setTimeout(async () => { await refresh(); schedulePoll(); }, 5000);
}

function renderIdentity() {
  const profile = client.state?.profile || {};
  const name = text(profile.name) || 'Tag';
  $$('[data-curator-name]').forEach(element => { element.textContent = name; });
  $$('.curator-mark').forEach(element => { if (!element.querySelector('img, [data-companion-artwork]')) element.innerHTML = '<img src="/curator/ink-avatar.svg" alt="">'; });
  if ($('#curator-personality')) $('#curator-personality').textContent = `${text(profile.personality) || '安静敏锐'} · 私人策展人`;
  if ($('#exhibition-count')) $('#exhibition-count').textContent = String(client.state?.exhibitions.length || 0);
  if ($('#collection-count')) $('#collection-count').textContent = String(client.state?.collections.length || 0);
}

function getCollections() { return list(client.state?.collections); }
function getExhibitions() { return list(client.state?.exhibitions); }
function getExhibition(id = client.selected) { return getExhibitions().find(exhibition => String(exhibition.id) === String(id)); }
function getExtraction(item) { return item.extraction || {}; }
function summary(item) { return text(item.summary) || text(getExtraction(item).summary); }
function coverFor(exhibition) {
  const direct = imageURL(exhibition.cover || exhibition.thumbnail || exhibition.image);
  if (direct) return direct;
  for (const room of list(exhibition.rooms)) {
    for (const item of list(room.exhibits)) { const image = imageURL(item.image || item.thumbnail); if (image) return image; }
  }
  const item = getCollections().find(collection => list(exhibition.sourceCollectionIds).includes(collection.id) && imageURL(collection.thumbnail));
  return imageURL(item?.thumbnail);
}

function statusLabel(status) {
  return ({ saved: '已收好', queued: '正在等候整理', running: '正在整理', processing: '正在慢慢看看', complete: '整理完成', ready: '已整理', qualified: '已整理', needs_input: '需要一点补充', needs_confirmation: '等你核对', failed: '暂未整理完成', interrupted: '可以接着整理', preview: '私人预览', needs_review: '待核对草稿', candidate: '私人草稿' })[status] || '已收好';
}

function emptyRoom() {
  const isCollection = client.view === 'collections';
  return `<section class="empty-room"><div class="empty-art" aria-hidden="true"><div class="empty-sheet"></div><div class="empty-sheet second"></div><div class="empty-sheet third"><img src="/curator/ink-avatar.svg" alt=""><span>未完待续</span></div></div><div class="empty-copy"><p class="eyebrow">一个小小的开始</p><h2>${isCollection ? '有些喜欢，<br>值得多停留一会儿。' : '第一场展览，<br>从一次喜欢开始。'}</h2><p>${isCollection ? '把文章、图片的链接交给我，也可以留下一段话。先收好，意义慢慢发现。' : '给我一些你想留下的东西。等它们之间长出值得讲的联系，我们再一起整理成小展。'}</p><div class="empty-actions"><button class="solid-button btn" data-action="chat" data-size="sm">交给${escape(client.state?.profile?.name || 'Tag')}一些东西</button></div></div></section>`;
}

function renderRoom() {
  if (isChat || !client.state) return;
  const exhibition = getExhibition();
  const reading = Boolean(client.selected && exhibition);
  $('#room-heading').hidden = reading;
  $('#room-toolbar').hidden = reading;
  $('#room-content').hidden = reading;
  $('#reader').hidden = !reading;
  if (reading) { renderReader(exhibition); return; }
  const signature = JSON.stringify([client.view, getCollections(), getExhibitions(), client.state.profile.name]);
  if (signature === client.roomSignature) return;
  client.roomSignature = signature;
  $$('.view-tab').forEach(tab => { const active = tab.dataset.view === client.view; tab.classList.toggle('is-active', active); if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); });
  const items = client.view === 'collections' ? getCollections() : getExhibitions();
  $('#room-content').innerHTML = (!items.length ? emptyRoom() : client.view === 'collections' ? renderCollections(items) : renderExhibitions(items));
}

function renderExhibitions(exhibitions) {
  const covers = exhibitions.map((exhibition, index) => {
    const image = coverFor(exhibition);
    const count = list(exhibition.sourceCollectionIds).length || list(exhibition.rooms).reduce((sum, room) => sum + list(room.exhibits || room.exhibit_ids).length, 0);
    return `<button class="exhibition-cover" data-exhibition="${escape(exhibition.id)}"><div class="cover-image${image ? '' : ' has-no-image'}">${image ? `<img src="${escape(image)}" alt="${escape(exhibition.title)}的封面" loading="lazy">` : `<span class="cover-monogram" aria-hidden="true">${escape(text(exhibition.title).slice(0, 1) || 'Tag')}</span>`}<span class="cover-count">${count} 件收藏</span></div><div class="cover-caption"><span class="cover-number">${String(index + 1).padStart(2, '0')}</span><div><h2>${escape(exhibition.title || '一场正在形成的小展')}</h2><p>${escape(exhibition.subtitle || exhibition.curatorial_note?.text || '来自我们一起留下的东西。')}</p><div class="cover-meta"><span class="status-label">${statusLabel(exhibition.status)}</span><span>我与${escape(client.state.profile.name || 'Tag')}</span></div></div></div></button>`;
  }).join('');
  const note = exhibitions.length === 1 ? `<aside class="shelf-note"><span class="curator-mark" aria-hidden="true"><img src="/curator/ink-avatar.svg" alt=""></span><strong>看展不必赶路。</strong><p>每一件收藏都保留着来处。你可以顺着章节慢慢看，也可以从最在意的那一件开始。</p></aside>` : '';
  return `<div class="exhibition-grid${exhibitions.length === 1 ? ' has-one' : ''}">${covers}${note}</div>`;
}

function renderCollections(collections) {
  return `<div class="collection-list">${[...collections].reverse().map((item, index) => {
    const image = imageURL(item.thumbnail || item.image), url = safeURL(item.url);
    const retry = ['failed', 'needs_input', 'interrupted', 'saved'].includes(item.status);
    return `<article class="collection-row"><span class="collection-number">${String(index + 1).padStart(2, '0')}</span>${image ? `<img class="collection-thumb" src="${escape(image)}" alt="" loading="lazy">` : `<span class="collection-thumb collection-placeholder" aria-hidden="true">${item.type === 'user_input' || !url ? '记' : '藏'}</span>`}<div class="collection-info"><h2>${escape(item.title || '刚刚留下的内容')}</h2><div class="collection-meta"><span>${escape(item.source || (url ? new URL(url).hostname : '我的想法'))}</span><span>${statusLabel(item.status)}</span></div>${summary(item) ? `<p>${escape(summary(item))}</p>` : ''}${item.error ? `<p class="collection-error">${escape(typeof item.error === 'string' ? item.error : item.error.message || '还没有整理完成。')}</p>` : ''}</div><div class="collection-actions">${retry ? `<button class="text-button btn" data-retry="${escape(item.id)}" data-variant="outline" data-size="sm">接着整理 →</button>` : ''}${url ? `<a href="${escape(url)}" class="source-link" data-external>查看来源 ↗</a>` : ''}</div></article>`;
  }).join('')}</div>`;
}

function sourceItem(id, exhibition) { return getCollections().find(item => item.id === id) || list(exhibition.items).find(item => item.id === id) || { id, title: '原始收藏' }; }
function exhibitionItems(exhibition, room) { return list(room.exhibits).length ? room.exhibits : list(room.exhibit_ids).map(id => sourceItem(id, exhibition)); }
function renderExhibit(item) {
  const image = imageURL(item.image || item.thumbnail), url = safeURL(item.url || getCollections().find(collection => collection.id === item.id)?.url);
  return `<div class="exhibit">${image ? `<img class="exhibit-image" src="${escape(image)}" alt="${escape(item.title || '')}" loading="lazy">` : ''}<h3>${escape(item.title || '原始收藏')}</h3><p>${escape(item.description || item.summary || summary(item))}</p>${item.evidence ? `<p>${escape(item.evidence)}</p>` : ''}${url ? `<a class="source-link" href="${escape(url)}" data-external>回到${escape(item.platform || item.source || '原始来源')} ↗</a>` : ''}</div>`;
}

function renderReader(exhibition) {
  const signature = JSON.stringify(exhibition);
  if (client.readerSignature === signature) return;
  if (document.activeElement?.id === 'exhibition-note' && $('#exhibition-note')?.value !== (exhibition.note || '')) return;
  client.readerSignature = signature;
  const cover = coverFor(exhibition), count = list(exhibition.sourceCollectionIds).length;
  const intro = exhibition.curatorial_note?.text || '这场展览，从我们反复留下的东西里生长出来。先看看它们，再听听它们之间的回声。';
  const sourceIds = list(exhibition.sourceCollectionIds);
  const sourceLinks = sourceIds.map(id => sourceItem(id, exhibition)).filter(item => safeURL(item.url));
  $('#reader').innerHTML = `<button class="reader-back btn" data-action="close-reader" data-variant="outline" data-size="sm">← 回到我的看展台</button><header class="reader-header"><p class="eyebrow">我们的展览${count ? ` / ${count} 件收藏` : ''}</p><h1>${escape(exhibition.title || '一场小展')}</h1>${exhibition.subtitle ? `<p class="reader-subtitle">${escape(exhibition.subtitle)}</p>` : ''}<p class="reader-intro">${escape(intro)}</p></header>${cover ? `<img class="reader-hero" src="${escape(cover)}" alt="${escape(exhibition.title)}的封面"><p class="reader-hero-caption">从一件收藏开始，慢慢看见它与其他事物的联系。</p>` : ''}${list(exhibition.rooms).map((room, index) => `<section class="chapter"><div class="chapter-title"><span class="chapter-number">${String(index + 1).padStart(2, '0')}</span><h2>${escape(room.title || '一段联系')}</h2></div>${room.prompt || room.introduction ? `<p class="chapter-question">${escape(room.prompt || room.introduction)}</p>` : ''}<div class="exhibit-group">${exhibitionItems(exhibition, room).map(renderExhibit).join('')}</div>${list(room.claims).map(claim => `<p class="chapter-claim">${escape(claim.text || '')}${claim.statement_type === 'hypothesis' ? '<small>策展人的一个理解，欢迎你纠正。</small>' : ''}</p>`).join('')}${room.connection?.hypothesis ? `<div class="connection-note"><span>为什么放在一起</span><p>${escape(room.connection.hypothesis)}</p></div>` : ''}${room.echo ? `<p class="chapter-question">${escape(room.echo)}</p>` : ''}</section>`).join('')}${list(exhibition.connection_claims).length ? `<section class="chapter"><div class="chapter-title"><span class="chapter-number">↔</span><h2>它们之间的回声</h2></div>${exhibition.connection_claims.map(claim => `<p class="chapter-claim">${escape(claim.text)}</p>`).join('')}</section>` : ''}${exhibition.open_question || exhibition.emerging_direction?.text ? `<section class="chapter"><div class="connection-note"><span>一个继续往前的问题</span><p>${escape(exhibition.open_question || exhibition.emerging_direction.text)}</p></div></section>` : ''}${sourceLinks.length ? `<section class="reader-source-list"><h2>每一件收藏，都有来处</h2>${sourceLinks.map(item => `<a href="${escape(safeURL(item.url))}" data-external>${escape(item.title)} ↗</a>`).join('')}</section>` : ''}<section class="personal-note"><h2>看完以后，我想留下一句。</h2><p>这句话，和这场展览一起留在本机。</p><label class="sr-only" for="exhibition-note">我在这场展览里留下的想法</label><textarea id="exhibition-note" rows="3" maxlength="10000" placeholder="这里留给你自己的判断。" class="textarea">${escape(exhibition.note || '')}</textarea><div class="note-actions"><button class="solid-button btn" data-action="save-note" data-size="sm">留下这句话</button><span class="note-status" id="note-status">${exhibition.note ? '已保存在本机' : '仅你可见'}</span></div></section>`;
}

function messageReceipt(item) {
  const aiEnabled = client.state.capabilities?.aiEnabled;
  const failed = ['failed', 'needs_input', 'interrupted'].includes(item.status);
  const processing = ['processing', 'queued', 'running'].includes(item.status);
  const sourceStatus = item.url ? item.sourceSaveStatus : '';
  const sourceLabel = item.videoCaptions ? '字幕' : '正文';
  let label;
  if (sourceStatus === 'complete' || sourceStatus === 'partial') {
    label = sourceStatus === 'complete' ? `${sourceLabel}已存` : '已存节选';
    if (processing || failed) label += ` · ${statusLabel(item.status)}`;
  } else if (sourceStatus === 'unavailable') {
    label = processing ? `链接已收藏 · 等待读取${sourceLabel}` : failed ? `仅存链接 · 未读到${sourceLabel}` : '仅存链接';
  } else if (sourceStatus === 'pending') {
    label = '正在保存正文';
  } else {
    label = statusLabel(item.status);
    if (!aiEnabled && item.status === 'saved') label += ' · 连接智能整理后再继续';
  }
  const retry = (failed || item.status === 'saved') && (aiEnabled || !sourceStatus || (item.videoCaptions && sourceStatus === 'unavailable'));
  return `<div class="message-receipt${failed ? ' is-failed' : ''}"><span class="receipt-dot" aria-hidden="true"></span><div><strong>${escape(item.title || '刚刚收下的内容')}</strong><small>${escape(label)}</small></div>${retry ? `<button class="small-button btn" data-retry="${escape(item.id)}" data-variant="outline" data-size="sm">重试</button>` : ''}</div>`;
}

const messageText = message => text(message?.text) || text(message?.content);

function clearCopyFeedback() {
  if (!copyFeedback) return;
  const { button, timer } = copyFeedback;
  clearTimeout(timer);
  delete button.dataset.copied;
  button.dataset.tooltip = '复制';
  $('#copy-status').textContent = '';
  copyFeedback = null;
}

async function copyMessage(button) {
  const id = button.closest('[data-message-id]')?.dataset.messageId;
  const message = client.state?.messages.find(entry => entry.id === id);
  const value = [messageText(message), messageWebSourcesText(message)].filter(Boolean).join('\n\n');
  if (!value.trim()) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    notify('复制失败，请选中文字后手动复制。');
    return;
  }
  if (destroyed || !button.isConnected) return;
  clearCopyFeedback();
  button.dataset.copied = 'true';
  button.dataset.tooltip = '已复制';
  $('#copy-status').textContent = '已复制消息。';
  copyFeedback = { button, timer: setTimeout(clearCopyFeedback, 1800) };
}

function messageNode(message) {
  const element = document.createElement('div');
  if (message.kind === 'page-read') {
    const title = message.context?.title || client.state.conversations?.find(item => item.id === message.conversationId)?.title || '当前页面';
    const stamp = new Date(message.createdAt);
    const time = Number.isNaN(stamp.getTime()) ? '' : `<time datetime="${escape(stamp.toISOString())}">${escape(new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}).format(stamp))}</time>`;
    element.className = 'message page-read-record';
    element.dataset.messageId = message.id;
    element.setAttribute('aria-label','页面读取记录');
    element.innerHTML = `<div class="message-label"><span>${text(message.text).startsWith('重新读取') ? '已重新读取' : '已读取'}《${escape(title)}》</span>${time}</div>`;
    return element;
  }
  const isUser = message.role === 'user';
  element.className = `message ${isUser ? 'is-user' : 'is-assistant'}`;
  element.setAttribute('aria-label', isUser ? '你的消息' : `${client.state.profile.name || 'Tag'}的回复`);
  element.dataset.messageId = message.id;
  const receipts = list(message.collectionIds).map(id => client.state.collections.find(item => item.id === id)).filter(Boolean);
  const createdAt = new Date(message.createdAt);
  const time = Number.isNaN(createdAt.getTime()) ? '' : `<time datetime="${escape(createdAt.toISOString())}">${escape(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(createdAt))}</time>`;
  const source = sourceForMessage(message, client.state);
  const scopeMessage = message.workspaceContext ? message : client.state.messages.find(item => item.id === message.sourceMessageId);
  const scope = scopeMessage?.workspaceContext;
  const scopeExhibition = scope?.exhibitionId && client.state.exhibitions.find(item => item.id === scope.exhibitionId);
  const scopeTitles = list(scope?.collectionIds).map(id => client.state.collections.find(item => item.id === id)?.title).filter(Boolean);
  const workspaceLabel = scope && (scopeExhibition || scopeTitles.length) ? `<div class="message-page-source"><span>关于${escape(scopeExhibition?.title || (scopeTitles.length === 1 ? scopeTitles[0] : `${scopeTitles.length} 条收藏`))}</span></div>` : '';
  const pageLabel = source && !isUser ? `<div class="message-page-source" title="${escape(source.url || source.title)}"><span>关于${escape(source.title ? `「${source.title}」` : source.url ? new URL(source.url).hostname : '关联页面')}</span></div>` : '';
  const value = messageText(message);
  element.innerHTML = `<div class="message-label"><span>${isUser ? '你' : escape(client.state.profile.name || 'Tag')}</span>${isCompanionChat ? '' : time}</div>${workspaceLabel || pageLabel}<div class="message-body">${isUser ? escape(value) : formatMessage(value)}</div>` + receipts.map(messageReceipt).join('');
  const webSources = renderMessageWebSources(message);
  if (webSources) element.insertAdjacentHTML('beforeend', webSources);
  const curated = message.referenceAttribution === 'selected_curation';
  const topic = curated && client.state.exhibitions.find(item => item.id === message.exhibitionId);
  if (topic) element.insertAdjacentHTML('beforeend', `<button type="button" class="reference-collection" data-private-exhibition="${escape(topic.id)}">打开专题 <span aria-hidden="true">↗</span></button>`);
  if (message.curationUpdateOffer) element.insertAdjacentHTML('beforeend', `<p class="message-scope">${message.curationUpdateOffer.accepted === true ? '已加入专题' : '这条邀请已结束'}</p>`);
  const references = messageReferences(message, client.state.collections);
  if (references.collections.length) element.insertAdjacentHTML('beforeend', `<div class="message-references"${curated ? ' data-curation-related' : ''}><span>${curated ? '相关收藏' : '本轮参考收藏'}</span>${references.collections.map(item => `<button type="button" class="reference-collection" data-open-collection="${escape(item.id)}">${escape(item.title || '原始收藏')} <span aria-hidden="true">↗</span></button>`).join('')}</div>`);
  if (references.scopeNotice) element.insertAdjacentHTML('beforeend', `<p class="message-scope">${escape(references.scopeNotice)}</p>`);
  const memories = list(message.memoryReferences).filter(item => list(client.state.conversations).some(conversation => conversation.id === item.conversationId));
  if (memories.length) element.insertAdjacentHTML('beforeend', `<div class="message-references"><span>本轮回顾的对话</span>${memories.map(item => `<button type="button" class="reference-collection" data-open-conversation="${escape(item.conversationId)}" data-source-message="${escape(list(item.sourceMessageIds)[0] || '')}">${escape(client.state.conversations.find(conversation => conversation.id === item.conversationId)?.title || '此前的对话')} <span aria-hidden="true">↗</span></button>`).join('')}</div>`);
  const actionTime = isCompanionChat ? time : '';
  const label = isUser ? '复制你的消息' : `复制 ${client.state.profile.name || 'Tag'} 的回复`;
  const copy = value.trim() || webSources ? `<button type="button" class="message-copy btn" data-action="copy-message" data-variant="ghost" data-size="icon-sm" aria-label="${escape(label)}" data-tooltip="复制" data-side="bottom"><svg viewBox="0 0 24 24" aria-hidden="true"><g class="message-copy-icon"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></g><path class="message-copied-icon" d="m5 12 4 4L19 6"/></svg></button>` : '';
  if (copy || actionTime) {
    element.insertAdjacentHTML('beforeend', `<div class="message-actions">${isUser ? actionTime + copy : copy + actionTime}</div>`);
  }
  return element;
}

function renderMessages() {
  if (destroyed || !client.state || (embedded && !client.visible) || (isWorkspaceChat && preserveEmptySelection && !client.conversationId)) return;
  const log = $('#chat-messages');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 65;
  const messages = !isWorkspaceChat && !client.conversationId ? [] : conversationMessages(client.state, client.conversationId);
  const jobs = !isWorkspaceChat && !client.conversationId ? [] : conversationJobs(client.state, client.conversationId);
  const scoped = Boolean(client.conversationId && list(client.state.conversations).length);
  const inlineTopics = new Set(messages.filter(message => message.referenceAttribution === 'selected_curation' && message.exhibitionId).map(message => message.exhibitionId));
  const exhibitions = scoped
    ? client.state.exhibitions.filter(exhibition => !inlineTopics.has(exhibition.id)
      && (messages.some(message => message.exhibitionId === exhibition.id) || jobs.some(job => job.exhibitionId === exhibition.id || job.result?.exhibitionId === exhibition.id)))
    : isCompanionChat ? [] : client.state.exhibitions;
  const hydrated = log.dataset.hydrated === 'true';
  let changed = false;
  if (!messages.length) {
    const { capabilities } = client.state;
    const signature = `${client.state.profile.name}/${capabilities?.aiEnabled}/${capabilities?.demoAccount}/${client.context?.attachmentId || ''}/${client.context?.contextStatus || ''}`;
    const availability = capabilities?.aiEnabled ? '' : `<p class="welcome-availability">${capabilities?.demoAccount ? demoChatNotice : isCompanionChat ? '链接可以先收藏到本机。智能对话暂未连接。' : '可以指定已收藏的文章整理专题。智能对话暂未连接。'}</p>`;
    if (log.dataset.welcome !== signature || !$('.chat-welcome', log)) {
      if (isCompanionChat) {
        log.innerHTML = `<div class="chat-welcome"><h2>${companionGreeting}</h2><p class="companion-start-hint">${companionStartHint}</p>${availability}</div>`;
      } else {
        log.innerHTML = `<div class="chat-welcome"><span class="welcome-rule" aria-hidden="true"></span><p class="eyebrow">与你的私人策展人对话</p><h2>有什么想留下？</h2><p>发来一条链接，或聊聊刚刚想到的事。</p>${availability}<button class="text-button btn" data-action="profile" data-variant="ghost" data-size="sm">认识一下彼此 <span aria-hidden="true">↗</span></button></div>`;
      }
      log.dataset.welcome = signature; client.messageSignatures.clear();
    }
  } else {
    $('.chat-welcome', log)?.remove();
    const ids = new Set(messages.map(message => String(message.id)));
    $$('.message', log).forEach(element => { if (!ids.has(element.dataset.messageId)) element.remove(); });
    for (const message of messages) {
      const topicAvailable = inlineTopics.has(message.exhibitionId) && client.state.exhibitions.some(item => item.id === message.exhibitionId);
      const signature = JSON.stringify([message, sourceForMessage(message, client.state), list(message.collectionIds).map(id => { const item = client.state.collections.find(collection => collection.id === id); return item ? [item.title, item.status, item.error, item.sourceSaveStatus, item.videoCaptions] : null; }), client.state.capabilities?.aiEnabled, client.state.profile.name, ...(inlineTopics.has(message.exhibitionId) ? [topicAvailable] : [])]);
      if (client.messageSignatures.get(message.id) === signature) continue;
      const old = [...log.children].find(element => element.dataset.messageId === String(message.id));
      const element = messageNode(message);
      if (old) old.replaceWith(element); else log.append(element);
      changed = true;
      if (!old && hydrated && !reducedMotion()) element.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
      client.messageSignatures.set(message.id, signature);
    }
  }
  let delivered = $('.chat-deliveries', log);
  const exhibitionSignature = JSON.stringify(exhibitions.map(exhibition => [exhibition.id, exhibition.title, exhibition.status]));
  if (!delivered || delivered.dataset.signature !== exhibitionSignature) {
    delivered?.remove();
    if (exhibitions.length) {
      delivered = document.createElement('div'); delivered.className = 'chat-deliveries'; delivered.dataset.signature = exhibitionSignature;
      delivered.innerHTML = exhibitions.slice(-2).map(exhibition => { const image = coverFor(exhibition); return `<button class="chat-exhibition" data-private-exhibition="${escape(exhibition.id)}">${image ? `<img src="${escape(image)}" alt="" loading="lazy">` : ''}<div class="chat-exhibition-copy"><span class="eyebrow">${exhibition.status === 'needs_review' ? '待核对的展览草稿' : '我带回了一场小展'}</span><h3>${escape(exhibition.title)}</h3><p>${escape(exhibition.curatorial_note?.text || '有空的时候，我们一起看看。')}</p><span class="source-link">打开看看 →</span></div></button>`; }).join('');
      log.append(delivered);
    }
  }
  const activity = conversationActivity({jobs,messages,collections:client.state.collections,busy:client.busy,capturing:captureRequests.size>0});
  const working = Boolean(activity.pending);
  let status = $('.chat-working:not(.chat-recovery)', log);
  if (working && !status) {
    status = document.createElement('p');
    status.className = 'chat-working';
    status.setAttribute('role', 'status');
    log.append(status);
    changed = true;
  } else if (!working && status) {
    status.remove();
    changed = true;
  }
  if (working && status.dataset.label !== activity.pending) {
    status.dataset.label = activity.pending;
    const reply = activity.pending === CHAT_REPLY_PENDING;
    status.classList.toggle('is-reply', reply);
    if (reply) {
      const announcement = document.createElement('span');
      announcement.className = 'sr-only';
      announcement.textContent = activity.pending;
      const wave = document.createElement('span');
      wave.className = 'working-wave';
      wave.setAttribute('aria-hidden', 'true');
      Array.from(activity.pending).forEach((character, index) => {
        const letter = document.createElement('span');
        letter.textContent = character;
        letter.style.setProperty('--wave-index', index);
        wave.append(letter);
      });
      status.replaceChildren(announcement, wave);
    } else {
      status.innerHTML = '<span class="working-dots" aria-hidden="true"><i></i><i></i><i></i></span><span></span>';
      status.lastElementChild.textContent = activity.pending;
    }
  }
  if (working && status !== log.lastElementChild) log.append(status);
  const oldProgress = $('.task-progress', log);
  if (oldProgress) { oldProgress.remove(); changed = true; }
  const recoveryIds = new Set(activity.recoveries.map(item=>item.jobId));
  for (const row of $$('[data-chat-recovery]',log)) if (!recoveryIds.has(row.dataset.chatRecovery)) { row.remove(); changed = true; }
  for (const item of activity.recoveries) {
    const message = [...log.children].find(element=>element.dataset.messageId===String(item.messageId));
    const parent = message || log;
    const signature = JSON.stringify(item);
    let row = $$('[data-chat-recovery]',log).find(element=>element.dataset.chatRecovery===item.jobId);
    if (row && (row.dataset.signature!==signature || row.parentElement!==parent)) { row.remove(); row = null; }
    if (!row) {
      row = document.createElement('p'); row.className = 'chat-working chat-recovery';
      row.dataset.chatRecovery = item.jobId; row.dataset.signature = signature;
      if (item.description) {
        row.setAttribute('role','status');
        const copy = document.createElement('span'); copy.textContent = item.description; row.append(copy);
      }
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button btn'; button.dataset.retryJob = item.jobId;
      button.textContent = item.retryLabel; button.setAttribute('aria-label',item.ariaLabel);
      row.append(button); parent.append(row); changed = true;
    }
  }
  if (working && status !== log.lastElementChild) log.append(status);
  if (client.restoreScroll !== null) { log.scrollTop = client.restoreScroll; client.restoreScroll = null; }
  else if (nearBottom && (changed || !hydrated)) log.scrollTo({ top: log.scrollHeight, behavior: hydrated && !reducedMotion() ? 'smooth' : 'auto' });
  log.dataset.hydrated = 'true';
}

function focusComposer() {
  if (destroyed || !client.visible || $('#profile-dialog').open || $('#chat-panel').hidden || (embedded && (root.hidden || !root.getClientRects().length))) return;
  const active = document.activeElement;
  if (active && active !== $('#chat-input') && active.matches('input,textarea,[contenteditable="true"]')) return;
  requestAnimationFrame(() => { if (!destroyed && client.visible && (!embedded || (!root.hidden && root.getClientRects().length))) $('#chat-input')?.focus({ preventScroll: true }); });
}
function openChat() {
  $('#chat-panel').hidden = false;
  if (!isChat && !reducedMotion()) $('#chat-panel').animate([{ opacity: 0, transform: 'translateY(6px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
  focusComposer();
}

function receiveWorkspaceChat(value) {
  if (typeof value?.requestId === 'string' && workspaceRequests.has(value.requestId)) return workspaceRequests.get(value.requestId);
  let request;
  try { request = normalizeWorkspaceChatRequest(value); }
  catch (error) { return Promise.resolve({ requestId: value?.requestId, accepted: false, error: error.message }); }
  if (workspaceRequests.has(request.requestId)) return workspaceRequests.get(request.requestId);
  const operation = (async () => {
    openChat();
    await refresh(true);
    const reject = error => { notify(error); return { requestId: request.requestId, accepted: false, error }; };
    if (Date.now() >= request.expiresAt) return reject('对话连接花了些时间，问题仍在收藏馆，请重新发送。');
    if (!client.connected) return reject('暂时没有连上本机服务，问题仍留在收藏馆。');
    if (client.busy || readingPage || composing || $('#chat-input').value.trim()) return reject('对话里还有未发送的内容，请先处理这份草稿，再从收藏馆继续。');
    try {
      const videoCapture = !request.collectionIds.length && !request.exhibitionId && parseVideoCaptureCommand(request.message);
      client.workspaceScope = videoCapture ? null : workspaceChatScope(request, client.state);
    }
    catch (error) { return reject(error.message); }
    $('#chat-input').value = request.message;
    client.persistDraft?.();
    setError(); renderContext(); updateComposer(); focusComposer();
    // The workspace submit click already requested sending. Start immediately:
    // visibility or animation scheduling must not turn that click into a draft.
    // sendMessage keeps the transferred draft in this composer if the API fails.
    if (request.submit) void sendMessage();
    return { requestId: request.requestId, accepted: true };
  })();
  workspaceRequests.set(request.requestId, operation);
  if (workspaceRequests.size > 100) workspaceRequests.delete(workspaceRequests.keys().next().value);
  return operation;
}

function canSavePageSnapshot(saved, snapshot) {
  return !saved || saved.sourceSaveStatus === 'pending' || Boolean(snapshot?.snapshotId && (snapshot.text || snapshot.selection) && snapshot.snapshotId !== saved.savedPageSnapshotId);
}
const pageSaveLabel = saved => ({ complete:'正文已存', partial:'已存节选', unavailable:'仅链接' })[saved?.sourceSaveStatus] || '本页已收藏';

function renderContext() {
  if (destroyed) return;
  const context = client.context;
  const scope = client.workspaceScope;
  const detach = $('#source-context [data-action="detach"]');
  const detachLabel = scope ? '取消收藏馆关联' : '取消页面关联';
  detach.setAttribute('aria-label', detachLabel);
  if (sourceMenu) {
    sourceMenu.hidden = !scope && !context;
    if (sourceMenu.hidden) sourceMenu.open = false;
    detach.textContent = detachLabel;
    $('.companion-read-info', sourceMenu).hidden = Boolean(scope);
  } else detach.dataset.tooltip = detachLabel;
  if (scope) {
    $('#source-context').hidden = false;
    (embedded ? root : document.body).classList.add('has-page-context');
    $('#context-label').textContent = scope.exhibitionId ? '正在聊这场展览' : scope.collectionIds.length ? '正在聊收藏' : '关于我的收藏馆';
    $('#context-title').textContent = scope.title;
    $('#source-context').title = '本轮只讨论这里关联的收藏；不会读取正在关注的浏览器页面。';
    $('#chat-input').placeholder = '围绕这些收藏，继续问问 Tag…';
    $('#page-prompt').hidden = true;
    $('#collect-page-button').hidden = true;
    $('#context-read-button').hidden = true;
    return;
  }
  $('#source-context').hidden = !context;
  (embedded ? root : document.body).classList.toggle('has-page-context', Boolean(context));
  $('#chat-input').placeholder = context ? '问问这页，或说说你的想法…' : '发消息，或贴一条链接…';
  const evidence = context && (samePageReadTarget(context, currentPageRead)
    ? currentPageRead : pageReadEvidence(context, client.state));
  const saved = collectionForPage(context, client.state?.collections);
  $('#page-prompt').hidden = Boolean(companionSessions) || !context || Boolean(saved) || pageDecision !== 'ask';
  if (context?.contextStatus === 'reading') $('#page-prompt').hidden = true;
  const collectButton = $('#collect-page-button');
  const observed = companionSessions?.view.observedPage;
  const accepted = companionSessions?.view.acceptedSource;
  const switchedPage = Boolean(observed && !samePageReadTarget(observed, context));
  const saveAvailable = canSavePageSnapshot(saved, accepted);
  const canCollect = Boolean(context?.url && (!companionSessions || (evidence?.text || evidence?.selection)
    && !switchedPage));
  collectButton.hidden = !canCollect || readingAttachment();
  collectButton.disabled = collectingPage || client.busy || readingPage || readingAttachment() || client.openingPageSession || !saveAvailable;
  collectButton.classList.toggle('is-saved', !saveAvailable);
  const collectingThisPage = collectingPage && samePageContext(collectingContext, context);
  collectButton.querySelector('span').textContent = collectingThisPage ? '正在收藏…' : !saveAvailable ? pageSaveLabel(saved) : saved?.sourceSaveStatus === 'pending' ? '重试保存' : saved ? '保存这一版' : '收藏本页内容';
  collectButton.setAttribute('aria-busy', String(Boolean(collectingThisPage)));
  $$('#page-prompt button').forEach(button => { button.disabled = collectingPage || client.busy || readingPage; });
  if (!context) {
    const startHint = $('.companion-start-hint');
    if (startHint && startHint.textContent !== companionStartHint) startHint.textContent = companionStartHint;
    return;
  }
  const readingLabel = ({ public_page: '已读取网页文字', attached_text: '已读取当前页文字', selection_only: '已读取选中文字', unavailable: '未能读取正文' })[evidence?.readStatus];
  if (isCompanionChat && context.url) {
    const status = evidence?.text ? evidence.textTruncated || evidence.contentQuality?.status === 'partial' ? '已读部分正文' : '已读正文'
      : evidence?.selection ? '已读选区' : evidence?.readStatus === 'unavailable' ? '未读到正文' : '已关联';
    $('#context-label').textContent = [switchedPage ? '正在聊' : '', new URL(context.url).hostname, status].filter(Boolean).join(' · ');
  } else {
    $('#context-label').textContent = context.url ? `${readingLabel || '已关联页面'} · ${new URL(context.url).hostname.replace(/^www\./, '')}` : context.contextStatus === 'reading' ? '正在确认页面…' : context.contextStatus === 'needs_permission' ? '尚未获准读取页面' : `已关联 · ${context.appName || '当前页面'}`;
  }
  $('#source-context').title = [readingLabel || (context.url ? '已识别页面标题与链接，选择读取后开始讨论。' : '已关注所选窗口，尚未确认可读取的页面。'), evidence?.textTruncated ? '页面较长，本次只读取了部分文字。' : '', context.contextHint, context.url].filter(Boolean).join('\n');
  const readButton = $('#context-read-button');
  readButton.hidden = !native() || (!context.url && context.contextStatus !== 'needs_permission')
    || (isCompanionChat && switchedPage && !samePageReadTarget(context, currentPageRead));
  readButton.disabled = client.busy || readingPage || readingAttachment() || client.openingPageSession;
  if (!readButton.dataset.loading) readButton.textContent = context.contextStatus === 'needs_permission' ? '允许读取' : evidence?.text ? '查看正文' : evidence?.selection ? '查看选区' : '读取正文';
  $('#context-title').textContent = context.title || context.appName || '当前页面';
  const welcome = $('.chat-welcome>p:not(.eyebrow):not(.welcome-availability)');
  const unavailableHint = client.state?.capabilities?.demoAccount ? '页面已关联。演示模式下可收藏链接。' : '页面已关联。智能对话尚未连接。';
  if (welcome) welcome.textContent = client.state && !client.state.capabilities?.aiEnabled ? unavailableHint : evidence?.readStatus === 'unavailable' ? '这页的正文还没读到。可以粘贴选中的段落，继续一起看。' : isCompanionChat && (evidence?.text || evidence?.selection) ? '这页已经读过了，可以直接开始聊。' : context.url ? '发出问题后，我会读取这页可获得的内容，再一起讨论。' : context.contextHint || '页面关联会保留，也可以直接把链接贴给我。';
}

function applyContext(context) {
  if (companionSessions) {
    if (attachmentPreview && client.observedPage?.url && !samePageReadTarget(client.observedPage, context)) pageTextReader.hide();
    attachmentPreview?.observe(context);
    void companionSessions.observe(context);
    return;
  }
  if (!samePageContext(client.context, context)) { pageDecision = 'ask'; currentPageRead = null; setError(); }
  if (!samePageReadTarget(client.context, context)) { currentPageRead = null; pageReadController.invalidate(); pageTextReader.hide(); }
  client.context = context;
  renderContext();
}

function receiveContext(context) {
  if (client.isWorkspaceChat) return;
  const version = advanceContextVersion(lastContextVersion, context);
  if (!version.accepted) {
    const pending = context?.requestId && captureRequests.get(context.requestId);
    if (pending) { clearTimeout(pending.timeout); captureRequests.delete(context.requestId); pending.reject(new Error('页面读取结果已过期，请围绕当前页面再试一次。')); }
    return;
  }
  lastContextVersion = version.highWater;
  if (context === null || (context && typeof context === 'object' && !context.url && !context.title && !context.appName && !context.error && !context.requestId)) {
    if (companionSessions) {
      cancelPageRead(); applyContext(null);
      for (const pending of captureRequests.values()) { clearTimeout(pending.timeout); pending.reject(new Error('页面关联已取消，请重新选择页面。')); }
      captureRequests.clear(); return;
    }
    cancelPageRead(); client.context = null; currentPageRead = null; pageDecision = 'ask'; renderContext();
    for (const pending of captureRequests.values()) { clearTimeout(pending.timeout); pending.reject(new Error('页面关联已取消，请重新选择页面。')); }
    captureRequests.clear(); return;
  }
  if (!context || typeof context !== 'object') return;
  const pending = context.requestId && captureRequests.get(context.requestId);
  const current = normalizePageContext(context);
  // Resolve only the selected page. A delayed result may never replace a new attachment.
  if (pending) {
    clearTimeout(pending.timeout); captureRequests.delete(context.requestId);
    const disposition = captureReplyDisposition(pending.expected, client.observedPage || client.context, current, pending.purpose);
    if (disposition !== 'accepted' && disposition !== 'confirm') {
      if (disposition === 'changed') applyContext(current);
      pending.reject(new Error('当前页面已变化，请确认来源后再试一次。')); return;
    }
    if (disposition === 'confirm') {
      applyContext(current); pageDecision = 'ask'; renderContext();
      pending.reject(Object.assign(new Error('页面已连接，请确认来源后再次点击收藏。'), { code: 'PAGE_CONFIRMATION_REQUIRED' })); return;
    }
  } else if (context.requestId) return;
  if (!isFreshContextUpdate(client.context, current)) return;
  applyContext(current);
  if (pending) {
    if (current?.url && !context.error) pending.resolve(current);
    else pending.reject(new Error(context.error || '还没读到这页。可以把文章链接贴给我。'));
  } else if (context.error) setError(context.error);
}

function captureContext(purpose = 'conversation', settings = {}) {
  if (!native()) return Promise.reject(new Error('把文章链接贴给我，就能收下。'));
  const target = settings.context || client.observedPage || client.context;
  if (!target) return Promise.reject(new Error('先把小伙伴拖到页面上，再试一次。'));
  const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    let timeout;
    const finish = callback => value => { clearTimeout(timeout); settings.signal?.removeEventListener('abort', abort); captureRequests.delete(requestId); callback(value); };
    const abort = () => finish(reject)(Object.assign(new Error('页面读取已取消。'), { name: 'AbortError' }));
    timeout = setTimeout(() => finish(reject)(new Error('页面读取尚未完成。可以确认系统授权后重试，或把链接贴给我。')), ['conversation','attachment-preview'].includes(purpose) ? 15000 : 90000);
    captureRequests.set(requestId, { resolve: finish(resolve), reject: finish(reject), timeout, purpose, expected: { ...target } });
    settings.signal?.addEventListener('abort', abort, { once: true });
    if (settings.signal?.aborted) { abort(); return; }
    const identity = purpose === 'attachment-preview' ? {
      attachmentId: target.attachmentId, pageRevision: target.pageRevision, url: target.url,
      browserWindowId: target.browserWindowId || '', browserTabId: target.browserTabId || '',
    } : {};
    bridge('captureContext', { requestId, purpose, ...identity });
  });
}

async function collectCurrentPage({ reportError = false } = {}) {
  if (client.busy || readingPage || readingAttachment() || client.openingPageSession || collectingPage || !client.context) return;
  const current = collectionForPage(client.context, client.state?.collections);
  if (!canSavePageSnapshot(current, companionSessions?.view.acceptedSource)) return current;
  setError(); collectingPage = true; collectingContext = { ...client.context }; client.busy = true; renderContext(); updateComposer();
  try {
    const context = companionSessions?.view.acceptedSource || (native() ? await captureContext('collect') : client.context);
    if (!context?.url) throw new Error('还没有读到页面地址，可以把链接贴给我。');
    const result = await api('messages', { text: '收藏这个页面', intent: 'collect-page', context, ...(client.conversationId ? {conversationId:client.conversationId} : {}) });
    if (result.state) applyState(result.state); else await refresh(true);
    const saved = collectionForPage(context, client.state?.collections);
    if (samePageContext(context, client.context) && saved) pageDecision = 'saved';
    return saved;
  } catch (error) { if (reportError) throw error; if (error.code === 'PAGE_CONFIRMATION_REQUIRED') notify(error.message); else setError(error.message); }
  finally { collectingPage = false; collectingContext = null; client.busy = false; renderContext(); updateComposer(); renderMessages(); }
}

async function sendMessage() {
  if (client.busy || readingPage || client.attachmentPreview?.view.status === 'reading' || client.openingPageSession || composing) return;
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message) return;
  const directLink = isDirectLinkCapture(message);
  const selectedCuration = parseScopedCurationCommand(message, Boolean(client.workspaceScope));
  const webSearch = !directLink && !selectedCuration && parseWebSearchRequest(message);
  if (!client.conversationId && client.pageSessions?.view.observedPage && !client.attachmentPreview && !directLink && !selectedCuration && !webSearch) {
    const started = await startObservedPage();
    if (!started) return;
    input.value = message;
  }
  const conversationId = client.conversationId;
  if (!conversationId) {
    const signature = JSON.stringify([message,client.workspaceScope]);
    if (client.pendingStart && client.pendingStart.signature !== signature) { setError('上一条发送状态尚未确认，请先重试原消息。输入已保留。',true); return; }
    if (!client.pendingStart) {
      const identity = `${Date.now()}-${Math.random().toString(36).slice(2,12)}`;
      client.pendingStart = { signature,requestId:`message-${identity}`,clientDraftId:`draft-${identity}` };
    }
  }
  client.sendingConversations?.add(conversationId);
  client.sendErrors?.delete(conversationId);
  client.persistDraft?.();
  setError(); client.busy = true; updateComposer(); renderMessages(); renderContext();
  try {
    const workspace = webSearch ? null : client.workspaceScope;
    let context = workspace || selectedCuration || webSearch ? null : client.context;
    const pageCommand = isPageCollectionCommand(message);
    // A page conversation sends its accepted snapshot even after the browser moves.
    if (!directLink && context && native() && !client.pageSessions?.view.acceptedSource) context = await captureContext(pageCommand ? 'collect' : 'conversation');
    const result = await api('messages', { text: message, ...(conversationId ? {conversationId} : { originSurface:client.isWorkspaceChat ? 'workspace' : 'companion', requestId:client.pendingStart.requestId,newConversation:{clientDraftId:client.pendingStart.clientDraftId} }), ...(!directLink && context ? { context } : {}), ...(workspace ? { intent: 'chat', collectionIds: workspace.collectionIds, ...(workspace.exhibitionId ? { exhibitionId: workspace.exhibitionId } : {}) } : !directLink && !pageCommand && /https?:\/\//i.test(message) ? { intent: 'chat' } : {}) });
    if (client.destroyed) { client.clearSentDraft?.(conversationId,message); return; }
    if (!conversationId && !client.conversationId && result.conversationId) { client.conversationId = result.conversationId; preserveEmptySelection = false; client.pendingStart = null; }
    if (result.state) applyState(result.state); else await refresh(true);
    if (client.conversationId === conversationId) {
      if (input.value.trim() === message) input.value = '';
      client.persistDraft?.();
      client.clearSentDraft?.(conversationId,message);
      if ([input, $('#send-button'), document.body].includes(document.activeElement)) focusComposer();
      $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
    } else if (client.clearSentDraft) client.clearSentDraft(conversationId, message);
  } catch (error) {
    client.sendErrors?.set(conversationId,error.message);
    if (client.conversationId === conversationId) { if (error.code === 'PAGE_CONFIRMATION_REQUIRED') notify(error.message); else setError(error.message, true); }
  }
  finally { client.sendingConversations?.delete(conversationId); client.busy = client.sendingConversations ? client.sendingConversations.has(client.conversationId) : false; updateComposer(); renderMessages(); renderContext(); }
}

function openProfile() {
  const dialog = $('#profile-dialog');
  if (dialog.open && !profileExit) return;
  profileExit?.cancel(); profileExit = null;
  delete dialog.dataset.closing;
  profileSession += 1;
  if (!dialog.open) profileTrigger = document.activeElement;
  const profile = client.state?.profile || {};
  $('#profile-name').value = profile.name || 'Tag';
  $('#profile-preferences').value = Array.isArray(profile.preferences) ? profile.preferences.join('\n') : profile.preferences || '';
  const personality = profile.personality || '安静敏锐';
  $$('input[name="personality"]').forEach(input => { input.checked = input.value === personality; });
  $('#profile-error').hidden = true;
  $('#profile-name').removeAttribute('aria-invalid');
  if (!dialog.open) dialog.showModal();
  $('#profile-name').focus({ preventScroll: true });
}

function closeProfile() {
  if (destroyed) return;
  const dialog = $('#profile-dialog');
  if (!dialog.open || profileExit) return;
  const finish = () => {
    dialog.close();
    delete dialog.dataset.closing;
    if (profileTrigger?.isConnected && profileTrigger.getClientRects().length) profileTrigger.focus({ preventScroll: true });
    profileTrigger = null;
  };
  profileExit?.cancel();
  if (reducedMotion() || typeof dialog.animate !== 'function') { finish(); profileExit = null; return; }
  dialog.dataset.closing = 'true';
  const animation = dialog.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(5px) scale(.985)' }], { duration: 140, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  profileExit = animation;
  animation.finished.then(() => { if (profileExit !== animation) return; finish(); animation.cancel(); profileExit = null; }).catch(() => {});
}

function openExhibition(id) {
  if (embedded) { options.onOpenExhibition?.(id); return; }
  if (isChat && native()) { bridge('openStage', { exhibitionId: id }); return; }
  if (isWorkspaceChat) { location.href = `/prototype/immersive-exhibition/light.html?exhibition=${encodeURIComponent(id)}`; return; }
  if (isChat) { location.href = `/prototype/immersive-exhibition/light.html?exhibition=${encodeURIComponent(id)}#gallery`; return; }
  client.selected = id; client.readerSignature = ''; renderRoom(); window.scrollTo({ top: 0, behavior: 'auto' });
}

async function curate(button) {
  if (!client.state) return notify('先等本机服务连接好。');
  return withPendingButton(button, '正在开始整理…', async () => {
    try { const result = await api('curate', client.conversationId ? {conversationId:client.conversationId} : {}); if (result.state) applyState(result.state); notify(result.message?.text || result.message || '我会在后台看看这些收藏。'); }
    catch (error) { notify(error.message); }
  });
}

async function retry(id, button) {
  return withPendingButton(button, '正在重试…', async () => {
    try { const result = await api('retry', { collectionId: id, ...(client.conversationId ? {conversationId:client.conversationId} : {}) }); if (result.state) applyState(result.state); notify('收到了，我再看看这件收藏。'); }
    catch (error) { notify(error.message); }
  });
}

async function retryJob(id, button) {
  return withPendingButton(button, '正在继续…', async () => {
    try {
      const result = await api('jobs/retry', { jobId: id });
      if (result.state) applyState(result.state);
      notify(result.job?.status === 'complete' ? '这项整理已经完成了。' : '我会接着已完成的步骤继续。');
    } catch (error) { notify(error.message); }
  });
}

function openCollection(id) {
  if (embedded) { options.onOpenCollection?.(id); return; }
  if (native()) { bridge('openStage', { collectionId: id }); return; }
  location.href = `/prototype/immersive-exhibition/light.html?collection=${encodeURIComponent(id)}`;
}

async function saveNote(button) {
  const exhibition = getExhibition(); if (!exhibition) return;
  const note = $('#exhibition-note').value;
  return withPendingButton(button, '正在保存…', async () => {
    $('#note-status').textContent = '正在留下…';
    try { const result = await api('notes', { exhibitionId: exhibition.id, text: note }); if (result.state) { client.readerSignature = ''; applyState(result.state); } $('#note-status').textContent = '已保存在本机'; }
    catch (error) { $('#note-status').textContent = error.message; }
  });
}

function matchesFallbackWindow(expected) {
  const current = companionSessions?.view.observedPage;
  return Boolean(expected?.attachmentId && current?.attachmentId === expected.attachmentId
    && current.title === expected.title && current.url === expected.url
    && current.pageRevision === expected.pageRevision && samePageContext(expected, current));
}

function clearFallbackPreview() {
  fallbackPreview = null;
  $('#companion-link-save').hidden = true;
  $('#companion-link-status').hidden = true;
}

function canSaveFallbackPreview(preview) {
  return Boolean(preview && !preview.saved && !preview.saving && client.visible && matchesFallbackWindow(preview.expected)
    && preview.input === attachedLinkForm.elements.source.value.trim());
}

async function saveFallbackPreview(preview) {
  if (destroyed || !canSaveFallbackPreview(preview)) throw new Error('页面或链接已变化，请重新预览正文。');
  const button = $('#companion-link-save');
  const status = $('#companion-link-status');
  preview.saving = true;
  button.disabled = true;
  button.textContent = '正在保存…';
  try {
    const result = await api('messages', {
      text: '收藏这个页面', intent: 'collect-page', context: { url: preview.context.url },
      previewId: preview.id, requestId: `save-${preview.id}`,
      ...(preview.conversationId ? { conversationId: preview.conversationId } : {}),
    });
    const saved = list(result.state?.collections).find(item => result.message?.collectionIds?.includes(item.id));
    if (!['complete', 'partial'].includes(saved?.sourceSaveStatus)) throw new Error('正文暂未保存，请稍后重试。');
    preview.saved = true;
    if (result.state) applyState(result.state);
    const label = pageSaveLabel(saved);
    if (!destroyed && fallbackPreview === preview) {
      button.hidden = true;
      status.textContent = label;
      status.hidden = false;
    }
    return label;
  } catch (error) {
    if (!destroyed && fallbackPreview === preview && error.code === 'PAGE_PREVIEW_EXPIRED') {
      clearFallbackPreview();
      status.textContent = error.message;
      status.hidden = false;
    }
    throw error;
  } finally {
    preview.saving = false;
    if (!destroyed) { button.disabled = false; button.textContent = '收藏正文'; }
  }
}

const attachedLinkForm = $('#companion-link-form');
if (attachedLinkForm) {
  listen(attachedLinkForm, 'input', clearFallbackPreview);
  listen($('#companion-link-save'), 'click', () => {
    const preview = fallbackPreview;
    void saveFallbackPreview(preview).catch(error => {
      if (destroyed || !preview || fallbackPreview !== preview) return;
      const status = $('#companion-link-status');
      status.textContent = error.message;
      status.hidden = false;
    });
  });
}
if (attachedLinkForm) listen(attachedLinkForm, 'submit', event => {
  event.preventDefault();
  const expected = companionSessions?.view.observedPage;
  const input = String(new FormData(attachedLinkForm).get('source') || '').trim();
  const url = /^https?:\/\/\S+$/i.test(input) ? safeURL(input) : '';
  const status = $('#companion-link-status');
  const button = attachedLinkForm.querySelector('button');
  if (!expected?.attachmentId || button.disabled) return;
  if (!url && (input.length < 20 || /^https?:\/\/\S+$/i.test(input))) {
    status.textContent = '请粘贴有效的文章链接，或至少 20 个字的正文。';
    status.hidden = false;
    return;
  }
  if (fallbackPreview?.input === input && matchesFallbackWindow(fallbackPreview.expected)) {
    pageTextReader.show(fallbackPreview.context);
    return;
  }
  const stillAttached = () => matchesFallbackWindow(expected) && input === attachedLinkForm.elements.source.value.trim();
  clearFallbackPreview();
  void withPendingButton(button, '正在读取…', async () => {
    try {
      const requestId = `read-link-${crypto.randomUUID()}`;
      const context = url ? { url } : { title: expected.title || '粘贴的正文', text: input };
      const result = await api('page-read', { context, requestId, ...(url ? { retainPublicPreview: true } : {}) });
      if (destroyed || !client.visible || !stillAttached()) return;
      const source = result.context;
      if (result.requestId !== requestId || (source?.url || '') !== url || !result.readable || !source.text) {
        throw new Error(url ? '这个链接暂未读到正文，可以复制文章正文后再粘贴。' : '没能从粘贴内容取得正文。');
      }
      const readerContext = { ...source, title: source.documentTitle || source.title };
      if (url && result.previewId) {
        fallbackPreview = { id: result.previewId, context: readerContext, expected, input, conversationId: client.conversationId };
        $('#companion-link-save').hidden = false;
      }
      pageTextReader.show(readerContext);
      status.textContent = `已从${url ? '链接' : '粘贴内容'}读到 ${source.contentQuality?.characterCount || Array.from(source.text).length} 字。`;
      status.hidden = false;
    } catch (error) {
      if (!destroyed && stillAttached()) { status.textContent = error.message; status.hidden = false; }
    }
  });
});

async function readCurrentPage() {
  if (client.busy || readingPage || destroyed) return;
  const capture = new AbortController();
  pageReadCapture = capture;
  readingPage = true; setError(); updateComposer(); renderContext();
  try {
    const expected = client.context;
    if (currentPageRead && samePageReadTarget(expected, currentPageRead)) {
      pageTextReader.show(currentPageRead); return;
    }
    const context = native()
      ? await captureContext(expected?.contextStatus === 'needs_permission' ? 'connect' : 'conversation', { signal: capture.signal })
      : expected;
    if (destroyed || capture.signal.aborted || !client.visible) return;
    await pageReadController.read(context);
  } catch (error) {
    if (!destroyed && !capture.signal.aborted) setError(error.message);
  } finally {
    if (pageReadCapture === capture) pageReadCapture = null;
    readingPage = false; updateComposer(); renderContext();
  }
}

listen(embedded ? root : document, 'click', event => {
  if (embedded) event.stopPropagation();
  if (isCompanionChat) {
    if (sourceMenu.open && !sourceMenu.contains(event.target)) sourceMenu.open = false;
    if (companionMenuOpen && !event.target.closest('#companion-session-heading')) closeCompanionPopovers();
  }
  const anchor = event.target.closest('a[data-external]');
  if (anchor) { const url = safeURL(anchor.href); if (url && bridge('openExternal', { url })) event.preventDefault(); else { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } return; }
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.view) { client.selected = null; client.view = button.dataset.view; client.roomSignature = ''; renderRoom(); return; }
  if (button.dataset.exhibition) { openExhibition(button.dataset.exhibition); return; }
  if (button.dataset.privateExhibition) { openExhibition(button.dataset.privateExhibition, true); return; }
  if (button.dataset.retry) { retry(button.dataset.retry, button); return; }
  if (button.dataset.retryJob) { retryJob(button.dataset.retryJob, button); return; }
  if (button.dataset.openCollection) { openCollection(button.dataset.openCollection); return; }
  if (button.dataset.openConversation) {
    const opening = companionSessions ? companionSessions.select(button.dataset.openConversation) : selectConversation(button.dataset.openConversation);
    void opening.then(() => { const row = [...$('#chat-messages').children].find(element => element.dataset.messageId === button.dataset.sourceMessage); row?.scrollIntoView?.({block:'center',behavior:'auto'}); }).catch(error => notify(error.message));
    return;
  }
  if (button.dataset.companionConversation && companionSessions) { companionMenuOpen = false; void companionSessions.select(button.dataset.companionConversation).catch(error => notify(error.message)); return; }
  switch (button.dataset.action) {
    case 'copy-message': void copyMessage(button); break;
    case 'chat': openChat(); break;
    case 'profile': openProfile(); break;
    case 'close-profile': closeProfile(); break;
    case 'close-chat': closeCompanionPopovers(); cancelPageRead(); attachmentPreview?.cancelRead(); persistConversationDraft(); void queueSurfaceDraft(); void companionSessions?.setVisible(false); if (embedded) options.onClose?.(); else if (isWorkspaceChat) location.href = '/prototype/immersive-exhibition/light.html'; else if (!bridge('closeChat')) $('#chat-panel').hidden = true; break;
    case 'detach': closeCompanionPopovers(); cancelPageRead(); if (client.workspaceScope) client.workspaceScope = null; else { attachmentPreview?.observe(null); client.context = null; currentPageRead = null; void companionSessions?.newDraft(); bridge('detach'); } persistConversationDraft(); renderContext(); setError(); break;
    case 'companion-history': companionMenuOpen = !companionMenuOpen; renderCompanionSessionUI(); break;
    case 'companion-new': companionMenuOpen = false; void companionSessions?.newDraft().then(focusComposer); break;
    case 'companion-read': void startObservedPage(); break;
    case 'companion-preview': {
      if (client.busy || composing || readingPage || client.openingPageSession) break;
      companionMenuOpen = false;
      void attachmentPreview?.read().then(result => {
        if (client.visible && samePageReadTarget(client.context, result)) focusComposer();
      });
      break;
    }
    case 'companion-preview-decline': attachmentPreview?.decline(); break;
    case 'enable-window-recognition': bridge('enableWindowRecognition'); break;
    case 'companion-reread': closeCompanionPopovers(); void startObservedPage({reread:true}); break;
    case 'companion-keep': companionSessions?.keep(); void queueSurfaceDraft(); focusComposer(); break;
    case 'companion-follow': void companionSessions?.follow(); break;
    case 'open-conversation': void continueInWorkspace().catch(error => notify(error.message)); break;
    case 'choose-references':
      openConversationReferences(client.state,client.workspaceScope,ids => { if (destroyed) return; client.workspaceScope = ids.length ? validatedConversationScope({collectionIds:ids}) : null; persistConversationDraft(); renderContext(); focusComposer(); }, embedded ? root : document.body);
      break;
    case 'collect-page': collectCurrentPage(); break;
    case 'read-page': withPendingButton(button, '正在读取…', readCurrentPage).finally(() => renderContext()); break;
    case 'decline-page': pageDecision = 'declined'; renderContext(); notify('好，暂不收藏。页面关联会保留。'); focusComposer(); break;
    case 'close-reader': client.selected = null; client.roomSignature = ''; renderRoom(); window.scrollTo({ top: 0, behavior: 'auto' }); break;
    case 'curate': curate(button); break;
    case 'save-note': saveNote(button); break;
    case 'refresh': withPendingButton(button, '正在连接…', () => refresh(true)); break;
    case 'retry-message': sendMessage(); break;
  }
});

if (isCompanionChat) listen(root, 'keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || $('dialog[open]')) return;
  const trigger = sourceMenu.open ? $('summary', sourceMenu) : companionMenuOpen ? $('#companion-session-title') : null;
  if (!trigger) return;
  event.preventDefault();
  closeCompanionPopovers();
  trigger.focus();
});

listen($('#chat-form'),'submit', event => { event.preventDefault(); if (embedded) event.stopPropagation(); sendMessage(); });
listen($('#chat-input'),'input', () => { updateComposer(); persistConversationDraft(); });
listen($('#chat-messages'),'scroll', persistConversationDraft, {passive:true});
listen($('#chat-input'),'compositionstart', () => { composing = true; updateComposer(); });
listen($('#chat-input'),'compositionend', () => { composing = false; compositionEndedAt = performance.now(); updateComposer(); });
listen($('#chat-input'),'keydown', event => {
  // WebKit may finish composition before reporting the Enter that confirmed it.
  if (event.isComposing || composing || event.keyCode === 229) return;
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  if (event.repeat || performance.now() - compositionEndedAt < 80) return;
  sendMessage();
});
listen($('#profile-form'),'submit', async event => {
  event.preventDefault();
  if (embedded) event.stopPropagation();
  if (profileSaving) return;
  if (!$('#profile-name').value.trim()) {
    $('#profile-error').textContent = '请先给策展人一个称呼。';
    $('#profile-error').hidden = false;
    $('#profile-name').setAttribute('aria-invalid', 'true');
    $('#profile-name').focus();
    return;
  }
  const button = $('#profile-save');
  const session = profileSession;
  const draft = { name: $('#profile-name').value.trim(), personality: $('input[name="personality"]:checked')?.value || '安静敏锐', preferences: $('#profile-preferences').value.trim() };
  profileSaving = true;
  $('#profile-form').setAttribute('aria-busy', 'true');
  $$('#profile-form input,#profile-form textarea').forEach(input => { input.disabled = true; });
  await withPendingButton(button, '正在保存设定…', async () => {
    $('#profile-error').hidden = true;
    try {
      const result = await api('profile', draft);
      if (result.state) applyState(result.state); else await refresh(true);
      if (session === profileSession) closeProfile();
      notify('设定已保存。');
    } catch (error) {
      if (destroyed) return;
      if (session === profileSession && $('#profile-dialog').open) {
        $('#profile-error').textContent = error.message;
        $('#profile-error').hidden = false;
        $('#profile-error').scrollIntoView({ block: 'nearest', behavior: 'auto' });
      } else notify(error.message);
    }
  });
  if (destroyed) return;
  profileSaving = false;
  $('#profile-form').removeAttribute('aria-busy');
  $$('#profile-form input,#profile-form textarea').forEach(input => { input.disabled = false; });
});
listen($('#profile-name'),'input', () => { $('#profile-name').removeAttribute('aria-invalid'); $('#profile-error').hidden = true; });
if (!embedded) {
  listen(document, 'visibilitychange', () => { if (!document.hidden) refresh(true); schedulePoll(); });
  listen(window, 'focus', () => { refresh(true); schedulePoll(); });
}
listen($('#profile-dialog'),'cancel', event => { event.preventDefault(); closeProfile(); });
const outsideProfile = event => {
  const dialog = $('#profile-dialog');
  const rect = dialog.getBoundingClientRect();
  return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
};
listen($('#profile-dialog'),'pointerdown', event => { profileBackdropPointer = outsideProfile(event); });
listen($('#profile-dialog'),'click', event => { if (profileBackdropPointer && outsideProfile(event)) closeProfile(); profileBackdropPointer = false; });
if (!embedded) window.formeNative = { ...(window.formeNative || {}), receiveContext, focusComposer, setVisible, handoffFailed: () => notify('主窗口暂时没打开，这段对话和草稿仍保留在这里。'), refresh: () => refresh(true), openExhibition: id => openExhibition(id, true), receiveWorkspaceChat: async request => {
  const result = await receiveWorkspaceChat(request);
  bridge('workspaceChatResult', result);
  return result;
} };
if (!embedded) listen(window, 'message', async event => {
  if (!isChat || event.origin !== location.origin || !event.source || event.data?.type !== 'forme:workspace-chat-launch') return;
  const result = await receiveWorkspaceChat(event.data.request);
  event.source.postMessage({ type: 'forme:workspace-chat-result', ...result }, event.origin);
});
if (isWorkspaceChat && !embedded) {
  conversationSidebar = mountConversationSidebar({ getState:() => client.state, getActiveId:() => client.conversationId, onSelect:selectConversation, onNew:newConversation });
  listen(document,'keydown',event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.isComposing && !document.querySelector('dialog[open]')) { event.preventDefault(); void newConversation(); }
  });
  listen(window,'popstate',() => { const id = new URLSearchParams(location.search).get('conversation'); if (id) void selectConversation(id); });
}
listen(window,'beforeunload',() => { cancelPageRead(); pageReadController.destroy(); companionAvatar?.destroy(); pageTextReader.destroy(); persistConversationDraft(); conversationDrafts.flush(); });
updateComposer();
if (isChat && !embedded) {
  await refresh(true);
  if (companionSessions) await companionSessions.restore(client.state);
  focusComposer();
  bridge('chatReady');
  schedulePoll();
} else if (!embedded) {
  // The companion chat is a shortcut into the original four-stage product.
  // Keep the full page and dialog structure as the main exhibition surface.
  document.body.hidden = true;
  const destination = new URL('/prototype/immersive-exhibition/light.html', location.origin);
  const requestedExhibition = new URLSearchParams(location.search).get('exhibition');
  if (requestedExhibition) destination.searchParams.set('exhibition', requestedExhibition);
  location.replace(destination);
}

function setVisible(visible) {
  if (destroyed) return;
  const show = Boolean(visible), wasVisible = client.visible;
  if (!show) {
    clearCopyFeedback();
    closeCompanionPopovers();
    cancelPageRead();
    attachmentPreview?.cancelRead();
    selectionVersion++;
    persistConversationDraft(); conversationDrafts.flush();
    profileExit?.cancel(); profileExit = null;
    for (const dialog of $$('dialog[open]')) dialog.close();
    for (const dialog of $$('.chat-reference-dialog')) dialog.remove();
    delete $('#profile-dialog').dataset.closing;
  }
  client.visible = show;
  if (companionSessions) void companionSessions.setVisible(show);
  if (embedded) root.hidden = !show;
  if (show) {
    if (!wasVisible) { const saved = conversationDrafts.get(client.loadedConversationId); if (saved?.scrolled) client.restoreScroll = saved.scrollTop; }
    updateComposer(); renderMessages(); focusComposer();
  }
}
return {
  update: state => applyState(state, true),
  select: id => selectConversation(id),
  create: () => newConversation(),
  setVisible,
  destroy() { if (destroyed) return; setVisible(false); destroyed = true; client.destroyed = true; clearTimeout(client.poll); clearTimeout(toastTimer); clearTimeout(surfaceSaveTimer); companionSessions?.destroy(); attachmentPreview?.destroy(); lifecycle.abort(); pageReadController.destroy(); companionAvatar?.destroy(); pageTextReader.destroy(); conversationDrafts.flush(); },
};
}

// This module is also imported by the persistent workspace host. Only the
// standalone curator document owns startup, native callbacks and polling.
if (typeof document !== 'undefined' && document.querySelector('#stage.stage-shell') && document.querySelector('#chat-panel')) {
  if (new URLSearchParams(location.search).get('surface') === 'workspace-chat') {
    const destination = new URL('/prototype/immersive-exhibition/light.html', location.origin);
    const id = new URLSearchParams(location.search).get('conversation');
    if (id) destination.searchParams.set('conversation',id);
    destination.hash = 'chat';
    location.replace(destination);
  } else await mountChatController();
}
