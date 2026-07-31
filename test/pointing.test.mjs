import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONE_EURO, OneEuroFilter, smoothingFactor,
  FIT_FAILURE_REASONS, RESIDUAL_LIMIT, fitHomography, applyHomography,
  CLIPS, CLIP_ACTIONS, LOCOMOTION, Locomotion,
} from '../pointing.js';

const DT = 1000 / 30; // the fast loop's frame interval; everything here is in ms

// mulberry32, same generator the core uses, so a failure is reproducible rather than a
// once-a-week mystery.
function rng(seed = 7) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Uniform noise scaled to have standard deviation `s`, so the assertions below can be
// stated in terms of the jitter a real fingertip has (a few thousandths of the frame).
const noise = (r, s) => (r() - 0.5) * 2 * s * Math.sqrt(3);

const std = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

// The filter is 2D; these wrappers drive one axis so lag and jitter are single numbers.
const oneEuro = (opt) => {
  const f = new OneEuroFilter(opt);
  return (x, t) => f.update({ x, y: 0 }, t).x;
};
// A plain EMA — what the rest of the core uses — as the thing one-euro has to beat.
const ema = (alpha) => {
  let v = null;
  return (x) => { v = v == null ? x : alpha * x + (1 - alpha) * v; return v; };
};

const SIGMA = 0.004; // observed MediaPipe fingertip jitter, in normalised frame units

// A still finger at 0.5 for 400 frames; returns the settled part of the output.
function stationary(filter, seed = 11) {
  const r = rng(seed);
  const out = [];
  let t = 0;
  for (let i = 0; i < 400; i += 1) out.push(filter(0.5 + noise(r, SIGMA), (t += DT)));
  return out.slice(100);
}

// Mean tracking error once a constant-velocity sweep has reached steady state — i.e. lag,
// expressed as a distance rather than a time so the two filters are directly comparable.
function rampLag(filter, v = 1.5) {
  let t = 0;
  let x = 0.1;
  const errs = [];
  for (let i = 0; i < 60; i += 1) {
    x += v * (DT / 1000);
    const y = filter(x, (t += DT));
    if (i > 30) errs.push(Math.abs(x - y));
  }
  return errs.reduce((a, b) => a + b, 0) / errs.length;
}

// ------------------------------------------------------------------ one euro ----

test('首帧原样输出，不从原点滑进来，且返回的是副本', () => {
  const f = new OneEuroFilter();
  const first = f.update({ x: 0.4, y: 0.9 }, 1000);
  assert.deepEqual(first, { x: 0.4, y: 0.9 });
  first.x = 999;
  assert.equal(f.value.x, 0.4, '返回值被改动后内部状态也变了，说明泄漏了引用');
  // Nothing sensible can be produced before any sample has arrived.
  assert.equal(new OneEuroFilter().update(null, 0), null);
});

test('阶跃输入单调趋近目标，不过冲', () => {
  const f = oneEuro();
  let t = 0;
  f(0, (t += DT));
  const ys = [];
  for (let i = 0; i < 60; i += 1) ys.push(f(1, (t += DT)));
  for (let i = 1; i < ys.length; i += 1) {
    assert.ok(ys[i] >= ys[i - 1] - 1e-12, `第 ${i} 帧回退了：${ys[i - 1]} → ${ys[i]}`);
  }
  assert.ok(Math.max(...ys) <= 1 + 1e-12, `过冲到 ${Math.max(...ys)}`);
  // A step is the largest possible derivative, so the cutoff opens wide and it settles
  // in well under the 60 ms-scale budget the reflex tier is held to.
  assert.ok(Math.abs(ys[14] - 1) < 0.02, `半秒还差 ${(1 - ys[14]).toFixed(4)}`);
});

