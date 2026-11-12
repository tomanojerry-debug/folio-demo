import { frameGlassDialog, closeGlassDialog } from './glass-dialogs.js';
import { icon } from '../prototype/immersive-exhibition/light-workspace.js';
import { articleReadingModes } from './article-reading.js';
import { TOPIC_EDITORIAL_MODES, TOPIC_PRESET_MODES } from './curation-mode-definitions.js';

const descriptions = { overview:'先读文章要点和依据', original:'直接阅读保存的原文', plain:'用更容易理解的语言阅读' };
const exhibitModes = { ...TOPIC_EDITORIAL_MODES, ...TOPIC_PRESET_MODES };
const initial = { version:1, defaultMode:'overview', curationMode:'overview', fontSize:17, readingWidth:'comfortable' };
const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const friendly = error => typeof error?.message === 'string' && /[\u3400-\u9fff]/u.test(error.message) ? error.message : '阅读设置暂时没有保存成功，请重试。';
function normalize(value) {
  if (!value || !Number.isSafeInteger(value.version) || value.version < 1 || !Object.hasOwn(articleReadingModes, value.defaultMode) || !Object.hasOwn(exhibitModes, value.curationMode) || !Number.isInteger(value.fontSize) || value.fontSize < 14 || value.fontSize > 24 || !['comfortable', 'wide'].includes(value.readingWidth)) throw new Error('阅读设置没有完整读取，请重新加载。');
  return { version:value.version, ...values(value) };
}
const values = preferences => ({ defaultMode:preferences.defaultMode, curationMode:preferences.curationMode, fontSize:preferences.fontSize, readingWidth:preferences.readingWidth });
const normalizeStored = value => normalize({
  ...value,
  defaultMode:value?.defaultMode === 'custom' ? initial.defaultMode : value?.defaultMode,
  curationMode:Object.hasOwn(exhibitModes, value?.curationMode) ? value.curationMode : initial.curationMode,
});

/** Preferences use the existing versioned local service. Unsaved drafts stay in this mount's memory. */
export function createReadingSettingsController({ api, onChange = () => {} }) {
  let revision = 0, opened = false;
  let state = { status:'idle', saved:null, draft:{ ...initial }, error:'', notice:'', dirty:false, conflict:false };
  const publish = patch => { state = { ...state, ...patch }; onChange(structuredClone(state)); };
  const dirty = draft => !state.saved || JSON.stringify(values(draft)) !== JSON.stringify(values(state.saved));
  async function load(replaceDraft = false) {
    const current = ++revision;
    publish({ status:'loading', error:'', notice:'' });
    try {
      const response = await api('reading/preferences', {});
      if (current !== revision || !opened) return;
      const saved = normalizeStored(response?.preferences || response);
      const restore = !replaceDraft && state.saved && state.dirty;
      if (restore) {
        const conflict = state.draft.version !== saved.version;
        publish({ status:'ready', saved, conflict, notice:conflict ? '已保存的设置在另一处更新。你的草稿仍保留，可以载入最新设置后再修改。' : '未保存的设置草稿已恢复。', dirty:true });
      } else publish({ status:'ready', saved, draft:{ ...saved }, error:'', conflict:false, dirty:false, notice:'' });
    } catch (error) { if (current === revision && opened) publish({ status:state.saved ? 'ready' : 'error', error:friendly(error), conflict:state.conflict }); }
  }
  return {
    getState:() => structuredClone(state),
    open() { opened = true; return load(false); },
    reload() { return load(true); },
    setDraft(field, value) {
      if (!opened || ['loading', 'saving'].includes(state.status) || !['defaultMode', 'curationMode', 'fontSize', 'readingWidth'].includes(field)) return;
      const draft = { ...state.draft, [field]:field === 'fontSize' ? Number(value) : String(value) };
      publish({ draft, dirty:dirty(draft), error:'', notice:'' });
    },
    async save() {
      if (!opened || state.status !== 'ready' || !state.saved) return false;
      const current = ++revision;
      const draft = structuredClone(state.draft);
      try { normalize(draft); }
      catch (error) { publish({ error:friendly(error) }); return false; }
      publish({ status:'saving', error:'', notice:'' });
      try {
        const { curationMode, ...articlePreferences } = values(draft);
        const response = await api('reading/preferences', {
          ...articlePreferences, ...(curationMode !== state.saved.curationMode ? { curationMode } : {}), expectedVersion:draft.version,
        });
        if (current !== revision || !opened) return false;
        const saved = normalizeStored(response?.preferences || response);
        publish({ status:'ready', saved, draft:{ ...saved }, dirty:false, conflict:false, error:'', notice:'阅读设置已保存。' });
        return true;
      } catch (error) {
        if (current === revision && opened) publish({ status:'ready', dirty:true, error:friendly(error), conflict:error?.code === 'READING_PREFERENCES_CHANGED' || /已更新|另一处|版本|重新打开/u.test(error?.message || '') });
        return false;
      }
    },
    close() { opened = false; revision++; state = { ...state, status:'idle' }; },
    destroy() { this.close(); state = { status:'idle', saved:null, draft:{ ...initial }, error:'', notice:'', dirty:false, conflict:false }; },
  };
}

