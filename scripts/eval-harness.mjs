import { spawn } from "node:child_process";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This runner executes injected fixtures only. It does not load .env or call a
// provider, and its summary deliberately excludes prompts, results and state.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, ".data", "harness-eval");
const files = (await readdir(path.join(root, "tests")))
  .filter((name) => /^harness-.*\.test\.mjs$/.test(name))
  .sort()
  .map((name) => `tests/${name}`);
const startedAt = new Date().toISOString();
const started = performance.now();
const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
let textTail = "";
let spawnError = false;
let exitCode = 1;

if (files.length) {
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], {
    cwd: root,
    // Test dependencies must stay injected even on a developer machine that
    // already has provider credentials in its inherited environment.
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    textTail = (textTail + chunk.toString("utf8")).slice(-16384);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  exitCode = await new Promise((resolve) => {
    child.once("error", () => { spawnError = true; resolve(1); });
    child.once("close", (code) => resolve(Number.isInteger(code) ? code : 1));
  });
  for (const key of Object.keys(totals)) {
    const value = [...textTail.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, "gm"))].at(-1)?.[1];
    if (value !== undefined) totals[key] = Number(value);
  }
} else {
  process.stderr.write("No harness test files were found.\n");
}

const passed = files.length > 0 && !spawnError && exitCode === 0
  && totals.tests > 0 && totals.fail === 0 && totals.cancelled === 0;
const summary = {
  version: 1,
  suite: "forme-product-harness",
  fixtureMode: "injected-only",
  realModelCalls: false,
  startedAt,
  completedAt: new Date().toISOString(),
  durationMs: Math.round(performance.now() - started),
  files,
  totals,
  exitCode,
  status: passed ? "passed" : "failed",
  ...(spawnError ? { reason: "TEST_PROCESS_START_FAILED" } : {}),
  ...(!files.length ? { reason: "NO_HARNESS_TESTS" } : {}),
};
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const outputFile = path.join(outputDirectory, "summary.json");
const temporary = `${outputFile}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, outputFile);
process.stdout.write(`Harness evaluation ${summary.status}: ${totals.pass}/${totals.tests} passed. Summary: .data/harness-eval/summary.json\n`);
process.exitCode = passed ? 0 : 1;
