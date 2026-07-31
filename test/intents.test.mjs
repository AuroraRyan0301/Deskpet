import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenise, matchGrammar, GRAMMAR, VoiceGrammar, isCommand,
  UTTERANCE_GAP_MS, COMMAND_REFRACTORY_MS,
  IntentBus, TIERS, INTENT_TIERS, OS_INTENTS, REQUIRED_ARGS,
  FUSION_WINDOW_MS, POINTER_TTL_MS, ARM_WINDOW_MS,
  tierOf, touchesOS, GESTURE_INTENTS, gestureIntent,
} from '../intents.js';
import { classifyHand } from '../perception.js';

// Replays a growing partial the way the sidecar delivers one: a new string every `step`
// ms, each a revision of the last. Returns every non-null result.
function stream(g, texts, from = 0, step = 25) {
  const out = [];
  let t = from;
  for (const text of texts) {
    const r = g.partial(text, t);
    if (r) out.push(r);
    t += step;
  }
  return { results: out, t };
}

const commands = (results) => results.filter(isCommand);

// Copied from perception.test.mjs: 21 landmarks with named fingers extended or curled, so
// the gesture-name check runs against the real classifier rather than a remembered list.
function hand({ extended = [], pinch = false, dir = 'up' } = {}) {
  const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const away = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }[dir];
  const wrist = { x: 0.5 + away[0] * 0.4, y: 0.5 + away[1] * 0.4, z: 0 };
  pts[0] = wrist;
  const spec = {
    thumb: [2, 4], index: [6, 8], middle: [10, 12], ring: [14, 16], pinky: [18, 20],
  };
  const lateral = [away[1], away[0]];
  for (const [i, [name, [pip, tip]]] of Object.entries(spec).entries()) {
    const isThumb = name === 'thumb';
    const off = isThumb ? -0.20 : (i - 2) * 0.06;
    const reach = isThumb ? 0.34 : 0.5;
    const base = { x: wrist.x + lateral[0] * off, y: wrist.y + lateral[1] * off };
    pts[pip] = { x: base.x - away[0] * 0.2, y: base.y - away[1] * 0.2, z: 0 };
    pts[tip] = extended.includes(name)
      ? { x: base.x - away[0] * reach, y: base.y - away[1] * reach, z: 0 }
      : { x: base.x - away[0] * 0.15, y: base.y - away[1] * 0.15, z: 0 };
  }
  pts[9] = { x: wrist.x - away[0] * 0.25, y: wrist.y - away[1] * 0.25, z: 0 };
  if (pinch) {
    const p = { x: wrist.x - away[0] * 0.45, y: wrist.y - away[1] * 0.45, z: 0 };
    pts[4] = p;
    pts[8] = { x: p.x + 0.004, y: p.y + 0.004, z: 0 };
  }
  return pts;
}

// ------------------------------------------------------------------ 语法基本盘 ----

test('每条语法词条都有 intent、route 和短语，命令类都在能力表里', () => {
  for (const e of GRAMMAR) {
    assert.ok(e.intent, `词条缺 intent: ${JSON.stringify(e)}`);
    assert.ok(['command', 'conversation'].includes(e.route), `${e.intent} 的 route 不合法`);
    assert.ok(Array.isArray(e.phrases) && e.phrases.length > 0, `${e.intent} 没有短语`);
    assert.ok(tierOf(e.intent), `${e.intent} 在 INTENT_TIERS 里没有对应的能力层`);
  }
});

test('tokenise 抹掉大小写、标点和口头语', () => {
  assert.deepEqual(tokenise('Um, Scroll Down a bit.'), ['scroll', 'down', 'a', 'bit']);
  assert.deepEqual(tokenise("  don't  stop!! "), ['dont', 'stop']);
  assert.deepEqual(tokenise(''), []);
  assert.deepEqual(tokenise(null), []);
});

test('只匹配整词，不匹配子串', () => {
  // A naive substring grammar fires on both of these, and only on real speech.
  assert.equal(matchGrammar(tokenise('the button is unclickable')), null);
  assert.equal(matchGrammar(tokenise('it stopped by itself')), null);
  assert.equal(matchGrammar(tokenise('click')).intent, 'click');
});

test('前后的垃圾和标点不影响匹配', () => {
  for (const text of ['Scroll down.', 'um, could you scroll down a bit?', 'SCROLL DOWN!!', 'ok — scroll down']) {
    assert.equal(matchGrammar(tokenise(text))?.intent, 'scroll_down', `匹配失败: ${text}`);
  }
});

