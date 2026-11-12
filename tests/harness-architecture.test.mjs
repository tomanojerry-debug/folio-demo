import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { describeHarness } from "../desktop/server/harness/architecture.mjs";

test("the public harness contract follows the four course boundaries without claiming unrun verification", () => {
  const architecture = describeHarness();
  assert.equal(architecture.version, 2);
  assert.deepEqual(architecture.sections.map(section => section.id), ["context-memory", "tools-flow", "runtime-security", "evaluation"]);
  assert.equal(architecture.reference.url, "https://g.dev/ai/ai-harness");
  assert.equal(architecture.verification.status, "not-run");
  for (const section of architecture.sections) {
    assert.equal(section.status, "implemented");
    assert.ok(section.modules.length);
    assert.ok(section.capabilities.length);
    assert.ok(section.validationCommands.length);
    assert.ok(section.validationFiles.length);
    assert.equal(typeof section.scope, "string");
    assert.equal(section.verified, undefined);
  }
});

test("architecture projections expose only policy and skill metadata, never attached private data", () => {
  const source = { id: "read-page", version: "1.0.0", description: "Read the selected page", capabilities: ["read-public-page"], instructions: "Recipe body", secret: "hidden" };
  const report = describeHarness({ skills: [source], memoryPolicy: { recentTurns: 20, pageSessionTtlMs: 86400000, entries: ["private memory"], apiKey: "secret", summary: "private summary" } });
  assert.deepEqual(report.skills, [{ id: "read-page", version: "1.0.0", description: "Read the selected page", capabilities: ["read-public-page"] }]);
  assert.deepEqual(report.memoryPolicy, { recentTurns: 20, pageSessionTtlMs: 86400000 });
  assert.doesNotMatch(JSON.stringify(report), /private memory|private summary|apiKey|Recipe body|hidden/);
  report.sections[0].modules.push("caller mutation");
  report.skills[0].capabilities.push("write-memory");
  assert.equal(describeHarness().sections[0].modules.includes("caller mutation"), false);
  assert.deepEqual(source.capabilities, ["read-public-page"]);
});

test("every declared implementation module exists in this checkout", async () => {
  const files = [...new Set(describeHarness().sections.flatMap(section => section.modules))];
  await Promise.all(files.map(file => access(new URL(`../${file}`, import.meta.url))));
});