test('静止时的抖动被明显压掉', () => {
  const raw = std(stationary((x) => x));
  const filtered = std(stationary(oneEuro()));
  assert.ok(Math.abs(raw - SIGMA) < SIGMA * 0.2, `噪声源本身不对：${raw}`);
  assert.ok(raw / filtered > 2.5, `只压了 ${(raw / filtered).toFixed(2)} 倍，静止的手指还会抖`);
});

test('同等平滑程度下，one-euro 的滞后远小于 EMA —— 这就是它值得多写的理由', () => {
  const oeJitter = std(stationary(oneEuro()));
  // Pick the *least* smoothing EMA that is still at least as smooth as one-euro on the
  // same stationary input. Choosing the largest such alpha deliberately favours the EMA
  // in the lag comparison that follows: any smaller alpha would only be laggier.
  let alpha = 0;
  for (let a = 0.01; a < 1; a += 0.01) {
    if (std(stationary(ema(a))) <= oeJitter) alpha = a;
  }
  assert.ok(alpha > 0.05, `没找到可比的 EMA 系数（${alpha}），这个对比就是空的`);

  const oeLag = rampLag(oneEuro());
  const emaLag = rampLag(ema(alpha));
  assert.ok(oeLag < emaLag * 0.5,
    `滞后 one-euro ${oeLag.toFixed(4)} vs EMA(α=${alpha.toFixed(2)}) ${emaLag.toFixed(4)}，没拉开差距`);
  // Sanity on the units: 1.5 units/s of lag must be a fraction of the screen, not more
  // than the screen.
  assert.ok(oeLag < 0.15, `快速移动时滞后 ${oeLag.toFixed(4)} 个屏幕宽，太大了`);
});

test('dt 为 0、为负、输入非有限，都不产生 NaN 或跳变', () => {
  const f = new OneEuroFilter();
  f.update({ x: 0.5, y: 0.5 }, 1000);
  f.update({ x: 0.52, y: 0.5 }, 1000 + DT);
  const before = { ...f.value };

  // Same timestamp twice: no time passed, so nothing may be integrated.
  const same = f.update({ x: 0.9, y: 0.1 }, 1000 + DT);
  assert.deepEqual(same, before, 'dt=0 时应保持估计不动');
  // A clock that went backwards is an upstream bug; consuming it would invert the
  // derivative's sign and kick the estimate the wrong way.
  const back = f.update({ x: 0.9, y: 0.1 }, 500);
  assert.deepEqual(back, before, 'dt<0 时应保持估计不动');
  // A dropped detection is not a position of (0,0).
  assert.deepEqual(f.update(null, 2000), before);
  assert.deepEqual(f.update({ x: NaN, y: 0.3 }, 2100), before);
  assert.deepEqual(f.update({ x: 0.3, y: 0.3 }, NaN), before);

  // And the filter still works afterwards: the bad frames left no poisoned state.
  const next = f.update({ x: 0.6, y: 0.5 }, 1000 + DT * 2);
  assert.ok(Number.isFinite(next.x) && next.x > before.x && next.x < 0.6);
});

test('十秒断流后按一帧推进，既不跳变也不 NaN', () => {
  const f = new OneEuroFilter();
  let t = 0;
  for (let i = 0; i < 30; i += 1) f.update({ x: 0.2, y: 0.2 }, (t += DT));
  const before = f.value.x;
  const after = f.update({ x: 0.8, y: 0.8 }, t + 10000);
  const step = (after.x - before) / 0.6;
  assert.ok(Number.isFinite(after.x) && Number.isFinite(after.y));
  assert.ok(step > 0.05, `断流后完全不动（${step.toFixed(3)}），会永远停在旧位置`);
  // One ordinary frame's worth of movement — the resting smoothing factor. Feeding 10 s
  // in as dt would make this ~1.0, i.e. a teleport.
  const oneFrame = smoothingFactor(ONE_EURO.fcmin, ONE_EURO.nominalDtSec);
  assert.ok(step <= oneFrame + 0.02, `断流后跳了 ${(step * 100).toFixed(1)}%，超过一帧的 ${(oneFrame * 100).toFixed(1)}%`);
  assert.equal(f.speed, 0, '跨越断流测出的速度没有意义，应丢弃');

  // Two seconds of normal frames later it has caught up.
  let tt = t + 10000;
  for (let i = 0; i < 60; i += 1) f.update({ x: 0.8, y: 0.8 }, (tt += DT));
  assert.ok(Math.abs(f.value.x - 0.8) < 1e-3, `断流后没收敛，停在 ${f.value.x}`);
});