function renderExhibitPreference(mode, publicDemo) {
  const options = modes => Object.entries(modes).map(([id, { label }]) => `<option value="${id}" ${id === mode ? 'selected' : ''}>${escape(label)}</option>`).join('');
  const help = publicDemo ? '选择打开示例展览时默认使用的读法。展览会直接显示已准备好的读稿。' : '选择打开个人展览时默认使用的读法。已有读稿会直接打开。有可用原文和已配置的模型时，预设会自动生成尚未保存的读稿，生成时会把本展的原文片段发送给模型。';
  return `<section class="forme-reading-settings-section">
    <h3>展览读法</h3><p id="forme-reading-settings-exhibit-help">${help}</p>
    <label for="forme-reading-settings-exhibit-mode">默认读法</label>
    <div class="forme-reading-settings-select">
      <select class="input" id="forme-reading-settings-exhibit-mode" data-reading-settings-field="curationMode" aria-describedby="forme-reading-settings-exhibit-help">
        <optgroup label="展览读法">${options(TOPIC_EDITORIAL_MODES)}</optgroup>
        <optgroup label="更多读法">${options(TOPIC_PRESET_MODES)}</optgroup>
      </select>
    </div>
  </section>`;
}

export function renderReadingSettings(state, { publicDemo = false } = {}) {
  if (state.status === 'loading') return '<p class="forme-reading-settings-status" role="status">正在读取阅读设置…</p>';
  if (state.status === 'error') return `<p class="forme-reading-settings-error" role="alert">${escape(state.error)}</p><button type="button" class="btn ws-button" data-variant="outline" data-size="sm" data-reading-settings-action="reload">重新加载</button>`;
  if (!state.saved) return '';
  const draft = state.draft, saving = state.status === 'saving';
  return `<form data-reading-settings-form><fieldset ${saving ? 'disabled' : ''}>
    <section class="forme-reading-settings-section"><h3>收藏读法</h3><p>选择打开收藏时默认显示的阅读方式。</p><div class="forme-reading-settings-modes" role="radiogroup" aria-label="默认阅读方式">${Object.entries(articleReadingModes).map(([mode, label]) => `<label class="forme-reading-settings-mode"><input type="radio" name="defaultMode" value="${mode}" data-reading-settings-field="defaultMode" ${draft.defaultMode === mode ? 'checked' : ''}><span><b>${label}</b><small>${descriptions[mode]}</small></span></label>`).join('')}</div></section>
    ${renderExhibitPreference(draft.curationMode, publicDemo)}
    <section class="forme-reading-settings-section">
      <h3>阅读显示</h3>
      <div class="forme-reading-settings-display">
        <div>
          <label for="forme-reading-settings-size">字号</label>
          <div class="forme-reading-settings-select">
            <select class="input" id="forme-reading-settings-size" data-reading-settings-field="fontSize">
              ${Array.from({ length:11 }, (_, index) => index + 14).map(size => `<option value="${size}" ${size === draft.fontSize ? 'selected' : ''}>${size}</option>`).join('')}
            </select>
          </div>
        </div>
        <div>
          <label for="forme-reading-settings-width">行宽</label>
          <div class="forme-reading-settings-select">
            <select class="input" id="forme-reading-settings-width" data-reading-settings-field="readingWidth">
              <option value="comfortable" ${draft.readingWidth === 'comfortable' ? 'selected' : ''}>舒适</option>
              <option value="wide" ${draft.readingWidth === 'wide' ? 'selected' : ''}>宽一些</option>
            </select>
          </div>
        </div>
      </div>
      <div class="forme-reading-settings-sample" style="--settings-font-size:${Number.isInteger(draft.fontSize) && draft.fontSize >= 14 && draft.fontSize <= 24 ? draft.fontSize : 17}px;--settings-reading-width:${draft.readingWidth === 'wide' ? '100%' : '26em'}"><p>偏好保存在${publicDemo ? '当前浏览器' : '这台电脑'}，可随时修改。</p></div>
    </section></fieldset>${state.error ? `<p class="forme-reading-settings-error" role="alert">${escape(state.error)}</p>` : ''}${state.notice ? `<p class="forme-reading-settings-status" role="status">${escape(state.notice)}</p>` : ''}${state.conflict ? '<p class="forme-reading-settings-hint">载入最新设置会替换当前草稿。</p>' : ''}<footer class="forme-reading-settings-actions"><button type="button" class="btn ws-button" data-variant="ghost" data-size="sm" data-reading-settings-action="reload" ${saving ? 'disabled' : ''}>${state.conflict ? '载入最新设置' : '重新加载'}</button><div><button type="button" class="btn ws-button" data-variant="ghost" data-size="sm" data-reading-settings-action="close">关闭</button><button type="submit" class="btn ws-button" data-variant="primary" data-size="sm" ${saving || !state.dirty ? 'disabled' : ''}>${saving ? '正在保存…' : '保存设置'}</button></div></footer></form>`;
}

