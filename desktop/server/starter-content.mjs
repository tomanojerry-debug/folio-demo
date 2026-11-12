import {
  demoCollections, demoExtractions, exhibitionFixture,
  demoExhibitionRecords, demoExhibitionNotes, demoStudioNotes, demoThemes,
} from '../../site/prototype/immersive-exhibition/fixtures.js';
import { emptyWorkspace } from './workspace.mjs';

export const STARTER_CONTENT_VERSION = 1;
const mediaRoot = '/prototype/immersive-exhibition/assets/';
const copy = value => structuredClone(value);
const origin = sourceId => ({ kind:'bundled-library', version:STARTER_CONTENT_VERSION, sourceId });
const normalizeMedia = value => {
  if (typeof value === 'string') return value.startsWith('./assets/') ? mediaRoot + value.slice('./assets/'.length) : value;
  if (Array.isArray(value)) return value.map(normalizeMedia);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,normalizeMedia(item)]));
  return value;
};
const urlKey = value => { try { const url=new URL(value); url.hash=''; return url.href; } catch { return ''; } };

function allocator(rows, references = []) {
  const occupied=new Set([...rows.map(row=>row.id),...references]);
  return preferred => {
    let result=preferred, suffix=1;
    while(occupied.has(result)) result=`starter-${preferred}${suffix++ > 1 ? `-${suffix-1}` : ''}`;
    occupied.add(result);
    return result;
  };
}

/**
 * Import the bundled library exactly once into the ordinary persisted store.
 * Its existing interpretations are readable references, not newly fetched or
 * signed pipeline results. In particular, this never issues receipts or jobs.
 */
