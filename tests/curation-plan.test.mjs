import test from "node:test";
import assert from "node:assert/strict";
import { createRoomPlan, assemblePlannedExhibition, CURATION_PLAN_MODE } from "../server/curation-plan.mjs";

function sources(count = 6) {
  return Array.from({ length: count }, (_, index) => ({ collection: { id: `item-${index + 1}`, title: `来源 ${index + 1}` }, extraction: { status: "qualified", evidenceBundle: [{ evidence_id: `evidence-${index + 1}`, text: `来源 ${index + 1} 中实际出现的内容。` }] } }));
}
const themeFor = (items) => ({ evidence_ids: items.map((item) => item.extraction.evidenceBundle[0].evidence_id) });
function narrative(items) {
  const refs = items.map((item) => item.extraction.evidenceBundle[0].evidence_id);
  return {
    status: "candidate", title: "来源与判断", curatorial_lens: "balanced",
    curatorial_note: { text: "这批来源可以放在一起比较。", statement_type: "hypothesis", evidence_ids: refs },
    room_narrative: { title: "共同的问题", introduction: "先分别看每条来源，再比较联系。", claims: refs.map((id, index) => ({ text: `第 ${index + 1} 条来源的具体内容。`, statement_type: "extraction", evidence_ids: [id] })) },
    connection_claims: [{ connection_id: "connection-1", text: "两个来源提供互补的视角。", statement_type: "hypothesis", evidence_ids: refs.slice(0, 2) }],
    open_question: "你更想继续核对哪一条？",
  };
}

test("the recovery plan includes 5–9 qualified sources actually supported by the theme", () => {
  const items = sources(12);
  const plan = createRoomPlan(items, themeFor(items.slice(0, 10)));
  assert.equal(CURATION_PLAN_MODE, "planned_single_room_v1");
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].exhibit_ids, items.slice(0, 9).map((item) => item.collection.id));
  assert.equal(plan[0].evidence_ids.length, 9);
  assert.deepEqual(createRoomPlan(items, themeFor(items.slice(0, 4))), []);
  assert.throws(() => createRoomPlan(items, { evidence_ids: ["invented-evidence"] }), { code: "MODEL_OUTPUT_INVALID" });
});

test("new narrative is assembled into the immutable source plan without mutating model output", () => {
  const items = sources(), plan = createRoomPlan(items, themeFor(items)), output = narrative(items);
  const before = structuredClone(output);
  const result = assemblePlannedExhibition(output, plan, items);
  assert.equal(result.status, "candidate");
  assert.deepEqual(result.rooms[0].exhibit_ids, plan[0].exhibit_ids);
  assert.equal(result.rooms[0].room_id, plan[0].room_id);
  assert.equal(result.rooms[0].claims.length, 6);
  assert.equal(result.room_narrative, undefined);
  assert.deepEqual(new Set(result.rooms.flatMap((room) => room.exhibit_ids)), new Set(items.map((item) => item.collection.id)));
  assert.ok(result.dialogue_nodes.every((node) => node.room_id === null || node.room_id === plan[0].room_id));
  assert.deepEqual(output, before);
});

test("a missing source claim cannot become an apparently complete five-or-six-exhibit room", () => {
  const items = sources(), plan = createRoomPlan(items, themeFor(items));
  const output = narrative(items);
  output.room_narrative.claims.pop();
  assert.throws(() => assemblePlannedExhibition(output, plan, items), { code: "MODEL_OUTPUT_INVALID", statusCode: 502 });
  output.room_narrative.claims = [];
  assert.throws(() => assemblePlannedExhibition(output, plan, items), { code: "MODEL_OUTPUT_INVALID" });
});

test("all narrative and connection references must belong to the selected plan and connections need two sources", () => {
  const items = sources(7), plan = createRoomPlan(items, themeFor(items.slice(0, 6)));
  for (const change of [
    (output) => { output.connection_claims[0].evidence_ids = ["evidence-1", "evidence-7"]; },
    (output) => { output.connection_claims[0].evidence_ids = ["evidence-1"]; },
    (output) => { output.room_narrative.claims[0].evidence_ids = ["invented"]; },
    (output) => { output.curatorial_note.evidence_ids = ["evidence-7"]; },
    (output) => { output.connection_claims[0].statement_type = "confirmed"; },
  ]) {
    const output = narrative(items.slice(0, 6)); change(output);
    assert.throws(() => assemblePlannedExhibition(output, plan, items), { code: "MODEL_OUTPUT_INVALID" });
  }
});

test("legacy invalid rooms payloads and extra layout fields are rejected instead of repaired into success", () => {
  const items = sources(), plan = createRoomPlan(items, themeFor(items));
  for (const field of ["rooms", "rooms_full", "rooms_more", "dialogue_nodes"]) {
    const output = narrative(items); output[field] = [];
    assert.throws(() => assemblePlannedExhibition(output, plan, items), { code: "MODEL_OUTPUT_INVALID" });
  }
  const output = narrative(items);
  output.room_narrative.exhibit_ids = ["item-1"];
  assert.throws(() => assemblePlannedExhibition(output, plan, items), { code: "MODEL_OUTPUT_INVALID" });
  assert.throws(() => assemblePlannedExhibition({ status: "candidate", rooms: [{ exhibit_ids: ["item-1"] }] }, plan, items), { code: "MODEL_OUTPUT_INVALID" });
});

test("unsupported planning inputs and honest downgrade responses retain their failure semantics", () => {
  const items = sources();
  const altered = structuredClone(items); altered[0].extraction.status = "needs_confirmation";
  assert.throws(() => createRoomPlan(altered, themeFor(items)), { code: "MODEL_OUTPUT_INVALID" });
  assert.throws(() => assemblePlannedExhibition(narrative(items), [{ room_id: "main", exhibit_ids: ["item-1"] }], items), { code: "MODEL_OUTPUT_INVALID" });
  const unable = { status: "unable_to_curate", reason_codes: ["no_coherent_structure"] };
  assert.deepEqual(assemblePlannedExhibition(unable, [], items), unable);
});
