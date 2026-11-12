import { readFile } from "node:fs/promises";
import { fault } from "../errors.mjs";

const files = Object.freeze({
  "P-BASE": "P-BASE.md",
  "P-001": "P-001-content-understanding.md",
  "P-002": "P-002-theme-connection.md",
  "P-003": "P-003-exhibition-generation.md",
  "P-003-PLANNED": "P-003-planned-exhibition.md",
  "P-004": "P-004-curatorial-dialogue.md",
  "P-005": "P-005-feedback-interpretation.md",
  "P-006": "P-006-personal-thought-note.md",
  "P-EVAL": "P-EVAL-quality-evaluator.md",
});

function readPrompt(id) {
  if (!Object.hasOwn(files, id)) throw fault("INVALID_REQUEST");
  return readFile(new URL(`../prompts/${files[id]}`, import.meta.url), "utf8");
}

export async function loadProductPrompt(id) {
  const document = (await readPrompt(id)).trim();
  if (id === "P-EVAL") return { system: document };
  return { system: (await readPrompt("P-BASE")).trim(), capability: document };
}
