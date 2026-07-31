import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PetCore, makeFeatures, featuresFromMediapipe, POLICIES } from '../pet-core.js';
import { CHANNELS, GLOBAL_FLOOR_MS, UNSOLICITED_BUDGET } from '../triggers.js';

// Feeds `n` frames at `step` ms, letting the caller mutate each frame.
function feed(core, n, step, mut = () => ({}), startT = 0) {
  let last;
  for (let i = 0; i < n; i += 1) {
    const t = startT + i * step;
    last = core.updateFast(makeFeatures({ t, facePresent: true, ...mut(i, t) }));
  }
  return last;
}

test('calibration completes after calibrationFrames and sets a baseline', () => {
  const core = new PetCore({ calibrationFrames: 10 });
  assert.equal(core.calibrated, false);
  feed(core, 9, 33, () => ({ faceCenterY: 0.4, faceSize: 0.3 }));
  assert.equal(core.calibrated, false, 'must not calibrate early');
  feed(core, 1, 33, () => ({ faceCenterY: 0.4, faceSize: 0.3 }), 9 * 33);
  assert.equal(core.calibrated, true);
  assert.ok(Math.abs(core.baseline.centerY - 0.4) < 1e-9);
  assert.ok(Math.abs(core.baseline.size - 0.3) < 1e-9);
});

test('slump is ~0 at baseline and rises when the head drops', () => {
  const core = new PetCore({ calibrationFrames: 10 });
  feed(core, 40, 33, () => ({ faceCenterY: 0.4, faceSize: 0.3 }));
  assert.ok(Math.abs(core.state.slump) < 0.02, `expected ~0, got ${core.state.slump}`);
  const s = feed(core, 120, 33, () => ({ faceCenterY: 0.5, faceSize: 0.3 }), 40 * 33);
  assert.ok(s.slump > 0.06, `slump should exceed threshold, got ${s.slump}`);
  // The reading rises but the sprite does not judge: expression belongs to the model's
  // `mood` verb now, and locally the face stays whatever it was.
  assert.equal(s.sprite, 'idle');
});

test('blink hysteresis counts one event per blink, not per frame', () => {
  const core = new PetCore({ calibrationFrames: 1 });
  // 5 blinks: each is 3 frames high then 3 frames low.
  let t = 0;
  for (let b = 0; b < 5; b += 1) {
    for (let i = 0; i < 3; i += 1) core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, blink: 0.9 }));
    for (let i = 0; i < 3; i += 1) core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, blink: 0.05 }));
  }
  assert.equal(core.blinkTimes.length, 5, `expected 5 blink events, got ${core.blinkTimes.length}`);
});

test('blinkRate is per-minute and independent of the clock origin', () => {
  const mk = (startT) => {
    const core = new PetCore({ calibrationFrames: 1 });
    let t = startT;
    // 10 blinks spread over 10 s -> 60/min.
    for (let b = 0; b < 10; b += 1) {
      core.updateFast(makeFeatures({ t: (t += 500), facePresent: true, blink: 0.9 }));
      core.updateFast(makeFeatures({ t: (t += 500), facePresent: true, blink: 0.05 }));
    }
    return core.state.blinkRate;
  };
  const atZero = mk(0);
  const atLarge = mk(1_234_567);
  assert.ok(atZero > 40 && atZero < 75, `rate at t0=0 out of range: ${atZero}`);
  assert.ok(
    Math.abs(atZero - atLarge) < 1,
    `blinkRate must not depend on clock origin: ${atZero} vs ${atLarge}`,
  );
});

test('a sustained open jaw counts exactly one yawn', () => {
  const core = new PetCore({ calibrationFrames: 1, yawnHoldMs: 700 });
  feed(core, 60, 33, () => ({ jawOpen: 0.8 }));
  assert.equal(core.yawnCount, 1, `expected 1 yawn, got ${core.yawnCount}`);
  feed(core, 10, 33, () => ({ jawOpen: 0.0 }), 60 * 33);
  feed(core, 60, 33, () => ({ jawOpen: 0.8 }), 70 * 33);
  assert.equal(core.yawnCount, 2, 'a second yawn after closing should count');
});