export function importStarterContent(state, { importedAt = new Date().toISOString() } = {}) {
  if ((state.starterContent?.version || 0) >= STARTER_CONTENT_VERSION) return state;
  const workspace = state.workspace ||= emptyWorkspace();
  for (const [key,value] of Object.entries(emptyWorkspace())) if (workspace[key] === undefined) workspace[key]=value;
  const maps={collections:{},exhibitions:{},exhibitionNotes:{},exhibitionRecords:{},studioNotes:{},themes:{}};
  const referencedCollections=[
    ...Object.keys(workspace.notes),...Object.keys(workspace.collectionCategories),
    ...Object.keys(workspace.feedback).map(key=>key.replace(/^(?:understanding|tags):/,'')),
    ...workspace.exhibitionNotes.map(row=>row.exhibitId),
    ...state.exhibitions.flatMap(row=>[...(row.collectionIds || []),...(row.sourceCollectionIds || []),...(row.items || []).map(item=>item.id),...(row.rooms || []).flatMap(room=>[...(room.exhibit_ids || []),...(room.exhibits || []).map(item=>item.id)])]),
    ...(state.messages || []).flatMap(row=>[...(row.collectionIds || []),...(row.relatedCollectionIds || []),...(row.workspaceContext?.collectionIds || [])]),
    ...(state.jobs || []).flatMap(row=>[row.collectionId,...(row.collectionIds || [])]),
  ].filter(Boolean);
  const allocateCollection=allocator(state.collections,referencedCollections);
  for (const source of demoCollections) {
    const existing=state.collections.find(item=>urlKey(item.url) && urlKey(item.url)===urlKey(source.url));
    if (existing) { maps.collections[source.id]=existing.id; continue; }
    const id=allocateCollection(source.id);
    maps.collections[source.id]=id;
    const extraction=normalizeMedia(copy(demoExtractions.find(item=>item.collectionId===source.id)));
    extraction.collectionId=id;
    state.collections.push({
      ...normalizeMedia(copy(source)), id, createdAt:source.addedAt,
      summary:extraction.summary, content:extraction.digest?.overview || extraction.summary,
      extraction, input:{mode:'link',content:source.url,title:source.sourceTitle || source.title},
      contentSource:'bundled-reference', libraryOrigin:origin(source.id),
    });
  }

  // Each existing archived note keeps an opening target. These smaller archives
  // reuse the original room text and evidence, without inventing new claims.
  const archiveRooms={presence:'presence','external-shape':'practice','visible-work':'boundaries'};
  const specs=[{sourceId:exhibitionFixture.id,title:exhibitionFixture.title,rooms:exhibitionFixture.rooms,createdAt:'2026-08-16T10:00:00.000Z'}];
  for (const [sourceId,roomId] of Object.entries(archiveRooms)) {
    const record=demoExhibitionRecords.find(item=>item.exhibitionId===sourceId);
    specs.push({sourceId,title:record.exhibitionTitle,rooms:exhibitionFixture.rooms.filter(room=>room.id===roomId),createdAt:record.createdAt});
  }
  const referencedExhibitions=[...workspace.exhibitionNotes,...workspace.exhibitionRecords,...workspace.studioNotes,...workspace.themes].map(row=>row.exhibitionId).filter(Boolean);
  const recordTargets=workspace.exhibitionRecords.map(row=>row.id?.startsWith('record-') ? row.id.slice('record-'.length) : null).filter(Boolean);
  const allocateExhibition=allocator(state.exhibitions,[...referencedExhibitions,...recordTargets,...workspace.exhibitionProgress.map(row=>row.id)]);
  for (const spec of specs) maps.exhibitions[spec.sourceId]=allocateExhibition(spec.sourceId);
  for (const field of ['exhibitionNotes','exhibitionRecords','studioNotes','themes']) {
    const allocate=allocator(workspace[field]);
    const sources={exhibitionNotes:demoExhibitionNotes,exhibitionRecords:demoExhibitionRecords,studioNotes:demoStudioNotes,themes:demoThemes}[field];
    for (const row of sources) maps[field][row.id]=allocate(field==='exhibitionRecords' ? `record-${maps.exhibitions[row.exhibitionId]}` : row.id);
  }

  for (const spec of specs) {
    const id=maps.exhibitions[spec.sourceId];
    const sourceIds=[...new Set(spec.rooms.flatMap(room=>room.exhibits.map(item=>item.id)))];
    const rooms=spec.rooms.map((source,index)=>({
      ...normalizeMedia(copy(source)), id:`${id}-room-${source.id}`, number:String(index+1).padStart(2,'0'),
      introduction:source.prompt,
      exhibit_ids:source.exhibits.map(item=>maps.collections[item.id]),
      exhibits:source.exhibits.map(item=>({...normalizeMedia(copy(item)),id:maps.collections[item.id]})),
      claims:[{text:source.connection.hypothesis,statement_type:'hypothesis',evidence_ids:source.connection.evidenceIds.map(value=>maps.collections[value])}],
      connection:{...copy(source.connection),id:`${id}-connection-${source.connection.id}`,evidenceIds:source.connection.evidenceIds.map(value=>maps.collections[value])},
    }));
    const items=sourceIds.map(sourceId=>{
      const collection=state.collections.find(item=>item.id===maps.collections[sourceId]);
      const exhibit=spec.rooms.flatMap(room=>room.exhibits).find(item=>item.id===sourceId);
      return {...normalizeMedia(copy(exhibit)),id:collection.id,title:collection.title,url:collection.url,source:collection.source,type:collection.type,summary:collection.summary || exhibit.description};
    });
    const record=demoExhibitionRecords.find(row=>row.exhibitionId===spec.sourceId);
    state.exhibitions.push({
      id,title:spec.title,status:'ready',createdAt:spec.createdAt,generatedAt:spec.createdAt,
      subtitle:spec.sourceId===exhibitionFixture.id ? exhibitionFixture.subtitle : spec.rooms[0].prompt,
      curatorial_note:{text:spec.sourceId===exhibitionFixture.id ? exhibitionFixture.subtitle : spec.rooms[0].connection.hypothesis},
      sourceCollectionIds:sourceIds.map(value=>maps.collections[value]),collectionIds:sourceIds.map(value=>maps.collections[value]),
      rooms,items,open_question:spec.rooms.at(-1).prompt,
      ...(record ? {note:record.content,noteUpdatedAt:record.updatedAt || record.createdAt} : {}),
      ...(spec.sourceId===exhibitionFixture.id ? {themeId:maps.themes[exhibitionFixture.themeId]} : {}),
      libraryOrigin:origin(spec.sourceId),
    });
  }

  for (const [field,sources] of Object.entries({exhibitionNotes:demoExhibitionNotes,exhibitionRecords:demoExhibitionRecords,studioNotes:demoStudioNotes,themes:demoThemes})) {
    for (const source of sources) {
      const row=normalizeMedia(copy(source));
      row.id=maps[field][source.id];
      if (source.exhibitionId) row.exhibitionId=maps.exhibitions[source.exhibitionId];
      if (source.exhibitId) row.exhibitId=maps.collections[source.exhibitId];
      if (source.noteId) row.noteId=maps.studioNotes[source.noteId];
      workspace[field].push(row);
    }
  }
  for (const record of demoExhibitionRecords) {
    const id=maps.exhibitions[record.exhibitionId];
    workspace.exhibitionProgress.push({id,status:'completed',viewed:[],revealed:[],completed:true,recommendationDecision:null});
  }
  state.starterContent={version:STARTER_CONTENT_VERSION,importedAt,ids:maps};
  return state;
}

