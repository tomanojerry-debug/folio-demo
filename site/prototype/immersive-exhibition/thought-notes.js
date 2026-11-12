const icons = {
  search: '<circle cx="8.5" cy="8.5" r="5"/><path d="m12.2 12.2 3.8 3.8"/>',
  image: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="m3 13 4-4 3.5 3.5L13 10l4 4M13.5 7.5h.01"/>',
  arrow: '<path d="M10 16V4m-5 5 5-5 5 5"/>',
  external: '<path d="M11 4h5v5m0-5-7 7M8 5H4v11h11v-4"/>',
  close: '<path d="m5 5 10 10M5 15 15 5"/>',
  more: '<circle cx="4.5" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="15.5" cy="10" r=".8"/>',
  note: '<path d="M5 3h7l3 3v11H5zM12 3v4h3M8 10h4m-4 3h4"/>',
};
const icon = name => `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const escape = (value = "") => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const list = value => Array.isArray(value) ? value : [];
const imageUrl = value => typeof value === "string" && /^(?:https?:\/\/|data:image\/(?:png|jpeg|jpg|webp|gif);base64,|\/(?!\/)|\.\.?\/)/i.test(value) ? value : "";
const noteLists = ["studioNotes", "exhibitionRecords", "exhibitionNotes"];
const sourceTypes = [["all", "全部"], ["written", "随手记"], ["text", "摘录"], ["image", "图片"]];
const maxImages = 3;
const maxImageLength = 2_500_000;
const allowedFileTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const boundSections = new WeakSet();
const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
let filter = "all";
let query = "";
let draft = { body: "", attachments: [] };
let submitting = false;
let readingImages = false;

function noteView(row, origin) {
  const capture = row.captureSource;
  const blockText = list(row.blocks).map(block => block?.text).filter(Boolean).join("\n\n");
  const reading = row.readingSource;
  const readingQuestion = reading?.kind === "question" ? reading.text : "";
  const excerpt = capture?.kind === "text" ? capture.text : reading ? (reading.originalText || reading.text) : origin === "exhibitionNotes" && row.kind === "text" && row.exhibitId ? row.content : "";
  const body = origin === "studioNotes" ? (row.body ?? blockText)
    : origin === "exhibitionNotes" && (excerpt || row.kind === "image") ? (row.comment || "") : (row.content || row.comment || "");
  const images = [...new Set([capture?.imageUrl, ...(row.kind === "image" ? [row.content] : []), ...list(row.attachments), ...list(row.images), row.image].map(imageUrl).filter(Boolean))];
  const sourceTitle = capture?.title || row.readingSource?.title || row.exhibitTitle || row.exhibitionTitle;
  const sourceSurface = capture?.surface === "collection" || row.readingSource ? "收藏" : "展览";
  const hasSource = Boolean(capture || row.readingSource || row.exhibitionId || row.exhibitId);
  const date = new Date(row.createdAt || row.updatedAt || "");
  const validDate = Number.isFinite(date.getTime());
  const quick = origin === "studioNotes" && !reading && (capture || (!row.title && !row.exhibitionId && (typeof row.body === "string" || list(row.attachments).length)));
  return {
    row, key: `${origin}:${row.id}`, body, excerpt, readingQuestion, images, hasSource, sourceTitle, sourceSurface,
    title: quick ? "" : row.title,
    date: validDate ? date : null,
    day: validDate ? dateFormat.format(date) : "较早的手记",
    editable: Boolean(quick),
    legacyEditable: origin === "studioNotes" && !quick && Boolean(row.blocks),
  };
}

function allNotes(state) {
  return noteLists.flatMap(origin => list(state?.[origin]).filter(row => row?.id).map(row => noteView(row, origin)))
    .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
}

function findNote(state, key) {
  const origin = noteLists.find(name => key?.startsWith(`${name}:`));
  if (!origin) return null;
  const row = list(state?.[origin]).find(item => item?.id === key.slice(origin.length + 1));
  return row ? noteView(row, origin) : null;
}

function imagesMarkup(images, preview = false) {
  if (!images.length) return "";
  return `<div class="tn-images" data-count="${Math.min(images.length, 3)}">${images.map((url, index) => `<figure><img src="${escape(url)}" alt="${preview ? `待保存的图片 ${index + 1}` : `手记图片 ${index + 1}`}" ${preview ? "" : 'loading="lazy"'} referrerpolicy="no-referrer" decoding="async"/>${preview ? `<button type="button" data-thought-action="remove-image" data-image-index="${index}" class="tn-icon" aria-label="移除图片 ${index + 1}">${icon("close")}</button>` : ""}</figure>`).join("")}</div>`;
}

function noteMarkup(note, allowAskTag) {
  const { row, key, body, excerpt, readingQuestion, images, hasSource, sourceTitle, sourceSurface, title, date, editable, legacyEditable } = note;
  const typeList = [!excerpt && !row.captureSource ? "written" : "", excerpt ? "text" : "", images.length ? "image" : ""].filter(Boolean).join(" ");
  const searchText = [body, excerpt, readingQuestion, title, sourceTitle, ...list(row.tags)].filter(Boolean).join(" ").toLocaleLowerCase();
  return `<article class="tn-note" data-thought-note="${escape(key)}" data-thought-types="${typeList}" data-thought-text="${escape(searchText)}">
    <header class="tn-note-head">
      <div>${date ? `<time datetime="${date.toISOString()}">${timeFormat.format(date)}</time>` : "手记"}${row.status === "draft" ? '<span class="tn-note-draft">草稿</span>' : ""}</div>
      ${editable || legacyEditable || allowAskTag ? `<details class="tn-menu"><summary class="tn-icon" aria-label="手记操作" title="手记操作">${icon("more")}</summary><div class="tn-menu-items">${editable || legacyEditable ? '<button type="button" data-thought-action="edit">编辑</button>' : ""}${allowAskTag ? '<button type="button" data-thought-action="ask">和 Tag 继续聊</button>' : ""}${editable ? '<button type="button" class="tn-danger" data-thought-action="delete">删除手记</button>' : ""}</div></details>` : ""}
    </header>
    <div class="tn-note-content" data-thought-content>
      ${title ? `<h2>${escape(title)}</h2>` : ""}
      ${body ? `<p class="tn-body">${escape(body)}</p>` : ""}
      ${readingQuestion && readingQuestion !== excerpt ? `<p class="tn-reading-question">${escape(readingQuestion)}</p>` : ""}
      ${excerpt ? `<blockquote>${escape(excerpt)}</blockquote>` : ""}
      ${imagesMarkup(images)}
    </div>
    ${editable ? `<form class="tn-edit" data-thought-edit hidden><textarea rows="2" maxlength="12000" aria-label="编辑手记" placeholder="补一句自己的想法…">${escape(body)}</textarea><div class="tn-edit-actions"><button type="button" class="tn-quiet" data-thought-action="cancel-edit">取消</button><button type="submit" class="tn-save">保存</button></div></form>` : ""}
    ${hasSource ? `<button class="tn-source" type="button" data-thought-action="source" title="查看来源">${icon("external")}<span>${sourceSurface} · ${escape(sourceTitle || "查看来源")}</span></button>` : ""}
    <p class="tn-card-status" role="status" data-thought-card-status></p>
  </article>`;
}

function feedMarkup(state) {
  const notes = allNotes(state);
  const allowAskTag = !state.desktopCapabilities?.publicDemo;
  const groups = new Map();
  for (const note of notes) {
    if (!groups.has(note.day)) groups.set(note.day, []);
    groups.get(note.day).push(note);
  }
  return [...groups].map(([day, entries]) => `<section class="tn-day" data-thought-day><h2 class="tn-date">${escape(day)}</h2>${entries.map(note => noteMarkup(note, allowAskTag)).join("")}</section>`).join("");
}

export function renderThoughtNotes(state) {
  const shortcut = typeof navigator !== "undefined" && /Mac|iPad/.test(navigator.platform) ? "⌘ ↵" : "Ctrl ↵";
  return `<div class="tn-page" data-thought-notes>
    <header class="tn-page-head"><h1>思考手记</h1><label class="tn-search">${icon("search")}<input type="search" id="workspace-search" aria-label="搜索手记" placeholder="搜索手记" data-thought-search value="${escape(query)}" autocomplete="off"/></label></header>
    <form class="tn-compose" data-thought-compose>
      <textarea rows="3" aria-label="写一条手记" placeholder="记点什么…" maxlength="12000" data-thought-draft>${escape(draft.body)}</textarea>
      <div class="tn-attachments" data-thought-attachments>${imagesMarkup(draft.attachments, true)}</div>
      <footer><div class="tn-compose-tools"><button type="button" class="tn-icon" data-thought-action="attach" aria-label="添加图片" title="添加图片">${icon("image")}</button><input type="file" data-thought-files accept="image/jpeg,image/png,image/webp" multiple hidden/><span class="tn-status" data-thought-status role="status"></span></div><div class="tn-submit"><kbd aria-hidden="true">${shortcut}</kbd><button class="tn-save" type="submit" aria-keyshortcuts="Meta+Enter Control+Enter">保存${icon("arrow")}</button></div></footer>
    </form>
    <div class="tn-filterbar"><div class="tn-filters" role="group" aria-label="筛选手记">${sourceTypes.map(([key, label]) => `<button type="button" data-thought-filter="${key}" aria-pressed="${key === filter}">${label}</button>`).join("")}</div><span class="tn-count" data-thought-count role="status"></span></div>
    <div class="tn-feed" data-thought-feed>${feedMarkup(state)}</div>
    <div class="tn-empty" data-thought-empty hidden>${icon("note")}<h2></h2><p></p><button type="button" class="tn-quiet" data-thought-action="clear-filters" hidden>清除筛选</button></div>
  </div>`;
}

function applyFilters(section) {
  const needle = query.trim().toLocaleLowerCase();
  const notes = [...section.querySelectorAll("[data-thought-note]")];
  let visible = 0;
  for (const note of notes) {
    note.hidden = (filter !== "all" && !note.dataset.thoughtTypes.split(" ").includes(filter)) || !note.dataset.thoughtText.includes(needle);
    if (!note.hidden) visible += 1;
  }
  for (const group of section.querySelectorAll("[data-thought-day]")) group.hidden = !group.querySelector("[data-thought-note]:not([hidden])");
  for (const button of section.querySelectorAll("[data-thought-filter]")) button.setAttribute("aria-pressed", String(button.dataset.thoughtFilter === filter));
  section.querySelector("[data-thought-count]").textContent = visible ? `${visible} 条` : "";
  const empty = section.querySelector("[data-thought-empty]");
  empty.hidden = visible > 0;
  const hasFilters = Boolean(needle || filter !== "all");
  empty.querySelector("h2").textContent = hasFilters ? "没有符合条件的手记" : "还没有手记";
  empty.querySelector("p").textContent = hasFilters ? "换个关键词或筛选试试。" : "记下一个想法，或在收藏和展览里存下文字与图片。";
  empty.querySelector("button").hidden = !hasFilters;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function bindThoughtNotes(root, { saveNote, deleteNote, openSource, askTag, editLegacyNote, getState, notify } = {}) {
  const section = root?.matches?.("[data-thought-notes]") ? root : root?.querySelector?.("[data-thought-notes]");
  if (!section || boundSections.has(section)) return;
  boundSections.add(section);
  const compose = section.querySelector("[data-thought-compose]");
  const textarea = section.querySelector("[data-thought-draft]");
  const search = section.querySelector("[data-thought-search]");
  const fileInput = section.querySelector("[data-thought-files]");
  const setStatus = message => { section.querySelector("[data-thought-status]").textContent = message; };
  const updateComposer = (target = section) => {
    const busy = submitting || readingImages;
    target.querySelector('[data-thought-compose] [type="submit"]').disabled = busy || !(draft.body.trim() || draft.attachments.length);
    target.querySelector('[data-thought-action="attach"]').disabled = busy || draft.attachments.length >= maxImages;
    target.querySelector("[data-thought-draft]").readOnly = submitting;
  };
  const currentSection = () => section.isConnected ? section : root?.querySelector?.("[data-thought-notes]");
  const syncDraft = () => {
    const target = currentSection();
    if (!target) return;
    const input = target.querySelector("[data-thought-draft]");
    if (input.value !== draft.body) input.value = draft.body;
    target.querySelector("[data-thought-attachments]").innerHTML = imagesMarkup(draft.attachments, true);
    updateComposer(target);
  };
  const updateFeed = () => {
    if (!section.isConnected || !getState) return;
    section.querySelector("[data-thought-feed]").innerHTML = feedMarkup(getState());
    applyFilters(section);
  };
  const report = message => {
    const target = currentSection();
    if (target) target.querySelector("[data-thought-status]").textContent = message;
    else if (message) notify?.(message);
  };
  const reportCard = (card, message) => {
    if (card?.isConnected) card.querySelector("[data-thought-card-status]").textContent = message;
    else report(message);
  };

  updateComposer();
  applyFilters(section);
  search.addEventListener("input", () => { query = search.value; applyFilters(section); });
  textarea.addEventListener("input", () => { draft.body = textarea.value; setStatus(""); updateComposer(); });
  fileInput.addEventListener("change", async () => {
    const files = [...fileInput.files];
    fileInput.value = "";
    if (!files.length) return;
    if (files.some(file => !allowedFileTypes.has(file.type))) return setStatus("支持 JPG、PNG 和 WebP 图片。");
    if (files.length + draft.attachments.length > maxImages) return setStatus("每条手记最多添加 3 张图片。");
    if (files.reduce((size, file) => size + file.size * 4 / 3 + 32, draft.attachments.join("").length) > maxImageLength) return setStatus("图片合计不能超过约 1.8 MB。");
    readingImages = true;
    updateComposer();
    try {
      const urls = await Promise.all(files.map(readFile));
      if (draft.attachments.length + urls.length > maxImages || [...draft.attachments, ...urls].join("").length > maxImageLength) return report("已达到手记图片上限。");
      draft.attachments = [...draft.attachments, ...urls];
      report("");
    } catch { report("图片读取失败，请重试。"); }
    finally { readingImages = false; syncDraft(); }
  });
  section.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing && event.keyCode !== 229 && event.target.matches("textarea")) {
      event.preventDefault();
      event.target.form?.requestSubmit();
    }
    if (event.key === "Escape") {
      const menu = event.target.closest(".tn-menu[open]");
      if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
    }
  });
  section.addEventListener("submit", async event => {
    if (event.target !== compose && !event.target.matches("[data-thought-edit]")) return;
    event.preventDefault();
    if (submitting || readingImages || !saveNote) return;
    const isNew = event.target === compose;
    const card = event.target.closest("[data-thought-note]");
    const old = !isNew && findNote(getState?.(), card?.dataset.thoughtNote)?.row;
    if (!isNew && !old) return;
    const body = event.target.querySelector("textarea").value.trim();
    const attachments = isNew ? [...draft.attachments] : list(old.attachments);
    if (!body && !attachments.length && !old?.captureSource) return;
    const updatedAt = new Date().toISOString();
    if (isNew && !draft.id) { draft.id = `thought-${crypto.randomUUID()}`; draft.createdAt = updatedAt; }
    const note = { ...(old || { id: draft.id, createdAt: draft.createdAt, status: "saved" }), body, updatedAt, blocks: body ? [{ type: "essay", ai: false, text: body }] : [], ...(attachments.length ? { attachments } : {}) };
    submitting = true;
    updateComposer();
    const editorInput = event.target.querySelector("textarea");
    const editorSubmit = event.target.querySelector('[type="submit"]');
    editorInput.readOnly = true;
    editorSubmit.disabled = true;
    try {
      if (await saveNote(note) === false) throw new Error("save rejected");
      if (isNew) draft = { body: "", attachments: [] };
      updateFeed();
      report("已保存");
    } catch (error) {
      reportCard(card, error?.message === "save rejected" ? "保存失败，请重试。" : error?.message || "保存失败，请重试。");
    } finally {
      submitting = false;
      editorInput.readOnly = false;
      editorSubmit.disabled = false;
      syncDraft();
    }
  });
  section.addEventListener("click", async event => {
    const button = event.target.closest("[data-thought-action],[data-thought-filter]");
    for (const menu of section.querySelectorAll(".tn-menu[open]")) {
      if (!menu.contains(event.target)) menu.open = false;
    }
    if (!button) return;
    const { thoughtFilter, thoughtAction } = button.dataset;
    if (thoughtFilter) { filter = thoughtFilter; return applyFilters(section); }
    if (thoughtAction === "attach") return fileInput.click();
    if (thoughtAction === "remove-image" && !submitting) {
      const index = Number(button.dataset.imageIndex);
      draft.attachments.splice(index, 1);
      syncDraft();
      const remaining = section.querySelectorAll('[data-thought-action="remove-image"]');
      (remaining[index] || remaining[index - 1] || section.querySelector('[data-thought-action="attach"]'))?.focus();
      return;
    }
    if (thoughtAction === "clear-filters") { query = ""; filter = "all"; search.value = ""; return applyFilters(section); }
    const card = button.closest("[data-thought-note]");
    const note = findNote(getState?.(), card?.dataset.thoughtNote);
    if (!note) return;
    const menu = button.closest("details");
    if (menu) { menu.open = false; menu.querySelector("summary").focus({ preventScroll: true }); }
    reportCard(card, "");
    if (thoughtAction === "source" || thoughtAction === "ask" || (thoughtAction === "edit" && note.legacyEditable)) {
      const run = thoughtAction === "source" ? openSource : thoughtAction === "ask" ? askTag : editLegacyNote;
      try { await run?.(note.row); }
      catch (error) { reportCard(card, error?.message || "暂时无法完成，请重试。"); }
      return;
    }
    const editor = card.querySelector("[data-thought-edit]");
    if (thoughtAction === "edit" || thoughtAction === "cancel-edit") {
      if (!editor) return;
      const editing = thoughtAction === "edit";
      editor.hidden = !editing;
      card.querySelector("[data-thought-content]").hidden = editing;
      if (editing) editor.querySelector("textarea").focus();
      else { editor.querySelector("textarea").value = note.body; card.querySelector("summary").focus(); }
    }
    if (thoughtAction === "delete" && deleteNote && window.confirm("删除这条手记？")) {
      try {
        if (await deleteNote(note.row.id) === false) throw new Error("delete rejected");
        updateFeed();
        report("已删除");
      } catch { reportCard(card, "删除失败，请重试。"); }
    }
  });
}