test('同义词都落到同一个 intent', () => {
  const want = {
    scroll_down: ['scroll down', 'page down'],
    scroll_up: ['scroll up', 'page up'],
    click: ['click', 'click that', 'tap', 'tap that'],
    close_window: ['close this window', 'close it', 'close this'],
    come_here: ['come here', 'come over here'],
    cancel: ['stop', 'never mind', 'nevermind'],
  };
  for (const [intent, phrases] of Object.entries(want)) {
    for (const p of phrases) {
      assert.equal(matchGrammar(tokenise(p))?.intent, intent, `"${p}" 没有落到 ${intent}`);
    }
  }
});

test('更长的短语优先，取消比长度更优先', () => {
  // "close this window" must beat the "close this" that sits inside it.
  assert.equal(matchGrammar(tokenise('close this window'))?.phrase, 'close this window');
  // A person interrupting themselves means the interruption, not the longer phrase.
  assert.equal(matchGrammar(tokenise('close this window no stop'))?.intent, 'cancel');
});

// ------------------------------------------------------- partial 修订风暴 ----

test('partial 修订风暴里命令只触发一次', () => {
  const g = new VoiceGrammar();
  const { results } = stream(g, ['Sc', 'Scroll', 'Scroll down', 'Scroll down a', 'Scroll down a bit', 'Scroll down a bit.']);
  const fired = commands(results);
  assert.equal(fired.length, 1, `一句话只该触发一次，实际 ${fired.length} 次`);
  assert.equal(fired[0].intent, 'scroll_down');
  // The fast path means firing at the earliest recognisable revision, not the last one.
  assert.equal(fired[0].phrase, 'scroll down');
});

test('触发之后 partial 被修订成别的话，也不会再触发一次', () => {
  const g = new VoiceGrammar();
  const { results } = stream(g, [
    'Cl', 'Close', 'Close this', 'Close this window', 'Close this windows', 'Clothes in the window',
  ]);
  const fired = commands(results);
  assert.equal(fired.length, 1, `实际 ${fired.length} 次`);
  assert.equal(fired[0].intent, 'close_window');
});

test('同一个 intent 在同一句里反复出现也只算一次', () => {
  const g = new VoiceGrammar();
  const { results } = stream(g, ['scroll down', 'scroll down and', 'scroll down and scroll down']);
  assert.equal(commands(results).length, 1);
});

test('final 划出 utterance 边界，下一句同样的命令还能触发', () => {
  const g = new VoiceGrammar();
  let { t } = stream(g, ['Sc', 'Scroll down', 'Scroll down a bit']);
  const done = g.final('Scroll down a bit.', t);
  // The command already fired on a partial, so the final is conversation, not a repeat.
  assert.equal(done.route, 'conversation');
  t += COMMAND_REFRACTORY_MS + 100;
  const again = stream(g, ['Sc', 'Scroll down'], t);
  assert.equal(commands(again.results).length, 1, '新的一句应该能再触发');
});

test('静默超过 gap 之后算新的 utterance', () => {
  const g = new VoiceGrammar();
  const first = g.partial('stop', 0);
  assert.ok(isCommand(first));
  // Same word again while the stream is still live: still the same utterance.
  assert.equal(g.partial('stop', 40), null);
  const later = g.partial('stop', UTTERANCE_GAP_MS + COMMAND_REFRACTORY_MS + 100);
  assert.ok(isCommand(later), '静默之后再说一次应该触发');
  assert.ok(later.utterance > first.utterance, 'utterance id 应该前进');
});

test('第一个词变了说明识别器已经换了一句', () => {
  const g = new VoiceGrammar();
  // "scroll down a bit" then the recogniser starts over on "click that": the leading word
  // disagrees with the one this utterance committed to, so it is a new utterance.
  const a = stream(g, ['Sc', 'Scroll down', 'Scroll down a bit']);
  const b = stream(g, ['Cl', 'Click that'], a.t);
  const fired = commands([...a.results, ...b.results]);
  assert.deepEqual(fired.map((f) => f.intent), ['scroll_down', 'click']);
  assert.ok(fired[1].utterance > fired[0].utterance);
});

