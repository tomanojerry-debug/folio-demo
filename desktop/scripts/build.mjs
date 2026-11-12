import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const buildRoot = path.join(projectRoot, 'desktop/.build');
export const appPath = path.join(buildRoot, 'Folio.app');
const buildScript = fileURLToPath(import.meta.url);
const nativeSource = path.join(projectRoot, 'desktop/native/FORME.swift');
const entitlements = path.join(projectRoot, 'desktop/native/FORME.entitlements');
const iconSource = path.join(projectRoot, 'desktop/scripts/app-icon.swift');
const companionAssets = path.join(projectRoot, 'site/curator');
const companionResources = ['companion-shell.png', 'companion-layout.json'];
const exec = promisify(execFile);
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
  });
}

async function nativeFingerprint(identity, architecture) {
  const inputs = [buildScript, nativeSource, entitlements, iconSource, ...companionResources.map(name => path.join(companionAssets, name))];
  const files = await Promise.all(inputs.map(async input => createHash('sha256').update(await readFile(input)).digest('hex')));
  return createHash('sha256').update(JSON.stringify([projectRoot, process.execPath, architecture, identity,
    process.env.DEVELOPER_DIR, process.env.SDKROOT, files])).digest('hex');
}

async function signingIdentity() {
  const configured = process.env.FOLIO_CODESIGN_IDENTITY?.trim() || '-';
  if (configured === '-') return configured;
  const { stdout } = await exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = [...stdout.matchAll(/^\s*\d+\) ([A-F0-9]{40}) "([^\r\n]+)"\s*$/gmi)];
  const matches = identities.filter(([, hash, name]) => hash.toUpperCase() === configured.toUpperCase() || name === configured);
  if (matches.length !== 1) throw new Error('FOLIO_CODESIGN_IDENTITY 必须匹配一个有效的本机代码签名身份。请使用完整名称或证书指纹。');
  return matches[0][1].toUpperCase();
}

function verifySignature(identity) {
  const requirement = identity === '-' ? [] : [`-R=certificate leaf = H"${identity}"`];
  return run('/usr/bin/codesign', ['--verify', '--deep', '--strict', ...requirement, appPath]);
}

export async function build({ reuseNative = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('当前桌面版需要在苹果电脑上构建，网页版收藏馆可在其他系统使用。');
  const contents = path.join(appPath, 'Contents');
  const binary = path.join(contents, 'MacOS/FORME');
  const infoPath = path.join(contents, 'Info.plist');
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const identity = await signingIdentity();
  const fingerprint = await nativeFingerprint(identity, architecture);
  const buildMarker = `<key>FOLIONativeBuildFingerprint</key><string>${fingerprint}</string>`;
  if (reuseNative) {
    const previous = await readFile(infoPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (previous.includes(buildMarker)) {
      const verified = await verifySignature(identity).then(() => true, () => false);
      if (verified) {
        await run(binary, ['--geometry-test']);
        console.log(`FORME_APP_PATH ${appPath}`);
        return appPath;
      }
    }
  }

  await mkdir(path.dirname(binary), { recursive: true });
  await mkdir(path.join(buildRoot, 'module-cache'), { recursive: true });
  const resources = path.join(contents, 'Resources');
  await mkdir(resources, { recursive: true });
  for (const name of companionResources) {
    await copyFile(path.join(companionAssets, name), path.join(resources, name));
  }
  await run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-target', `${architecture}-apple-macosx13.0`, '-O', '-module-cache-path', path.join(buildRoot, 'module-cache'),
    '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'ApplicationServices',
    nativeSource, '-o', binary]);
  const iconRenderer = path.join(buildRoot, 'render-app-icon');
  await run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-module-cache-path', path.join(buildRoot, 'module-cache'),
    '-framework', 'AppKit', iconSource, '-o', iconRenderer]);
  const iconset = path.join(buildRoot, 'Folio.iconset');
  await run(iconRenderer, [iconset, companionAssets]);
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'Folio.icns')]);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>FORME</string>
<key>CFBundleIdentifier</key><string>com.forme.curator.local</string>
<key>CFBundleName</key><string>Folio</string>
<key>CFBundleDisplayName</key><string>Folio</string>
<key>CFBundleIconFile</key><string>Folio</string>
<key>CFBundleVersion</key><string>16</string>
<key>CFBundleShortVersionString</key><string>0.3.9</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppleEventsUsageDescription</key><string>只在你主动关联浏览器页面并使用对话或收藏时，读取所选窗口当前页面的标题和地址。</string>
<key>FORMEProjectRoot</key><string>${xml(projectRoot)}</string>
<key>FORMENodePath</key><string>${xml(process.execPath)}</string>
${buildMarker}
</dict></plist>
`;
  await writeFile(infoPath, plist);
  await run('/usr/bin/codesign', ['--force', '--sign', identity, '--entitlements', entitlements, appPath]);
  await verifySignature(identity);
  await run(binary, ['--geometry-test']);
  console.log(`FORME_APP_PATH ${appPath}`);
  return appPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === buildScript) {
  await build({ reuseNative: process.argv.slice(2).includes('--reuse-native') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