test('对角移动不会被弯曲：两轴用同一个截止频率', () => {
  const f = new OneEuroFilter();
  let t = 0;
  let p = 0.1;
  let worst = 0;
  for (let i = 0; i < 60; i += 1) {
    p += 0.02;
    // Exactly 45°: if the cutoff were computed per axis, the axis with the larger
    // absolute speed would be smoothed differently and a straight sweep would bow.
    const out = f.update({ x: p, y: p }, (t += DT));
    worst = Math.max(worst, Math.abs(out.x - out.y));
  }
  assert.ok(worst < 1e-12, `对角线被弯了 ${worst}`);
});

// ----------------------------------------------------------------- homography ----

const H_KNOWN = [1.2, 0.3, 0.05, -0.2, 1.1, 0.02, 0.25, -0.15, 1];
const byHand = (h, p) => {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
};
const pair = (from, to) => ({ from, to });
const QUAD = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.25 }, { x: 0.85, y: 0.8 }, { x: 0.15, y: 0.75 }];

test('四点精确拟合能还原已知的投影变换', () => {
  const fit = fitHomography(QUAD.map((p) => pair(p, byHand(H_KNOWN, p))));
  assert.equal(fit.ok, true, JSON.stringify(fit));
  assert.ok(fit.residual < 1e-9, `残差 ${fit.residual}`);
  assert.equal(fit.points, 4);
  // The matrix itself, not just the fit points: h[8] is pinned to 1 on both sides, so
  // the recovered entries must match term by term.
  for (let i = 0; i < 9; i += 1) {
    assert.ok(Math.abs(fit.h[i] - H_KNOWN[i]) < 1e-9, `h[${i}] = ${fit.h[i]}, 应为 ${H_KNOWN[i]}`);
  }
  // Points that were not in the fit must map correctly too, or it memorised instead of
  // solving.
  for (const p of [{ x: 0.4, y: 0.5 }, { x: 0.7, y: 0.3 }, { x: 0.55, y: 0.62 }]) {
    const want = byHand(H_KNOWN, p);
    const got = applyHomography(fit.h, p);
    assert.equal(got.ok, true);
    assert.ok(Math.hypot(got.raw.x - want.x, got.raw.y - want.y) < 1e-9, `${JSON.stringify(p)} 映射错了`);
  }
});

test('恒等标定能往返，屏幕点原样回来', () => {
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const fit = fitHomography(corners.map((p) => pair(p, p)));
  assert.equal(fit.ok, true);
  assert.ok(fit.residual < 1e-12);
  for (const p of [{ x: 0.3, y: 0.7 }, { x: 0.5, y: 0.5 }, { x: 0, y: 1 }]) {
    const got = applyHomography(fit.h, p);
    assert.ok(Math.abs(got.x - p.x) < 1e-12 && Math.abs(got.y - p.y) < 1e-12, `${JSON.stringify(got)}`);
    assert.equal(got.inside, true);
  }
});

