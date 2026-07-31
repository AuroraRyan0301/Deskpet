// Static server for the app. Sends the correct wasm MIME type and the isolation
// headers, which `python3 -m http.server` does not — MediaPipe's streaming compile
// needs application/wasm. The e2e check and the Electron shell both start this same
// server, so what you run locally is what was tested.
//
//   node serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
};

// Hosts the slow-loop proxy will forward to. An open forwarder on localhost is a
// liability even bound to 127.0.0.1, so the allowlist is not optional.
const PROXY_ALLOW = [
  /^api\.anthropic\.com$/i,
  /^api\.chatanywhere\.(tech|org)$/i,
  /^(127\.0\.0\.1|localhost|host\.docker\.internal)$/i,
];

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    // A frame at 384px/q0.7 is well under this; anything larger is a mistake.
    if (size > 12 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

// The gateway (and api.anthropic.com) send no CORS headers, so the renderer cannot
// call them directly — the preflight is rejected before the request is even made.
// The page posts here instead, same-origin, and Node forwards it.
async function handleProxy(req, res, quiet) {
  if (req.method !== 'POST') { res.writeHead(405).end('POST only'); return; }
  let spec;
  try {
    spec = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `bad proxy envelope: ${e.message}` }));
    return;
  }
  let target;
  try {
    target = new URL(spec.url);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy: url 无法解析' }));
    return;
  }
  if (!PROXY_ALLOW.some((re) => re.test(target.hostname))) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `proxy: 不允许的目标主机 ${target.hostname}` }));
    return;
  }
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) },
      body: JSON.stringify(spec.body ?? {}),
      signal: AbortSignal.timeout(Number(spec.timeoutMs) || 30000),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
    if (!quiet) console.log(`proxy ${target.host} -> ${upstream.status}`);
  } catch (e) {
    // 502 keeps "the upstream failed" distinct from "the proxy rejected you".
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `proxy upstream: ${e.message}` }));
    if (!quiet) console.log(`proxy ${target.host} -> failed: ${e.message}`);
  }
}

// ---- voice bridge for the browser ----
//
// The web page cannot spawn a child process, so without this it has no voice input at all.
// The obvious alternative, the Web Speech API, ships microphone audio to a vendor's servers
// — the exact opposite of the fast loop's point — so instead the *server* owns the sidecar
// and streams its lines to the page over Server-Sent Events.
//
// A side effect worth noting: the browser never touches the microphone, so it never prompts
// for microphone permission. The grant belongs to whatever launched `npm run serve`.
let voiceProc = null;
const voiceClients = new Set();

function voiceBroadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of voiceClients) {
    try { res.write(payload); } catch { voiceClients.delete(res); }
  }
}

async function startVoice(quiet) {
  if (voiceProc) return { ok: true, already: true };
  const bin = join(HERE, 'native', 'voiced');
  if (!existsSync(bin)) {
    voiceBroadcast({ type: 'error', code: 'not-built', message: `no sidecar at ${bin} — run native/build.sh` });
    return { ok: false, reason: 'not-built' };
  }
  const { spawn } = await import('node:child_process');
  // The browser owns the microphone (getUserMedia, with the browser's own permission
  // prompt and echo cancellation) and streams PCM here; the sidecar never opens a device.
  const proc = spawn(bin, ['--net-audio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  voiceProc = proc;
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      try { voiceBroadcast(JSON.parse(line)); }
      catch { voiceBroadcast({ type: 'error', code: 'bad-line', message: line.slice(0, 200) }); }
    }
  });
  proc.stderr.on('data', (d) => { if (!quiet) process.stderr.write(`voiced: ${d}`); });
  proc.on('close', (code) => {
    voiceProc = null;
    voiceBroadcast({ type: 'stopped', code });
  });
  proc.on('error', (err) => {
    voiceProc = null;
    voiceBroadcast({ type: 'error', code: 'spawn-failed', message: err.message });
  });
  return { ok: true };
}

