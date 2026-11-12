import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readPageContent } from "../page-content.mjs";
import { safeFetch, validURL } from "../../../server/safe-fetch.mjs";

const READ_ACTIONS = ["read-page", "chat-with-page", "collect-page"];
const SEARCH_ACTION = "search-web";
const SEARCH_RECENCY = ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"];
const MAX_SEARCH_QUERY = 320;
const MAX_SEARCH_CANDIDATES = 30;
const SOURCES = new Set(["attachment", "browser-accessibility", "stored-page-snapshot", "public-page", "manual-text"]);
const STRINGS = Object.freeze({ url: 4000, title: 300, appName: 120, attachmentId: 150, pageRevision: 150,
  text: 40000, selection: 12000, contentSource: 80, browserWindowId: 150, browserTabId: 150, browserProfileId: 150 });
const SNAPSHOT_STRINGS = Object.freeze({ snapshotId: 150, readAt: 40, originalContentSource: 80 });
const OUTPUT_FIELDS = Object.freeze([...Object.keys(STRINGS), ...Object.keys(SNAPSHOT_STRINGS), "contextVersion", "textTruncated", "documentTitle", "resolvedUrl", "readStatus", "readError", "contentQuality"]);
const QUALITY_FIELDS = Object.freeze(["version", "status", "method", "scope", "characterCount", "paragraphCount", "removedLines", "truncated", "warnings", "fallbackFrom", "fallbackReason", "fallbackError"]);
const READ_STATUSES = new Set(["attached_text", "selection_only", "public_page", "unavailable"]);
const fault = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const digest = value => createHash("sha256").update(value).digest("hex");

function freeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

function sameValues(manifestValues, allowed) {
  return Array.isArray(manifestValues) && manifestValues.length === allowed.length
    && allowed.every(value => manifestValues.includes(value));
}

// The executable allowlist is code-owned. A manifest or recipe cannot add tools.
function registeredSkill(id, capabilities, actions) {
  const directory = new URL(`../../agent-skills/${id}/`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.id !== id || manifest.name !== id
      || !/^\d+\.\d+\.\d+$/.test(manifest.version)
      || typeof manifest.description !== "string" || !manifest.description
      || !sameValues(manifest.capabilities, capabilities) || !sameValues(manifest.allowedActions, actions)) {
    throw fault("SKILL_CONTRACT_INVALID", `The ${id} skill manifest does not match its executable contract.`, 500);
  }
  return { directory, manifest:freeze(manifest) };
}

const skillDefinitions = new Map([
  ["read-page", registeredSkill("read-page", ["read-attached-text", "read-selection", "read-public-page"], READ_ACTIONS)],
  ["web-search", registeredSkill("web-search", ["search-public-web"], [SEARCH_ACTION])],
]);
const pageManifest = skillDefinitions.get("read-page").manifest;
const searchManifest = skillDefinitions.get("web-search").manifest;
if (searchManifest.input?.maxQueryCharacters !== MAX_SEARCH_QUERY || searchManifest.output?.maxCandidates !== MAX_SEARCH_CANDIDATES
    || !sameValues(searchManifest.input?.recency, SEARCH_RECENCY)) {
  throw fault("SKILL_CONTRACT_INVALID", "The web-search skill manifest does not match its input and output limits.", 500);
}

function selectedContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fault("SKILL_INPUT_INVALID", "A selected page context is required.");
  const context = {};
  for (const [key, limit] of Object.entries(STRINGS)) {
    if (value[key] === undefined || value[key] === null) continue;
    let item = value[key];
    if (["browserWindowId", "browserTabId"].includes(key) && Number.isSafeInteger(item)) item = String(item);
    if (typeof item !== "string" || item.length > limit || /\u0000/.test(item)) throw fault("SKILL_INPUT_INVALID", `Invalid page context field: ${key}.`);
    context[key] = item.trim();
  }
  if (context.url) context.url = validURL(context.url).href;
  if (context.contentSource && !SOURCES.has(context.contentSource)) throw fault("SKILL_INPUT_INVALID", "Unsupported page text provenance.");
  // These fields come from an accepted server-side snapshot, never a passive
  // browser update. They are provenance only and do not enlarge the capability.
  if (context.contentSource === "stored-page-snapshot") {
    for (const [key, limit] of Object.entries(SNAPSHOT_STRINGS)) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > limit || /\u0000/.test(value[key])) throw fault("SKILL_INPUT_INVALID", `Invalid snapshot metadata field: ${key}.`);
      context[key] = value[key].trim();
    }
    if (context.readAt && !Number.isFinite(Date.parse(context.readAt))) throw fault("SKILL_INPUT_INVALID", "Invalid snapshot read time.");
    if (context.originalContentSource && (!SOURCES.has(context.originalContentSource) || context.originalContentSource === "stored-page-snapshot")) throw fault("SKILL_INPUT_INVALID", "Invalid original snapshot provenance.");
  }
  if (value.contextVersion !== undefined) {
    if (!Number.isSafeInteger(value.contextVersion) || value.contextVersion < 0) throw fault("SKILL_INPUT_INVALID", "Invalid page context version.");
    context.contextVersion = value.contextVersion;
  }
  if (value.textTruncated !== undefined) {
    if (typeof value.textTruncated !== "boolean") throw fault("SKILL_INPUT_INVALID", "Invalid page truncation state.");
    context.textTruncated = value.textTruncated;
  }
  if (!context.url && !context.text && !context.selection) throw fault("SKILL_INPUT_INVALID", "The selected page needs a URL, text or selection.");
  return context;
}

function checkedPageOutput(result) {
  if (!READ_STATUSES.has(result?.readStatus) || !result.contentQuality || typeof result.contentQuality !== "object") throw fault("SKILL_OUTPUT_INVALID", "The page reader returned an invalid result.", 500);
  if ((result.text?.length || 0) > pageManifest.output.maxTextCharacters || (result.selection?.length || 0) > pageManifest.output.maxSelectionCharacters) throw fault("SKILL_OUTPUT_INVALID", "The page reader exceeded its output budget.", 500);
  const output = Object.fromEntries(OUTPUT_FIELDS.filter(key => result[key] !== undefined).map(key => [key, structuredClone(result[key])]));
  output.contentQuality = Object.fromEntries(QUALITY_FIELDS.filter(key => result.contentQuality[key] !== undefined).map(key => [key, structuredClone(result.contentQuality[key])]));
  return output;
}

function selectedSearch({ query, recency }) {
  if (typeof query !== "string" || !query.trim() || query.length > MAX_SEARCH_QUERY || /[\u0000-\u001f\u007f]/u.test(query)
      || !SEARCH_RECENCY.includes(recency)) {
    throw fault("SKILL_INPUT_INVALID", "A bounded public search query and recency are required.");
  }
  return { query, recency };
}

const candidateText = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
function checkedSearchOutput(result) {
  if (!Array.isArray(result)) throw fault("WEB_SEARCH_PROVIDER_ERROR", "The web search tool returned an invalid result.", 502);
  return result.slice(0, MAX_SEARCH_CANDIDATES).flatMap(candidate => {
    const title = candidateText(candidate?.title, 240);
    const url = candidate?.url;
    if (!title.trim() || typeof url !== "string" || url.length > 2048) return [];
    try { validURL(url); } catch { return []; }
    return [{
      title, url,
      snippet:candidateText(candidate.snippet, 800),
      source:candidateText(candidate.source, 100),
      publishedAt:candidateText(candidate.publishedAt, 80),
    }];
  });
}

/**
 * Product-owned skill runtime. Discovery only reads a small manifest; recipes are
 * loaded lazily. The service must mint authorization after validating user intent.
 * HTTP payloads and source text cannot forge or enlarge an execution capability.
 */