test('away then return produces a return trigger', () => {
  const core = new PetCore({ calibrationFrames: 5, returnAfterMs: 1000, reactionDelayMs: 0 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.4 }));
  let t = 20 * 33;
  for (let i = 0; i < 200; i += 1) {
    core.updateFast(makeFeatures({ t: (t += 33), facePresent: false }));
  }
  assert.equal(core.state.sprite, 'away');
  assert.ok(core.state.awayMs > 1000);
  const back = core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceCenterY: 0.4 }));
  assert.notEqual(back.sprite, 'away');
  const returned = core.log.some((r) => r.trigger === 'return');
  assert.ok(returned, 'a return trigger should be logged');
});

test('posture readings are never reported for a face that is not there', () => {
  const core = new PetCore({ calibrationFrames: 5, returnAfterMs: 1000 });
  // Calibrate at 0.42, then slump hard so the stale value would be 1.0.
  feed(core, 10, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  const slumped = feed(core, 200, 33, () => ({ faceCenterY: 0.65, faceSize: 0.3 }), 10 * 33);
  assert.ok(slumped.slump > 0.5, `should be slumping first, got ${slumped.slump}`);

  let t = 210 * 33;
  let last;
  for (let i = 0; i < 200; i += 1) {
    last = core.updateFast(makeFeatures({ t: (t += 33), facePresent: false }));
  }
  assert.equal(last.sprite, 'away');
  assert.equal(last.slump, 0, `stale slump leaked while away: ${last.slump}`);
  assert.equal(last.leanRatio, 1, `stale leanRatio leaked while away: ${last.leanRatio}`);
  assert.equal(last.attention, false);

  // Coming back at a good posture must not immediately re-report the old slump.
  const back = core.updateFast(makeFeatures({ t: t + 33, facePresent: true, faceCenterY: 0.42, faceSize: 0.3 }));
  assert.ok(Math.abs(back.slump) < 0.02, `posture should re-seed on return, got ${back.slump}`);
});

test('mood does not collapse from a stale posture while away', () => {
  const core = new PetCore({ calibrationFrames: 5, returnAfterMs: 1000, policy: 'honest' });
  feed(core, 10, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  feed(core, 200, 33, () => ({ faceCenterY: 0.65, faceSize: 0.3 }), 10 * 33);
  let t = 210 * 33;
  for (let i = 0; i < 400; i += 1) core.updateFast(makeFeatures({ t: (t += 33), facePresent: false }));
  assert.ok(core.state.mood > 0.4, `mood should recover once posture is unknown, got ${core.state.mood}`);
});

// Reproduces the reported chatter: yawning pins `sleepy` on, and opening the mouth
// drags the face centroid down far enough to cross the slump threshold, so the sprite
// flips annoyed<->sleepy every few frames. Before the fix each flip re-fired the line.
test('打哈欠时姿势抖动不会让 sleepy 台词反复触发', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0, policy: 'honest' });
  feed(core, 10, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 10 * 33;
  // Hold a yawn long enough to register, with faceCenterY oscillating across the
  // slump threshold the way an opening mouth actually makes it.
  for (let i = 0; i < 400; i += 1) {
    core.updateFast(makeFeatures({
      t: (t += 33),
      facePresent: true,
      faceSize: 0.3,
      jawOpen: i < 40 ? 0.8 : 0.1,
      faceCenterY: i % 6 < 3 ? 0.62 : 0.42,
    }));
  }
  const sleepyTriggers = core.log.filter((r) => r.trigger === 'sleepy').length;
  assert.ok(sleepyTriggers <= 1, `sleepy 触发了 ${sleepyTriggers} 次，应最多 1 次`);
  const lines = core.log.filter((r) => r.line).length;
  assert.ok(lines < 12, `${400 * 33 / 1000} 秒内说了 ${lines} 句，太吵`);
});