/** One global Settings surface, launched from the existing workspace navigation. */
export function mountReadingSettings({ api, document:doc = globalThis.document, publicDemo = false } = {}) {
  let dialog = null, body = null, trigger = null, destroyed = false;
  function paint(state) {
    if (!body || !dialog?.isConnected) return;
    const active = doc.activeElement;
    const focused = body.contains(active) ? { field:active.dataset?.readingSettingsField, value:active.value, start:active.selectionStart, end:active.selectionEnd } : null;
    body.innerHTML = renderReadingSettings(state, { publicDemo });
    if (focused?.field && !['loading', 'saving'].includes(state.status)) {
      const target = [...body.querySelectorAll('[data-reading-settings-field]')].find(element => element.dataset.readingSettingsField === focused.field && (element.type !== 'radio' || element.value === focused.value));
      target?.focus({ preventScroll:true });
      if (target?.type !== 'radio' && typeof focused.start === 'number' && typeof target.setSelectionRange === 'function') target.setSelectionRange(focused.start, focused.end);
    }
  }
  const controller = createReadingSettingsController({ api, onChange:paint });
  async function close() {
    const current = dialog;
    if (!current) return;
    controller.close(); dialog = null; body = null;
    await closeGlassDialog(current);
    current.remove();
    if (!dialog && trigger?.isConnected) trigger.focus({ preventScroll:true });
  }
  function input(event) {
    const field = event.target.dataset?.readingSettingsField;
    if (field && (event.target.type !== 'radio' || event.target.checked)) controller.setDraft(field, event.target.value);
  }
  async function open(source) {
    if (destroyed || !doc) return;
    trigger = source || doc.activeElement;
    if (!dialog?.isConnected) {
      dialog = doc.createElement('dialog');
      dialog.className = 'forme-live-dialog forme-reading-settings-dialog';
      dialog.innerHTML = `<header class="forme-live-head"><div><small>设置</small><h2>阅读习惯</h2></div><button type="button" class="btn ws-icon-button" data-variant="ghost" data-size="icon-sm" data-reading-settings-action="close" aria-label="关闭阅读设置">${icon('close')}</button></header><div class="forme-reading-settings-body"></div>`;
      doc.body.append(dialog);
      frameGlassDialog(dialog);
      body = dialog.querySelector('.forme-reading-settings-body');
      dialog.addEventListener('input', input);
      dialog.addEventListener('change', input);
      dialog.addEventListener('submit', event => { if (event.target.matches('[data-reading-settings-form]')) { event.preventDefault(); void controller.save(); } });
      dialog.addEventListener('click', event => {
        const action = event.target.closest?.('[data-reading-settings-action]')?.dataset.readingSettingsAction;
        if (!action) return;
        event.preventDefault(); event.stopPropagation();
        if (action === 'close') void close();
        else if (action === 'reload') void controller.reload();
      });
      dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
      dialog.addEventListener('close', event => { if (dialog === event.currentTarget) { controller.close(); dialog = null; body = null; } event.currentTarget.remove(); });
    }
    if (!dialog.open) dialog.showModal();
    await controller.open();
  }
  function launch(event) {
    const source = event.target.closest?.('[data-workspace-settings]');
    if (!source) return;
    event.preventDefault(); event.stopPropagation(); void open(source);
  }
  doc?.addEventListener('click', launch);
  return { open, close, controller, destroy() { destroyed = true; doc?.removeEventListener('click', launch); controller.destroy(); dialog?.remove(); dialog = null; body = null; } };
}
