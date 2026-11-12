import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicit offline integration check. Keep native inference in a child process:
// a fatal addon abort must become a failed check, not kill the invoking process.
// ORT 1.21's multi-worker native state crashed when both models were loaded:
// https://github.com/microsoft/onnxruntime/issues/24486
// The thread-safe binding fix shipped in ORT 1.22:
// https://github.com/microsoft/onnxruntime/pull/24366
const filename = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const cacheDirectory = path.resolve(argument('cache-dir') || path.join(projectRoot, '.data/knowledge-models'));
const rounds = Number(argument('rounds') || 12);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('--rounds must be between 1 and 100.');

async function exercise() {
  const [{ createLocalKnowledgeEmbedder }, { createLocalKnowledgeReranker }] = await Promise.all([
    import('../desktop/server/knowledge/local-embeddings.mjs'),
    import('../desktop/server/knowledge/local-reranker.mjs'),
  ]);
  const started = performance.now();
  let embeddingCalls = 0, rerankingCalls = 0, heartbeat = 0;
  const timer = setInterval(() => { heartbeat++; }, 10);
  const clients = [];
  try {
    for (let lifecycle = 0; lifecycle < 2; lifecycle++) {
      const embedder = createLocalKnowledgeEmbedder({ directory: projectRoot, cacheDirectory, localFilesOnly: true, timeoutMs: 30000 });
      const reranker = createLocalKnowledgeReranker({ directory: projectRoot, cacheDirectory, localFilesOnly: true, timeoutMs: 30000 });
      clients.push(embedder, reranker);
      try {
        for (let round = 0; round < rounds; round++) {
          const [vectors, scored] = await Promise.all([
            embedder.embed(['窗户把自然光带入房间。', 'Windows bring daylight into the room.', `无关的咖啡烘焙记录 ${round}`], { role: round % 2 ? 'query' : 'passage' }),
            reranker.rerank('如何利用窗户改善室内采光？', [
              { id: 'related', text: `窗户朝向与室内采光\n阳光通过窗户进入房间，遮阳与阅读位置影响室内明暗。第 ${round} 次检查。` },
              { id: 'unrelated', text: '咖啡烘焙记录\n咖啡豆的酸度、香气与烘焙温度有关。' },
            ]),
          ]);
          embeddingCalls++; rerankingCalls++;
          if (vectors.length !== 3 || vectors.some(vector => vector.length !== 384 || vector.some(value => !Number.isFinite(value)) || Math.abs(Math.hypot(...vector) - 1) > 0.0001)) throw new Error('Invalid local embedding output.');
          const byId = new Map(scored.map(row => [row.id, row]));
          if (scored.length !== 2 || scored.some(row => !Number.isFinite(row.logit) || row.scoreKind !== 'sigmoid_relevance_logit') || !(byId.get('related')?.logit > byId.get('unrelated')?.logit)) throw new Error('Invalid local relevance output.');
        }
      } finally { await Promise.all([embedder.close(), reranker.close()]); }
    }
  } finally {
    clearInterval(timer);
    await Promise.allSettled(clients.map(client => client.close()));
  }
  return { passed: true, realModelCalls: true, network: 'disabled; cached model files only', syntheticFixtures: true,
    node: process.version, platform: process.platform, arch: process.arch,
    onnxruntime: require('onnxruntime-node/package.json').version,
    transformers: JSON.parse(await readFile(new URL('../node_modules/@huggingface/transformers/package.json', import.meta.url), 'utf8')).version,
    modelWorkers: 2, lifecycles: 2, roundsPerLifecycle: rounds, embeddingCalls, rerankingCalls,
    elapsedMs: Math.round(performance.now() - started), heartbeatTicks: heartbeat, cacheDirectory };
}

if (process.argv.includes('--child')) {
  try { process.stdout.write(`${JSON.stringify(await exercise())}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ passed: false, code: error?.code || 'LOCAL_RUNTIME_CHECK_FAILED', message: String(error?.message || 'Local runtime check failed.').slice(0, 200) })}\n`);
    process.exitCode = 1;
  }
} else {
  const child = spawn(process.execPath, [filename, '--child', `--cache-dir=${cacheDirectory}`, `--rounds=${rounds}`], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', expired = false;
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-100000); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 60000);
  let result;
  try {
    const outcome = await new Promise(resolve => {
      child.once('error', error => resolve({ error: error.code || 'CHILD_PROCESS_FAILED' }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    let report;
    try { report = JSON.parse(stdout.trim().split('\n').at(-1)); } catch {}
    result = { ...(report || {}), passed: outcome.code === 0 && report?.passed === true, childExitCode: outcome.code ?? null,
      childSignal: outcome.signal || null, ...(expired ? { timeout: true } : {}), ...(outcome.error ? { error: outcome.error } : {}),
      ...((outcome.code !== 0 || !report?.passed) && stderr ? { diagnostic: stderr } : {}) };
  } finally { clearTimeout(timer); }
  const output = argument('output');
  if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}
