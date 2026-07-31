import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScript, describeVerbs, stepDurationMs, ScriptRunner, MOODS,
  SCRIPT_LIMITS, CAPABILITIES, GRANTABLE, VERBS, VERB_NAMES, SCRIPT_EXAMPLE,
} from '../script.js';
import { actionVocabulary, BUILTIN_ACTIONS } from '../characters.js';

// The real pack vocabulary, so a rename in characters.js shows up here rather than in a
// pet that silently stops emoting.
const VOCAB = actionVocabulary({ actions: BUILTIN_ACTIONS });
const parse = (s, opt = {}) => parseScript(s, { vocabulary: VOCAB, ...opt });

// Records every sink callback in order; the runner is tested through what it emitted.
function recorder() {
  const log = [];
  const push = (kind) => (...args) => { log.push([kind, ...args]); };
  return {
    log,
    kinds: () => log.map((e) => e[0]),
    say: push('say'),
    emote: push('emote'),
    look: push('look'),
    move: push('move'),
    grant: push('grant'),
    revoke: push('revoke'),
    release: push('release'),
    take: push('take'),
  };
}

// Every string in this list has to come back with a result and no exception.
const HOSTILE = [
  '', '   ', ';', ';;;;;;', '\n\n', ' ; ; ',
  'say "unterminated', 'walk 5,5', 'walk -0.1,0.5', 'walk abc', 'walk 0.5',
  'emote nonexistent', 'grant rm_rf', 'grant', 'grant close_window',
  'wait 999999999', 'wait -5', 'wait abc', 'wait 1e9', 'take 0', 'take 99999',
  'look sideways', 'look 2,2', 'dance now', 'rm -rf /', 'say', 'say ""',
  'I think the user wants me to wave, so: emote wave',
  '{"line":"hi","action":"wave"}', 'walk 0.5,0.5,0.5', 'SAY Hello', 'emote WAVE',
  'say 你好，需要休息一下吗？', 'say 🐈 mrow', 'walk 0,0', 'walk 1,1',
  'look\tcursor', 'take', 'release now', 'grant click,rm_rf', 'grant click,click',
  'walk 0.5,0.5; ; ;emote wave;;', 'wait 300 300', 'say hi; walk NaN,NaN',
];

test('文档里的例子完整通过解析', () => {
  const r = parse(SCRIPT_EXAMPLE);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  assert.deepEqual(r.steps, [
    { verb: 'look', target: 'cursor' },
    { verb: 'walk', gait: 'walk', x: 0.72, y: 0.31 },
    { verb: 'emote', action: 'wave', durationMs: 0 },
    { verb: 'wait', ms: 300 },
    { verb: 'say', text: 'over here?' },
  ]);
});

test('每个动词都至少有一条能被接受的用法', () => {
  const ok = {
    say: 'say hello there',
    emote: 'emote nod',
    mood: 'mood happy',
    snap: 'snap',
    look: 'look user',
    walk: 'walk 0.1,0.2',
    run: 'run 0.9,0.8',
    wait: 'wait 500',
    grant: `grant ${GRANTABLE[0]}`,
    release: 'release',
    take: 'take 1000',
  };
  for (const verb of VERB_NAMES) {
    const r = parse(ok[verb]);
    assert.equal(r.steps.length, 1, `${verb} 应该被接受: ${JSON.stringify(r.rejected)}`);
    assert.equal(r.steps[0].verb, verb);
  }
});

test('say 的引号可有可无，裸文本延伸到步骤结尾', () => {
  assert.equal(parse('say "over here?"').steps[0].text, 'over here?');
  assert.equal(parse("say 'over here?'").steps[0].text, 'over here?');
  assert.equal(parse('say over here, right now').steps[0].text, 'over here, right now');
  // An apostrophe in the middle is speech, not a quote.
  assert.equal(parse("say don't worry about it").steps[0].text, "don't worry about it");
  // A quoted say may contain the step separator.
  assert.equal(parse('say "wait; really?"').steps.length, 1);
});