test('同一通道在冷却时间内不会重复', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 10, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 10 * 33;
  // Sit exactly on the threshold so slump/good would otherwise alternate every frame.
  for (let i = 0; i < 300; i += 1) {
    core.updateFast(makeFeatures({
      t: (t += 33), facePresent: true, faceSize: 0.3,
      faceCenterY: i % 2 === 0 ? 0.62 : 0.42,
    }));
  }
  // Both belong to the posture channel, so its cooldown applies across the pair.
  const times = core.log.filter((r) => r.trigger === 'slump' || r.trigger === 'good').map((r) => r.t);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= CHANNELS.posture.cooldownMs,
      `姿态通道两次触发只隔了 ${times[i] - times[i - 1]}ms`);
  }
});

test('哈欠会随时间窗过期，不会永久把状态钉在 sleepy', () => {
  const core = new PetCore({ calibrationFrames: 5, yawnWindowMs: 5000, sleepyBlinkRate: 999 });
  feed(core, 10, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 10 * 33;
  for (let i = 0; i < 40; i += 1) {
    core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceCenterY: 0.42, faceSize: 0.3, jawOpen: 0.8 }));
  }
  assert.equal(core.yawnCount, 1);
  // Let the window pass with the mouth shut.
  for (let i = 0; i < 250; i += 1) {
    core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceCenterY: 0.42, faceSize: 0.3 }));
  }
  assert.equal(core.yawnCount, 0, '哈欠应已过期');
});

// The three-way switch is what actually turns the canned tables off, so each mode's
// contract is pinned: canned speaks, model speaks and falls back, modelOnly never
// consults the tables at all.
// Eight trigger kinds each on a 6 s per-kind cooldown still allowed eight events inside
// six seconds, which is what made the character twitch. The global floor is the fix.
// The reported symptom was the pet saying "sit up" over and over. slump is
// (centerY - baseline) / 0.2, so the old 0.06 threshold fired on a 1.2%-of-frame move —
// roughly six pixels at 480p, which breathing crosses. These pin the three fixes:
// a higher entry point, separate exit point, and a dwell requirement.
const atSlump = (baseline, want) => baseline + want * 0.2;

test('轻微晃动不再触发姿态提醒', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 20 * 33;
  // Wobble around slump 0.10 — clearly above the old 0.06, below the new entry 0.28.
  for (let i = 0; i < 600; i += 1) {
    core.updateFast(makeFeatures({
      t: (t += 33), facePresent: true, faceSize: 0.3,
      faceCenterY: atSlump(0.42, i % 2 === 0 ? 0.06 : 0.12),
    }));
  }
  const slumps = core.log.filter((r) => r.trigger === 'slump').length;
  assert.equal(slumps, 0, `轻微晃动触发了 ${slumps} 次姿态提醒`);
});

test('短暂前倾（低于持续时间）不算塌', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0, slumpDwellMs: 1600 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 20 * 33;
  // Deep but brief: ~1 s of real slouch, then back up. Repeated several times.
  for (let cycle = 0; cycle < 4; cycle += 1) {
    for (let i = 0; i < 30; i += 1) {
      core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceSize: 0.3, faceCenterY: atSlump(0.42, 0.6) }));
    }
    for (let i = 0; i < 60; i += 1) {
      core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceSize: 0.3, faceCenterY: 0.42 }));
    }
  }
  const slumps = core.log.filter((r) => r.trigger === 'slump').length;
  assert.equal(slumps, 0, `短暂前倾触发了 ${slumps} 次`);
});

test('在 exit 和 enter 之间徘徊不会让 slump/good 反复翻', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 20 * 33;
  // Sit right in the dead band: above exit 0.14, below enter 0.28.
  for (let i = 0; i < 900; i += 1) {
    core.updateFast(makeFeatures({
      t: (t += 33), facePresent: true, faceSize: 0.3,
      faceCenterY: atSlump(0.42, i % 2 === 0 ? 0.16 : 0.26),
    }));
  }
  const flips = core.log.filter((r) => r.trigger === 'slump' || r.trigger === 'good').length;
  assert.equal(flips, 0, `死区内翻转了 ${flips} 次`);
});