test('句尾的修订不会被误当成新的一句而重复触发', () => {
  const g = new VoiceGrammar();
  // Tail rewrites keep the leading word, which is why the boundary rule looks there.
  const { results } = stream(g, ['scroll down a', 'scroll down a bit', 'scroll down of it', 'scroll down a bit']);
  assert.equal(commands(results).length, 1);
});

test('冷却期是第二道保险，边界判错也不会重复触发', () => {
  const g = new VoiceGrammar();
  assert.ok(isCommand(g.partial('stop', 0)));
  // Force a boundary by changing the leading word, then say the same command again well
  // inside the refractory window.
  g.partial('please hold on', 60);
  assert.equal(g.partial('stop it', 120), null, '冷却期内不该再触发');
});

// --------------------------------------------------------------- 社交与取消 ----

test('社交寒暄走对话，不走命令', () => {
  const g = new VoiceGrammar();
  for (const [text, intent] of [['Hello!', 'greeting'], ['Good morning.', 'good_morning']]) {
    g.reset();
    const r = g.partial(text, 0);
    assert.ok(r, `${text} 应该被识别`);
    assert.equal(r.route, 'conversation', `${text} 不该被当成命令`);
    assert.equal(isCommand(r), false);
    assert.equal(r.intent, intent);
    assert.equal(r.source, undefined, '对话结果不该长成 bus 事件');
  }
});

test('寒暄在一句里也只报一次', () => {
  const g = new VoiceGrammar();
  const { results } = stream(g, ['Hel', 'Hello', 'Hello there', 'Hello there pet']);
  assert.equal(results.length, 1);
  assert.equal(results[0].route, 'conversation');
});

test('取消压住同一句里后面的命令', () => {
  const g = new VoiceGrammar();
  const { results } = stream(g, ['stop', 'stop no', 'stop no close this window']);
  const fired = commands(results);
  assert.deepEqual(fired.map((f) => f.intent), ['cancel'], '取消之后不该再接受命令');
});

test('final 兜底触发 partial 里没能认出来的命令', () => {
  const g = new VoiceGrammar();
  // The partials never spelled a grammar phrase; the final did.
  const { t } = stream(g, ['Scroll', 'Scroll doubt', 'Scroll dowd']);
  const r = g.final('scroll down', t);
  assert.ok(isCommand(r), 'final 应该兜底');
  assert.equal(r.intent, 'scroll_down');
  assert.equal(r.late, true, '要标出这是迟到的命令');
  assert.ok(r.confidence > 0.8, 'final 比 partial 更可信');
  assert.equal(r.text, 'scroll down', 'final 仍然要带原文给模型');
});

test('partial 已经触发过的命令，final 不会再触发一次', () => {
  const g = new VoiceGrammar();
  const { t } = stream(g, ['Sc', 'Scroll down']);
  const r = g.final('scroll down a bit', t);
  assert.equal(r.route, 'conversation');
});

test('reset 清空 utterance 状态', () => {
  const g = new VoiceGrammar();
  assert.ok(isCommand(g.partial('scroll down', 0)));
  g.reset();
  assert.ok(isCommand(g.partial('scroll down', 10)), 'reset 之后应该能重新触发');
});

// ------------------------------------------------------------------ 能力分层 ----

test('能力层按可逆性排序，门槛越来越高', () => {
  assert.equal(TIERS.free.dwellMs, 0);
  assert.equal(TIERS.free.needsConfirmation, false);
  assert.ok(TIERS.reversible.dwellMs > 0, '可逆层要有 dwell');
  assert.equal(TIERS.reversible.needsConfirmation, false);
  assert.equal(TIERS.destructive.needsConfirmation, true);
  assert.equal(TIERS.destructive.needsArmed, true);
  assert.equal(TIERS.destructive.enabledByDefault, false, 'destructive 必须默认关闭');
  for (const [intent, tier] of Object.entries(INTENT_TIERS)) {
    assert.ok(TIERS[tier], `${intent} 指向了不存在的层 ${tier}`);
  }
});

test('碰系统的 intent 和能力层是两根独立的轴', () => {
  assert.equal(tierOf('cursor_move'), 'free');
  assert.equal(touchesOS('cursor_move'), true, '光标是自由层但确实碰系统');
  assert.equal(touchesOS('come_here'), false, '走过来只动精灵');
  for (const i of OS_INTENTS) assert.ok(tierOf(i), `${i} 没有能力层`);
});

