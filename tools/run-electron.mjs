// Launches the Electron shell with a clean environment.
//
// Some terminals and tool harnesses export ELECTRON_RUN_AS_NODE=1. When that is set,
// the Electron binary starts as plain Node: `app` is undefined, `require('electron')`
// returns the path to the binary instead of the API, and no window ever appears. The
// failure looks like a bug in main.mjs, so strip the variable here rather than relying
// on the shell.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const electronPath = require('electron');

if (typeof electronPath !== 'string') {
  console.error('无法解析 electron 可执行文件，先跑 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [join(ROOT, 'electron', 'main.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: ROOT,
});

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