test('解析结果同时给出被丢掉的步骤和原因，因为要写进日志', () => {
  const r = parse('emote wave; emote nonexistent; walk 5,5; frobnicate');
  assert.equal(r.steps.length, 1);
  assert.equal(r.rejected.length, 3);
  for (const rj of r.rejected) {
    assert.equal(typeof rj.reason, 'string');
    assert.ok(rj.reason.length > 0);
    assert.equal(typeof rj.raw, 'string');
  }
  assert.match(r.rejected[0].reason, /unknown-action/);
  assert.match(r.rejected[1].reason, /out-of-range/);
  assert.match(r.rejected[2].reason, /unknown-verb/);
});

test('任何输入都不抛异常，也不会有非法步骤混进 steps', () => {
  const names = new Set(VOCAB.map((a) => a.name));
  for (const src of HOSTILE) {
    let r = null;
    assert.doesNotThrow(() => { r = parse(src); }, `抛了异常: ${JSON.stringify(src)}`);
    assert.ok(Array.isArray(r.steps) && Array.isArray(r.rejected), JSON.stringify(src));
    assert.ok(r.steps.length <= SCRIPT_LIMITS.maxSteps);
    assert.ok(r.totalMs <= SCRIPT_LIMITS.maxTotalMs);
    for (const s of r.steps) {
      assert.ok(Object.prototype.hasOwnProperty.call(VERBS, s.verb), `未知动词存活: ${s.verb}`);
      if (s.verb === 'emote') assert.ok(names.has(s.action), `不存在的动作存活: ${s.action}`);
      if (s.verb === 'wait') assert.ok(Number.isSafeInteger(s.ms) && s.ms >= 1 && s.ms <= SCRIPT_LIMITS.maxWaitMs, `wait ${s.ms}`);
      if (s.verb === 'take') assert.ok(Number.isSafeInteger(s.ms) && s.ms >= 1 && s.ms <= SCRIPT_LIMITS.maxTakeMs, `take ${s.ms}`);
      if (s.verb === 'walk' || s.verb === 'run' || s.target === 'point') {
        assert.ok(s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1, `坐标越界存活: ${s.x},${s.y}`);
      }
      if (s.verb === 'say') assert.ok(s.text.length > 0 && s.text.length <= SCRIPT_LIMITS.maxSayChars);
      if (s.verb === 'grant') {
        assert.ok(s.caps.length > 0);
        for (const c of s.caps) assert.ok(GRANTABLE.includes(c), `未授权能力存活: ${c}`);
      }
    }
  }
});

test('非字符串输入也照样返回空结果', () => {
  for (const bad of [null, undefined, 0, 42, NaN, true, {}, [], () => {}, Symbol('x')]) {
    let r = null;
    assert.doesNotThrow(() => { r = parseScript(bad, { vocabulary: VOCAB }); }, String(String(bad)));
    assert.deepEqual(r.steps, []);
  }
});

test('空字符串与只有分号，什么都不产生也不算问题', () => {
  for (const src of ['', '   ', ';', ';;;;;;', ' ;\n; ;']) {
    const r = parse(src);
    assert.deepEqual(r.steps, [], JSON.stringify(src));
    // Punctuation is not a problem worth logging — noise here would bury real rejections.
    assert.deepEqual(r.rejected, [], `${JSON.stringify(src)} 不该产生 rejection`);
  }
});

test('只有空白的步骤被静默跳过，前后步骤照常', () => {
  const r = parse('emote nod;    ;\t; emote wave');
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.rejected, []);
});

test('引号没闭合的 say 被丢掉，而不是说半句话', () => {
  const r = parse('look cursor; say "over here');
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].verb, 'look');
  assert.match(r.rejected[0].reason, /unterminated-quote/);
});

test('坐标必须落在 0..1，越界会把角色送出屏幕', () => {
  for (const bad of ['walk 5,5', 'walk 1.0001,0.5', 'walk -0.01,0.5', 'run 0.5,2', 'walk 0.5,-0']) {
    const r = parse(bad);
    if (bad === 'walk 0.5,-0') { assert.equal(r.steps.length, 1, '-0 等于 0，合法'); continue; }
    assert.deepEqual(r.steps, [], bad);
    assert.match(r.rejected[0].reason, /out-of-range/, bad);
  }
  // Inclusive at both ends.
  assert.equal(parse('walk 0,0; walk 1,1').steps.length, 2);
});