test('free 层单通道就够', () => {
  const bus = new IntentBus();
  const d = bus.submit({ source: 'voice', intent: 'come_here', confidence: 0.7, t: 1000 });
  assert.equal(d.status, 'fired');
  assert.equal(d.event.confirmed, false);
  assert.deepEqual(d.event.sources, ['voice']);
});

test('可逆层单通道不够，要先满足 dwell', () => {
  const bus = new IntentBus();
  const first = bus.submit({ source: 'gesture', intent: 'scroll_down', confidence: 0.7, t: 1000 });
  assert.equal(first.status, 'withheld');
  assert.equal(first.code, 'needs_dwell');
  assert.match(first.reason, /dwell/);
  // Held across frames the way the 30 fps loop delivers it.
  let d = first;
  for (let t = 1033; t <= 1000 + TIERS.reversible.dwellMs + 40; t += 33) {
    d = bus.submit({ source: 'gesture', intent: 'scroll_down', confidence: 0.7, t });
    if (d.status === 'fired') break;
  }
  assert.equal(d.status, 'fired', 'dwell 满了应该放行');
  assert.ok(d.t - 1000 >= TIERS.reversible.dwellMs);
});

test('dwell 只在被扣下时累积，松手之后重新计时', () => {
  const bus = new IntentBus();
  bus.submit({ source: 'gesture', intent: 'scroll_down', confidence: 0.7, t: 1000 });
  // A gap longer than the continuity leash means the hand was released.
  const d = bus.submit({ source: 'gesture', intent: 'scroll_down', confidence: 0.7, t: 1000 + 5000 });
  assert.equal(d.status, 'withheld');
  assert.equal(d.code, 'needs_dwell');
  assert.match(d.reason, /held 0 ms/);
});

// ------------------------------------------------------------------ 跨通道融合 ----

test('融合窗口内两个通道一致：置信度提高并标记为多通道确认', () => {
  const bus = new IntentBus();
  const a = bus.submit({ source: 'gesture', intent: 'come_here', confidence: 0.6, t: 5000 });
  assert.equal(a.status, 'fired');
  assert.equal(a.event.confidence, 0.6);
  const b = bus.submit({ source: 'voice', intent: 'come_here', confidence: 0.72, t: 5000 + 40 });
  assert.equal(b.status, 'absorbed');
  assert.equal(b.event.confirmed, true, '要标记成多通道确认');
  assert.deepEqual(b.event.sources, ['gesture', 'voice']);
  assert.ok(b.event.confidence > 0.72, `融合后应高于任一单通道，实际 ${b.event.confidence}`);
  assert.ok(b.event.confidence < 1);
});

test('一致不会把 intent 触发两次', () => {
  const bus = new IntentBus();
  const a = bus.submit({ source: 'gesture', intent: 'come_here', confidence: 0.6, t: 5000 });
  const b = bus.submit({ source: 'voice', intent: 'come_here', confidence: 0.7, t: 5040 });
  assert.equal(b.status, 'absorbed', '第二个通道不该产生第二个事件');
  assert.equal(b.event, a.event, '升级的是同一个事件对象，不是新的一个');
  const fired = bus.history.filter((d) => d.status === 'fired');
  assert.equal(fired.length, 1);
});

test('融合窗口之外不算一致', () => {
  const bus = new IntentBus();
  bus.arm('close_window', ARM_WINDOW_MS, 0);
  bus.enable('close_window');
  bus.submit({ source: 'gesture', intent: 'close_window', confidence: 0.7, t: 1000 });
  const late = bus.submit({
    source: 'voice', intent: 'close_window', confidence: 0.7, t: 1000 + FUSION_WINDOW_MS + 20,
  });
  assert.equal(late.status, 'withheld');
  assert.equal(late.code, 'needs_confirmation', '隔太远的两个断言不是同一个瞬间');
});

test('同一个通道重复不算跨通道确认', () => {
  const bus = new IntentBus();
  bus.arm('close_window', ARM_WINDOW_MS, 0);
  bus.enable('close_window');
  for (const t of [1000, 1030, 1060, 1090]) {
    const d = bus.submit({ source: 'gesture', intent: 'close_window', confidence: 0.8, t });
    assert.equal(d.status, 'withheld', `t=${t} 单通道刷帧不该被当成确认`);
    assert.equal(d.code, 'needs_confirmation');
  }
});

