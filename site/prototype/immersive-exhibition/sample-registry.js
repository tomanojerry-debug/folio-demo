import { demoCollections, demoExtractions } from "./fixtures.js";

export function resolveSampleUrl(content) {
  const url = typeof content === "string" ? content.trim() : "";
  const collection = demoCollections.find(item => item.url === url);
  if (!collection) return null;
  const extraction = demoExtractions.find(item => item.collectionId === collection.id);
  return {
    kind: "sample",
    collection: structuredClone(collection),
    extraction: structuredClone(extraction),
  };
}