test('坐标写坏了就是坏了，不会被猜成某个方向', () => {
  for (const bad of ['walk abc', 'walk 0.5', 'walk 0.5,', 'walk ,0.5', 'walk 0.5 0.5', 'walk NaN,NaN', 'walk 1e-1,0.5']) {
    const r = parse(bad);
    assert.deepEqual(r.steps, [], bad);
    assert.equal(r.rejected.length, 1, bad);
  }
});

test('emote 只接受词表里真实存在的动作名', () => {
  assert.equal(parse('emote nonexistent').steps.length, 0);
  assert.equal(parse('emote').steps.length, 0);
  // Vocabulary comes from the pack, so an empty pack can emote nothing at all.
  assert.equal(parseScript('emote wave', { vocabulary: [] }).steps.length, 0);
  // Case is resolved to the pack's own spelling — the name still has to exist.
  assert.equal(parse('emote WAVE').steps[0].action, 'wave');
});

test('动词大小写和一个尾随冒号都容忍，但参数依旧要自己过关', () => {
  assert.equal(parse('SAY Hello').steps[0].text, 'Hello');
  assert.equal(parse('Look: cursor').steps[0].target, 'cursor');
  assert.equal(parse('WALK: 0.2,0.3').steps.length, 1);
  // Tolerating the spelling does not tolerate the argument.
  assert.equal(parse('Look: sideways').steps.length, 0);
  assert.equal(parse('walk0.2,0.3').steps.length, 0, '没有空格就不是这个动词');
});

test('时长必须是整毫秒且在界内，越界不会被悄悄夹到上限', () => {
  assert.equal(parse('wait 999999999').steps.length, 0, 'wait 11 天不是 wait 3 秒');
  assert.match(parse('wait 999999999').rejected[0].reason, /out-of-range/);
  assert.equal(parse('wait abc').steps.length, 0);
  assert.equal(parse('wait -5').steps.length, 0);
  assert.equal(parse('wait 1.5').steps.length, 0);
  assert.equal(parse('wait 1e3').steps.length, 0);
  assert.equal(parse(`wait ${SCRIPT_LIMITS.maxWaitMs}`).steps.length, 1);
  assert.equal(parse(`wait ${SCRIPT_LIMITS.maxWaitMs + 1}`).steps.length, 0);
  assert.equal(parse(`take ${SCRIPT_LIMITS.maxTakeMs}`).steps.length, 1);
  assert.equal(parse(`take ${SCRIPT_LIMITS.maxTakeMs + 1}`).steps.length, 0);
});

test('grant 只认允许清单，rm_rf 之类连「武装」都做不到', () => {
  assert.equal(parse('grant rm_rf').steps.length, 0);
  assert.match(parse('grant rm_rf').rejected[0].reason, /unknown-capability/);
  const r = parse('grant click,scroll');
  assert.deepEqual(r.steps[0].caps, ['click', 'scroll']);
  // Named but not shipped: close_window costs unsaved work on a false positive.
  assert.equal(CAPABILITIES.close_window.grantable, false);
  assert.equal(parse('grant close_window').steps.length, 0);
  assert.match(parse('grant close_window').rejected[0].reason, /not-grantable/);
  // A mixed list keeps the legal half and still logs the bad name.
  const mixed = parse('grant click,rm_rf');
  assert.deepEqual(mixed.steps[0].caps, ['click']);
  assert.equal(mixed.rejected.length, 1);
  // Widening the allowlist is one switch, passed in rather than edited into the parser.
  assert.equal(parseScript('grant close_window', { capabilities: ['close_window'] }).steps.length, 1);
});