function stopVoice() {
  if (!voiceProc) return { ok: true, already: true };
  try { voiceProc.stdin.write('{"op":"quit"}\n'); } catch { /* already gone */ }
  const proc = voiceProc;
  setTimeout(() => { if (proc && !proc.killed) proc.kill('SIGTERM'); }, 1500);
  return { ok: true };
}

function voiceContext(strings) {
  if (!voiceProc?.stdin?.writable) return { ok: false };
  try {
    voiceProc.stdin.write(`${JSON.stringify({ op: 'context', strings })}\n`);
    return { ok: true };
  } catch { return { ok: false }; }
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c);
  }
  if (n === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleVoice(url, req, res, quiet) {
  // Only loopback may drive the microphone. The static server is otherwise harmless, but
  // this route starts a recording process, so it must not be reachable from the network.
  const remote = req.socket.remoteAddress ?? '';
  if (!/^(::1|::ffff:127\.|127\.)/.test(remote)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('voice control is loopback-only');
    return true;
  }
  if (url.pathname === '/_voice/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    voiceClients.add(res);
    req.on('close', () => voiceClients.delete(res));
    return true;
  }
  if (url.pathname === '/_voice/start') {
    const r = await startVoice(quiet);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r));
    return true;
  }
  if (url.pathname === '/_voice/stop') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stopVoice()));
    return true;
  }
  if (url.pathname === '/_voice/audio') {
    // Raw little-endian int16 16 kHz mono PCM from the page, forwarded as a base64 line.
    // ~250 ms per chunk is ~8 KB; the 1 MB cap is pure paranoia.
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 1024 * 1024) { res.writeHead(413); res.end(); return true; }
      chunks.push(c);
    }
    if (voiceProc?.stdin?.writable && n > 0) {
      try {
        voiceProc.stdin.write(`${JSON.stringify({ op: 'audio', pcm: Buffer.concat(chunks).toString('base64') })}\n`);
      } catch { /* process going away; close handler deals with it */ }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return true;
  }
  if (url.pathname === '/_voice/context') {
    let body = null;
    try { body = await readJson(req); } catch { /* ignore, treated as empty */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(voiceContext(Array.isArray(body?.strings) ? body.strings.slice(0, 200) : [])));
    return true;
  }
  return false;
}

export function createStatic({ root = HERE, quiet = false } = {}) {
  return createServer(async (req, res) => {
    const started = Date.now();
    let path = root;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/_llm') { await handleProxy(req, res, quiet); return; }
      if (url.pathname.startsWith('/_voice/')) {
        if (await handleVoice(url, req, res, quiet)) return;
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      path = join(root, rel === '/' ? 'index.html' : rel);
      if (!path.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(path);
      if (info.isDirectory()) path = join(path, 'index.html');
      const buf = await readFile(path);
      res.writeHead(200, {
        'content-type': MIME[extname(path)] ?? 'application/octet-stream',
        'content-length': buf.length,
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
      });
      res.end(buf);
      if (!quiet) console.log(`200 ${req.url} (${buf.length}B, ${Date.now() - started}ms)`);
    } catch (e) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      if (!quiet) console.log(`404 ${req.url} — ${e.code ?? e.message}`);
    }
  });
}

// Port 0 asks the OS for a free port, which is what the Electron shell wants — it must
// not collide with a `npm run serve` the user already has open.
export function startStatic({ port = 0, root = HERE, quiet = false } = {}) {
  const server = createStatic({ root, quiet });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const PORT = Number(process.argv[2] ?? 8765);
  const server = createStatic();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用。换一个：node serve.mjs 8766`);
    } else {
      console.error(e.message);
    }
    process.exit(1);
  });
  // Bind dual-stack so both http://localhost and http://127.0.0.1 work regardless of
  // how the browser orders A/AAAA records — browsers do not always agree with curl.
  server.listen(PORT, () => {
    console.log('\n  Desk Pet 在跑：');
    console.log(`    http://localhost:${PORT}`);
    console.log(`    http://127.0.0.1:${PORT}\n`);
    console.log(`  serving ${HERE}`);
    console.log('  Ctrl-C 停止\n');
  });
}
