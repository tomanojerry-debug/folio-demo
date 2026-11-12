import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describeHarness } from "../desktop/server/harness/architecture.mjs";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const arguments_ = process.argv.slice(2);
if (arguments_.some(argument => !["--json", "--help"].includes(argument))) {
  process.stderr.write("Usage: node scripts/eval-memory-skills.mjs [--json]\n");
  process.exitCode = 2;
} else if (arguments_.includes("--help")) {
  process.stdout.write("Verify the memory, page-reading and curation harness using local test fixtures. No live model or private library is loaded.\nUsage: node scripts/eval-memory-skills.mjs [--json]\n");
} else {
  const startedAt = new Date().toISOString();
  const architecture = describeHarness();
  const files = [...new Set(architecture.sections.flatMap(section => section.validationFiles))];
  const environment = { ...process.env, NODE_ENV: "test", FORCE_COLOR: "0", KNOWLEDGE_EMBEDDING_BACKEND: "disabled" };
  // Child tests use injected models and temporary data. Do not propagate account
  // credentials or an application's configured private data directory into them.
  for (const key of Object.keys(environment)) if (/(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD)$/i.test(key) || /^FORME_(?:DATA|DESKTOP_DATA|SESSION)_/.test(key)) delete environment[key];

  function verify(file) {
    return new Promise(resolve => {
      let output = "", timedOut = false, settled = false;
      const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], { cwd: projectDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
      const collect = chunk => { if (output.length < 2_000_000) output += String(chunk).slice(0, 2_000_000 - output.length); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 180_000);
      const finish = (exitCode, errorCode) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const count = label => Number(new RegExp(`^# ${label} (\\d+)$`, "m").exec(output)?.[1] || 0);
        const counts = { tests: count("tests"), passed: count("pass"), failed: count("fail"), skipped: count("skipped") };
        const passed = exitCode === 0 && !timedOut && counts.tests > 0 && counts.passed > 0 && counts.failed === 0;
        resolve({ file, status: passed ? "passed" : "failed", exitCode: Number.isInteger(exitCode) ? exitCode : 1,
          ...counts,
          ...(timedOut ? { errorCode: "EVALUATION_TIMEOUT" } : errorCode ? { errorCode } : {}) });
      };
      child.on("error", error => finish(1, /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "PROCESS_START_FAILED"));
      child.on("close", code => finish(code));
    });
  }

  const checks = await Promise.all(files.map(verify));
  const byFile = new Map(checks.map(check => [check.file, check]));
  const sections = architecture.sections.map(section => ({ id: section.id, name: section.name,
    status: section.validationFiles.every(file => byFile.get(file)?.status === "passed") ? "passed" : "failed",
    checks: section.validationFiles,
  }));
  const passed = checks.every(check => check.status === "passed");
  const report = { version: 1, architectureVersion: architecture.version, scope: architecture.scope,
    startedAt, finishedAt: new Date().toISOString(), status: passed ? "passed" : "failed", exitCode: passed ? 0 : 1,
    dataMode: "synthetic-temporary-fixtures", sections, checks };
  if (arguments_.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    process.stdout.write("Memory, page-reading and curation harness verification\n");
    for (const section of sections) process.stdout.write(`${section.status.toUpperCase()} ${section.id}: ${section.name}\n`);
    for (const check of checks) process.stdout.write(`${check.status.toUpperCase()} ${check.file}: ${check.passed}/${check.tests} tests (exit ${check.exitCode})\n`);
    process.stdout.write(`Overall: ${report.status}; exitCode=${report.exitCode}\n`);
  }
  process.exitCode = report.exitCode;
}
