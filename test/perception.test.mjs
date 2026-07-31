import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPRESSION_RULES, ExpressionDetector, blendshapeLookup, expressionDesc,
  fingerStates, pinchAmount, pointingDirection, classifyHand, handNearFace,
  WaveDetector, readHands,
} from '../perception.js';
import { HAND_CONNECTIONS, toPixels, faceBox, annotateFrame } from '../annotate.js';

const bs = (obj) => blendshapeLookup(Object.entries(obj).map(([categoryName, score]) => ({ categoryName, score })));

// Builds 21 hand landmarks: wrist at origin, each named finger either extended or
// curled, so the finger tests are exercised without a real hand.
function hand({ extended = [], pinch = false, dir = 'up' } = {}) {
  const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  // The wrist sits opposite the pointing direction, or fingers reaching that way would
  // not be further from the wrist than their own knuckle and would read as curled.
  const away = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }[dir];
  const wrist = { x: 0.5 + away[0] * 0.4, y: 0.5 + away[1] * 0.4, z: 0 };
  pts[0] = wrist;
  const spec = {
    thumb: [2, 4], index: [6, 8], middle: [10, 12], ring: [14, 16], pinky: [18, 20],
  };
  // Each finger is laid out along -away, splayed sideways so no two tips coincide —
  // real thumb and index tips are never at the same point on an open hand.
  const lateral = [away[1], away[0]];
  for (const [i, [name, [pip, tip]]] of Object.entries(spec).entries()) {
    // The thumb abducts well away from the palm and is shorter than the fingers. Laying
    // all five out in an even row instead puts the thumb tip next to the index tip, and
    // an open palm then measures as a pinch.
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
    // Thumb and index tips brought together while the rest stay where they were.
    const p = { x: wrist.x - away[0] * 0.45, y: wrist.y - away[1] * 0.45, z: 0 };
    pts[4] = p;
    pts[8] = { x: p.x + 0.004, y: p.y + 0.004, z: 0 };
  }
  return pts;
}

test('每条表情规则都有名字、描述和迟滞阈值', () => {
  for (const r of EXPRESSION_RULES) {
    assert.ok(r.name && r.desc, `规则缺字段: ${JSON.stringify(r)}`);
    assert.ok(r.on > r.off, `${r.name} 的 on(${r.on}) 必须大于 off(${r.off})`);
    assert.equal(typeof r.score, 'function');
  }
});

test('规则只引用模型真实存在的 blendshape 名', () => {
  // Read out of models/face_landmarker.task; a typo here silently scores 0 forever.
  const REAL = new Set(['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft',
    'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft',
    'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
    'jawOpen', 'mouthClose', 'mouthFrownLeft', 'mouthFrownRight', 'mouthPressLeft',
    'mouthPressRight', 'mouthPucker', 'mouthSmileLeft', 'mouthSmileRight',
    'noseSneerLeft', 'noseSneerRight', 'tongueOut']);
  const seen = new Set();
  const spy = (name) => { seen.add(name); return 0.5; };
  for (const r of EXPRESSION_RULES) r.score(spy);
  for (const n of seen) assert.ok(REAL.has(n), `规则用了不存在的 blendshape: ${n}`);
});

test('笑和吐舌头能被分别识别', () => {
  const d = new ExpressionDetector();
  assert.equal(d.update(bs({ mouthSmileLeft: 0.8 })).name, 'smile');
  d.reset();
  assert.equal(d.update(bs({ tongueOut: 0.7 })).name, 'tongueOut');
});

test('惊讶需要三个条件同时成立，缺一个就不是', () => {
  const d = new ExpressionDetector();
  const full = { browInnerUp: 0.8, eyeWideLeft: 0.7, jawOpen: 0.5 };
  assert.equal(d.update(bs(full)).name, 'surprise');
  d.reset();
  // Raised brows alone must not read as surprise.
  assert.notEqual(d.update(bs({ browInnerUp: 0.9 })).name, 'surprise');
});

test('表情有迟滞：在阈值附近抖动不会反复 changed', () => {
  const d = new ExpressionDetector();
  const first = d.update(bs({ mouthSmileLeft: 0.5 }));
  assert.equal(first.changed, true);
  let changes = 0;
  for (let i = 0; i < 40; i += 1) {
    // Oscillate across the 0.35 `on` threshold but stay above the 0.20 `off`.
    const v = i % 2 === 0 ? 0.30 : 0.40;
    if (d.update(bs({ mouthSmileLeft: v })).changed) changes += 1;
  }
  assert.equal(changes, 0, `迟滞失效，抖动了 ${changes} 次`);
});

test('表情消失后会回到 null', () => {
  const d = new ExpressionDetector();
  d.update(bs({ mouthSmileLeft: 0.8 }));
  const gone = d.update(bs({ mouthSmileLeft: 0.05 }));
  assert.equal(gone.name, null);
  assert.equal(gone.changed, true);
});

test('expressionDesc 对每个规则名都有中文描述', () => {
  for (const r of EXPRESSION_RULES) assert.notEqual(expressionDesc(r.name), r.name);
});

