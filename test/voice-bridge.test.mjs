import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceBridge, BRIDGE_DEFAULTS } from '../voice-bridge.js';
import { IntentBus, GRAMMAR, TIERS } from '../intents.js';

// Replays a realistic partial storm: recognisers commit left to right, so the tail keeps
// being rewritten while the head stays put.
const SCROLL_PARTIALS = ['Sc', 'Scroll', 'Scroll down', 'Scroll down a', 'Scroll down a bit.'];

function feedPartials(bridge, texts, from, step = 40) {
  let t = from;
  const out = [];
  for (const text of texts) {
    out.push(bridge.onLine({ type: 'partial', text }, (t += step)));
  }
  return { results: out, t };
}

test('ready / warm / level / error 各自被认出来，且错误不会让语音假装还在跑', () => {
  const b = new VoiceBridge();
  assert.equal(b.onLine({ type: 'ready', sampleRate: 16000, channels: 1 }, 0).kind, 'ready');
  assert.equal(b.status().running, true);
  assert.equal(b.onLine({ type: 'warm', ms: 3200 }, 10).kind, 'warm');
  assert.equal(b.status().warmMs, 3200);
  assert.equal(b.onLine({ type: 'level', rms: 0.01, peak: 0.03 }, 20).kind, 'level');
  const e = b.onLine({ type: 'error', code: 'not-built', message: 'no binary' }, 30);
  assert.equal(e.kind, 'error');
  assert.equal(b.status().running, false, 'sidecar 没构建时不能还报告 running');
});

test('识别到命令后开始持续投递，投够 dwell 才真的触发', () => {
  const b = new VoiceBridge();
  const bus = new IntentBus();
  const { results, t } = feedPartials(b, SCROLL_PARTIALS, 1000);

  const cmd = results.find((r) => r.kind === 'command');
  assert.ok(cmd, '这串 partial 里应该识别出一个命令');
  assert.equal(cmd.submit.intent, 'scroll_down');

  // First submission cannot fire: the reversible tier wants evidence that persisted.
  const first = bus.submit(cmd.submit);
  assert.equal(first.status, 'withheld');
  assert.equal(first.code, 'needs_dwell');

  // Sustaining across frames is what supplies that evidence. Without the bridge's sustain
  // the intent would be submitted exactly once and never fire at all.
  let fired = null;
  for (let k = 1; k <= 20 && !fired; k += 1) {
    const s = b.tick(t + k * 33);
    if (!s) break;
    const r = bus.submit(s);
    if (r.status === 'fired') fired = { r, at: t + k * 33 };
  }
  assert.ok(fired, '持续投递应该最终触发 scroll_down');
  const dwell = fired.at - cmd.submit.t;
  assert.ok(dwell >= TIERS.reversible.dwellMs,
    `触发前应至少累积 ${TIERS.reversible.dwellMs}ms，实际 ${dwell}ms`);
  assert.ok(dwell < 400, `dwell 不该拖到 ${dwell}ms，语音滚动会显得迟钝`);
});

test('sustain 有上限，说完很久之后不会还在投票', () => {
  const b = new VoiceBridge();
  const { t } = feedPartials(b, SCROLL_PARTIALS, 0);
  assert.ok(b.tick(t + 100), '刚说完还应该在投');
  assert.equal(b.tick(t + BRIDGE_DEFAULTS.sustainMs + 1), null, '超过 sustain 上限就该停');
  assert.equal(b.status().live, null);
});

test('settled 之后停止投递，不做无用功', () => {
  const b = new VoiceBridge();
  const { results, t } = feedPartials(b, SCROLL_PARTIALS, 0);
  assert.ok(results.find((r) => r.kind === 'command'));
  b.settled('scroll_down');
  assert.equal(b.tick(t + 33), null);
});

test('一串 partial 只投出一个命令，修订风暴不会重复触发', () => {
  const b = new VoiceBridge();
  const { results } = feedPartials(b, [
    'Cl', 'Close', 'Close this', 'Close this window', 'Close this window please.',
    'Clothes in the window please.',
  ], 0);
  const cmds = results.filter((r) => r.kind === 'command');
  assert.equal(cmds.length, 1, `一次话语只该出一个命令，实际 ${cmds.length}`);
});

