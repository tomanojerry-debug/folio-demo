import { fault } from "./errors.mjs";

export const CURATION_PLAN_MODE = "planned_single_room_v1";
const statements = new Set(["fact", "extraction", "hypothesis", "question"]);
const invalid = () => { throw fault("MODEL_OUTPUT_INVALID", 502); };
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const hasText = (value) => typeof value === "string" && Boolean(value.trim());
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));

function sourceIndex(items) {
  const sources = new Map(), evidence = new Map();
  for (const item of array(items)) {
    const id = item?.collection?.id;
    if (!hasText(id) || item.extraction?.status !== "qualified" || sources.has(id)) invalid();
    sources.set(id, item);
    for (const entry of array(item.extraction.evidenceBundle)) {
      if (!hasText(entry?.evidence_id) || !hasText(entry.text) || evidence.has(entry.evidence_id)) invalid();
      evidence.set(entry.evidence_id, id);
    }
  }
  return { sources, evidence };
}

/** A server-owned recovery layout; unsupported sources are never padded in. */
export function createRoomPlan(items, theme) {
  const { sources, evidence } = sourceIndex(items);
  const refs = array(theme?.evidence_ids);
  if (refs.some((id) => !evidence.has(id))) invalid();
  const supported = new Set(refs.map((id) => evidence.get(id)));
  const exhibitIds = [...sources.keys()].filter((id) => supported.has(id)).slice(0, 9);
  if (exhibitIds.length < 5) return [];
  return [{ room_id: "room-main", exhibit_ids: exhibitIds, evidence_ids: [...new Set(refs.filter((id) => exhibitIds.includes(evidence.get(id))))] }];
}

/** Validate newly generated narrative, then attach the immutable server layout. */
export function assemblePlannedExhibition(output, roomPlan, items) {
  if (!object(output)) invalid();
  if (["waiting_for_content", "unable_to_curate"].includes(output.status)) return structuredClone(output);
  if (output.status !== "candidate" || !onlyKeys(output, ["status", "title", "curatorial_lens", "curatorial_note", "room_narrative", "connection_claims", "emerging_direction", "open_question", "quality_metadata", "reason_codes"])) invalid();
  if (!hasText(output.title) || output.curatorial_lens !== "balanced") invalid();
  const { sources, evidence } = sourceIndex(items);
  if (!Array.isArray(roomPlan) || roomPlan.length !== 1) invalid();
  const plan = roomPlan[0];
  const selected = array(plan?.exhibit_ids);
  if (!hasText(plan?.room_id) || selected.length < 5 || selected.length > 9 || new Set(selected).size !== selected.length || selected.some((id) => !sources.has(id))) invalid();
  const selectedSet = new Set(selected);
  const checkedRefs = (ids, minimumSources = 1) => {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !evidence.has(id) || !selectedSet.has(evidence.get(id)))) invalid();
    const owners = new Set(ids.map((id) => evidence.get(id)));
    if (owners.size < minimumSources) invalid();
    return owners;
  };
  const checkedClaim = (claim, minimumSources = 1) => {
    if (!object(claim) || !hasText(claim.text) || !statements.has(claim.statement_type)) invalid();
    return checkedRefs(claim.evidence_ids, minimumSources);
  };
  checkedClaim(output.curatorial_note);
  const narrative = output.room_narrative;
  if (!onlyKeys(narrative, ["title", "introduction", "claims"]) || !hasText(narrative.title) || !hasText(narrative.introduction) || !Array.isArray(narrative.claims) || !narrative.claims.length) invalid();
  const covered = new Set();
  for (const claim of narrative.claims) for (const id of checkedClaim(claim)) covered.add(id);
  if (selected.some((id) => !covered.has(id))) invalid();
  if (!Array.isArray(output.connection_claims) || !output.connection_claims.length) invalid();
  const connectionIds = new Set();
  for (const connection of output.connection_claims) {
    if (!hasText(connection?.connection_id) || connectionIds.has(connection.connection_id)) invalid();
    connectionIds.add(connection.connection_id);
    checkedClaim(connection, 2);
  }
  if (output.emerging_direction?.text) checkedClaim(output.emerging_direction);
  const { room_narrative, ...candidate } = structuredClone(output);
  return {
    ...candidate,
    rooms: [{ room_id: plan.room_id, title: room_narrative.title, introduction: room_narrative.introduction, exhibit_ids: [...selected], claims: room_narrative.claims }],
    dialogue_nodes: [
      { node_type: "foyer", room_id: plan.room_id, source_claim_ids: [] },
      { node_type: "core_theme", room_id: plan.room_id, source_claim_ids: [] },
      { node_type: "hidden_connection", room_id: plan.room_id, source_claim_ids: [...connectionIds] },
      { node_type: "ending", room_id: null, source_claim_ids: [] },
    ],
  };
}
