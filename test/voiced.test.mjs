import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Contract test for the Swift voice sidecar. The JS side is written against this protocol,
// so it is pinned here rather than trusted to stay stable.
//
// It runs over test/fixtures/voice.wav instead of the microphone. Verifying through the
// speakers into the mic was tried first and produced contradictory results — it depends on
// output routing, system volume and room acoustics, none of which a test should care about.
// The file path exercises the identical analyzer plumbing (same start, same results stream,
// same emitters), so this genuinely covers the live path.
//
// The fixture is ~9 s and playback is paced to the wall clock on purpose: a burst read lets
// the analyzer run ahead of real time, which would make any timing assertion here describe
// throughput rather than the streaming lag the design depends on.

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, '..', 'native', 'voiced');
const fixture = join(here, 'fixtures', 'voice.wav');

// Absent on a fresh checkout — the binary is not committed. Skipping beats failing, but the
// skip has to be loud enough that nobody mistakes an unbuilt sidecar for a passing suite.
const built = existsSync(binary);

function runSidecar(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    const bad = [];
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`sidecar did not exit within ${timeoutMs}ms; got ${lines.length} lines`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d;
      const parts = stdout.split('\n');
      stdout = parts.pop();
      for (const p of parts) {
        if (!p.trim()) continue;
        try { lines.push(JSON.parse(p)); } catch { bad.push(p); }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stdout.trim()) {
        try { lines.push(JSON.parse(stdout)); } catch { bad.push(stdout); }
      }
      resolve({ code, lines, bad, stderr });
    });
    proc.stdin.end();
  });
}

test('sidecar 把 WAV 转成协议里约定的 JSON 行', { skip: built ? false : 'native/voiced 未构建，先跑 native/build.sh' }, async () => {
  const { code, lines, bad, stderr } = await runSidecar([fixture]);
  assert.equal(bad.length, 0, `有解析不了的输出行：${bad.slice(0, 2).join(' | ')}`);
  assert.equal(code, 0, `退出码 ${code}，stderr: ${stderr.slice(0, 300)}`);

  const errors = lines.filter((l) => l.type === 'error');
  assert.deepEqual(errors.map((e) => e.message ?? e.code), [], '不该有 error 行');

  const ready = lines.find((l) => l.type === 'ready');
  assert.ok(ready, '必须先发 ready');
  assert.equal(ready.channels, 1);
  assert.ok(ready.sampleRate > 0, 'ready 要带分析器采样率');
  assert.ok(ready.durationSec > 5, `fixture 应该有几秒长，实际 ${ready.durationSec}`);

  // ready must come first: the consumer configures itself from it before handling text.
  assert.equal(lines[0].type, 'ready', `第一行应是 ready，实际 ${lines[0].type}`);
});

test('partial 流式增长，final 收口', { skip: built ? false : 'native/voiced 未构建' }, async () => {
  const { lines } = await runSidecar([fixture]);
  const partials = lines.filter((l) => l.type === 'partial');
  const finals = lines.filter((l) => l.type === 'final');

  // The fast path is the whole reason the sidecar exists; a build that only emitted finals
  // would look fine to a human watching the log and be useless to the reflex tier.
  assert.ok(partials.length > 10, `partial 太少（${partials.length}），快路径没在工作`);
  assert.ok(finals.length > 0, '至少要有一个 final');
  assert.ok(partials.length > finals.length, 'partial 应该远多于 final');

  for (const l of [...partials, ...finals]) {
    assert.equal(typeof l.text, 'string');
    assert.equal(typeof l.t, 'number', '每行都要带单调时钟毫秒，消费端要用它算延时');
  }

  // Monotonic timestamps *in emission order*: the consumer computes deltas from them, so
  // going backwards would silently produce negative latencies rather than an obvious
  // failure. Must be checked on the ordered stream — concatenating the two filtered arrays
  // is trivially non-monotonic and says nothing about the protocol.
  const ts = lines.filter((l) => l.type === 'partial' || l.type === 'final').map((l) => l.t);
  for (let i = 1; i < ts.length; i += 1) {
    assert.ok(ts[i] >= ts[i - 1], `时间戳倒流：${ts[i - 1]} -> ${ts[i]}`);
  }
});

test('fixture 里的短命令被真的识别出来了', { skip: built ? false : 'native/voiced 未构建' }, async () => {
  const { lines } = await runSidecar([fixture]);
  const all = lines
    .filter((l) => l.type === 'final' || l.type === 'partial')
    .map((l) => l.text.toLowerCase())
    .join(' ');

  // These are the phrases the voice grammar has to match, so recognition of *these* is the
  // thing worth asserting — not overall accuracy.
  for (const phrase of ['close this window', 'scroll down', 'come over here']) {
    assert.ok(all.includes(phrase), `没识别到 “${phrase}”`);
  }
});

test('第一个结果的延迟被报告出来，供预热策略参考', { skip: built ? false : 'native/voiced 未构建' }, async () => {
  const { lines } = await runSidecar([fixture]);
  const warm = lines.find((l) => l.type === 'warm');
  assert.ok(warm, '要报告首个结果的等待时间');
  assert.ok(warm.ms > 0 && warm.ms < 30000, `首结果 ${warm.ms}ms 不在合理范围`);
  // Measured at 2.7-3.9 s on an M4 Pro. It is once per analyzer, not per utterance, which
  // is why the sidecar is long-lived: the cost is paid at launch, before anyone speaks.
  // A regression that pushed this past ~8 s would make voice input feel broken on startup.
  assert.ok(warm.ms < 8000, `首结果 ${warm.ms}ms 过慢，预热回归了`);
});

test('给不存在的文件时报错而不是挂住', { skip: built ? false : 'native/voiced 未构建' }, async () => {
  const { lines } = await runSidecar(['/nonexistent/nope.wav'], { timeoutMs: 30000 });
  const err = lines.find((l) => l.type === 'error');
  assert.ok(err, '应该报 error');
  assert.match(err.message, /cannot open/i);
});