test('社交语走对话路径，进 transcript，而不是当命令', () => {
  const b = new VoiceBridge();
  const r1 = b.onLine({ type: 'partial', text: 'hello there' }, 100);
  assert.equal(r1.kind, 'conversation');
  assert.equal(r1.submit, null, '打招呼不该产生 intent 投递');
  assert.equal(r1.speak, null, 'partial 不该唤醒模型');

  const r2 = b.onLine({ type: 'final', text: 'Hello there.' }, 300);
  assert.equal(r2.kind, 'conversation');
  assert.ok(r2.speak, 'final 才让模型回话');
  assert.equal(r2.speak.text, 'Hello there.');
  assert.match(b.transcriptText(), /Hello there/);
});

test('普通说话（不在语法里）也进 transcript，宠能回应真实内容', () => {
  const b = new VoiceBridge();
  b.onLine({ type: 'final', text: 'I have been staring at this bug for an hour.' }, 500);
  assert.match(b.transcriptText(), /staring at this bug/);
});

test('transcript 有上限，不会长成聊天记录让模型开始演', () => {
  const b = new VoiceBridge({ transcriptTurns: 3 });
  let t = 0;
  for (const s of ['one', 'two', 'three', 'four', 'five']) {
    b.onLine({ type: 'final', text: s }, (t += 1000));
  }
  assert.equal(b.status().transcript, 3);
  assert.equal(b.transcriptText(), 'three / four / five', '应保留最近三轮');
});

test('语音+手势同瞬间时立刻触发，不必等 dwell', () => {
  const b = new VoiceBridge();
  const bus = new IntentBus();
  const { results, t } = feedPartials(b, SCROLL_PARTIALS, 0);
  const cmd = results.find((r) => r.kind === 'command');
  // Gesture arrives first and is itself withheld for dwell...
  assert.equal(bus.submit({ source: 'gesture', intent: 'scroll_down', confidence: 0.8, t: t + 5 }).status,
    'withheld');
  // ...but the two channels agreeing inside the fusion window is stronger evidence than any
  // amount of waiting on one, so it fires immediately.
  const r = bus.submit(cmd.submit);
  assert.equal(r.status, 'fired');
  assert.equal(r.event.confirmed, true);
  assert.deepEqual([...r.event.sources].sort(), ['gesture', 'voice']);
});

test('close_window 即使说得很清楚也默认被拒', () => {
  const b = new VoiceBridge();
  const bus = new IntentBus();
  const { results, t } = feedPartials(b, ['Cl', 'Close', 'Close this window'], 0);
  const cmd = results.find((r) => r.kind === 'command');
  assert.equal(cmd.submit.intent, 'close_window');
  let statuses = [bus.submit(cmd.submit)];
  for (let k = 1; k <= 20; k += 1) {
    const s = b.tick(t + k * 33);
    if (!s) break;
    statuses.push(bus.submit(s));
  }
  assert.ok(statuses.every((r) => r.status === 'withheld'), '默认绝不能关窗口');
  assert.ok(statuses.every((r) => typeof r.reason === 'string' && r.reason.length > 0),
    '每次拒绝都要给出可以显示给用户的理由');
});

test('contextStrings 把语法里的短语交给识别器做偏置', () => {
  const ctx = VoiceBridge.contextStrings(GRAMMAR, ['Exusiai', 'Agnes Tachyon']);
  assert.ok(ctx.includes('scroll down'));
  assert.ok(ctx.includes('close this window'));
  assert.ok(ctx.includes('Exusiai'), '角色名也该偏置，宠被叫到时要听得出来');
  assert.equal(new Set(ctx).size, ctx.length, '不该有重复项');
});

test('乱七八糟的输入不会让 bridge 崩', () => {
  const b = new VoiceBridge();
  for (const junk of [null, undefined, 42, 'string', {}, { type: 'nope' },
    { type: 'partial' }, { type: 'final', text: null }, { type: 'level' }]) {
    assert.doesNotThrow(() => b.onLine(junk, 100), `炸在 ${JSON.stringify(junk)}`);
  }
});

test('reset 之后不残留上一句的证据', () => {
  const b = new VoiceBridge();
  const { t } = feedPartials(b, SCROLL_PARTIALS, 0);
  b.onLine({ type: 'final', text: 'and some chatter' }, t + 100);
  b.reset();
  assert.equal(b.tick(t + 120), null);
  assert.equal(b.transcriptText(), '');
  assert.equal(b.status().running, false);
});