test('共线的标定点被判为退化，而不是返回一堆垃圾', () => {
  const line = fitHomography([0, 1, 2, 3].map((i) => pair({ x: 0.1 + i * 0.1, y: 0.1 + i * 0.1 }, { x: i * 0.3, y: i * 0.3 })));
  assert.equal(line.ok, false);
  assert.equal(line.reason, 'collinear_points');
  assert.equal(line.h, null);

  // Only three of the four on a line: the fourth point does not rescue it, because with
  // exactly four pairs every triple carries constraints the others cannot supply.
  const three = fitHomography([
    pair({ x: 0.1, y: 0.1 }, { x: 0, y: 0 }),
    pair({ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }),
    pair({ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.6 }),
    pair({ x: 0.1, y: 0.9 }, { x: 0, y: 1 }),
  ]);
  assert.equal(three.ok, false, '三点共线也必须拒绝');
  assert.equal(three.reason, 'collinear_points');

  // Degenerate on the screen side: four distinct camera points all aimed at one line of
  // the screen cannot define a mapping onto the screen either.
  const flatTarget = fitHomography(QUAD.map((p, i) => pair(p, { x: i * 0.3, y: i * 0.3 })));
  assert.equal(flatTarget.ok, false);
  assert.equal(flatTarget.reason, 'collinear_points');
  assert.match(flatTarget.detail, /screen/);
});

test('少于四点直接拒绝，因为八个未知量需要八个方程', () => {
  for (const n of [0, 1, 2, 3]) {
    const fit = fitHomography(QUAD.slice(0, n).map((p) => pair(p, byHand(H_KNOWN, p))));
    assert.equal(fit.ok, false, `${n} 点竟然拟合成功了`);
    assert.equal(fit.reason, 'too_few_points');
  }
});

test('重合的标定点被拒绝：同一个点记两次不是两个约束', () => {
  const dup = fitHomography([
    pair({ x: 0.1, y: 0.1 }, { x: 0, y: 0 }),
    pair({ x: 0.1, y: 0.1 }, { x: 1, y: 0 }),
    pair({ x: 0.9, y: 0.9 }, { x: 1, y: 1 }),
    pair({ x: 0.1, y: 0.9 }, { x: 0, y: 1 }),
  ]);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'coincident_points');

  // A near-miss counts too: two taps a thousandth of the frame apart are one tap.
  const near = fitHomography(QUAD.map((p, i) => pair(i === 1 ? { x: QUAD[0].x + 1e-5, y: QUAD[0].y } : p, byHand(H_KNOWN, p))));
  assert.equal(near.ok, false);
  assert.equal(near.reason, 'coincident_points');

  const allSame = fitHomography(Array.from({ length: 4 }, () => pair({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
  assert.equal(allSame.ok, false);
  assert.equal(allSame.reason, 'coincident_points');
});

test('超定拟合的残差与噪声同量级，好标定过关坏标定被拦下', () => {
  const r = rng(5);
  const grid = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) grid.push({ x: 0.15 + i * 0.3, y: 0.15 + j * 0.3 });
  }
  const jittered = grid.map((from) => {
    const t = byHand(H_KNOWN, from);
    return pair(from, { x: t.x + noise(r, 0.004), y: t.y + noise(r, 0.004) });
  });
  const good = fitHomography(jittered);
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.points, 9);
  assert.ok(good.residual > 0, '有噪声却报零残差，说明残差算错了');
  assert.ok(good.residual < 0.004 * 3, `残差 ${good.residual.toFixed(4)} 远大于噪声量级`);
  assert.ok(good.maxResidual >= good.residual, 'max 应不小于 RMS');
  assert.ok(good.residual < RESIDUAL_LIMIT, '正常噪声的标定不该被上限拦下');

  // One badly misclicked corner: the residual has to grow enough for the caller to
  // reject it, otherwise the pet walks confidently to the wrong window.
  const bad = jittered.map((p, i) => (i === 4 ? pair(p.from, { x: p.to.x + 0.25, y: p.to.y - 0.2 }) : p));
  const badFit = fitHomography(bad);
  assert.equal(badFit.ok, true, '一个坏点不该让求解失败，而应体现在残差上');
  assert.ok(badFit.residual > RESIDUAL_LIMIT,
    `坏标定的残差只有 ${badFit.residual.toFixed(4)}，会被当成好标定用`);
});