test('步骤数有上限，500 步的脚本只留下前面一小段', () => {
  const src = Array.from({ length: 500 }, () => 'emote nod').join('; ');
  let r = null;
  assert.doesNotThrow(() => { r = parse(src); });
  assert.ok(r.steps.length <= SCRIPT_LIMITS.maxSteps, `实际 ${r.steps.length} 步`);
  assert.ok(r.rejected.length > 0);
  assert.ok(r.rejected.some((x) => /too-many-steps|too-long|exceeds-total-duration/.test(x.reason)));
});

test('整段脚本时长有上限，超出的尾巴被丢掉', () => {
  const src = Array.from({ length: 12 }, () => 'wait 3000').join('; ');
  const r = parse(src);
  assert.ok(r.totalMs <= SCRIPT_LIMITS.maxTotalMs, `实际 ${r.totalMs}ms`);
  assert.ok(r.rejected.some((x) => /exceeds-total-duration/.test(x.reason)));
});

test('超长输入先截断，不会把整段丢掉', () => {
  const src = `emote wave; ${'x'.repeat(2000)}`;
  const r = parse(src);
  assert.equal(r.steps.length, 1);
  assert.ok(r.rejected.some((x) => /script-too-long/.test(x.reason)));
});

test('say 过长是截断而不是丢弃：半句话仍然是话，半个时长是编造', () => {
  const r = parse(`say ${'长'.repeat(400)}`);
  assert.equal(r.steps.length, 1);
  assert.ok(r.steps[0].text.length <= SCRIPT_LIMITS.maxSayChars);
  assert.ok(r.steps[0].text.endsWith('…'));
});

test('unicode 原样保留，只有控制字符被清掉', () => {
  assert.equal(parse('say 你好，要不要歇一会儿？').steps[0].text, '你好，要不要歇一会儿？');
  assert.equal(parse('say 🐈 mrow').steps[0].text, '🐈 mrow');
  assert.equal(parse('say a\u0001b\u0007c').steps[0].text, 'a b c');
});

test('换行也当分隔符，因为模型经常分行写', () => {
  const r = parse('look cursor\nemote wave\nsay hi');
  assert.equal(r.steps.length, 3);
});

test('散文和 JSON 之类的整段乱答，一步都不会被执行', () => {
  for (const src of [
    'I think the user wants me to wave.',
    '{"line":"hi","action":"wave"}',
    '```\nlook cursor\n```',
    'Sure! Here is the script:',
  ]) {
    const r = parse(src);
    assert.ok(r.steps.every((s) => Object.prototype.hasOwnProperty.call(VERBS, s.verb)), src);
  }
  assert.deepEqual(parse('I think the user wants me to wave.').steps, []);
});

test('describeVerbs 覆盖全部动词、全部动作名和全部能力，防止 prompt 与解析器漂移', () => {
  const text = describeVerbs({ vocabulary: VOCAB });
  for (const v of VERB_NAMES) assert.match(text, new RegExp(`\\b${v}\\b`), `prompt 缺动词 ${v}`);
  for (const a of VOCAB) assert.ok(text.includes(a.name), `prompt 缺动作 ${a.name}`);
  for (const c of GRANTABLE) assert.ok(text.includes(c), `prompt 缺能力 ${c}`);
  // A capability that is not grantable must not be advertised as if it were.
  assert.ok(!/grant.*close_window/.test(text));
  // The bounds are stated, not left for the model to discover by having steps dropped.
  assert.ok(text.includes(String(SCRIPT_LIMITS.maxSteps)));
  assert.ok(text.includes(String(SCRIPT_LIMITS.maxWaitMs)));
  assert.ok(text.includes(String(SCRIPT_LIMITS.maxSayChars)));
  // And the example it shows must itself parse, or the prompt is teaching a mistake.
  const shown = text.split('Example: ')[1];
  assert.equal(parse(shown).rejected.length, 0, shown);
});

