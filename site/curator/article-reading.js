import { renderArticleOriginal } from './article-original.js';

const list = value => Array.isArray(value) ? value : [];
const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
export const articleReadingModes = Object.freeze({ overview:'解读', original:'阅读原文', plain:'通俗' });
const modes = articleReadingModes;
const defaults = { version:0, defaultMode:'overview', fontSize:16, readingWidth:'comfortable' };
const working = job => ['queued', 'running', 'retrying', 'pending'].includes(job?.status);
const message = error => typeof error?.message === 'string' && /[\u3400-\u9fff]/u.test(error.message) ? error.message : '暂时没有完成，请重试。';
const id = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 180) throw new Error('请先选择一条有效收藏。');
  return value.trim();
};
const requestId = () => globalThis.crypto?.randomUUID?.() || `reading-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const hasMode = mode => Object.hasOwn(modes, mode);
const preferences = value => ({ version:value?.version ?? defaults.version, defaultMode:hasMode(value?.defaultMode) ? value.defaultMode : defaults.defaultMode, fontSize:Number.isInteger(value?.fontSize) && value.fontSize >= 14 && value.fontSize <= 24 ? value.fontSize : defaults.fontSize, readingWidth:value?.readingWidth === 'wide' ? 'wide' : 'comfortable' });
const sourceIds = (article, values) => [...new Set(list(values).filter(value => list(article?.paragraphs).some(paragraph => paragraph.id === value)))];
const sourceResults = article => list(article?.results).filter(result => result && (!article.documentVersionId || result.documentVersionId === article.documentVersionId) && (!article.contentHash || result.contentHash === article.contentHash));

export function articleReadingResult(state, mode = state.mode) {
  return sourceResults(state.article).findLast(result => result.mode === mode) || null;
}

/** Navigation, generated jobs, and preferences have separate lifetimes; an old source never repaints a new one. */
export function createArticleReadingController({ api, onChange = () => {}, pollMs = 1200, maxPolls = 180, autoPoll = true }) {
  if (typeof api !== 'function') throw new TypeError('A reading API callback is required');
  let epoch = 0, operation = 0, preferenceOperation = 0, timer = null, pollCount = 0;
  const drafts = new Map();
  let state = { collectionId:'', status:'idle', article:null, preferences:{ ...defaults }, mode:'overview', sourceSelection:null, error:'', generationError:'', generationStatus:'idle', preferenceError:'', preferenceStatus:'idle', job:null, questionDraft:'', similarStatus:'idle', similarItems:[], similarAnchor:null, similarMode:'', similarError:'', curation:null, noteError:'', request:null, lastRequest:null };
  const publish = patch => { state = { ...state, ...patch }; onChange(structuredClone(state)); };
  const stop = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const draftKey = article => article ? `${article.collectionId}\u0000${article.documentVersionId || ''}` : '';
  function rememberDraft() {
    const key = draftKey(state.article);
    if (key) drafts.set(key, state.questionDraft);
    if (drafts.size > 50) drafts.delete(drafts.keys().next().value);
  }
  function checkArticle(result, collectionId, version) {
    const article = result?.article;
    if (!article || article.collectionId !== collectionId || !Array.isArray(article.paragraphs)) throw new Error('这条收藏的原文暂时不可用，请重试。');
    if (version && article.documentVersionId !== version) throw new Error('原文版本已经变化，请重新打开这条收藏。');
    const ids = new Set();
    for (const paragraph of article.paragraphs) {
      if (!paragraph || typeof paragraph.id !== 'string' || !paragraph.id || ids.has(paragraph.id) || typeof paragraph.text !== 'string') throw new Error('原文暂时没有完整读取，请重试。');
      ids.add(paragraph.id);
    }
    return article;
  }
  function applyJob(job) {
    const error = job?.status === 'failed' ? job.errorCode === 'READING_CANCELLED' ? '已取消这次生成。' : message({ message:job.error }) : '';
    publish({ job:job || null, generationError:error });
  }
  function schedulePolling(currentEpoch, currentOperation) {
    stop();
    if (!autoPoll || !working(state.job)) return;
    if (pollCount >= maxPolls) { publish({ generationError:'仍在处理中。可以稍后刷新查看，或取消这次生成。' }); return; }
    timer = setTimeout(() => { timer = null; void refreshArticle(currentEpoch, currentOperation, true); }, pollMs);
    timer.unref?.();
  }
  async function refreshArticle(currentEpoch = epoch, currentOperation = operation, polling = false) {
    const collectionId = state.collectionId;
    const version = state.article?.documentVersionId;
    if (!collectionId || currentEpoch !== epoch) return;
    if (polling) pollCount++;
    try {
      const understanding = state.job?.readingMode === 'understanding' || state.lastRequest?.mode === 'understanding';
      const result = await api('reading/article', { collectionId, ...(version ? { documentVersionId:version } : {}), ...(understanding ? { mode:'understanding' } : {}) });
      if (currentEpoch !== epoch || currentOperation !== operation) return;
      const article = checkArticle(result, collectionId, version);
      if (state.article?.contentHash && article.contentHash !== state.article.contentHash) throw new Error('原文内容已经变化，请重新打开这条收藏。');
      publish({ article, status:'ready', error:'' });
      applyJob(result.job || article.job || null);
      schedulePolling(currentEpoch, currentOperation);
    } catch (error) {
      if (currentEpoch !== epoch || currentOperation !== operation) return;
      publish(polling ? { generationError:message(error) } : { error:message(error) });
      // Transient polling failures retain the job and source; explicit retry is always available.
      if (polling) schedulePolling(currentEpoch, currentOperation);
    }
  }
  async function loadSimilar(currentEpoch = epoch) {
    const collectionId = state.collectionId;
    if (!collectionId) return;
    publish({ similarStatus:'loading', similarError:'' });
    try {
      const result = await api('knowledge/similar', { collectionId, limit:4 });
      if (currentEpoch !== epoch) return;
      if (result?.anchor?.collectionId && result.anchor.collectionId !== collectionId) throw new Error('相似收藏暂时没有读取成功，请重试。');
      if (result?.anchor?.documentVersionId && state.article?.documentVersionId && result.anchor.documentVersionId !== state.article.documentVersionId) throw new Error('这条收藏已经更新，请重新打开后查看相似内容。');
      publish({ similarStatus:'ready', similarItems:list(result?.items).filter(item => typeof item?.collectionId === 'string' && item.collectionId !== collectionId).slice(0, 4), similarAnchor:result?.anchor || null, similarMode:result?.mode || '', curation:result?.curation || null });
    } catch (error) { if (currentEpoch === epoch) publish({ similarStatus:'error', similarError:message(error), similarItems:[], curation:null }); }
  }
  async function open(collectionId, options = {}) {
    rememberDraft(); stop();
    const currentEpoch = ++epoch; ++operation; ++preferenceOperation; pollCount = 0;
    try {
      const key = id(collectionId);
      const version = options.documentVersionId ? id(options.documentVersionId) : '';
      publish({ collectionId:key, article:null, status:'loading', mode:hasMode(options.mode) ? options.mode : 'overview', sourceSelection:null, error:'', generationError:'', generationStatus:'idle', preferenceError:'', preferenceStatus:'idle', job:null, similarStatus:'idle', similarItems:[], similarAnchor:null, similarMode:'', similarError:'', curation:null, noteError:'', request:null, lastRequest:null, questionDraft:'' });
      const result = await api('reading/article', { collectionId:key, ...(version ? { documentVersionId:version } : {}) });
      if (currentEpoch !== epoch) return;
      const article = checkArticle(result, key, version);
      const prefs = preferences(result.preferences);
      publish({ article, status:'ready', preferences:prefs, mode:hasMode(options.mode) ? options.mode : prefs.defaultMode, questionDraft:drafts.get(draftKey(article)) || '' });
      const readingJob = result.job || article.job || null;
      const understandingJob = result.understandingJob;
      applyJob(working(readingJob) ? readingJob : working(understandingJob) || state.mode === 'overview' ? understandingJob || null : readingJob);
      schedulePolling(currentEpoch, operation);
      // Recommendations are a read-only request, independent from model generation.
      void loadSimilar(currentEpoch);
    } catch (error) { if (currentEpoch === epoch) publish({ status:'error', error:message(error) }); }
  }
  async function generate(mode = state.mode, options = {}) {
    if (working(state.job) || state.generationStatus === 'submitting') return;
    const currentEpoch = epoch;
    const currentOperation = ++operation;
    stop(); pollCount = 0;
    let body;
    try {
      if (!state.article?.paragraphs?.length) throw new Error('还没有可供生成的原文，请先打开原文。');
      if (state.article.active === false) throw new Error('当前正在阅读历史版本，请重新打开收藏后生成。');
      if (!['understanding', 'overview', 'plain', 'question'].includes(mode)) throw new Error('请选择一种阅读方式。');
      if (mode === 'understanding' && state.article.canGenerateUnderstanding !== true) throw new Error('这篇收藏暂时无法生成解读。');
      const question = String(options.question ?? state.questionDraft).trim();
      if (mode === 'question' && (!question || question.length > 2000)) throw new Error('请写下 2000 字以内的阅读问题。');
      body = options.retryBody ? structuredClone(options.retryBody) : { collectionId:state.collectionId, requestId:requestId(), mode, ...(state.article.documentVersionId ? { documentVersionId:state.article.documentVersionId } : {}), ...(mode === 'question' ? { question } : {}) };
      publish({ generationStatus:'submitting', generationError:'', request:body, lastRequest:body });
      const result = await api('reading/generate', body);
      if (currentEpoch !== epoch || currentOperation !== operation) return;
      if (!result?.job?.id) throw new Error('生成请求还未确认，请重试。');
      publish({ generationStatus:'idle', request:null });
      applyJob(result.job);
      if (working(result.job)) schedulePolling(currentEpoch, currentOperation);
      else await refreshArticle(currentEpoch, currentOperation);
    } catch (error) {
      if (currentEpoch === epoch && currentOperation === operation) publish({ generationStatus:'idle', generationError:message(error), request:body || null });
    }
  }
  async function savePreferences(patch) {
    const currentEpoch = epoch, currentOperation = ++preferenceOperation;
    const allowed = {};
    for (const key of ['fontSize', 'readingWidth']) if (Object.hasOwn(patch, key)) allowed[key] = patch[key];
    if (hasMode(patch.defaultMode)) allowed.defaultMode = patch.defaultMode;
    if (!Object.keys(allowed).length) return true;
    publish({ preferenceStatus:'saving', preferenceError:'' });
    try {
      const result = await api('reading/preferences', { ...allowed, expectedVersion:state.preferences.version });
      if (currentEpoch !== epoch || currentOperation !== preferenceOperation) return false;
      publish({ preferences:preferences(result?.preferences || result), preferenceStatus:'saved', preferenceError:'' });
      return true;
    } catch (error) {
      if (currentEpoch === epoch && currentOperation === preferenceOperation) publish({ preferenceStatus:'error', preferenceError:message(error) });
      return false;
    }
  }
  return {
    getState:() => structuredClone(state), open,
    setMode(mode) { if (hasMode(mode)) publish({ mode, sourceSelection:null, noteError:'' }); },
    selectSource(paragraphId, quote, offset) {
      const paragraph = list(state.article?.paragraphs).find(entry => entry.id === paragraphId);
      if (!paragraph) return false;
      const start = typeof quote === 'string' && quote ? Number.isSafeInteger(offset) ? offset : paragraph.text.indexOf(quote) : -1;
      const sourceSelection = start >= 0 && paragraph.text.slice(start, start + quote.length) === quote ? { paragraphId, quote, start } : null;
      publish({ mode:'original', sourceSelection, noteError:'' });
      return true;
    },
    setDraft(field, value) {
      if (field !== 'questionDraft') return;
      state = { ...state, questionDraft:String(value) };
      rememberDraft();
    },
    setNoteError(error = '') { publish({ noteError:error }); },
    generate,
    savePreferences,
    refresh(options = {}) {
      stop(); pollCount = 0;
      if (options.currentSource || options.forceReload) return open(state.collectionId, { mode:state.mode });
      return refreshArticle();
    },
    refreshSimilar() { return loadSimilar(); },
    retry() {
      if (state.status === 'error') return open(state.collectionId);
      if (state.request) return generate(state.request.mode, { retryBody:state.request });
      if (state.job?.status === 'failed' && state.job.errorCode !== 'READING_CANCELLED' && state.lastRequest) return generate(state.lastRequest.mode, { question:state.lastRequest.question });
      if (state.job?.status === 'failed' && state.job.errorCode !== 'READING_CANCELLED' && state.job.readingMode === 'understanding') return generate('understanding');
      return refreshArticle();
    },
    async cancel() {
      if (!working(state.job) || !state.job.id) return;
      const currentEpoch = epoch, currentOperation = ++operation, jobId = state.job.id;
      stop(); publish({ generationStatus:'cancelling', generationError:'' });
      try {
        const result = await api('reading/cancel', { jobId });
        if (currentEpoch !== epoch || currentOperation !== operation) return;
        publish({ generationStatus:'idle' });
        applyJob(result?.job || { ...state.job, status:'failed', errorCode:'READING_CANCELLED' });
        if (working(state.job)) schedulePolling(currentEpoch, currentOperation);
      } catch (error) { if (currentEpoch === epoch && currentOperation === operation) { publish({ generationStatus:'idle', generationError:message(error) }); schedulePolling(currentEpoch, currentOperation); } }
    },
    close() { rememberDraft(); ++epoch; ++operation; ++preferenceOperation; stop(); state = { ...state, status:'idle', article:null, sourceSelection:null, job:null, request:null, lastRequest:null, generationStatus:'idle' }; },
    destroy() { this.close(); drafts.clear(); },
  };
}

const button = (action, label, attributes = '', variant = 'ghost') => `<button type="button" class="btn ws-button" data-variant="${variant}" data-size="sm" data-reading-action="${action}" ${attributes}>${label}</button>`;
const evidence = (article, ids, label = '查看原文') => {
  const valid = sourceIds(article, ids);
  return valid.length ? button('source', escape(label), `data-reading-evidence="${escape(valid.join(' '))}"`) : '';
};
function understandingEvidence(article, entry) {
  const ids = sourceIds(article, entry?.evidenceIds);
  return list(entry?.evidence).flatMap(ref => {
    if (!ids.includes(ref?.paragraphId) || typeof ref.quote !== 'string' || !ref.quote.trim()) return [];
    const index = article.paragraphs.findIndex(paragraph => paragraph.id === ref.paragraphId);
    const paragraph = article.paragraphs[index];
    const start = Number.isSafeInteger(ref.start) && Number.isSafeInteger(paragraph.start)
      ? ref.start - paragraph.start : paragraph.text.indexOf(ref.quote);
    return start >= 0 && paragraph.text.slice(start, start + ref.quote.length) === ref.quote
      ? [{ ...ref, start, number:index + 1 }] : [];
  });
}
function passageLinks(refs) {
  return refs.length ? `<div class="forme-reading-evidence-links">${refs.map(ref => button('source', `原文第 ${ref.number} 段 <span aria-hidden="true">↗</span>`,
    `data-reading-evidence="${escape(ref.paragraphId)}" data-reading-quote="${escape(ref.quote)}" data-reading-start="${ref.start}" title="${escape(ref.quote)}"`)).join('')}</div>` : '';
}
const caption = article => ({ image_description:'图片的 AI 描述', transcript:'保存的转录文本', reconstructed:'保存的证据片段' })[article?.sourceKind] || (article?.coverage === 'reconstructed' ? '保存的证据片段' : '保存的原文');
function coverageNote(article) {
  if (!list(article?.paragraphs).length) return '<p class="forme-reading-empty">暂时没有可阅读的原文。可以稍后重试，或在收藏中检查原文是否已保存。</p>';
  return `${article.active === false ? '<p class="forme-reading-hint">正在阅读保存的历史版本。需要生成新内容时，请重新打开当前收藏。</p>' : ''}${article.sourceKind === 'image_description' ? '<p class="forme-reading-hint">以下是图片的 AI 描述，请结合原图阅读。</p>' : ''}${article.truncated ? '<p class="forme-reading-hint">内容较长，目前显示已保存文本的前 4 万字。</p>' : article.coverage === 'reconstructed' ? '<p class="forme-reading-hint">目前仅保存了部分片段，内容可能不完整。</p>' : article.coverage === 'partial' || article.complete === false ? '<p class="forme-reading-hint">目前仅保存了部分原文。</p>' : ''}`;
}
function generatedParagraphs(article, result) {
  return list(result?.paragraphs).filter(paragraph => typeof paragraph?.text === 'string' && paragraph.text.trim()).map(paragraph => `<div class="forme-reading-passage"><p>${escape(paragraph.text)}</p>${evidence(article, paragraph.evidenceIds, '依据原文')}</div>`).join('');
}
function originalPreview(article) {
  const paragraphs = list(article.paragraphs).filter(paragraph => paragraph.text.trim());
  const paragraph = paragraphs.find(row => row.text.trim().length >= 42) || paragraphs[0];
  if (!paragraph) return null;
  const text = paragraph.text.trim();
  const firstSentence = text.match(/^.{20,180}?(?:[。！？]|[.!?](?=\s|$))/su)?.[0];
  const quote = firstSentence || Array.from(text).slice(0, 180).join('');
  return { quote, clipped:!firstSentence && quote.length < text.length, paragraphId:paragraph.id, start:paragraph.text.indexOf(quote), number:article.paragraphs.indexOf(paragraph) + 1 };
}
function understandingPassage(article, entry) {
  const refs = understandingEvidence(article, entry);
  return typeof entry?.text === 'string' && entry.text.trim() && refs.length
    ? `<div class="forme-understanding-passage"><p>${escape(entry.text)}</p>${passageLinks(refs)}</div>` : '';
}
function understandingSection(article, label, entries) {
  const rendered = list(entries).map(entry => understandingPassage(article, entry)).join('');
  const missing = article.complete === false || article.truncated ? '已保存的节选中没有足够信息。' : '原文没有提供足够信息。';
  return `<section class="forme-understanding-section"><h2>${label}</h2>${rendered || `<p class="forme-reading-hint">${missing}</p>`}</section>`;
}
function renderUnderstanding(state) {
  const article = state.article;
  const brief = article.understanding;
  const answer = brief?.answer;
  const refs = understandingEvidence(article, answer);
  const ready = typeof answer?.text === 'string' && answer.text.trim() && refs.length;
  const disabled = working(state.job) || ['submitting', 'cancelling'].includes(state.generationStatus);
  const generate = article.canGenerateUnderstanding === true
    ? button('generate', ready ? '重新生成解读' : '生成解读', `data-reading-mode="understanding" ${disabled ? 'disabled' : ''}`, ready ? 'outline' : 'primary') : '';
  if (ready) return `<div class="forme-understanding">
    <section class="forme-understanding-lead"><h2 class="forme-reading-sr-only">一句话读懂</h2>
      <p class="forme-understanding-answer">${escape(answer.text)}</p>${passageLinks(refs)}</section>
    ${coverageNote(article)}
    ${understandingSection(article, '作者怎么做', brief.approach)}
    ${understandingSection(article, '关键发现', brief.findings)}
    ${understandingSection(article, '依据是什么', brief.evidence)}
    ${understandingSection(article, '结论的边界', brief.boundaries)}
    <footer class="forme-understanding-footer"><p class="forme-reading-hint">解读由 AI 根据已保存的原文整理。</p>${generate}</footer>
  </div>`;
  const preview = originalPreview(article);
  if (!preview) return `<section class="forme-understanding-lead"><h2>原文尚未保存</h2>${coverageNote(article)}</section>`;
  const label = ({ image_description:'保存的图片描述', transcript:'字幕节选', reconstructed:'保存的证据片段' })[article.sourceKind] || '原文节选';
  const unavailable = state.aiEnabled === false ? '智能整理尚未连接。' : '这篇收藏暂时无法生成解读。';
  return `<div class="forme-understanding">
    <section class="forme-understanding-lead is-excerpt"><h2>${label}</h2>
      <blockquote class="forme-understanding-answer">${escape(preview.quote)}${preview.clipped ? '…' : ''}</blockquote>${passageLinks([preview])}</section>
    ${coverageNote(article)}
    ${generate ? `<div class="forme-understanding-footer">${generate}<span class="forme-reading-hint">使用已保存的原文片段</span></div>` : article.active !== false ? `<p class="forme-reading-hint">${unavailable}</p>` : ''}
  </div>`;
}
function renderPlainReading(state) {
  const article = state.article;
  const plain = articleReadingResult(state, 'plain');
  const paragraphs = generatedParagraphs(article, plain);
  const hasSource = article.active !== false && list(article.paragraphs).length > 0;
  const canGenerate = hasSource && state.aiEnabled !== false;
  const busy = working(state.job) || ['submitting', 'cancelling'].includes(state.generationStatus);
  const generate = canGenerate ? `<div class="forme-reading-generate">${button('generate', paragraphs ? '重新生成通俗解读' : '生成通俗解读', `data-reading-mode="plain" ${busy ? 'disabled' : ''}`, paragraphs ? 'outline' : 'primary')}</div>` : '';
  if (paragraphs) return `${coverageNote(article)}<p class="forme-reading-eyebrow">通俗解读 · AI 根据原文整理</p><div class="forme-reading-prose">${paragraphs}</div>${generate}`;

  const brief = article.understanding;
  const preview = [brief?.answer, ...list(brief?.findings)].map(entry => understandingPassage(article, entry)).filter(Boolean).slice(0, 3).join('');
  const body = preview ? `<div class="forme-understanding"><p class="forme-reading-eyebrow">解读要点 · 来自已有的 AI 解读</p>${preview}</div>`
    : canGenerate ? '<p class="forme-reading-hint">用更容易理解的语言重述原文，并解释必要的术语。</p>' : '';
  const unavailable = hasSource && !canGenerate ? '<p class="forme-reading-hint">智能整理尚未连接。</p>' : '';
  return `${coverageNote(article)}${body}${generate}${unavailable}`;
}
function readingBody(state) {
  const article = state.article || {};
  if (state.mode === 'original') return `${coverageNote(article)}<p class="forme-reading-eyebrow">${caption(article)}</p>${renderArticleOriginal(article, state.sourceSelection)}`;
  return state.mode === 'plain' ? renderPlainReading(state) : renderUnderstanding(state);
}
function quoteItems(state) {
  const article = state.article;
  const generated = articleReadingResult(state);
  const originals = list(article?.quotes).map(quote => ({ ...quote, origin:'source' }));
  const combined = [...originals, ...list(generated?.quotes).map(quote => ({ ...quote, origin:'generated' }))];
  const seen = new Set();
  return combined.filter(quote => {
    if (typeof quote?.text !== 'string' || !quote.text.trim() || seen.has(quote.text) || !sourceIds(article, quote.evidenceIds).some(key => list(article.paragraphs).find(paragraph => paragraph.id === key)?.text.includes(quote.text))) return false;
    seen.add(quote.text); return true;
  }).slice(0, 6);
}
function questionItems(state) {
  const article = state.article;
  const results = sourceResults(article);
  const preferred = articleReadingResult(state);
  const candidates = [...(preferred ? [preferred] : []), ...results.filter(result => result.mode === 'question').reverse()];
  const items = candidates.flatMap(result => {
    const questions = list(result.questions);
    if (questions.length) return questions;
    return result.mode === 'question' && result.question ? [{ question:result.question, answer:list(result.paragraphs).map(paragraph => paragraph.text).join('\n\n'), evidenceIds:list(result.paragraphs).flatMap(paragraph => list(paragraph.evidenceIds)) }] : [];
  });
  const seen = new Set();
  return items.filter(item => typeof item?.question === 'string' && item.question.trim() && !seen.has(item.question) && (seen.add(item.question), true)).slice(0, 8);
}
function renderQuotes(state) {
  const quotes = quoteItems(state);
  if (!quotes.length) return '';
  return `<section class="forme-reading-section" aria-labelledby="forme-reading-quotes"><header class="forme-reading-section-head"><h3 id="forme-reading-quotes">值得留下的话</h3><span>原文摘录</span></header><div class="forme-reading-quotes">${quotes.map((quote, index) => `<figure><blockquote>${escape(quote.text)}</blockquote><figcaption>${quote.speaker ? `<span>${escape(quote.speaker)}</span>` : ''}<div>${evidence(state.article, quote.evidenceIds)}${button('note-quote', '写进手记', `data-reading-index="${index}"`)}</div></figcaption></figure>`).join('')}</div></section>`;
}
function renderQuestions(state) {
  const questions = questionItems(state);
  if (!questions.length && !list(state.article?.paragraphs).length) return '';
  const busy = working(state.job) || state.generationStatus === 'submitting';
  return `<section class="forme-reading-section" aria-labelledby="forme-reading-questions"><header class="forme-reading-section-head"><h3 id="forme-reading-questions">带着问题读</h3><span>AI 辅助思考</span></header>${questions.length ? `<div class="forme-reading-questions">${questions.map((question, index) => `<details data-reading-details="question-${index}"><summary>${escape(question.question)}<span aria-hidden="true">＋</span></summary><div class="forme-reading-answer">${question.answer ? `<p>${escape(question.answer)}</p>` : '<p class="forme-reading-hint">这个问题还没有生成回答，可以继续追问。</p>'}<div class="forme-reading-actions">${evidence(state.article, question.evidenceIds, '依据原文')}${button('note-question', '带入手记思考', `data-reading-index="${index}"`)}</div></div></details>`).join('')}</div>` : '<p class="forme-reading-empty">写下一个问题，从这篇收藏里寻找有依据的回答。</p>'}<form data-reading-form="question" class="forme-reading-question-form"><label class="forme-reading-sr-only" for="forme-reading-question-input">向这篇收藏提问</label><textarea id="forme-reading-question-input" rows="2" maxlength="2000" data-reading-field="questionDraft" placeholder="这篇内容让我想到…">${escape(state.questionDraft)}</textarea><button type="submit" class="btn ws-button" data-variant="outline" data-size="sm" ${busy || !list(state.article?.paragraphs).length || state.article?.active === false ? 'disabled' : ''}>根据原文回答</button></form><p class="forme-reading-hint">回答仅依据当前收藏；生成内容仍需核对。</p></section>`;
}
const excerpt = chunks => list(chunks).find(chunk => typeof chunk?.text === 'string' && chunk.text.trim())?.text || '';
const shortExcerpt = text => text.length > 300 ? `${text.slice(0, 300)}…` : text;
function renderSimilar(state) {
  let content;
  if (state.similarStatus === 'loading' || state.similarStatus === 'idle') content = '<p class="forme-reading-empty" role="status">正在查找相似收藏…</p>';
  else if (state.similarStatus === 'error') content = `<p class="forme-reading-error" role="alert">${escape(state.similarError)}</p>${button('similar-retry', '重新查找')}`;
  else if (!list(state.similarItems).length) content = '<p class="forme-reading-empty">暂未找到相似收藏。</p>';
  else content = `<div class="forme-reading-related">${state.similarItems.map((item, index) => {
    const current = excerpt(item.anchorChunks) || excerpt(state.similarAnchor?.chunks);
    const peer = excerpt(item.chunks || item.matchedChunks);
    const reasons = list(item.matchReasons).filter(reason => typeof reason === 'string' && reason.trim()).slice(0, 2);
    const terms = list(item.matchedTerms).filter(term => typeof term === 'string').slice(0, 4);
    const why = reasons.length ? reasons.join(' · ') : terms.length ? `相关内容：${terms.join('、')}` : '内容相近，可对照阅读';
    return `<article><button type="button" class="forme-reading-related-title" data-reading-action="collection" data-reading-index="${index}">${escape(item.title || '收藏内容')}<span aria-hidden="true">↗</span></button><p class="forme-reading-hint">${escape(why)}</p>${current && peer ? `<details data-reading-details="similar-${index}"><summary>为什么推荐 · 对照原文<span aria-hidden="true">＋</span></summary><div class="forme-reading-comparison"><blockquote><small>当前收藏 · 节选</small><p>${escape(shortExcerpt(current))}</p></blockquote><blockquote><small>${escape(item.title || '相似收藏')} · 节选</small><p>${escape(shortExcerpt(peer))}</p></blockquote></div></details>` : peer ? `<p class="forme-reading-related-excerpt">${escape(shortExcerpt(peer))}</p>` : ''}</article>`;
  }).join('')}</div>`;
  const title = state.curation?.status === 'related' ? '相关收藏' : '接着读什么';
  const topic = state.curation?.topicId ? button('open-topic', `查看专题 · ${escape(state.curation.title || '来自你的收藏')}`) : '';
  return `<section class="forme-reading-section" aria-labelledby="forme-reading-similar"><header class="forme-reading-section-head"><h3 id="forme-reading-similar">${title}</h3><span>来自你的收藏${state.similarMode === 'full_text' ? ' · 关键词相近' : ''}</span></header>${topic}${content}</section>`;
}

/** This is content for the existing collection reader, never a new dialog or application shell. */
export function renderArticleReading(state) {
  if (state.status === 'idle') return '';
  if (state.status === 'loading') return `<div class="forme-reading-loading" data-reading-width="${state.preferences?.readingWidth === 'wide' ? 'wide' : 'comfortable'}" role="status">正在打开阅读内容…</div>`;
  if (state.status === 'error') return `<p class="forme-reading-error" role="alert">${escape(state.error)}</p>${button('retry', '重新打开', '', 'outline')}`;
  if (state.article?.editorial && !list(state.article.paragraphs).length) {
    const { summary, note, imageCredit } = state.article.editorial;
    return `<section class="forme-understanding-lead">
      <p class="forme-reading-eyebrow">策展导读</p><p>${escape(summary)}</p>
      ${note ? `<h2>阅读线索</h2><p>${escape(note)}</p>` : ''}
      ${imageCredit ? `<p class="forme-reading-hint">配图 · ${escape(imageCredit)}</p>` : ''}
    </section>`;
  }
  const prefs = preferences(state.preferences);
  const tabs = Object.entries(modes).map(([mode, label]) => `<button type="button" role="tab" id="forme-reading-tab-${mode}" aria-controls="forme-reading-panel" aria-selected="${mode === state.mode}" tabindex="${mode === state.mode ? 0 : -1}" data-reading-action="mode" data-reading-mode="${mode}">${label}</button>`).join('');
  const busy = working(state.job) || ['submitting', 'cancelling'].includes(state.generationStatus);
  const job = busy ? `<div class="forme-reading-job" role="status" aria-live="polite"><span class="forme-reading-pulse" aria-hidden="true"></span><span>${state.generationStatus === 'cancelling' ? '正在取消…' : state.generationStatus === 'submitting' ? '正在提交阅读请求…' : `正在${state.job?.readingMode === 'question' ? '根据原文回答' : '整理阅读内容'}…`}</span>${working(state.job) ? button('cancel', '取消', state.generationStatus === 'cancelling' ? 'disabled' : '') : ''}</div>` : '';
  const preferencePanel = `<details class="forme-reading-preferences" data-reading-details="preferences"><summary aria-label="阅读偏好">阅读偏好<span aria-hidden="true">⌄</span></summary><form data-reading-form="preferences"><label>字号 <select data-reading-field="fontSize">${[14, 16, 18, 20, 22, 24, ...(![14, 16, 18, 20, 22, 24].includes(prefs.fontSize) ? [prefs.fontSize] : [])].sort((a, b) => a - b).map(size => `<option value="${size}" ${prefs.fontSize === size ? 'selected' : ''}>${size}</option>`).join('')}</select></label><label>行宽 <select data-reading-field="readingWidth"><option value="comfortable" ${prefs.readingWidth === 'comfortable' ? 'selected' : ''}>舒适</option><option value="wide" ${prefs.readingWidth === 'wide' ? 'selected' : ''}>宽一些</option></select></label><label>默认方式 <select data-reading-field="defaultMode">${Object.entries(modes).map(([mode, label]) => `<option value="${mode}" ${prefs.defaultMode === mode ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button type="submit" class="btn ws-button" data-variant="outline" data-size="sm" ${state.preferenceStatus === 'saving' ? 'disabled' : ''}>${state.preferenceStatus === 'saving' ? '保存中…' : '保存偏好'}</button>${state.preferenceStatus === 'saved' ? '<span class="forme-reading-hint" role="status">已记住</span>' : ''}</form></details>`;
  return `<div class="forme-reading-toolbar"><div class="forme-reading-tabs" role="tablist" aria-label="阅读方式">${tabs}</div>${preferencePanel}</div>${state.preferenceError ? `<p class="forme-reading-error" role="alert">${escape(state.preferenceError)}</p>` : ''}${job}${state.generationError ? `<div class="forme-reading-error" role="alert"><p>${escape(state.generationError)}</p>${button('retry', busy ? '刷新进度' : '重新尝试')}</div>` : ''}${state.error ? `<p class="forme-reading-error" role="alert">${escape(state.error)} ${button('refresh', '刷新')}</p>` : ''}<div id="forme-reading-panel" class="forme-reading-panel" data-reading-width="${prefs.readingWidth}" role="tabpanel" aria-labelledby="forme-reading-tab-${escape(state.mode)}" style="--reading-font-size:${prefs.fontSize}px;--reading-measure:${prefs.readingWidth === 'wide' ? '100%' : '39em'}">${readingBody(state)}</div>${state.noteError ? `<p class="forme-reading-error" role="alert">${escape(state.noteError)}</p>` : ''}${renderQuotes(state)}${state.publicDemo ? "" : renderQuestions(state)}${renderSimilar(state)}`;
}

/** Immutable source provenance travels into the existing studio note editor. No note is stored here. */
export function buildArticleReadingNote(state, kind, index) {
  const item = kind === 'quote' ? quoteItems(state)[index] : kind === 'question' ? questionItems(state)[index] : null;
  const article = state.article;
  if (!item || !article) return null;
  const paragraphIds = sourceIds(article, item.evidenceIds);
  const paragraphs = list(article.paragraphs).filter(paragraph => paragraphIds.includes(paragraph.id)).map(paragraph => ({ id:paragraph.id, text:paragraph.text, start:paragraph.start, end:paragraph.end }));
  const text = kind === 'quote' ? item.text : item.question;
  return {
    collectionId:article.collectionId, documentVersionId:article.documentVersionId,
    title:kind === 'quote' ? '从一句话开始思考' : Array.from(text).slice(0, 160).join(''),
    articleTitle:article.title || '', sourceTitle:article.title || '', url:article.url || '', sourceUrl:article.url || '',
    source:{ kind, text, ...(kind === 'question' ? { answer:item.answer || '' } : { originalText:item.text }), paragraphIds, evidenceIds:paragraphIds, paragraphs, url:article.url || '', title:article.title || '', sourceRevision:article.sourceRevision, contentHash:article.contentHash, generated:kind === 'question' },
    blocks:kind === 'quote' ? [{ type:'essay', ai:false, text:`“${text}”` }, { type:'question', ai:false, text:'' }] : [{ type:'question', ai:false, text }, ...(item.answer ? [{ type:'essay', ai:true, text:item.answer }] : []), { type:'opinion', ai:false, text:'' }],
  };
}

export function mountArticleReading({ doc = document, api, getState = () => ({}), onCreateNote, saveNote, openCollection, openExhibition } = {}) {
  let host = null, root = null, destroyed = false, lastHTML = '', activeCollection = '', explicitContainer = null;
  const noteHandler = onCreateNote || saveNote;
  function attach(container) {
    const target = container || explicitContainer || doc.querySelector('.collection-glass__reading');
    if (!target) return false;
    if (!root || root.parentNode !== target) {
      root?.remove();
      root = doc.createElement('section');
      root.className = 'forme-article-reading';
      root.setAttribute('aria-label', '收藏阅读');
      target.prepend(root);
      host = target;
      host.classList.add('has-article-reading');
      root.addEventListener('click', click);
      root.addEventListener('submit', submit);
      root.addEventListener('input', input);
      root.addEventListener('change', input);
      root.addEventListener('keydown', keydown);
      lastHTML = '';
    }
    return true;
  }
  function paint(state) {
    if (destroyed || !root?.isConnected) return;
    const capabilities = getState()?.desktopCapabilities;
    const html = renderArticleReading({ ...state, aiEnabled:capabilities?.aiEnabled, publicDemo:capabilities?.publicDemo });
    if (html === lastHTML) return;
    const active = doc.activeElement;
    const focused = root.contains(active) ? { field:active.dataset?.readingField, action:active.dataset?.readingAction, mode:active.dataset?.readingMode, paragraph:active.dataset?.readingParagraph, start:active.selectionStart, end:active.selectionEnd } : null;
    const open = [...root.querySelectorAll('details[open]')].map(detail => detail.dataset.readingDetails);
    const drafts = [...root.querySelectorAll('select[data-reading-field]')].map(select => [select.dataset.readingField, select.value]);
    root.innerHTML = html; lastHTML = html;
    for (const detail of root.querySelectorAll('details')) if (open.includes(detail.dataset.readingDetails)) detail.open = true;
    if (state.preferenceStatus !== 'saved') for (const select of root.querySelectorAll('select[data-reading-field]')) { const value = drafts.find(([field]) => field === select.dataset.readingField)?.[1]; if (value !== undefined) select.value = value; }
    if (focused) {
      const element = focused.paragraph
        ? [...root.querySelectorAll('[data-reading-paragraph]')].find(element => element.dataset.readingParagraph === focused.paragraph)
        : [...root.querySelectorAll('[data-reading-field], [data-reading-action]')].find(element => focused.field ? element.dataset.readingField === focused.field : element.dataset.readingAction === focused.action && element.dataset.readingMode === focused.mode);
      element?.focus({ preventScroll:true });
      if (element && typeof focused.start === 'number' && typeof element.setSelectionRange === 'function') element.setSelectionRange(focused.start, focused.end);
    }
  }
  const controller = createArticleReadingController({ api, onChange:paint });
  function revealOriginal(element, { focus = false, block = 'center' } = {}) {
    const raw = element?.closest?.('[data-reading-raw]');
    if (raw) raw.open = true;
    element?.scrollIntoView?.({ behavior:'auto', block });
    if (focus) element?.focus?.({ preventScroll:true });
  }
  function jumpToOffset(offset, focus = false) {
    if (!focus) {
      revealOriginal(root?.querySelector('[data-reading-article-start]'), { block:'start' });
      return;
    }
    const paragraphs = list(controller.getState().article?.paragraphs);
    const paragraph = paragraphs.find(paragraph => Number.isSafeInteger(paragraph.start) && Number.isSafeInteger(paragraph.end) && paragraph.start <= offset && paragraph.end > offset) || paragraphs.find(paragraph => Number.isSafeInteger(paragraph.start) && paragraph.start >= offset);
    const element = paragraph && [...(root?.querySelectorAll('[data-reading-paragraph]') || [])].find(element => element.dataset.readingParagraph === paragraph.id);
    revealOriginal(element, { focus:true });
  }
  function input(event) {
    const element = event.target;
    if (!root?.contains(element)) return;
    const field = element.dataset?.readingField;
    if (field === 'questionDraft') controller.setDraft(field, element.value);
  }
  async function submit(event) {
    const form = event.target.closest?.('[data-reading-form]');
    if (!form || !root?.contains(form)) return;
    event.preventDefault(); event.stopPropagation();
    if (form.dataset.readingForm === 'question') await controller.generate('question');
    else if (form.dataset.readingForm === 'preferences') {
      const value = field => form.querySelector(`[data-reading-field="${field}"]`)?.value;
      await controller.savePreferences({ fontSize:Number(value('fontSize')), readingWidth:value('readingWidth'), defaultMode:value('defaultMode') });
    }
  }
  async function click(event) {
    const control = event.target.closest?.('[data-reading-action]');
    if (!control || !root?.contains(control)) return;
    event.preventDefault(); event.stopPropagation();
    const action = control.dataset.readingAction;
    if (action === 'mode') controller.setMode(control.dataset.readingMode);
    else if (action === 'generate') await controller.generate(control.dataset.readingMode);
    else if (action === 'retry') await controller.retry();
    else if (action === 'refresh') await controller.refresh();
    else if (action === 'cancel') await controller.cancel();
    else if (action === 'similar-retry') await controller.refreshSimilar();
    else if (action === 'source') {
      const ids = sourceIds(controller.getState().article, control.dataset.readingEvidence?.split(' '));
      if (!ids.length) return;
      if (!controller.selectSource(ids[0], control.dataset.readingQuote, Number(control.dataset.readingStart))) return;
      const paragraph = [...root.querySelectorAll('[data-reading-paragraph]')].find(element => element.dataset.readingParagraph === ids[0]);
      revealOriginal(paragraph, { focus:true });
    } else if (action === 'collection') {
      const item = controller.getState().similarItems[Number(control.dataset.readingIndex)];
      if (item) openCollection?.(item.collectionId, { documentVersionId:item.documentVersionId });
    } else if (action === 'open-topic') {
      const topicId = controller.getState().curation?.topicId;
      if (topicId) openExhibition?.(topicId);
    } else if (action === 'note-quote' || action === 'note-question') {
      const note = buildArticleReadingNote(controller.getState(), action === 'note-quote' ? 'quote' : 'question', Number(control.dataset.readingIndex));
      if (!note) return;
      if (!noteHandler) { controller.setNoteError('手记编辑器暂时没有连接，请稍后重试。'); return; }
      const sourceId = controller.getState().article?.collectionId;
      try { await noteHandler(note); if (controller.getState().article?.collectionId === sourceId) controller.setNoteError(''); }
      catch (error) { if (controller.getState().article?.collectionId === sourceId) controller.setNoteError(message(error)); }
    }
  }
  function keydown(event) {
    const tab = event.target.closest?.('[role="tab"][data-reading-mode]');
    if (!tab || !root?.contains(tab) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const keys = Object.keys(modes), current = keys.indexOf(tab.dataset.readingMode);
    const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(current + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
    controller.setMode(next);
    root.querySelector(`[data-reading-mode="${next}"][role="tab"]`)?.focus();
  }
  return {
    controller,
    async open(collectionId, options = {}) {
      if (destroyed) return;
      explicitContainer = options.container || null;
      if (!attach(explicitContainer)) return;
      const current = controller.getState();
      if (current.status === 'ready' && current.collectionId === collectionId && current.article && !options.forceReload && (!options.documentVersionId || current.article.documentVersionId === options.documentVersionId)) { if (options.mode) controller.setMode(options.mode); paint(controller.getState()); return; }
      activeCollection = collectionId;
      await controller.open(collectionId, options);
    },
    async openOriginal(collectionId, options = {}) {
      await this.open(collectionId, { ...options, mode:'original' });
      const hasOffset = Number.isSafeInteger(options.offset) && options.offset >= 0;
      if (controller.getState().collectionId === collectionId) jumpToOffset(hasOffset ? options.offset : 0, hasOffset);
    },
    refresh(options = {}) {
      const appState = getState() || {};
      const collectionId = options.collectionId || activeCollection || appState.selectedCollectionId;
      if (options.container) explicitContainer = options.container;
      attach(explicitContainer); paint(controller.getState());
      return (options.reload || options.forceReload || options.currentSource) && collectionId ? controller.refresh(options) : Promise.resolve();
    },
    close() { controller.close(); root?.remove(); host?.classList.remove('has-article-reading'); root = null; host = null; explicitContainer = null; activeCollection = ''; lastHTML = ''; },
    destroy() { this.close(); destroyed = true; controller.destroy(); },
  };
}