test('映射到 0..1 之外的点会被标记，同时给出夹住的坐标', () => {
  const corners = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];
  const screen = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const fit = fitHomography(corners.map((p, i) => pair(p, screen[i])));
  assert.equal(fit.ok, true);

  const inside = applyHomography(fit.h, { x: 0.5, y: 0.5 });
  assert.equal(inside.inside, true);

  // Outside the calibrated quad — the finger drifted past the corner it was taught.
  const out = applyHomography(fit.h, { x: 0.05, y: 0.9 });
  assert.equal(out.ok, true);
  assert.equal(out.inside, false, '越界没被标记');
  assert.ok(out.raw.x < 0, `raw 应保留越界值，实际 ${out.raw.x}`);
  // Clamped, so a caller that ignores `inside` still gets an on-screen goal.
  assert.ok(out.x >= 0 && out.x <= 1 && out.y >= 0 && out.y <= 1, JSON.stringify(out));
});

test('非法输入都返回带原因的失败对象，不抛错也不返回 NaN', () => {
  const cases = [
    undefined, null, 'nope', [],
    [pair({ x: 0.1, y: 0.1 }, { x: 0, y: 0 }), null, pair({ x: 0.9, y: 0.9 }, { x: 1, y: 1 }), pair({ x: 0.1, y: 0.9 }, { x: 0, y: 1 })],
    QUAD.map((p, i) => pair(i === 2 ? { x: NaN, y: 0.5 } : p, { x: 0, y: 0 })),
    QUAD.map((p) => ({ from: p })),
  ];
  for (const c of cases) {
    const fit = fitHomography(c);
    assert.equal(fit.ok, false, `${JSON.stringify(c)} 竟然通过了`);
    assert.ok(FIT_FAILURE_REASONS.includes(fit.reason), `未知失败原因 ${fit.reason}`);
    assert.equal(fit.h, null);
    assert.equal(typeof fit.detail, 'string', '失败必须说明原因，日志里要能看懂');
  }

  for (const h of [null, [1, 2, 3], Array(9).fill(NaN), 'x']) {
    assert.equal(applyHomography(h, { x: 0.5, y: 0.5 }).ok, false, `${h} 竟然可用`);
  }
  assert.equal(applyHomography([1, 0, 0, 0, 1, 0, 0, 0, 1], { x: NaN, y: 0 }).ok, false);
});