test('手指伸展判定：拳头 / 张掌 / 剪刀手', () => {
  assert.deepEqual(fingerStates(hand({ extended: [] })),
    { thumb: false, index: false, middle: false, ring: false, pinky: false });
  const all = fingerStates(hand({ extended: ['thumb', 'index', 'middle', 'ring', 'pinky'] }));
  assert.equal(Object.values(all).every(Boolean), true);
  const v = fingerStates(hand({ extended: ['index', 'middle'] }));
  assert.equal(v.index && v.middle && !v.ring, true);
});

test('关键点不足 21 个时返回 null 而不是抛错', () => {
  assert.equal(fingerStates([{ x: 0, y: 0 }]), null);
  assert.equal(classifyHand(null), null);
  assert.equal(pointingDirection([]), null);
});

test('组合手势能命名', () => {
  assert.equal(classifyHand(hand({ extended: [] })).name, 'fist');
  assert.equal(classifyHand(hand({ extended: ['thumb', 'index', 'middle', 'ring', 'pinky'] })).name, 'openPalm');
  assert.equal(classifyHand(hand({ extended: ['index', 'middle'] })).name, 'victory');
  assert.equal(classifyHand(hand({ extended: ['index', 'pinky'] })).name, 'rock');
  assert.equal(classifyHand(hand({ extended: ['thumb', 'pinky'] })).name, 'callMe');
});

test('捏合优先于组合表，OK 不会被误判成四指', () => {
  const okHand = hand({ extended: ['index', 'middle', 'ring', 'pinky'], pinch: true });
  assert.equal(pinchAmount(okHand) < 0.22, true);
  assert.equal(classifyHand(okHand).name, 'ok');
});

test('指向方向会写进手势名', () => {
  for (const [dir, want] of [['up', 'point_up'], ['down', 'point_down'], ['left', 'point_left'], ['right', 'point_right']]) {
    assert.equal(classifyHand(hand({ extended: ['index'], dir })).name, want, `${dir} 方向判错`);
  }
});

test('手靠近脸能检出，远离时不误报', () => {
  const face = [{ x: 0.45, y: 0.3 }, { x: 0.55, y: 0.5 }];
  const near = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.4 }));
  const far = Array.from({ length: 21 }, () => ({ x: 0.05, y: 0.95 }));
  assert.equal(handNearFace(near, face), true);
  assert.equal(handNearFace(far, face), false);
  assert.equal(handNearFace(near, []), false);
});

test('挥手需要多次往复，单向移动不算', () => {
  const w = new WaveDetector();
  let t = 0;
  let waved = false;
  for (let i = 0; i < 14; i += 1) {
    const pts = hand({ extended: ['index'] });
    pts[0] = { x: 0.5 + (i % 2 === 0 ? 0.05 : -0.05), y: 0.9, z: 0 };
    waved = w.update(pts, (t += 100)) || waved;
  }
  assert.equal(waved, true, '往复摆动应判为挥手');

  const w2 = new WaveDetector();
  let t2 = 0;
  let any = false;
  for (let i = 0; i < 14; i += 1) {
    const pts = hand({ extended: ['index'] });
    pts[0] = { x: 0.2 + i * 0.02, y: 0.9, z: 0 };
    any = w2.update(pts, (t2 += 100)) || any;
  }
  assert.equal(any, false, '单向平移不该算挥手');
});

test('readHands 汇总一帧的手部事实', () => {
  const wave = new WaveDetector();
  const out = readHands({
    gestureResult: {
      landmarks: [hand({ extended: ['index', 'middle'] })],
      gestures: [[{ categoryName: 'Victory', score: 0.9 }]],
    },
    faceLandmarks: [{ x: 0.45, y: 0.3 }, { x: 0.55, y: 0.5 }],
    t: 0,
    wave,
  });
  assert.equal(out.handCount, 1);
  assert.equal(out.canned, 'Victory');
  assert.equal(out.shape, 'victory');
  assert.equal(out.fingers, 2);
  assert.equal(out.bothHands, false);
});

test('readHands 在没有手时不炸，并重置挥手窗口', () => {
  const wave = new WaveDetector();
  wave.update(hand({ extended: ['index'] }), 0);
  const out = readHands({ gestureResult: { landmarks: [], gestures: [] }, faceLandmarks: [], t: 10, wave });
  assert.equal(out.handCount, 0);
  assert.equal(out.shape, null);
  assert.equal(wave.samples.length, 0, '没有手时应清空挥手采样');
});

test('readHands 把 None 当作没有手势', () => {
  const out = readHands({
    gestureResult: { landmarks: [], gestures: [[{ categoryName: 'None', score: 0.4 }]] },
    faceLandmarks: [], t: 0,
  });
  assert.equal(out.canned, null);
});

// ------------------------------------------------------------------ annotate ----