test('跨通道一致可以替代 dwell', () => {
  const bus = new IntentBus();
  const a = bus.submit({ source: 'gesture', intent: 'scroll_up', confidence: 0.7, t: 2000 });
  assert.equal(a.code, 'needs_dwell');
  // 30 ms later, nowhere near the 200 ms dwell, but a second channel agrees.
  const b = bus.submit({ source: 'voice', intent: 'scroll_up', confidence: 0.72, t: 2030 });
  assert.equal(b.status, 'fired', '两个通道一致比等下去更有说服力');
  assert.equal(b.event.confirmed, true);
  assert.ok(b.event.confidence > 0.72);
});

// ---------------------------------------------------------------- close_window ----

test('close_window 默认就是关着的', () => {
  const bus = new IntentBus();
  assert.equal(bus.isEnabled('close_window'), false);
  bus.arm('close_window', ARM_WINDOW_MS, 0);
  bus.submit({ source: 'gesture', intent: 'close_window', confidence: 0.9, t: 1000 });
  const d = bus.submit({ source: 'voice', intent: 'close_window', confidence: 0.9, t: 1030 });
  assert.equal(d.status, 'withheld');
  assert.equal(d.code, 'disabled');
  assert.match(d.reason, /default/);
});

test('close_window 打开之后仍然要 armed 窗口', () => {
  const bus = new IntentBus();
  bus.enable('close_window');
  bus.submit({ source: 'gesture', intent: 'close_window', confidence: 0.9, t: 1000 });
  const d = bus.submit({ source: 'voice', intent: 'close_window', confidence: 0.9, t: 1030 });
  assert.equal(d.code, 'not_armed');
  assert.match(d.reason, /armed/);
});

test('close_window 只有 armed 且两个通道一致才放行', () => {
  const bus = new IntentBus();
  bus.enable('close_window');
  bus.arm('close_window', 3000, 900);
  const only = bus.submit({ source: 'voice', intent: 'close_window', confidence: 0.9, t: 1000 });
  assert.equal(only.status, 'withheld');
  assert.equal(only.code, 'needs_confirmation');
  assert.match(only.reason, /voice/);
  const both = bus.submit({ source: 'gesture', intent: 'close_window', confidence: 0.85, t: 1050 });
  assert.equal(both.status, 'fired', 'armed + 两通道一致才该放行');
  assert.equal(both.event.confirmed, true);
  assert.deepEqual(both.event.sources, ['gesture', 'voice']);
  // Agreement is the confirmation dialog; there is no modal.
  assert.ok(both.event.confidence > 0.9);
});

test('arm 会过期，过期之后 close_window 又被扣下', () => {
  const bus = new IntentBus();
  bus.enable('close_window');
  bus.arm('close_window', 1000, 0);
  assert.deepEqual(bus.armedList(500), ['close_window'], '指示器要能看到 arm 状态');
  assert.deepEqual(bus.armedList(1500), [], 'arm 应该自己过期');
  bus.submit({ source: 'voice', intent: 'close_window', confidence: 0.9, t: 2000 });
  const d = bus.submit({ source: 'gesture', intent: 'close_window', confidence: 0.9, t: 2030 });
  assert.equal(d.code, 'not_armed');
});

// ------------------------------------------------------------------ kill switch ----

test('kill switch 一按下，所有碰系统的 intent 立刻被扣下', () => {
  const bus = new IntentBus();
  bus.enable('close_window');
  bus.arm('close_window', ARM_WINDOW_MS, 0);
  bus.engageKill('user hit the kill switch');
  for (const intent of OS_INTENTS) {
    const d = bus.submit({ source: 'gesture', intent, confidence: 0.95, args: { point: { x: 0.5, y: 0.5 } }, t: 100 });
    assert.equal(d.status, 'withheld', `${intent} 应该被扣下`);
    assert.equal(d.code, 'kill_switch');
    assert.match(d.reason, /kill switch/);
  }
});

test('kill switch 期间不碰系统的表达性 intent 照样通过', () => {
  const bus = new IntentBus();
  bus.engageKill();
  for (const intent of ['come_here', 'emote', 'look', 'greeting', 'cancel']) {
    const d = bus.submit({ source: 'voice', intent, confidence: 0.8, t: 100 });
    assert.equal(d.status, 'fired', `${intent} 不碰系统，不该被冻住`);
    assert.equal(d.event.touchesOS, false);
  }
});

