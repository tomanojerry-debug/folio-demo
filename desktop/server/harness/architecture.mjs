const REFERENCE = Object.freeze({
  title: "Google AI Harness Crash Course",
  url: "https://g.dev/ai/ai-harness",
  videoUrl: "https://www.youtube.com/watch?v=2C_CefSQEAQ",
});

const CONTRACT = Object.freeze([
  {
    id: "context-memory", name: "Context & memory", status: "implemented",
    modules: ["desktop/server/harness/context.mjs", "desktop/server/harness/memory.mjs", "desktop/server/harness/page-sessions.mjs", "desktop/server/state.mjs"],
    capabilities: ["conversation-owned event history", "last 20 complete user turns", "bounded extractive working summary", "source-linked cross-session recall", "explicit versioned user memory and revocation", "fixed 24-hour page-session restoration", "independent surface cursors and drafts"],
    validationCommands: ["node --test tests/harness-memory.test.mjs tests/harness-semantic.test.mjs tests/page-sessions.test.mjs tests/companion-page-sessions.test.mjs"],
    validationFiles: ["tests/harness-memory.test.mjs", "tests/harness-semantic.test.mjs", "tests/page-sessions.test.mjs", "tests/companion-page-sessions.test.mjs"],
    scope: "Local single-user memory and context contracts; summary quality and retrieval relevance still need product evaluation.",
  },
  {
    id: "tools-flow", name: "Tools & execution flow", status: "implemented",
    modules: ["desktop/server/harness/skills.mjs", "desktop/agent-skills/read-page/SKILL.md", "desktop/agent-skills/read-page/manifest.json", "desktop/agent-skills/web-search/SKILL.md", "desktop/agent-skills/web-search/manifest.json", "desktop/server/web-search-provider.mjs", "desktop/server/web-search.mjs", "desktop/server/page-content.mjs", "desktop/server/harness/runtime.mjs", "desktop/server/local-curation.mjs", "desktop/server/curation-clusters.mjs", "desktop/server/curation-model-reading.mjs"],
    capabilities: ["manifest-only skill discovery", "on-demand trusted recipe loading", "page-bound single-use read capability", "query-bound single-use public web search", "dated, deduplicated search sources in the requesting conversation", "existing deterministic page reader adapter", "skill version and recipe digest provenance", "untrusted page data separated from trusted recipes", "local evidence gates for automatic and Tag-selected curation", "independent three-source exhibits and six-source continuations with source-version revalidation", "fixed reading templates with pinned citations"],
    validationCommands: ["node --test tests/harness-skills.test.mjs tests/harness-web-search.test.mjs tests/web-search-provider.test.mjs tests/local-curation.test.mjs tests/curation-clusters.test.mjs tests/scoped-curation.test.mjs tests/curation-model-reading.test.mjs"],
    validationFiles: ["tests/harness-skills.test.mjs", "tests/harness-web-search.test.mjs", "tests/web-search-provider.test.mjs", "tests/local-curation.test.mjs", "tests/curation-clusters.test.mjs", "tests/scoped-curation.test.mjs", "tests/curation-model-reading.test.mjs"],
    scope: "Explicit page reading and public web search, plus local curation workflows with confirmed generation from saved evidence.",
  },
  {
    id: "runtime-security", name: "Runtime, security & privacy", status: "implemented",
    modules: ["desktop/server/harness/runtime.mjs", "desktop/server/harness/skills.mjs", "desktop/server/harness/page-sessions.mjs", "desktop/server/service.mjs", "desktop/server/index.mjs", "server/safe-fetch.mjs"],
    capabilities: ["persisted task ownership and bounded execution", "public-source network restrictions", "cancellation and late-result rejection", "atomic page acceptance and request replay", "passive detection cannot authorize a read", "source snapshots do not silently follow navigation", "passive topic reads use local cache", "explicit generation sends bounded topic excerpts", "edition checks reject stale update acceptance and drafts"],
    validationCommands: ["node --test tests/harness-skills.test.mjs tests/page-sessions.test.mjs tests/harness-integration.test.mjs tests/companion-page-sessions.test.mjs"],
    validationFiles: ["tests/harness-skills.test.mjs", "tests/page-sessions.test.mjs", "tests/harness-integration.test.mjs", "tests/companion-page-sessions.test.mjs"],
    scope: "Application-enforced boundaries for the local product; this is not an OS sandbox or a multi-user deployment security claim.",
  },
  {
    id: "evaluation", name: "Evaluation", status: "implemented",
    modules: ["scripts/eval-memory-skills.mjs", "tests/harness-memory.test.mjs", "tests/harness-semantic.test.mjs", "tests/harness-skills.test.mjs", "tests/page-sessions.test.mjs", "tests/harness-integration.test.mjs", "tests/companion-page-sessions.test.mjs", "tests/harness-architecture.test.mjs"],
    capabilities: ["synthetic offline contract fixtures", "per-file subprocess verification", "four-section result summary", "machine-readable result without prompts or user content"],
    validationCommands: ["node scripts/eval-memory-skills.mjs", "node scripts/eval-memory-skills.mjs --json"],
    validationFiles: ["tests/harness-memory.test.mjs", "tests/harness-semantic.test.mjs", "tests/harness-skills.test.mjs", "tests/page-sessions.test.mjs", "tests/harness-integration.test.mjs", "tests/companion-page-sessions.test.mjs", "tests/harness-architecture.test.mjs"],
    scope: "Deterministic contracts only. A passing report is not proof of live model quality, native UI behavior or deployment readiness.",
  },
]);

/** Describe implementation boundaries, never fabricate a historical pass result. */
export function describeHarness({ skills = [], memoryPolicy = {} } = {}) {
  const describedSkills = (Array.isArray(skills) ? skills : []).filter(skill => skill && typeof skill.id === "string").map(skill => ({
    id: skill.id, ...(typeof skill.version === "string" ? { version: skill.version } : {}),
    ...(typeof skill.description === "string" ? { description: skill.description } : {}),
    ...(Array.isArray(skill.capabilities) ? { capabilities: skill.capabilities.filter(value => typeof value === "string") } : {}),
  }));
  const policy = {};
  // Only documented policy metadata is public; no messages, memory entries or keys.
  for (const key of ["version", "recentTurns", "historyTurns", "historyChars", "summaryChars", "recallChars", "recallLimit", "pageSessionTtlMs", "summaryStrategy", "strategy", "retrieval"]) {
    const value = memoryPolicy?.[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") policy[key] = value;
  }
  return {
    version: 2, reference: { ...REFERENCE }, scope: "memory-page-reading-web-search-and-curation",
    verification: { status: "not-run", command: "node scripts/eval-memory-skills.mjs --json", note: "Run verification in the current checkout; static implementation status does not imply passing tests." },
    sections: structuredClone(CONTRACT), skills: describedSkills, memoryPolicy: policy,
  };
}
