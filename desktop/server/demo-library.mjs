import { readFile } from "node:fs/promises";
import { TOPIC_PRESET_MODES } from "../../site/curator/curation-mode-definitions.js";

const collectedAt = "2026-11-12T04:00:00.000Z";
const editionVersion = edition => edition.introducedIn ?? 1;
const secureURL = value => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
};
const localArtwork = /^\/curator\/assets\/(?:demo-art\/[a-z0-9-]+\.(?:png|jpg)|folio-login-monet\.jpg)$/u;

function validateReadings(edition, articleIds) {
  const prepared = edition.readings;
  if (!prepared || Object.keys(prepared).length !== Object.keys(TOPIC_PRESET_MODES).length) throw new Error("Folio demo requires each preset reading mode.");
  for (const [mode, { slots }] of Object.entries(TOPIC_PRESET_MODES)) {
    const entries = prepared[mode];
    if (!entries || Object.keys(entries).length !== slots.length) throw new Error(`Missing Folio demo reading slots for ${mode}.`);
    for (const { id } of slots) {
      const entry = entries[id];
      if (typeof entry?.text !== "string" || !entry.text.trim() || !Array.isArray(entry.articleIds) ||
          !entry.articleIds.length || entry.articleIds.some(articleId => !articleIds.includes(articleId))) {
        throw new Error(`Invalid Folio demo reading source in ${mode}/${id}.`);
      }
    }
  }
}

export async function loadDemoLibrary() {
  const editions = JSON.parse(await readFile(new URL("./demo-content.json", import.meta.url), "utf8"));
  const urls = new Set();
  const editionIds = new Set();
  if (!Array.isArray(editions) || !editions.length) throw new Error("Folio demo requires an exhibition catalog.");
  for (const edition of editions) {
    const articleIds = edition.articles.map(article => article.id);
    const exhibitIds = edition.sections.flatMap(section => section.articleIds);
    const coverId = edition.coverArticleId || edition.sections[0]?.articleIds[0];
    if (!edition.id || editionIds.has(edition.id) || !Number.isSafeInteger(editionVersion(edition)) || editionVersion(edition) < 1 ||
        !articleIds.length || new Set(articleIds).size !== articleIds.length ||
        !articleIds.includes(coverId) ||
        exhibitIds.length !== articleIds.length || new Set(exhibitIds).size !== articleIds.length || exhibitIds.some(id => !articleIds.includes(id))) {
      throw new Error("Each Folio demo exhibition requires distinct articles assigned to chapters.");
    }
    validateReadings(edition, articleIds);
    editionIds.add(edition.id);
    for (const article of edition.articles) {
      if (!article.id || !article.title || !article.description || !article.source || !article.imageCredit ||
          (article.type && !["article", "video"].includes(article.type)) ||
          !secureURL(article.url) || !localArtwork.test(article.imagePath) ||
          (article.imageUrl !== undefined && !secureURL(article.imageUrl)) || urls.has(article.url)) {
        throw new Error("Folio demo articles require a unique public source and an attributed local image.");
      }
      urls.add(article.url);
    }
  }
  return editions;
}

export function demoReadingsByExhibition(editions) {
  return new Map(editions.map(edition => {
    const exhibitionId = `folio-demo-${edition.id}`;
    const readings = Object.fromEntries(Object.entries(edition.readings).map(([mode, entries]) => [
      mode, Object.fromEntries(Object.entries(entries).map(([slot, { text, articleIds }]) => [
        slot, { text, collectionIds: articleIds.map(articleId => `${exhibitionId}-${articleId}`) },
      ])),
    ]));
    return [exhibitionId, readings];
  }));
}

function refreshPublishedCover(collection, article) {
  if (collection?.contentSource !== "demo-editorial" || collection.url !== article.url || collection.manualThumbnail || !collection.editorial) return;
  const previousImage = collection.thumbnail;
  if (!previousImage || ![collection.editorial.imagePath, collection.editorial.imageUrl, article.imagePath].includes(previousImage)) return;
  collection.thumbnail = article.imagePath;
  collection.editorial.imagePath = article.imagePath;
  if (article.imageUrl) collection.editorial.imageUrl = article.imageUrl;
  else delete collection.editorial.imageUrl;
  collection.editorial.imageCredit = article.imageCredit;
  if (previousImage !== article.imagePath) return previousImage;
}

export function importDemoLibrary(state, editions) {
  const previousVersion = state.demoCatalogVersion || 0;
  const catalogVersion = Math.max(...editions.map(editionVersion));
  const existingCollections = new Map(state.collections.map(item => [item.id, item]));
  const existingExhibitions = new Map(state.exhibitions.map(item => [item.id, item]));
  for (const edition of editions) {
    const exhibitionId = `folio-demo-${edition.id}`;
    const coverId = edition.coverArticleId || edition.sections[0].articleIds[0];
    if (editionVersion(edition) <= previousVersion) {
      const exhibition = existingExhibitions.get(exhibitionId);
      for (const article of edition.articles) {
        const collectionId = `${exhibitionId}-${article.id}`;
        const previous = refreshPublishedCover(existingCollections.get(collectionId), article);
        if (!previous || !exhibition) continue;
        const item = exhibition.items?.find(entry => entry.id === collectionId);
        if (item?.thumbnail === previous) item.thumbnail = article.imagePath;
        if (article.id === coverId && exhibition.image === previous) exhibition.image = article.imagePath;
      }
      continue;
    }
    const collections = new Map(edition.articles.map(article => {
      const id = `${exhibitionId}-${article.id}`;
      const item = {
        id, title: article.title, url: article.url, source: article.source, type: article.type || "article",
        status: "ready", createdAt: collectedAt, addedAt: collectedAt, publishedAt: article.publishedAt || "",
        thumbnail: article.imagePath, summary: article.description,
        input: { mode: "link", content: article.url, title: article.title },
        contentSource: "demo-editorial",
        editorial: { summary: article.description, note: article.note || "", imageCredit: article.imageCredit,
          imagePath: article.imagePath, ...(article.imageUrl ? { imageUrl: article.imageUrl } : {}) },
      };
      return [article.id, item];
    }));
    const items = [...collections.values()];
    const collectionIds = items.map(item => item.id);
    const rooms = edition.sections.map((section, index) => ({
      id: `${exhibitionId}-chapter-${index + 1}`, title: section.title, introduction: section.introduction,
      exhibit_ids: section.articleIds.map(id => collections.get(id).id),
    }));
    state.collections.push(...items);
    state.exhibitions.push({
      id: exhibitionId, kind: "editorial", status: "ready", title: edition.title, subtitle: edition.subtitle,
      themeTitle: edition.themeTitle, open_question: edition.openQuestion, createdAt: collectedAt,
      generatedAt: collectedAt, image: collections.get(coverId).thumbnail,
      collectionIds, sourceCollectionIds: collectionIds, rooms,
      items: items.map(({ id, title, url, source, thumbnail, summary }) => ({ id, title, url, source, thumbnail, summary })),
    });
  }
  state.demoCatalogVersion = Math.max(previousVersion, catalogVersion);
}