test('bus 上的任何事件都放不开 kill switch，只有宿主能', () => {
  const bus = new IntentBus();
  bus.engageKill();
  // Nothing a recogniser can produce may hand itself more authority than it has.
  for (const intent of ['cancel', 'release', 'release_kill', 'kill_off', 'enable_all', 'greeting']) {
    bus.submit({ source: 'voice', intent, confidence: 1, t: 100 });
    assert.equal(bus.killed, true, `${intent} 竟然放开了 kill switch`);
  }
  bus.reset();
  assert.equal(bus.killed, true, 'reset 也不该放开 kill switch');
  bus.releaseKill();
  assert.equal(bus.killed, false, '宿主调用方法才能放开');
  const d = bus.submit({ source: 'voice', intent: 'come_here', confidence: 0.7, t: 200 });
  assert.equal(d.status, 'fired');
});

test('kill switch 同时解除所有 arm，避免恢复时停在危险状态', () => {
  const bus = new IntentBus();
  bus.enable('close_window');
  bus.arm('close_window', 5000, 0);
  bus.engageKill();
  bus.releaseKill();
  assert.deepEqual(bus.armedList(100), []);
  bus.submit({ source: 'voice', intent: 'close_window', confidence: 0.9, t: 100 });
  const d = bus.submit({ source: 'gesture', intent: 'close_window', confidence: 0.9, t: 130 });
  assert.equal(d.code, 'not_armed');
});

// ---------------------------------------------------------------------- deixis ----

test('「点那个」缺屏幕坐标会被扣下，并说清缺什么', () => {
  const bus = new IntentBus();
  assert.deepEqual(REQUIRED_ARGS.click, ['point']);
  const d = bus.submit({ source: 'voice', intent: 'click', confidence: 0.9, t: 1000 });
  assert.equal(d.status, 'withheld');
  assert.equal(d.code, 'missing_arg');
  assert.match(d.reason, /point/);
  assert.match(d.reason, /where/);
});

test('指针新鲜时自动补上 point，动词来自嘴、参数来自手', () => {
  const bus = new IntentBus();
  bus.setPointer({ x: 0.4, y: 0.7 }, 1000);
  bus.submit({ source: 'voice', intent: 'click', confidence: 0.72, t: 1010 });
  const d = bus.submit({ source: 'gesture', intent: 'click', confidence: 0.8, t: 1040 });
  assert.equal(d.status, 'fired');
  assert.deepEqual(d.event.args.point, { x: 0.4, y: 0.7 });
  assert.equal(d.event.args.pointFrom, 'pointer');
});

test('过期的指针不算「那个」', () => {
  const bus = new IntentBus();
  bus.setPointer({ x: 0.4, y: 0.7 }, 1000);
  assert.equal(bus.pointerAt(1000 + POINTER_TTL_MS + 1), null);
  const d = bus.submit({ source: 'voice', intent: 'click', confidence: 0.9, t: 1000 + POINTER_TTL_MS + 1 });
  assert.equal(d.code, 'missing_arg', '一秒前指的地方不是「那个」');
});

test('事件自带的 args 优先于指针', () => {
  const bus = new IntentBus();
  bus.setPointer({ x: 0.1, y: 0.1 }, 1000);
  bus.submit({ source: 'voice', intent: 'click', confidence: 0.8, args: { point: { x: 0.9, y: 0.2 } }, t: 1000 });
  const d = bus.submit({ source: 'gesture', intent: 'click', confidence: 0.8, args: { point: { x: 0.9, y: 0.2 } }, t: 1030 });
  assert.equal(d.status, 'fired');
  assert.deepEqual(d.event.args.point, { x: 0.9, y: 0.2 });
  assert.equal(d.event.args.pointFrom, undefined);
});

// ------------------------------------------------------------------ 扣下的理由 ----

test('每一个被扣下的 intent 都带一句人能读的理由', () => {
  const bus = new IntentBus();
  const cases = [
    () => bus.submit({ source: 'voice', intent: 'scroll_down', confidence: 0.7, t: 100 }),      // dwell
    () => bus.submit({ source: 'voice', intent: 'click', confidence: 0.7, t: 100 }),            // deixis
    () => bus.submit({ source: 'voice', intent: 'close_window', confidence: 0.9, t: 100 }),     // disabled
    () => bus.submit({ source: 'voice', intent: 'do_my_taxes', confidence: 0.9, t: 100 }),      // unknown
  ];
  const codes = new Set();
  for (const run of cases) {
    const d = run();
    assert.equal(d.status, 'withheld');
    assert.ok(d.code, '要有机器可读的 code');
    assert.equal(typeof d.reason, 'string');
    assert.ok(d.reason.length > 20, `理由太短，UI 没法照着说: "${d.reason}"`);
    assert.ok(/[a-z]{4}/.test(d.reason), '理由要是人话');
    codes.add(d.code);
  }
  assert.deepEqual([...codes].sort(), ['disabled', 'missing_arg', 'needs_dwell', 'unknown_intent']);
  // Withheld is reported, never silently dropped.
  assert.equal(bus.history.length, 4);
});

