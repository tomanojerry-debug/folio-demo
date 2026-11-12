import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = new URL('../desktop/server/knowledge/', import.meta.url);
const modules = (await readdir(directory)).filter(name => name.endsWith('.mjs')).sort().map(name => fileURLToPath(new URL(name, directory)));
modules.push(fileURLToPath(new URL('../site/curator/knowledge-panel.js', import.meta.url)));
for (const filename of modules) {
  const result = spawnSync(process.execPath, ['--check', filename], { stdio:'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Knowledge syntax: ${modules.length} modules passed.`);