// Records calls instead of drawing, so the mapping is checkable without a canvas.
function stubCtx() {
  const calls = [];
  const rec = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    set lineWidth(v) { calls.push({ name: 'lineWidth', args: [v] }); },
    set strokeStyle(v) { calls.push({ name: 'strokeStyle', args: [v] }); },
    set fillStyle(v) { calls.push({ name: 'fillStyle', args: [v] }); },
    set font(v) { calls.push({ name: 'font', args: [v] }); },
    set textBaseline(v) { },
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    stroke: rec('stroke'), arc: rec('arc'), fill: rec('fill'),
    strokeRect: rec('strokeRect'), fillRect: rec('fillRect'), fillText: rec('fillText'),
    setLineDash: rec('setLineDash'),
    measureText: () => ({ width: 40 }),
  };
}

test('手部骨架拓扑覆盖全部 21 个点', () => {
  const seen = new Set(HAND_CONNECTIONS.flat());
  for (let i = 0; i < 21; i += 1) assert.ok(seen.has(i), `点 ${i} 没有连线`);
  for (const [a, b] of HAND_CONNECTIONS) {
    assert.ok(a >= 0 && a < 21 && b >= 0 && b < 21, `连线越界: ${a}-${b}`);
  }
});

test('toPixels 会镜像，和预览画面一致', () => {
  const [p] = toPixels([{ x: 0.25, y: 0.5 }], 640, 480, true);
  assert.equal(p.x, 480);
  assert.equal(p.y, 240);
  const [q] = toPixels([{ x: 0.25, y: 0.5 }], 640, 480, false);
  assert.equal(q.x, 160);
});

test('faceBox 在镜像下左右翻转但宽度不变', () => {
  const lm = [{ x: 0.2, y: 0.1 }, { x: 0.4, y: 0.6 }];
  const a = faceBox(lm, 100, 100, false);
  const b = faceBox(lm, 100, 100, true);
  assert.equal(Math.round(a.w), Math.round(b.w));
  assert.equal(Math.round(a.x), 20);
  assert.equal(Math.round(b.x), 60);
  assert.equal(faceBox([], 100, 100), null);
});

test('annotateFrame 画了骨架和参考线，并说明标了什么', () => {
  const ctx = stubCtx();
  const marked = annotateFrame(ctx, {
    width: 640, height: 480,
    hands: [hand({ extended: ['index'] })],
    faceLandmarks: [{ x: 0.4, y: 0.2 }, { x: 0.6, y: 0.5 }],
    baselineY: 0.42, currentY: 0.6,
    labels: ['slump 0.62'],
  });
  const names = ctx.calls.map((c) => c.name);
  assert.ok(names.filter((n) => n === 'lineTo').length >= HAND_CONNECTIONS.length, '骨架连线数量不足');
  assert.ok(names.includes('arc'), '关键点没画');
  assert.ok(names.includes('strokeRect'), '人脸框没画');
  assert.ok(names.includes('fillText'), '标签没画');
  assert.equal(marked.length, 4, `说明项应为 4 条，实际 ${marked.length}: ${marked}`);
  // These strings are pasted into an English prompt, so any CJK here is a real defect.
  for (const m of marked) assert.ok(!/[\u4e00-\u9fff]/.test(m), `说明项不该有中文: ${m}`);
  assert.ok(marked.some((m) => m.includes('fingertips')));
});

test('给了人脸连线就画轮廓，并在说明里提到表情依据', () => {
  const ctx = stubCtx();
  const face = Array.from({ length: 20 }, (_, i) => ({ x: 0.4 + i * 0.005, y: 0.3 + i * 0.005 }));
  // Both shapes the library uses over its history: {start,end} objects and [a,b] pairs.
  for (const conns of [[{ start: 0, end: 1 }, { start: 1, end: 2 }], [[0, 1], [1, 2]]]) {
    const c = stubCtx();
    const marked = annotateFrame(c, { width: 320, height: 240, faceLandmarks: face, faceConnections: conns });
    assert.ok(c.calls.filter((x) => x.name === 'lineTo').length >= 2, '轮廓连线没画');
    assert.ok(marked.some((m) => /expression reading/.test(m)), `说明缺轮廓项: ${marked}`);
  }
  // Out-of-range indices must be skipped, not throw.
  assert.doesNotThrow(() => annotateFrame(ctx, {
    width: 320, height: 240, faceLandmarks: face, faceConnections: [{ start: 0, end: 999 }],
  }));
});

test('annotateFrame 在什么都没检测到时不画也不报错', () => {
  const ctx = stubCtx();
  const marked = annotateFrame(ctx, { width: 320, height: 240 });
  assert.deepEqual(marked, []);
  assert.equal(ctx.calls.some((c) => c.name === 'arc'), false);
});

test('annotateFrame 跳过点数不足的手，不会画半个骨架', () => {
  const ctx = stubCtx();
  const marked = annotateFrame(ctx, { width: 320, height: 240, hands: [[{ x: 0, y: 0 }]] });
  assert.equal(marked.length, 0);
  assert.equal(ctx.calls.some((c) => c.name === 'arc'), false);
});
