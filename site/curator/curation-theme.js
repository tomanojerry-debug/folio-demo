// A small Folio palette shared by exhibition cards and their reading surfaces.
export const CURATION_COLORS = Object.freeze([
  '#a3423e', // warm red
  '#ad613e', // terracotta
  '#a47d32', // ochre
  '#5b8b3d', // leaf green
  '#337d72', // deep green
  '#65509a', // grape
]);

export function curationColor(exhibition = {}) {
  const selected = String(exhibition.themeColor || '').toLowerCase();
  if (CURATION_COLORS.includes(selected)) return selected;
  const identity = String(exhibition.id || exhibition.title || 'folio');
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index++) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619) >>> 0;
  return CURATION_COLORS[hash % CURATION_COLORS.length];
}