test('真的塌下去触发一次；姿态通道随后进入分钟级冷却', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  const step = 33;
  let t = 20 * step;
  const run = (ms, centerY) => {
    for (let i = 0; i < Math.round(ms / step); i += 1) {
      core.updateFast(makeFeatures({ t: (t += step), facePresent: true, faceSize: 0.3, faceCenterY: centerY }));
    }
  };
  run(7000, atSlump(0.42, 0.7));
  assert.equal(core.log.filter((r) => r.trigger === 'slump').length, 1, '持续塌着应恰好触发一次');

  // Sitting up seconds later is real, but posture speaks at most once a minute or so:
  // being told to sit up and then praised eight seconds later is the nagging we removed.
  run(7000, 0.42);
  assert.equal(core.log.filter((r) => r.trigger === 'good').length, 0, '冷却期内不该马上夸');

  // A suppressed edge is simply missed, not queued up: it was a moment, and the moment
  // passed. What the cooldown must not do is silence the channel forever — once it is
  // past, the next real posture change is reported again.
  run(80000, 0.42);
  assert.equal(core.log.filter((r) => r.trigger === 'good').length, 0, '被挡掉的沿不该补发');
  run(7000, atSlump(0.42, 0.7));
  assert.equal(core.log.filter((r) => r.trigger === 'slump').length, 2, '过了冷却，新的姿态变化应再次被注意到');
});

test('打字的手不会被当成手势：手型每几帧一变，一句都不该说', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 20 * 33;
  // Fingers over keys: classifyHand flips through shapes every few frames. This is the exact
  // scenario that produced a remark every 2.5 s — 24 a minute — before the dwell existed.
  const flicker = ['pinch', 'openPalm', 'fist', 'point_up', 'openPalm', 'pinch'];
  for (let i = 0; i < 5400; i += 1) {   // three minutes
    core.updateFast(makeFeatures({
      t: (t += 33), facePresent: true, faceSize: 0.3, faceCenterY: 0.42,
      handShape: flicker[Math.floor(i / 3) % flicker.length], handCount: 1,
    }));
  }
  const said = core.log.filter((r) => r.trigger === 'handShape').length;
  assert.equal(said, 0, `打字被当成了 ${said} 次手势`);
});

test('刻意举住的手势仍然会被应答', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 20 * 33;
  // Held still for a second and a half: that is somebody signing at the pet, not typing.
  for (let i = 0; i < 45; i += 1) {
    core.updateFast(makeFeatures({
      t: (t += 33), facePresent: true, faceSize: 0.3, faceCenterY: 0.42,
      handShape: 'victory', handCount: 1,
    }));
  }
  assert.equal(core.log.filter((r) => r.trigger === 'handShape').length, 1,
    '举住的手势应该恰好被应答一次');
});

test('主动开口有总预算，最坏情况下十分钟也不会喋喋不休', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 20 * 33;
  // Someone shifting, frowning and yawning throughout — every unprompted channel active.
  for (let i = 0; i < 18000; i += 1) {
    const slouching = i % 2000 >= 300;
    core.updateFast(makeFeatures({
      t: (t += 33), facePresent: true, faceSize: 0.3,
      faceCenterY: slouching ? atSlump(0.42, 0.7) : 0.42,
      browDown: i % 3000 < 400 ? 0.8 : 0,
      jawOpen: i % 5000 < 120 ? 0.85 : 0,
    }));
  }
  const volunteered = core.log.filter((r) => ['slump', 'good', 'expression', 'sleepy'].includes(r.trigger)).length;
  assert.ok(volunteered <= UNSOLICITED_BUDGET.count,
    `十分钟内主动开口 ${volunteered} 次，预算是 ${UNSOLICITED_BUDGET.count}`);
});

test('一直塌着的人不会被反复提醒', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 20, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 20 * 33;
  // Ten minutes of habitual slouching, with brief straightenings that do not last.
  for (let i = 0; i < 18000; i += 1) {
    core.updateFast(makeFeatures({
      t: (t += 33), facePresent: true, faceSize: 0.3,
      faceCenterY: i % 900 < 60 ? 0.42 : atSlump(0.42, 0.7),
    }));
  }
  const nags = core.log.filter((r) => r.trigger === 'slump').length;
  assert.ok(nags <= 2, `十分钟里提醒了 ${nags} 次坐姿，应该 <= 2`);
});