test('落在消隐线上的点报错，而不是返回 1e12 当屏幕坐标', () => {
  // w = 1 - x, so x = 1 maps to infinity.
  const h = [1, 0, 0, 0, 1, 0, -1, 0, 1];
  const bad = applyHomography(h, { x: 1, y: 0.5 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'behind_horizon');
  // Just short of it is still finite, and must not silently return an absurd coordinate
  // dressed up as a screen position.
  const near = applyHomography(h, { x: 0.999999, y: 0.5 });
  assert.equal(near.ok, true);
  assert.equal(near.inside, false);
  assert.ok(near.x <= 1, '越界值必须被夹住');
});

// ----------------------------------------------------------------- locomotion ----

test('一直走会到达目标并停下，途中不越过目标', () => {
  const loco = new Locomotion();
  let pos = { x: 0.1, y: 0.2 };
  const goal = { x: 0.8, y: 0.6 };
  let last = Infinity;
  let arrived = false;
  let frames = 0;
  for (let i = 0; i < 600 && !arrived; i += 1) {
    const s = loco.step({ pos, goal, speed: 0.25, dt: DT });
    assert.ok(s.remaining <= last + 1e-12, `第 ${i} 帧离目标更远了：${last} → ${s.remaining}`);
    last = s.remaining;
    pos = s.pos;
    arrived = s.arrived;
    frames = i + 1;
  }
  assert.equal(arrived, true, '600 帧都没到');
  assert.ok(Math.abs(pos.x - goal.x) < 1e-12 && Math.abs(pos.y - goal.y) < 1e-12, '到达时应吸附到目标');
  // 0.806 units at 0.25 units/s ≈ 3.2 s ≈ 97 frames. Wildly off means the speed unit is
  // being interpreted as something other than screen widths per second.
  assert.ok(frames > 80 && frames < 115, `用了 ${frames} 帧，速度单位对不上`);
});

test('到达之后不再移动、不再播放走路动画', () => {
  const loco = new Locomotion();
  const goal = { x: 0.5, y: 0.5 };
  let pos = { x: 0.5, y: 0.5 - LOCOMOTION.tolerance * 0.5 };
  const first = loco.step({ pos, goal, speed: 0.25, dt: DT });
  assert.equal(first.arrived, true);
  // Snapped, not just declared arrived. A sub-tolerance residual left in place is a
  // direction computed from noise on the next frame, and it also accumulates: every goal
  // in a sequence would land a few pixels further off than the last.
  assert.deepEqual(first.pos, goal, '到达时应吸附到目标，而不是留一点残差');
  assert.equal(first.remaining, 0);
  pos = first.pos;
  for (let i = 0; i < 200; i += 1) {
    const s = loco.step({ pos, goal, speed: 0.25, dt: DT });
    assert.equal(s.arrived, true, `第 ${i} 帧又说没到`);
    assert.deepEqual(s.pos, pos, `第 ${i} 帧原地抖了`);
    assert.equal(s.clip, null, '站着不该播走路动画');
    assert.equal(s.moved, 0);
    pos = s.pos;
  }
});

test('近 45 度路径不会每帧换动画（关掉迟滞就会疯狂闪）', () => {
  // The goal is re-read from a jittery fingertip every frame, which is exactly how tier 1
  // runs — so |dx| and |dy| trade places constantly on a diagonal approach.
  const walk = (opt) => {
    const r = rng(3);
    const loco = new Locomotion(opt);
    let pos = { x: 0.05, y: 0.05 };
    let changes = 0;
    let last = null;
    let frames = 0;
    for (let i = 0; i < 400; i += 1) {
      const goal = { x: 0.85 + noise(r, 0.002), y: 0.85 + noise(r, 0.002) };
      const s = loco.step({ pos, goal, speed: 0.2, dt: DT });
      pos = s.pos;
      frames += 1;
      if (s.clip) {
        if (last && s.clip !== last) changes += 1;
        last = s.clip;
      }
      if (s.remaining <= 0.02) break;
    }
    return { changes, frames };
  };
  const withH = walk({});
  const without = walk({ hysteresis: 0 });
  assert.ok(withH.frames > 100, '路走太短，这个测试没意义');
  // The control run proves the fixture actually provokes the flicker; without it a
  // hysteresis that did nothing would still pass.
  assert.ok(without.changes > 20, `对照组只闪了 ${without.changes} 次，抖动构造得不够狠`);
  assert.ok(withH.changes <= 2, `迟滞失效，${withH.frames} 帧里换了 ${withH.changes} 次动画`);
});

test('同轴反向要立刻换向，迟滞不能把角色卡在旧动画上', () => {
  const loco = new Locomotion();
  const right = loco.step({ pos: { x: 0.2, y: 0.5 }, goal: { x: 0.9, y: 0.5 }, speed: 0.2, dt: DT });
  assert.equal(right.dir, 'R');
  // Same axis, opposite sign: a real reversal, not flicker. Holding WALK_R here would
  // render the character sliding backwards.
  const left = loco.step({ pos: { x: 0.9, y: 0.5 }, goal: { x: 0.2, y: 0.5 }, speed: 0.2, dt: DT });
  assert.equal(left.dir, 'L');
  assert.equal(left.clip, 'WALK_L');

  // A decisive change of axis must also get through: hysteresis is a margin, not a lock.
  const up = loco.step({ pos: { x: 0.5, y: 0.9 }, goal: { x: 0.5, y: 0.1 }, speed: 0.2, dt: DT });
  assert.equal(up.dir, 'U');
});

test('零步长和缺失输入都是安全的', () => {
  const loco = new Locomotion();
  const goal = { x: 0.9, y: 0.9 };
  const pos = { x: 0.1, y: 0.1 };
  for (const args of [
    { pos, goal, speed: 0.2, dt: 0 },
    { pos, goal, speed: 0, dt: DT },
    { pos, goal, speed: -1, dt: DT },
    { pos, goal, speed: NaN, dt: DT },
    { pos, goal, speed: 0.2, dt: NaN },
  ]) {
    const s = loco.step(args);
    assert.deepEqual(s.pos, pos, `${JSON.stringify(args)} 竟然移动了`);
    assert.equal(s.arrived, false);
    assert.equal(s.moved, 0);
    assert.equal(s.clip, null, '没动就不该有动画');
    assert.ok(Number.isFinite(s.remaining));
  }
  // No goal at all: standing still is the answer, not walking toward NaN.
  for (const bad of [undefined, null, { x: NaN, y: 0.5 }]) {
    const s = loco.step({ pos, goal: bad, speed: 0.2, dt: DT });
    assert.equal(s.arrived, true);
    assert.deepEqual(s.pos, pos);
    assert.ok(Number.isFinite(s.remaining));
  }
  // A junk position must not become a NaN position that never recovers.
  const s = loco.step({ pos: { x: NaN, y: 0 }, goal, speed: 0.2, dt: DT });
  assert.ok(Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y), JSON.stringify(s));
});