test('不认识的 intent 被扣下而不是崩掉，也不会被当成自由层', () => {
  const bus = new IntentBus();
  assert.doesNotThrow(() => bus.submit({ source: 'model', intent: 'rm_rf', confidence: 1, t: 0 }));
  const d = bus.submit({ source: 'model', intent: 'rm_rf', confidence: 1, t: 0 });
  assert.equal(d.code, 'unknown_intent');
  assert.equal(tierOf('rm_rf'), null);
});

test('reset 清掉证据但不动权限', () => {
  const bus = new IntentBus();
  bus.submit({ source: 'gesture', intent: 'scroll_down', confidence: 0.7, t: 1000 });
  bus.reset();
  const d = bus.submit({ source: 'gesture', intent: 'scroll_down', confidence: 0.7, t: 1100 });
  assert.equal(d.code, 'needs_dwell', 'reset 之后 dwell 从零开始');
  assert.equal(bus.isEnabled('close_window'), false);
  assert.deepEqual(bus.armedList(1100), []);
});

// ---------------------------------------------------------------- 手势映射 ----

test('GESTURE_INTENTS 用的是 classifyHand 真会返回的名字', () => {
  const real = {
    fist: hand({ extended: [] }),
    openPalm: hand({ extended: ['thumb', 'index', 'middle', 'ring', 'pinky'] }),
    pinch: hand({ extended: ['index', 'middle', 'pinky'], pinch: true }),
    point_up: hand({ extended: ['index'], dir: 'up' }),
    point_down: hand({ extended: ['index'], dir: 'down' }),
    point_left: hand({ extended: ['index'], dir: 'left' }),
    point_right: hand({ extended: ['index'], dir: 'right' }),
  };
  for (const shape of Object.keys(GESTURE_INTENTS)) {
    assert.ok(real[shape], `${shape} 没有对应的真实手型样本`);
    assert.equal(classifyHand(real[shape]).name, shape, `perception.js 不会返回 "${shape}"`);
  }
});

test('每个手势都映射到能力表里的 intent', () => {
  for (const [shape, intent] of Object.entries(GESTURE_INTENTS)) {
    assert.ok(tierOf(intent), `${shape} → ${intent} 不在能力表里`);
  }
  assert.equal(gestureIntent('victory', 10), null, '没映射的手型不该造出 intent');
  const ev = gestureIntent('point_down', 77, { confidence: 0.8 });
  assert.deepEqual(ev, { source: 'gesture', intent: 'scroll_down', confidence: 0.8, args: {}, t: 77 });
});

// ------------------------------------------------------------------ 端到端 ----

test('语音 partial 的结果可以直接喂给 bus', () => {
  const g = new VoiceGrammar();
  const bus = new IntentBus();
  const cmd = g.partial('come over here', 4000);
  assert.ok(isCommand(cmd));
  const d = bus.submit(cmd);
  assert.equal(d.status, 'fired');
  assert.equal(d.event.intent, 'come_here');
  assert.equal(d.event.tier, 'free');
});

test('说「关掉这个窗口」并同时握拳，在 armed 窗口里刚好放行一次', () => {
  const g = new VoiceGrammar();
  const bus = new IntentBus();
  bus.enable('close_window');           // the host's one switch
  bus.arm('close_window', 3000, 9000);  // the model's `grant`
  const spoken = g.partial('Close this window.', 10000);
  const byVoice = bus.submit(spoken);
  assert.equal(byVoice.code, 'needs_confirmation');
  const byHand = bus.submit(gestureIntent('fist', 10040, { confidence: 0.8 }));
  assert.equal(byHand.status, 'fired');
  assert.equal(byHand.event.confirmed, true);
  // Extra frames of the same fist must not close a second window.
  const extra = bus.submit(gestureIntent('fist', 10073, { confidence: 0.8 }));
  assert.equal(extra.status, 'absorbed');
  assert.equal(bus.history.filter((d) => d.status === 'fired').length, 1);
});