test('runner 按顺序把步骤交给注入的回调', () => {
  const sink = recorder();
  const run = new ScriptRunner(sink);
  const { steps } = parse('look cursor; walk 0.7,0.3; emote wave; wait 300; say hi');
  run.start(steps, 0);
  // look and walk do not block, so they land on the first tick together with the emote.
  assert.deepEqual(sink.kinds(), ['look', 'move', 'emote']);
  run.update(500);
  assert.deepEqual(sink.kinds(), ['look', 'move', 'emote']);
  run.update(900);
  run.update(1300);
  assert.deepEqual(sink.kinds(), ['look', 'move', 'emote', 'say']);
  assert.equal(run.playing, false);
  assert.deepEqual(sink.log[1][1], { x: 0.7, y: 0.3, gait: 'walk' });
});

test('walk 交出去的是目标点而不是位置，wait 只是延迟', () => {
  const sink = recorder();
  const run = new ScriptRunner(sink);
  run.start(parse('wait 1000; emote nod'), 0);
  assert.deepEqual(sink.kinds(), [], 'wait 期间不该发生别的事');
  run.update(999);
  assert.deepEqual(sink.kinds(), []);
  run.update(1000);
  assert.deepEqual(sink.kinds(), ['emote']);
});

test('新脚本抢占旧脚本，旧脚本剩下的步骤永远不会再执行', () => {
  const sink = recorder();
  const run = new ScriptRunner(sink);
  run.start(parse('emote nod; wait 3000; say stale line'), 0);
  assert.deepEqual(sink.kinds(), ['emote']);
  const before = run.epoch;
  run.start(parse('say fresh line'), 1000);
  assert.ok(run.epoch > before, '抢占应该换代，好让异步 sink 认出自己过期了');
  for (let t = 1000; t <= 20000; t += 100) run.update(t);
  const said = sink.log.filter((e) => e[0] === 'say').map((e) => e[1]);
  assert.deepEqual(said, ['fresh line'], '被抢占的台词不该再出现');
});

test('cancel 之后剩余步骤作废，并且把身体和能力都交回去', () => {
  const sink = recorder();
  const run = new ScriptRunner(sink);
  run.start(parse('grant click; take 3000; wait 2000; say stale'), 0);
  assert.deepEqual(sink.kinds(), ['grant', 'take']);
  assert.ok(run.leaseActive(500));
  run.cancel(500, 'user-command');
  assert.equal(run.playing, false);
  assert.equal(run.leaseActive(500), false);
  assert.deepEqual(run.status(500).granted, []);
  assert.deepEqual(sink.kinds(), ['grant', 'take', 'revoke', 'release']);
  for (let t = 500; t <= 10000; t += 100) run.update(t);
  assert.ok(!sink.log.some((e) => e[0] === 'say'), '取消后不该再说话');
});

test('租约靠时钟自己过期，不依赖任何回复到达', () => {
  const sink = recorder();
  const run = new ScriptRunner(sink);
  run.start(parse('take 2000; emote nod'), 0);
  assert.ok(run.leaseActive(1999));
  run.update(1999);
  assert.ok(!sink.kinds().includes('release'));
  // Nothing else happens — no reply, no further script — and the body still comes back.
  run.update(2000);
  assert.equal(run.leaseActive(2000), false);
  assert.equal(sink.log.filter((e) => e[0] === 'release').length, 1);
  run.update(9000);
  assert.equal(sink.log.filter((e) => e[0] === 'release').length, 1, 'release 只该发一次');
});

test('release 动词立刻把身体还给反射层', () => {
  const sink = recorder();
  const run = new ScriptRunner(sink);
  run.start(parse('take 5000; release'), 0);
  assert.equal(run.leaseActive(0), false);
  assert.deepEqual(sink.kinds(), ['take', 'release']);
});

test('sink 抛异常不会让脚本卡死，也不会冒到快循环', () => {
  const boom = { emote: () => { throw new Error('canvas gone'); }, say: (t) => { boom.said = t; } };
  const run = new ScriptRunner(boom);
  assert.doesNotThrow(() => run.start(parse('emote nod; say still here'), 0));
  run.update(900);
  assert.equal(boom.said, 'still here');
  assert.match(run.lastError, /canvas gone/);
});

test('sink 上没实现的回调只是没人接，不是崩溃', () => {
  const run = new ScriptRunner({});
  assert.doesNotThrow(() => run.start(parse('look user; emote nod; say hi; grant click; take 500'), 0));
  assert.doesNotThrow(() => run.update(10000));
});

