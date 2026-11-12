import {
  demoCollections, demoExhibitionNotes, demoExhibitionRecords, demoStudioNotes, demoThemes, exhibitionFixture,
} from "./fixtures.js?v=20260826-understanding-2";

export const APP_STATE_VERSION = 2;
export const STORAGE_KEY = "pec-ai.vertical-slice.v1";

export function createInitialState() {
  return {
    version: APP_STATE_VERSION,
    collections: [],
    extractions: [],
    curationTask: { id: null, status: "idle", gates: [], blockedBy: null, exhibitionId: null },
    exhibitions: [],
    feedback: {},
    notes: {},
    exhibitionNotes: [],
    collectionCategories: {},
    exhibitionRecords: [],
    studioNotes: [],
    themes: [],
    ui: { view: "inbox", roomIndex: 0, exhibitIndex: 0, recommendationIndex: 0, studioNoteId: null },
  };
}

export function hydrateState(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || parsed.version !== APP_STATE_VERSION) return createInitialState();
    return {
      ...createInitialState(),
      ...parsed,
      exhibitionRecords: Array.isArray(parsed.exhibitionRecords) ? parsed.exhibitionRecords : [],
      exhibitionNotes: Array.isArray(parsed.exhibitionNotes) ? parsed.exhibitionNotes : [],
      collectionCategories: parsed.collectionCategories && typeof parsed.collectionCategories === "object" ? parsed.collectionCategories : {},
      studioNotes: Array.isArray(parsed.studioNotes) ? parsed.studioNotes : [],
      themes: Array.isArray(parsed.themes) ? parsed.themes : [],
      ui: { ...createInitialState().ui, ...parsed.ui },
    };
  } catch {
    return createInitialState();
  }
}

const legacyPreviewRecords = [
  ["record-systems-step-back", "2026-08-16T08:20:00.000Z"],
  ["record-structure-breath", "2026-07-02T10:35:00.000Z"],
  ["record-edge-of-looking", "2026-05-18T06:10:00.000Z"],
  ["record-silent-material", "2026-03-11T13:45:00.000Z"],
].map(([id, date]) => ({ id, createdAt: date, updatedAt: date }));

function removeLegacyDemo(state) {
  let changed = false;
  function discard(key, matches) {
    if (!Array.isArray(state[key])) return;
    const remaining = state[key].filter((item) => !matches(item));
    if (remaining.length === state[key].length) return;
    state[key] = remaining;
    changed = true;
  }
  function discardUnedited(key, samples, fields) {
    discard(key, (item) => samples.some((sample) => item?.id === sample.id
      && fields.every((field) => item[field] === sample[field])));
  }

  const demoIds = new Set((Array.isArray(state.collections) ? state.collections : [])
    .filter((item) => {
      if (typeof item?.id !== "string" || item.live) return false;
      const baseId = item.id.replace(/-more-\d+$/, "");
      return demoCollections.some((sample) => baseId === sample.id && item.url === sample.url
        && (item.id !== baseId || item.addedAt === sample.addedAt));
    }).map((item) => item.id));
  // A personal note or category can turn a seeded link into a personal collection.
  discard("collections", (item) => demoIds.has(item?.id) && !state.notes?.[item.id] && !state.collectionCategories[item.id]);
  discard("extractions", (item) => demoIds.has(item?.collectionId) && item.source !== "live_ai");
  discard("exhibitions", (item) => item?.id === exhibitionFixture.id);
  discardUnedited("exhibitionRecords", demoExhibitionRecords, ["createdAt", "updatedAt", "content"]);
  discardUnedited("exhibitionRecords", legacyPreviewRecords, ["createdAt", "updatedAt"]);
  discardUnedited("exhibitionNotes", demoExhibitionNotes, ["createdAt", "content", "comment"]);
  discardUnedited("studioNotes", demoStudioNotes, ["updatedAt", "title", "status"]);
  discardUnedited("themes", demoThemes, ["noteId", "title", "status"]);
  if (state.curationTask?.id === "curation-001") {
    state.curationTask = createInitialState().curationTask;
    changed = true;
  }
  if (["foyer", "room", "finale"].includes(state.ui.view)) {
    state.ui.view = "inbox";
    state.ui.lightPage = "gallery";
    changed = true;
  }
  if (state.ui.view === "collection" && demoIds.has(state.ui.collectionId)
      && !state.collections.some((item) => item?.id === state.ui.collectionId)) {
    state.ui.view = "inbox";
    state.ui.collectionId = null;
    changed = true;
  }
  return changed;
}

export function createStorageAdapter(storage, key = STORAGE_KEY) {
  function save(state) {
    try {
      storage?.setItem(key, JSON.stringify(state));
    } catch {
      // 隐私模式、禁用存储或配额不足时保持内存态，不能阻断页面启动。
    }
    return state;
  }
  return {
    load() {
      try {
        const state = hydrateState(storage?.getItem(key));
        return removeLegacyDemo(state) ? save(state) : state;
      } catch {
        return createInitialState();
      }
    },
    save,
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        // 无持久化权限时，reset 仍由 store 在内存中完成。
      }
    },
  };
}

export function createStore(adapter) {
  let state = adapter.load();
  return {
    getState: () => state,
    update(mutator) {
      const next = structuredClone(state);
      mutator(next);
      state = adapter.save(next);
      return state;
    },
    reset() {
      adapter.clear();
      state = createInitialState();
      adapter.save(state);
      return state;
    },
  };
}