export function createSkillRegistry({ fetchPage = safeFetch, searchWeb = null } = {}) {
  if (typeof fetchPage !== "function") throw new TypeError("A page fetch adapter must be a function.");
  if (searchWeb !== null && typeof searchWeb !== "function") throw new TypeError("A web search adapter must be a function.");
  const grants = new WeakMap();
  const loaded = new Map();

  function requireSkill(skillId) {
    const definition = skillDefinitions.get(skillId);
    if (!definition) throw fault("SKILL_NOT_FOUND", "This skill is not available.", 404);
    return definition;
  }

  function describe() { return [...skillDefinitions.values()].map(({ manifest }) => structuredClone(manifest)); }

  async function load(skillId) {
    const { directory, manifest } = requireSkill(skillId);
    if (!loaded.has(skillId)) {
      const recipe = (async () => {
        const instructions = await readFile(new URL("SKILL.md", directory), "utf8");
        if (Buffer.byteLength(instructions) > 32768) throw fault("SKILL_CONTRACT_INVALID", "The skill recipe exceeds its loading budget.", 500);
        const frontmatter = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---(?:\r?\n|$)/.exec(instructions);
        if (!frontmatter || frontmatter[1] !== manifest.name || frontmatter[2] !== manifest.description) throw fault("SKILL_CONTRACT_INVALID", "The skill recipe and manifest disagree.", 500);
        return freeze({ ...structuredClone(manifest), instructions, digest: digest(instructions), trust: "trusted-application-recipe" });
      })().catch(error => { loaded.delete(skillId); throw error; });
      loaded.set(skillId, recipe);
    }
    return loaded.get(skillId);
  }

  function authorize({ action, context, query, recency, requestId } = {}) {
    const isSearch = action === SEARCH_ACTION;
    if (!isSearch && !READ_ACTIONS.includes(action)) throw fault("SKILL_AUTHORIZATION_REQUIRED", "A verified user action is required to use this skill.", 403);
    if (requestId !== undefined && (typeof requestId !== "string" || !requestId || requestId.length > 150 || /\u0000/.test(requestId))) throw fault("SKILL_INPUT_INVALID", "Invalid skill request identity.");
    const skillId = isSearch ? "web-search" : "read-page";
    const selected = isSearch ? selectedSearch({ query, recency }) : selectedContext(context);
    const token = Object.freeze({ skillId, action, ...(requestId ? { requestId } : {}) });
    grants.set(token, { skillId, fingerprint: digest(JSON.stringify(selected)), used: false });
    return token;
  }

  async function execute(skillId, { context, query, recency, authorization } = {}, { signal } = {}) {
    requireSkill(skillId);
    const grant = authorization && typeof authorization === "object" ? grants.get(authorization) : undefined;
    if (grant?.skillId !== skillId) throw fault("SKILL_AUTHORIZATION_REQUIRED", "A verified user action is required to use this skill.", 403);
    if (grant.used) throw fault("SKILL_AUTHORIZATION_USED", "This skill capability has already been used.", 409);
    const isSearch = skillId === "web-search";
    const selected = isSearch ? selectedSearch({ query, recency }) : selectedContext(context);
    if (grant.fingerprint !== digest(JSON.stringify(selected))) throw fault("SKILL_SOURCE_CHANGED", "The skill input changed after authorization.", 409);
    signal?.throwIfAborted();
    grant.used = true;
    const recipe = await load(skillId);
    signal?.throwIfAborted();
    const skill = { id:recipe.id, version:recipe.version, digest:recipe.digest };
    if (isSearch) {
      if (!searchWeb) throw fault("WEB_SEARCH_UNAVAILABLE", "网页搜索暂未配置。", 503);
      const result = await searchWeb({ ...selected, signal });
      signal?.throwIfAborted();
      return { candidates:checkedSearchOutput(result), skill };
    }
    const result = await readPageContent(selected, { fetchPage, signal });
    signal?.throwIfAborted();
    return { ...checkedPageOutput(result), skill };
  }

  return Object.freeze({ describe, load, authorize, execute });
}
