import { spawn } from 'node:child_process';
import { build } from './build.mjs';

const app = await build({ reuseNative: true });
// This launcher is for the person using the project. Automated UI verification
// launches the prepared .app through the computer-use surface instead.
const mode = process.argv.includes('--personal') ? ['--args', '--personal'] : [];
const child = spawn('/usr/bin/open', ['-a', app, ...mode], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { if (code) process.exitCode = code; });