test('任意两次触发之间有全局下限，八种触发不会挤在一起', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 10, 33, () => ({ faceCenterY: 0.42, faceSize: 0.3 }));
  let t = 10 * 33;
  const fired = [];
  // Everything changes at once, over and over: posture, expression, hand shape, waving.
  for (let i = 0; i < 900; i += 1) {
    const st = core.updateFast(makeFeatures({
      t: (t += 33),
      facePresent: true,
      faceSize: 0.3,
      faceCenterY: i % 40 < 20 ? 0.65 : 0.42,
      expression: ['smile', 'skeptical', 'surprise', 'frown'][Math.floor(i / 7) % 4],
      handShape: ['fist', 'openPalm', 'victory', 'ok'][Math.floor(i / 11) % 4],
      waving: i % 90 < 8,
      handNearFace: i % 130 < 10,
      jawOpen: i % 200 < 30 ? 0.8 : 0,
    }));
    if (st.trigger) fired.push({ t: st.t, trigger: st.trigger });
  }
  assert.ok(fired.length > 3, `应该还有触发，实际 ${fired.length}`);
  for (let i = 1; i < fired.length; i += 1) {
    const gap = fired[i].t - fired[i - 1].t;
    assert.ok(gap >= GLOBAL_FLOOR_MS,
      `${fired[i - 1].trigger} -> ${fired[i].trigger} 只隔了 ${gap}ms`);
  }
  // Hands may answer often; posture/expression are minute-scale, so 30 s of everything
  // changing at once should still stay well under a dozen remarks.
  assert.ok(fired.length <= 12, `30 秒内触发了 ${fired.length} 次，太密`);
  const slow = fired.filter((f) => ['slump', 'good', 'expression', 'sleepy'].includes(f.trigger)).length;
  assert.ok(slow <= 3, `慢通道在 30 秒里触发了 ${slow} 次，应该很少`);
});

test('快环彻底不产生台词：任何策略、任何触发，state 里都没有 line 字段', () => {
  // The puppet has one author. If this fails, someone reintroduced local speech.
  for (const policy of POLICIES) {
    const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0, policy });
    feed(core, 10, 33, () => ({ faceCenterY: 0.4 }));
    let t = 10 * 33;
    for (let i = 0; i < 300; i += 1) {
      const s = core.updateFast(makeFeatures({
        t: (t += 33), facePresent: true, faceCenterY: 0.65, gesture: i === 100 ? 'Thumb_Up' : null,
      }));
      assert.ok(!('line' in s), `${policy}: state 不该再有 line`);
    }
    assert.ok(core.log.some((r) => r.trigger), `${policy}: 触发本身要照常工作`);
  }
});

test('reactionDelayMs holds the trigger back, then emits it exactly once', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 200, policy: 'honest' });
  feed(core, 10, 33, () => ({ faceCenterY: 0.4 }));
  let t = 10 * 33;
  let firstEmitT = null;
  let emitCount = 0;
  for (let i = 0; i < 200; i += 1) {
    const s = core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceCenterY: 0.6 }));
    if (s.trigger) {
      emitCount += 1;
      if (firstEmitT == null) firstEmitT = s.t;
    }
  }
  assert.ok(firstEmitT != null, 'the delayed trigger must eventually surface');
  assert.equal(emitCount, 1, '同一个触发只该浮出一次');
  const triggerRow = core.log.find((r) => r.trigger === 'slump');
  assert.ok(triggerRow, 'slump must be logged');
  assert.ok(
    firstEmitT - triggerRow.t >= 200,
    `trigger surfaced ${firstEmitT - triggerRow.t} ms after detection, expected >= 200`,
  );
});

