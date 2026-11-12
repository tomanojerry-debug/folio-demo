import { execFile, spawn } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { appVersion, build, buildRoot, projectRoot } from './build.mjs';

const exec = promisify(execFile);
const local = process.argv.slice(2).includes('--local');
const nodeArchitecture = process.arch;
const macArchitecture = nodeArchitecture === 'x64' ? 'x86_64' : nodeArchitecture;
const notaryProfile = process.env.FOLIO_NOTARY_PROFILE?.trim();
const runtimeRoots = ['desktop/agent-skills', 'desktop/server', 'server', 'site', 'worker', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code ?? signal}`)));
  });
}

async function copyRuntimeSources(destination) {
  // Only files already reviewed for this public repository are eligible for the bundle.
  const { stdout } = await exec('/usr/bin/git', ['ls-files', '-z', '--', ...runtimeRoots], { cwd: projectRoot, maxBuffer: 4_000_000 });
  const files = stdout.split('\0').filter(Boolean);
  if (!files.includes('desktop/server/index.mjs') || !files.includes('site/curator/index.html')) {
    throw new Error('请在公开 Folio Git 检出目录中构建安装包。');
  }
  for (const file of files) {
    if (file.split('/').some(part => part.startsWith('.') || part === 'node_modules')) continue;
    const source = path.join(projectRoot, file);
    const target = path.join(destination, file);
    if (!(await lstat(source)).isFile()) throw new Error(`安装包的运行文件必须是普通文件：${file}`);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

async function copyDependencies(destination) {
  const dependencies = path.join(projectRoot, 'node_modules');
  const bindingRoot = path.join('onnxruntime-node', 'bin', 'napi-v6');
  const targetBinding = path.join(bindingRoot, 'darwin', nodeArchitecture);
  await cp(dependencies, destination, {
    recursive: true,
    filter: async source => {
      const relative = path.relative(dependencies, source);
      if (relative.split(path.sep).some(part => part.startsWith('.'))) return false;
      if (relative.startsWith(bindingRoot + path.sep) &&
          !targetBinding.startsWith(relative + path.sep) &&
          relative !== targetBinding &&
          !relative.startsWith(targetBinding + path.sep)) return false;
      if ((await lstat(source)).isSymbolicLink()) throw new Error(`运行依赖不能包含符号链接：${relative}`);
      return true;
    },
  });
}

async function signBindings(directory, identity) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await signBindings(file, identity);
    else if (/\.(?:dylib|node)$/.test(entry.name)) {
      const timestamp = identity === '-' ? [] : ['--timestamp'];
      await run('/usr/bin/codesign', ['--force', '--sign', identity, ...timestamp, file]);
    }
  }
}

async function prepareRuntime(resources, staging, { identity, runtimeSignature }) {
  const runtime = path.join(resources, 'runtime');
  const sourceNode = await realpath(process.execPath);
  const node = path.join(runtime, 'node/bin/node');
  const dependencies = path.join(runtime, 'node_modules');
  await mkdir(path.dirname(node), { recursive: true });
  await copyFile(sourceNode, node);
  await copyFile(path.join(path.dirname(sourceNode), '../LICENSE'), path.join(runtime, 'node/LICENSE'));
  await copyRuntimeSources(runtime);
  await copyDependencies(dependencies);

  const jitEntitlements = path.join(staging, 'node.entitlements');
  await writeFile(jitEntitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>
`);
  await run('/usr/bin/codesign', ['--force', '--sign', identity, ...runtimeSignature, '--entitlements', jitEntitlements, node]);
  await signBindings(dependencies, identity);
  await run(node, ['--input-type=module', '-e', 'await import("./desktop/server/index.mjs"); await import("sharp"); await import("onnxruntime-node");'], { cwd: runtime, env: { PATH: '/usr/bin:/bin' } });
  return identity;
}

async function createPackage() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(nodeArchitecture) || process.versions.node.split('.')[0] !== '22') {
    throw new Error('请使用 Node.js 22 在目标架构的 Mac 上构建 Folio 安装包。');
  }
  if (!local && !process.env.FOLIO_CODESIGN_IDENTITY?.trim()) throw new Error('请设置 FOLIO_CODESIGN_IDENTITY 指定 Developer ID Application 证书。');
  if (!local && !notaryProfile) throw new Error('请设置 FOLIO_NOTARY_PROFILE 指定 Apple 公证钥匙串配置。');
  await mkdir(buildRoot, { recursive: true });
  const staging = await mkdtemp(path.join(buildRoot, 'package-'));
  const volume = path.join(staging, 'volume');
  const fileName = `Folio-${appVersion}-macOS-${macArchitecture}${local ? '-local' : ''}.dmg`;
  const image = path.join(staging, fileName);
  let signingIdentity;
  try {
    await mkdir(volume);
    await build({
      output: path.join(volume, 'Folio.app'),
      workDirectory: path.join(staging, 'native-build'),
      local,
      async prepareRuntime(resources, signing) {
        signingIdentity = await prepareRuntime(resources, staging, signing);
      },
    });
    await symlink('/Applications', path.join(volume, 'Applications'));
    await run('/usr/bin/hdiutil', ['create', '-volname', 'Folio', '-srcfolder', volume, '-format', 'UDZO', image]);
    if (!local) {
      await run('/usr/bin/codesign', ['--force', '--sign', signingIdentity, '--timestamp', image]);
      await run('/usr/bin/xcrun', ['notarytool', 'submit', image, '--keychain-profile', notaryProfile, '--wait']);
      await run('/usr/bin/xcrun', ['stapler', 'staple', image]);
      await run('/usr/bin/xcrun', ['stapler', 'validate', image]);
    }
    await run('/usr/bin/hdiutil', ['verify', image]);
    const output = path.join(buildRoot, fileName);
    await rename(image, output);
    console.log(`FOLIO_DMG_PATH ${output}`);
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 4 });
  }
}

await createPackage().catch(error => { console.error(error.message); process.exitCode = 1; });