export function removeStarterContent(state) {
  const workspace = state.workspace || {};
  const imported = state.starterContent?.ids || {};
  const bundledRows = { exhibitionNotes:demoExhibitionNotes, exhibitionRecords:demoExhibitionRecords, studioNotes:demoStudioNotes, themes:demoThemes };
  for (const [field, sources] of Object.entries(bundledRows)) {
    if (!Array.isArray(workspace[field])) continue;
    const exact = new Map(sources.map(source => {
      const row = normalizeMedia(copy(source));
      row.id = imported[field]?.[source.id];
      if (source.exhibitionId) row.exhibitionId = imported.exhibitions?.[source.exhibitionId];
      if (source.exhibitId) row.exhibitId = imported.collections?.[source.exhibitId];
      if (source.noteId) row.noteId = imported.studioNotes?.[source.noteId];
      return [row.id, row];
    }).filter(([id]) => id));
    workspace[field] = workspace[field].filter(row => {
      const original = exact.get(row.id);
      return !original || JSON.stringify(row) !== JSON.stringify(original);
    });
  }
  const userRows = ['exhibitionNotes', 'exhibitionRecords', 'studioNotes', 'themes'].flatMap(field => workspace[field] || []);
  const keptExhibitions = new Set(userRows.map(row => row.exhibitionId));
  const exhibitions = new Set(state.exhibitions.filter(row => {
    if (row.libraryOrigin?.kind !== 'bundled-library' || keptExhibitions.has(row.id)) return false;
    const original = demoExhibitionRecords.find(record => record.exhibitionId === row.libraryOrigin.sourceId);
    return !row.note || row.note === original?.content;
  }).map(row => row.id));
  const keptCollections = new Set([
    ...Object.keys(workspace.notes || {}), ...Object.keys(workspace.collectionCategories || {}),
    ...userRows.map(row => row.exhibitId),
    ...state.exhibitions.filter(row => !exhibitions.has(row.id)).flatMap(row => row.collectionIds || []),
  ]);
  const collections = new Set(state.collections.filter(row =>
    row.libraryOrigin?.kind === 'bundled-library' && !keptCollections.has(row.id) && !row.receipt && !row.manualThumbnail &&
    !row.understandingDocumentVersionId && !(row.sourceRevision > 1)
  ).map(row => row.id));
  state.collections = state.collections.filter(row => !collections.has(row.id));
  state.exhibitions = state.exhibitions.filter(row => !exhibitions.has(row.id));
  if (Array.isArray(workspace.exhibitionProgress)) workspace.exhibitionProgress = workspace.exhibitionProgress.filter(row => !exhibitions.has(row.id));
  delete state.starterContent;
}
