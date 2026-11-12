import { fault } from "../errors.mjs";

const productPrompts = Object.freeze({
  "CALL-P001": "P-001",
  "CALL-P002": "P-002",
  "CALL-P003": "P-003",
  "CALL-P004": "P-004",
  "CALL-P005": "P-005",
  "CALL-P006": "P-006",
  "CALL-PEVAL": "P-EVAL",
});

export function getCall(id) {
  if (id === "CALL-VISION01") return { kind: "vision" };
  if (Object.hasOwn(productPrompts, id)) {
    return { kind: id === "CALL-PEVAL" ? "evaluation" : "product", promptId: productPrompts[id] };
  }
  throw fault("INVALID_REQUEST");
}