test('表情归模型：本地检测不再写 sprite，setMood 是唯一入口', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 10, 33, () => ({ faceCenterY: 0.4 }));
  let t = 10 * 33;
  const sprites = new Set();
  // Slouch, smile, lean — everything that used to flip the sprite locally.
  for (let i = 0; i < 300; i += 1) {
    const s = core.updateFast(makeFeatures({
      t: (t += 33), facePresent: true, faceCenterY: 0.65, smile: 0.9, faceSize: 0.4,
    }));
    sprites.add(s.sprite);
  }
  assert.deepEqual([...sprites], ['idle'], `检测不该改变表情，实际出现了 ${[...sprites]}`);

  core.setMood('annoyed');
  let s2 = core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceCenterY: 0.4 }));
  assert.equal(s2.sprite, 'annoyed', 'setMood 应立即生效');
  core.setMood('nonsense');
  s2 = core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceCenterY: 0.4 }));
  assert.equal(s2.sprite, 'annoyed', '非法 mood 名必须被拒绝');
});

test('presence 依然压过 mood：人不在时永远是 away，回来恢复', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 10, 33, () => ({ faceCenterY: 0.4 }));
  core.setMood('happy');
  let t = 10 * 33;
  let s = null;
  for (let i = 0; i < 150; i += 1) s = core.updateFast(makeFeatures({ t: (t += 33), facePresent: false }));
  assert.equal(s.sprite, 'away', '模型不能决定用户在不在');
  for (let i = 0; i < 60; i += 1) s = core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, faceCenterY: 0.4 }));
  assert.equal(s.sprite, 'happy', '回来后恢复模型设的 mood');
});



test('every policy is constructible and rejects unknown names', () => {
  for (const p of POLICIES) assert.doesNotThrow(() => new PetCore({ policy: p }));
  assert.throws(() => new PetCore({ policy: 'nope' }));
  const core = new PetCore();
  assert.throws(() => core.setPolicy('nope'));
});

test('slow loop is rate limited and needs calibration', () => {
  const core = new PetCore({ calibrationFrames: 5, slowMinIntervalMs: 4000, slowPeriodMs: 8000 });
  assert.equal(core.shouldTriggerSlow(0), null, 'must not fire before calibration');
  feed(core, 10, 33, () => ({ faceCenterY: 0.4 }));
  const t0 = 10 * 33;
  assert.equal(core.shouldTriggerSlow(t0), 'periodic');
  assert.equal(core.shouldTriggerSlow(t0 + 100), null, 'rate limit must hold');
  assert.equal(core.shouldTriggerSlow(t0 + 3999), null);
  assert.equal(core.shouldTriggerSlow(t0 + 9000), 'periodic');
});

test('slow loop does not fire while the user is away', () => {
  const core = new PetCore({ calibrationFrames: 5, returnAfterMs: 1000 });
  feed(core, 10, 33, () => ({ faceCenterY: 0.4 }));
  let t = 10 * 33;
  for (let i = 0; i < 200; i += 1) core.updateFast(makeFeatures({ t: (t += 33), facePresent: false }));
  assert.equal(core.shouldTriggerSlow(t + 20000), null, 'nobody to describe while away');
});

test('ingestSemantic 只记录语义，不再驱动任何输出', () => {
  const core = new PetCore({ calibrationFrames: 1, reactionDelayMs: 0, policy: 'honest' });
  core.updateFast(makeFeatures({ t: 0, facePresent: true }));
  core.ingestSemantic('spacing out', 100);
  const s = core.updateFast(makeFeatures({ t: 200, facePresent: true }));
  assert.equal(s.semantic, 'spacing out', '语义要能被下一次 prompt 读到');
  assert.ok(!('line' in s), '但绝不产生台词');
});

test('csv has a header and one row per logged event', () => {
  const core = new PetCore({ calibrationFrames: 5, reactionDelayMs: 0 });
  feed(core, 10, 33, () => ({ faceCenterY: 0.4 }));
  feed(core, 100, 33, () => ({ faceCenterY: 0.65 }), 10 * 33);
  const csv = core.toCsv();
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /^t,policy,trigger,sprite,/);
  assert.equal(lines.length, core.log.length + 1);
  for (const l of lines.slice(1)) {
    assert.equal(l.split(',').length, lines[0].split(',').length, `ragged row: ${l}`);
  }
});