test('dt 尖峰时吸附到目标，不会冲过去再折回', () => {
  const loco = new Locomotion();
  // A 5 s stall — a garbage collection or a window resize — with a goal 0.1 away.
  const s = loco.step({ pos: { x: 0.5, y: 0.5 }, goal: { x: 0.6, y: 0.5 }, speed: 0.5, dt: 5000 });
  assert.equal(s.arrived, true);
  assert.deepEqual(s.pos, { x: 0.6, y: 0.5 });
  assert.equal(s.remaining, 0);
});

test('四个方向和 走/跑 都映射到 pack 真有的动作名', () => {
  // Read out of tools/import-gremlin.mjs; a name that no pack ships silently renders
  // nothing, and the character would slide across the screen in its idle pose.
  const PACK_ACTIONS = new Set(['walkLeft', 'walkRight', 'walkUp', 'walkDown',
    'runLeft', 'runRight', 'runUp', 'runDown']);
  const cases = [
    [{ x: 0.9, y: 0.5 }, 'R'], [{ x: 0.1, y: 0.5 }, 'L'],
    [{ x: 0.5, y: 0.1 }, 'U'], [{ x: 0.5, y: 0.9 }, 'D'],
  ];
  for (const [goal, dir] of cases) {
    for (const [speed, gait] of [[0.2, 'WALK'], [0.8, 'RUN']]) {
      const s = new Locomotion().step({ pos: { x: 0.5, y: 0.5 }, goal, speed, dt: DT });
      assert.equal(s.dir, dir, `${JSON.stringify(goal)} 方向判错`);
      assert.equal(s.clip, `${gait}_${dir}`, `速度 ${speed} 的步态选错：${s.clip}`);
      assert.ok(CLIPS.includes(s.clip), `${s.clip} 不在 CLIPS 里`);
      assert.ok(PACK_ACTIONS.has(s.action), `${s.action} 不是 pack 里的动作名`);
    }
  }
  assert.equal(Object.keys(CLIP_ACTIONS).length, CLIPS.length, 'CLIPS 和 CLIP_ACTIONS 应一一对应');
  for (const c of CLIPS) assert.ok(PACK_ACTIONS.has(CLIP_ACTIONS[c]), `${c} 没有对应动作`);
  assert.ok(LOCOMOTION.runSpeed > 0 && LOCOMOTION.tolerance > 0);
});
