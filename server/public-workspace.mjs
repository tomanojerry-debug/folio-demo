import { demoReadingsByExhibition, importDemoLibrary, loadDemoLibrary } from "../desktop/server/demo-library.mjs";
import { READING_DEFAULTS, loadReadingSource } from "../desktop/server/reading.mjs";
import { initialState } from "../desktop/server/state.mjs";
import { emptyWorkspace } from "../desktop/server/workspace.mjs";

const linkOnlySource = {
  async readDocument() {
    return { coverage: "unavailable" };
  },
};

let library;

export async function publicWorkspaceCatalog(basePath) {
  library ||= loadDemoLibrary();
  const editions = await library;
  const imported = initialState();
  importDemoLibrary(imported, editions);
  const readings = demoReadingsByExhibition(editions);
  const colors = new Map(editions.flatMap(edition => edition.articles
    .filter(article => /^#[a-f0-9]{6}$/i.test(article.coverColor))
    .map(article => [article.imagePath, article.coverColor])));
  const image = value => `${basePath}${value}`;
  const collections = imported.collections.map(({ input, thumbnail, editorial, ...collection }) => ({
    ...collection,
    thumbnail: image(thumbnail),
    editorial: { ...editorial, imagePath: image(editorial.imagePath) },
    ...(colors.has(thumbnail) ? { coverColor: colors.get(thumbnail) } : {}),
  }));
  const exhibitions = imported.exhibitions.map(exhibition => ({
    ...exhibition,
    image: image(exhibition.image),
    items: exhibition.items.map(item => ({ ...item, thumbnail: image(item.thumbnail) })),
    editorialReadings: readings.get(exhibition.id),
  }));
  const articles = Object.fromEntries(await Promise.all(collections.map(async collection => [
    collection.id,
    {
      ...await loadReadingSource(linkOnlySource, collection),
      editorial: collection.editorial,
      results: [],
      understanding: null,
      canGenerateUnderstanding: false,
    },
  ])));
  return {
    state: {
      profile: imported.profile,
      collections,
      exhibitions,
      messages: [],
      jobs: [],
      conversations: [],
      activeConversationId: null,
      surfaceSessions: [],
      workspace: emptyWorkspace(),
      capabilities: {
        publicDemo: true,
        localOnly: false,
        aiEnabled: false,
        webSearch: false,
        autoCurate: false,
      },
    },
    articles,
    preferences: { ...READING_DEFAULTS },
  };
}