test('featuresFromMediapipe maps blendshapes, geometry and gestures', () => {
  const landmarks = [];
  for (let i = 0; i < 20; i += 1) {
    landmarks.push({ x: 0.4 + (i % 5) * 0.02, y: 0.3 + Math.floor(i / 5) * 0.02, z: 0 });
  }
  const f = featuresFromMediapipe({
    t: 1000,
    faceResult: {
      faceLandmarks: [landmarks],
      faceBlendshapes: [{
        categories: [
          { categoryName: 'eyeBlinkLeft', score: 0.8 },
          { categoryName: 'eyeBlinkRight', score: 0.2 },
          { categoryName: 'mouthSmileLeft', score: 0.6 },
          { categoryName: 'mouthSmileRight', score: 0.4 },
          { categoryName: 'jawOpen', score: 0.7 },
          { categoryName: 'browDownLeft', score: 0.1 },
          { categoryName: 'browDownRight', score: 0.3 },
        ],
      }],
      facialTransformationMatrixes: [{
        data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      }],
    },
    gestureResult: { gestures: [[{ categoryName: 'Thumb_Up', score: 0.93 }]] },
  });
  assert.equal(f.facePresent, true);
  assert.equal(f.blink, 0.8);
  assert.equal(f.smile, 0.6);
  assert.equal(f.jawOpen, 0.7);
  assert.equal(f.browDown, 0.3);
  assert.equal(f.gesture, 'Thumb_Up');
  assert.ok(Math.abs(f.headYaw) < 1, `identity matrix should give ~0 yaw, got ${f.headYaw}`);
  assert.ok(f.faceCenterY > 0.3 && f.faceCenterY < 0.4);
  assert.ok(f.faceSize > 0);
});

test('featuresFromMediapipe reports no face when results are empty', () => {
  const f = featuresFromMediapipe({ t: 5, faceResult: { faceLandmarks: [] }, gestureResult: null });
  assert.equal(f.facePresent, false);
  assert.equal(f.gesture, null);
  const g = featuresFromMediapipe({ t: 5, faceResult: null, gestureResult: { gestures: [[{ categoryName: 'None', score: 0.5 }]] } });
  assert.equal(g.gesture, null, '"None" is not a gesture');
});

test('a None gesture does not retrigger curious every frame', () => {
  const core = new PetCore({ calibrationFrames: 1, reactionDelayMs: 0 });
  core.updateFast(makeFeatures({ t: 0, facePresent: true }));
  let curiousFrames = 0;
  let t = 0;
  for (let i = 0; i < 60; i += 1) {
    const s = core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, gesture: 'None' }));
    if (s.sprite === 'curious') curiousFrames += 1;
  }
  assert.equal(curiousFrames, 0, 'None must not be treated as a gesture');
});

test('a held gesture fires once, not on every frame', () => {
  const core = new PetCore({ calibrationFrames: 1, reactionDelayMs: 0, policy: 'honest' });
  core.updateFast(makeFeatures({ t: 0, facePresent: true }));
  let t = 0;
  for (let i = 0; i < 60; i += 1) {
    core.updateFast(makeFeatures({ t: (t += 33), facePresent: true, gesture: 'Thumb_Up' }));
  }
  const gestureTriggers = core.log.filter((r) => r.trigger === 'gesture').length;
  assert.equal(gestureTriggers, 1, `held gesture should trigger once, got ${gestureTriggers}`);
});

test('reset returns the core to a pristine state', () => {
  const core = new PetCore({ calibrationFrames: 5 });
  feed(core, 100, 33, () => ({ faceCenterY: 0.6, blink: 0.9 }));
  assert.ok(core.log.length > 0 || core.calibrated);
  core.reset();
  assert.equal(core.calibrated, false);
  assert.equal(core.log.length, 0);
  assert.equal(core.yawnCount, 0);
  assert.equal(core.blinkTimes.length, 0);
  assert.equal(core.state.sprite, 'away');
});