test('runner 可以直接吃 parseScript 的返回值', () => {
  const sink = recorder();
  const run = new ScriptRunner(sink);
  run.start(parse('say hello'), 0);
  assert.deepEqual(sink.kinds(), ['say']);
  // And a garbage script simply plays nothing.
  const run2 = new ScriptRunner(sink);
  assert.doesNotThrow(() => run2.start(parse('frobnicate everything'), 0));
  assert.equal(run2.playing, false);
});

test('stepDurationMs：只有 wait / emote / say 占用身体', () => {
  assert.equal(stepDurationMs({ verb: 'wait', ms: 250 }), 250);
  assert.equal(stepDurationMs({ verb: 'emote', action: 'wave', durationMs: 1200 }), 1200);
  assert.equal(stepDurationMs({ verb: 'emote', action: 'x', durationMs: 0 }), SCRIPT_LIMITS.defaultEmoteMs);
  assert.ok(stepDurationMs({ verb: 'say', text: 'hello there' }) >= SCRIPT_LIMITS.minSayMs);
  for (const s of [{ verb: 'walk' }, { verb: 'run' }, { verb: 'look' }, { verb: 'grant' }, { verb: 'release' }, { verb: 'take', ms: 3000 }]) {
    assert.equal(stepDurationMs(s), 0, `${s.verb} 不该阻塞脚本`);
  }
});

test('上限本身是有理由的数，不是随手写的', () => {
  assert.ok(SCRIPT_LIMITS.maxSteps >= 5 && SCRIPT_LIMITS.maxSteps <= 20);
  assert.ok(SCRIPT_LIMITS.maxWaitMs < SCRIPT_LIMITS.maxTotalMs, '单次停顿不该能占满整段脚本');
  assert.ok(SCRIPT_LIMITS.maxTakeMs <= SCRIPT_LIMITS.maxTotalMs, '租约不该长过整段表演');
  assert.ok(SCRIPT_LIMITS.maxTakeMs >= 3000, 'DESIGN.md 的例子是 take 3000，必须放得下');
  assert.equal(SCRIPT_LIMITS.maxSayChars, 90, '和 brain.js 的 maxLineChars 保持一致');
});

test('mood 设置持续状态：合法状态被接受，编造的被丢弃', () => {
  const r = parseScript('mood happy; mood 生气; mood AWAY; mood sleepy', { vocabulary: VOCAB });
  // `away` is presence, measured by the camera — the model may not decide the user left.
  assert.deepEqual(r.steps.map((s) => s.state), ['happy', 'sleepy'], 'away 和编造值都不该过');
  assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.every((x) => /unknown-mood/.test(x.reason)));
});

test('runner 把 mood 交给 sink，且 mood 不占表演时长', () => {
  const moods = [];
  const runner = new ScriptRunner({ mood: (m) => moods.push(m) });
  const { steps, totalMs } = parseScript('mood curious; say hi', { vocabulary: VOCAB });
  runner.start(steps, 0);
  runner.update(1);
  assert.deepEqual(moods, ['curious']);
  const withoutMood = parseScript('say hi', { vocabulary: VOCAB }).totalMs;
  assert.equal(totalMs, withoutMood, 'mood 是瞬时的，不该计入 maxTotalMs');
});

test('describeVerbs 把 mood 及其取值范围写进给模型的说明', () => {
  const text = describeVerbs({ vocabulary: VOCAB });
  assert.match(text, /mood <state>/);
  for (const m of MOODS) assert.ok(text.includes(m), `说明里缺 ${m}`);
});

test('snap 是无参工具调用，runner 把它交给 sink', () => {
  const calls = [];
  const runner = new ScriptRunner({ snap: () => calls.push('snap') });
  const { steps } = parseScript('snap; say checking', { vocabulary: VOCAB });
  assert.equal(steps[0].verb, 'snap');
  runner.start(steps, 0);
  runner.update(1);
  assert.deepEqual(calls, ['snap']);
});
