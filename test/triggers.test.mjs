import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoveltyGate, CHANNELS, TRIGGER_CHANNEL, GLOBAL_FLOOR_MS } from '../triggers.js';

// Feeds a channel one value for `ms`, sampling every 100 ms the way the fast loop does.
function hold(gate, channel, value, from, ms, step = 100) {
  let t = from;
  const end = from + ms;
  while (t <= end) {
    gate.observe(channel, value, t);
    t += step;
  }
  return end;
}

test('每个 trigger 都归属一个 channel', () => {
  for (const t of ['slump', 'good', 'sleepy', 'return', 'gesture', 'handShape', 'wave', 'handNearFace']) {
    assert.ok(TRIGGER_CHANNEL[t], `${t} 没有归属 channel`);
    assert.ok(CHANNELS[TRIGGER_CHANNEL[t]], `${t} 指向了不存在的 channel`);
  }
});

test('手部比姿态和表情快得多', () => {
  assert.ok(CHANNELS.hand.cooldownMs < CHANNELS.posture.cooldownMs / 10,
    '手势应该比姿态快一个量级以上');
  assert.ok(CHANNELS.hand.windowMs < CHANNELS.expression.windowMs);
  assert.ok(CHANNELS.posture.windowMs >= 120000, '姿态窗口至少要几分钟');
});

test('share 是绝对时长相对窗口全长的占比', () => {
  const g = new NoveltyGate();
  const win = CHANNELS.posture.windowMs;
  let t = 0;
  t = hold(g, 'posture', 'slumping', t, 30000);
  t = hold(g, 'posture', 'upright', t, 10000);
  const slouch = g.share('posture', 'slumping', t);
  const up = g.share('posture', 'upright', t);
  assert.ok(Math.abs(slouch - 30000 / win) < 0.02, `塌着 30s/${win / 1000}s，实际 ${slouch.toFixed(3)}`);
  assert.ok(Math.abs(up - 10000 / win) < 0.02, `坐直 10s/${win / 1000}s，实际 ${up.toFixed(3)}`);
  assert.ok(slouch > up, '塌得更久，占比应更大');
});

test('新会话里一切都是新闻，宠不会一开始就沉默', () => {
  const g = new NoveltyGate();
  const t = hold(g, 'posture', 'slumping', 0, 3000);
  assert.ok(g.admit('slump', 'slumping', t), '刚开始就该能触发');
});

test('长时间保持同一状态后，它不再是新闻', () => {
  const g = new NoveltyGate();
  let t = 0;
  // First slouch of the session is news.
  t = hold(g, 'posture', 'slumping', t, 2000);
  assert.ok(g.admit('slump', 'slumping', t), '第一次塌应该触发');
  // Two more minutes of the same posture: now it is simply how they sit.
  t = hold(g, 'posture', 'slumping', t, 120000);
  assert.equal(g.admit('slump', 'slumping', t), null, '一直塌着不该再提醒');
});

test('长期塌着之后坐直，坐直才是新闻', () => {
  const g = new NoveltyGate();
  let t = 0;
  t = hold(g, 'posture', 'slumping', t, 200000);
  g.admit('slump', 'slumping', 1000);
  t = hold(g, 'posture', 'upright', t, 3000);
  const ok = g.admit('good', 'upright', t);
  assert.ok(ok, '长期塌着后坐直应该被注意到');
  assert.ok(ok.share < 0.2, `坐直应该很少见，实际占比 ${ok.share}`);
});

test('姿态在冷却期内不会重复触发', () => {
  const g = new NoveltyGate();
  let t = 0;
  t = hold(g, 'posture', 'slumping', t, 1000);
  assert.ok(g.admit('slump', 'slumping', t));
  t = hold(g, 'posture', 'upright', t, 2000);
  t = hold(g, 'posture', 'slumping', t, 2000);
  // Same channel, well inside its 75 s cooldown.
  assert.equal(g.admit('slump', 'slumping', t), null, '姿态冷却期内不该再触发');
});

test('手势即使重复也照样响应，因为那是在跟宠说话', () => {
  const g = new NoveltyGate();
  let t = 0;
  let fired = 0;
  for (let i = 0; i < 6; i += 1) {
    t = hold(g, 'hand', 'victory', t, 1000);
    if (g.admit('handShape', 'victory', t)) fired += 1;
    t = hold(g, 'hand', null, t, 3000);
  }
  assert.ok(fired >= 4, `重复手势应该多次响应，实际 ${fired} 次`);
});

test('全局下限防止多个 channel 撞在同一帧', () => {
  const g = new NoveltyGate();
  const t = 5000;
  g.observe('hand', 'victory', t);
  g.observe('posture', 'slumping', t);
  assert.ok(g.admit('handShape', 'victory', t), '第一个应该过');
  assert.equal(g.admit('slump', 'slumping', t), null, '同一帧的第二个应被全局下限挡住');
  assert.ok(g.admit('slump', 'slumping', t + GLOBAL_FLOOR_MS + 1), '过了下限就可以');
});

test('describe 把「有多常见」翻成模型能用的话', () => {
  const g = new NoveltyGate();
  let t = 0;
  t = hold(g, 'posture', 'slumping', t, 200000);
  assert.match(g.describe('posture', 'slumping', t), /usual state/);
  const g2 = new NoveltyGate();
  let t2 = hold(g2, 'posture', 'upright', 0, 100000);
  t2 = hold(g2, 'posture', 'slumping', t2, 2000);
  assert.match(g2.describe('posture', 'slumping', t2), /new for them/);
});

test('reset 清空历史与冷却', () => {
  const g = new NoveltyGate();
  const t = hold(g, 'posture', 'slumping', 0, 5000);
  g.admit('slump', 'slumping', t);
  g.reset();
  assert.equal(g.share('posture', 'slumping', t), 0);
  assert.ok(g.admit('slump', 'slumping', t), 'reset 后应能重新触发');
});

test('未知 trigger 落到 hand 通道而不是崩掉', () => {
  const g = new NoveltyGate();
  g.observe('hand', 'x', 0);
  assert.doesNotThrow(() => g.admit('somethingNew', 'x', 3000));
});
