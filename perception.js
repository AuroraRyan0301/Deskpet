// Named expressions and hand gestures, derived from data the fast loop already has.
// DOM-free and pure, so every rule is unit-tested rather than eyeballed.
//
// Two sources, neither of which needs a new model:
//   blendshapes — the 52 ARKit coefficients FaceLandmarker already returns. The names
//                 here were read out of models/face_landmarker.task, not recalled.
//   landmarks   — the 21 hand points GestureRecognizer returns alongside its 7 canned
//                 labels. Those labels were the only thing being used; the points give
//                 finger counts, pinches and pointing directions for free.

// ---------------------------------------------------------------- expressions ----

const maxOf = (b, ...names) => Math.max(...names.map((n) => b(n)));

// Ordered by specificity: the first rule that clears its threshold wins, so
// `surprise` is tested before the plain `browRaise` it contains.
export const EXPRESSION_RULES = [
  { name: 'tongueOut', desc: '吐舌头', on: 0.35, off: 0.20, score: (b) => b('tongueOut') },
  {
    name: 'surprise',
    desc: '惊讶：抬内眉 + 睁大眼 + 张嘴',
    on: 0.30,
    off: 0.18,
    // min() because all three have to be present; any one alone is a different face.
    score: (b) => Math.min(b('browInnerUp'), maxOf(b, 'eyeWideLeft', 'eyeWideRight'), b('jawOpen') * 1.5),
  },
  {
    name: 'skeptical',
    desc: '怀疑/嫌弃：压眉 + 眯眼',
    on: 0.30,
    off: 0.18,
    score: (b) => Math.min(maxOf(b, 'browDownLeft', 'browDownRight'), maxOf(b, 'eyeSquintLeft', 'eyeSquintRight')),
  },
  { name: 'sneer', desc: '皱鼻，不屑', on: 0.30, off: 0.18, score: (b) => maxOf(b, 'noseSneerLeft', 'noseSneerRight') },
  { name: 'cheekPuff', desc: '鼓腮，赌气', on: 0.30, off: 0.18, score: (b) => b('cheekPuff') },
  { name: 'pucker', desc: '嘟嘴', on: 0.40, off: 0.25, score: (b) => b('mouthPucker') },
  { name: 'frown', desc: '嘴角下垂，不高兴', on: 0.30, off: 0.18, score: (b) => maxOf(b, 'mouthFrownLeft', 'mouthFrownRight') },
  { name: 'pressLips', desc: '闭嘴憋着，忍住不说', on: 0.40, off: 0.25, score: (b) => maxOf(b, 'mouthPressLeft', 'mouthPressRight') },
  { name: 'browRaise', desc: '抬眉，意外或询问', on: 0.35, off: 0.22, score: (b) => maxOf(b, 'browOuterUpLeft', 'browOuterUpRight') },
  { name: 'smile', desc: '笑', on: 0.35, off: 0.20, score: (b) => maxOf(b, 'mouthSmileLeft', 'mouthSmileRight') },
];

export function blendshapeLookup(categories) {
  if (!Array.isArray(categories)) return () => 0;
  const m = new Map(categories.map((c) => [c.categoryName, c.score]));
  return (name) => m.get(name) ?? 0;
}

// Hysteresis is per-expression: a face hovering at a threshold would otherwise emit a
// new expression every frame, which is the same failure the sleepy trigger had.
export class ExpressionDetector {
  constructor(rules = EXPRESSION_RULES) {
    this.rules = rules;
    this.current = null;
  }

  reset() {
    this.current = null;
  }

  // Returns { name, score, changed } — `changed` is the rising edge callers trigger on.
  update(lookup) {
    const scored = this.rules.map((r) => ({ rule: r, score: r.score(lookup) }));
    const held = this.current ? scored.find((s) => s.rule.name === this.current) : null;
    // Keep the current expression until it drops below its own release threshold.
    if (held && held.score >= held.rule.off) {
      const better = scored.find((s) => s.rule.name !== this.current && s.score >= s.rule.on && s.score > held.score + 0.15);
      if (!better) return { name: this.current, score: held.score, changed: false };
    }
    const win = scored.filter((s) => s.score >= s.rule.on).sort((a, b) => b.score - a.score)[0];
    const name = win ? win.rule.name : null;
    const changed = name !== this.current;
    this.current = name;
    return { name, score: win?.score ?? 0, changed };
  }
}

export const expressionDesc = (name) => EXPRESSION_RULES.find((r) => r.name === name)?.desc ?? name;

// ------------------------------------------------------------------- gestures ----

// MediaPipe hand landmark indices.
const WRIST = 0;
const TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIPS = { thumb: 2, index: 6, middle: 10, ring: 14, pinky: 18 };
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

// A finger counts as extended when its tip is further from the wrist than its middle
// joint. Scale-free, so it works at any distance from the camera, and orientation-free,
// which matters because a desk pet sees hands at odd angles.
export function fingerStates(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return null;
  const w = landmarks[WRIST];
  const out = {};
  for (const f of FINGERS) {
    out[f] = dist(landmarks[TIPS[f]], w) > dist(landmarks[PIPS[f]], w) * 1.06;
  }
  return out;
}

// Normalised by hand size so a pinch is a pinch near or far from the camera.
export function pinchAmount(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return 1;
  const span = dist(landmarks[WRIST], landmarks[TIPS.middle]) || 1e-6;
  return dist(landmarks[TIPS.thumb], landmarks[TIPS.index]) / span;
}

export function pointingDirection(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return null;
  const dx = landmarks[TIPS.index].x - landmarks[PIPS.index].x;
  // Screen y grows downward, so flip it to read as "up".
  const dy = -(landmarks[TIPS.index].y - landmarks[PIPS.index].y);
  if (Math.hypot(dx, dy) < 0.02) return null;
  return Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'up' : 'down');
}

const KEY = (s) => FINGERS.map((f) => (s[f] ? '1' : '0')).join('');

// Combinations beyond the model's 7 canned labels. The canned label still wins when the
// recognizer is confident, because it was trained rather than hand-tuned.
const COMBOS = {
  '00000': { name: 'fist', desc: '握拳' },
  '11111': { name: 'openPalm', desc: '张开手掌' },
  '01000': { name: 'point', desc: '指' },
  '01100': { name: 'victory', desc: '剪刀手 / V' },
  '01110': { name: 'three', desc: '三' },
  '01111': { name: 'four', desc: '四' },
  '11000': { name: 'gun', desc: '手枪手势' },
  '01001': { name: 'rock', desc: '摇滚手势' },
  '10001': { name: 'callMe', desc: '打电话手势' },
  '10000': { name: 'thumbOnly', desc: '只伸拇指' },
  '00001': { name: 'pinkyOnly', desc: '只伸小指' },
};

export function classifyHand(landmarks) {
  const st = fingerStates(landmarks);
  if (!st) return null;
  const pinch = pinchAmount(landmarks);
  const extended = FINGERS.filter((f) => st[f]).length;

  // Pinch is checked before the combo table: an OK sign reads as three or four fingers
  // extended, so the table would mislabel it. Both forms require some finger still
  // out — in a closed fist the thumb and index tips are touching anyway, and calling
  // that a pinch made every fist read as one.
  const others = [st.middle, st.ring, st.pinky].filter(Boolean).length;
  if (pinch < 0.22 && st.middle && st.ring) return { name: 'ok', desc: 'OK 手势', fingers: extended };
  if (pinch < 0.18 && others >= 1) return { name: 'pinch', desc: '捏合', fingers: extended };

  const combo = COMBOS[KEY(st)];
  const base = combo ?? { name: `fingers${extended}`, desc: `伸出 ${extended} 根手指` };
  if (base.name === 'point') {
    const dir = pointingDirection(landmarks);
    if (dir) return { ...base, name: `point_${dir}`, desc: `指向${{ up: '上', down: '下', left: '左', right: '右' }[dir]}`, fingers: extended };
  }
  return { ...base, fingers: extended };
}

// Faces and hands come from two different models in normalised image coordinates, so
// they are directly comparable — which is what makes "hand near face" free.
export function handNearFace(landmarks, faceLandmarks) {
  if (!Array.isArray(landmarks) || !Array.isArray(faceLandmarks) || faceLandmarks.length === 0) return false;
  let minX = 1; let maxX = 0; let minY = 1; let maxY = 0;
  for (const p of faceLandmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = (maxX - minX) * 0.25;
  return landmarks.some((p) => p.x > minX - pad && p.x < maxX + pad && p.y > minY - pad && p.y < maxY + pad);
}

// Wrist x over time; a wave is several direction reversals inside the window.
export class WaveDetector {
  constructor({ windowMs = 1400, minReversals = 3, minAmplitude = 0.04 } = {}) {
    this.opt = { windowMs, minReversals, minAmplitude };
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  update(landmarks, t) {
    if (!Array.isArray(landmarks) || landmarks.length < 21) { this.samples = []; return false; }
    this.samples.push({ t, x: landmarks[WRIST].x });
    this.samples = this.samples.filter((s) => t - s.t <= this.opt.windowMs);
    if (this.samples.length < 6) return false;
    const xs = this.samples.map((s) => s.x);
    if (Math.max(...xs) - Math.min(...xs) < this.opt.minAmplitude) return false;
    let reversals = 0;
    let dir = 0;
    for (let i = 1; i < xs.length; i += 1) {
      const d = Math.sign(xs[i] - xs[i - 1]);
      if (d !== 0 && dir !== 0 && d !== dir) reversals += 1;
      if (d !== 0) dir = d;
    }
    return reversals >= this.opt.minReversals;
  }
}

// Detects a deliberate directional flick: an open hand travelling decisively one way.
//
// Same family as WaveDetector — a short wrist-position history read every frame — and the
// same defence against typing hands: three gates stacked (open palm, displacement over a
// short window, one axis clearly dominating) plus a refractory period. A hand crossing the
// frame to reach the mouse fails the open-palm gate; a typing hand fails displacement.
//
// Directions are reported in *screen* space (what the user sees in the mirrored preview):
// swiping toward their right reads as 'right'. Image x is therefore flipped.
export class SwipeDetector {
  constructor({ windowMs = 260, minTravel = 0.13, dominance = 1.6, refractoryMs = 650,
    oppositeLockoutMs = 1500 } = {}) {
    this.opt = { windowMs, minTravel, dominance, refractoryMs, oppositeLockoutMs };
    this.reset();
  }

  reset() {
    this.hist = [];
    this.lastFired = -Infinity;
    this.lastDir = null;
  }

  // `landmarks` is one hand; `open` is whether the shape gate (open palm) held this frame.
  update(landmarks, open, t) {
    if (!Array.isArray(landmarks) || landmarks.length < 21 || !open) {
      // The gate must hold for the whole travel, so any closed/absent frame clears it.
      this.hist = [];
      return null;
    }
    const wrist = landmarks[0];
    this.hist.push({ x: wrist.x, y: wrist.y, t });
    while (this.hist.length > 0 && t - this.hist[0].t > this.opt.windowMs) this.hist.shift();
    if (this.hist.length < 4) return null;
    if (t - this.lastFired < this.opt.refractoryMs) return null;

    const a = this.hist[0];
    const dxRaw = wrist.x - a.x;
    const dy = wrist.y - a.y;
    const adx = Math.abs(dxRaw);
    const ady = Math.abs(dy);
    if (Math.max(adx, ady) < this.opt.minTravel) return null;
    if (Math.max(adx, ady) < Math.min(adx, ady) * this.opt.dominance) return null;

    let dir;
    if (ady >= adx) dir = dy < 0 ? 'up' : 'down';
    // Mirrored: image x grows toward the user's left.
    else dir = dxRaw < 0 ? 'right' : 'left';

    // Return-stroke suppression. A flick has a recovery: the hand travels back to where
    // it came from, same open palm, opposite direction — and it read as a second command
    // that sent the character straight back. The recovery is always opposite and always
    // soon, so opposite-direction swipes are locked out for a while after each fire.
    // Deliberate reversals a moment later still work; the immediate bounce does not.
    const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
    if (this.lastDir && dir === OPP[this.lastDir] && t - this.lastFired < this.opt.oppositeLockoutMs) {
      this.hist = [];
      return null;
    }

    this.lastFired = t;
    this.lastDir = dir;
    this.hist = [];
    return dir;
  }
}

// Turns one frame of MediaPipe output into the gesture facts the core reacts to.
export function readHands({ gestureResult, faceLandmarks, t, wave, swipe }) {
  const hands = gestureResult?.landmarks ?? [];
  const canned = gestureResult?.gestures?.[0]?.[0];
  const cannedName = canned && canned.categoryName !== 'None' ? canned.categoryName : null;
  const out = {
    handCount: hands.length,
    canned: cannedName,
    cannedScore: canned?.score ?? 0,
    shape: null,
    fingers: null,
    // Which fingers are up, by name. This is the honest reading the model gets — the
    // classified `shape` is kept for local use (OS intents, trigger novelty) only,
    // because the classifier is the least reliable stage of the pipeline.
    fingersUp: [],
    swipe: null,
    nearFace: false,
    waving: false,
    bothHands: hands.length >= 2,
  };
  if (hands.length === 0) {
    wave?.reset();
    swipe?.update(null, false, t);
    return out;
  }
  const first = hands[0];
  const cls = classifyHand(first);
  if (cls) { out.shape = cls.name; out.fingers = cls.fingers; }
  const st = fingerStates(first);
  out.fingersUp = ['thumb', 'index', 'middle', 'ring', 'pinky'].filter((n) => st[n]);
  out.nearFace = handNearFace(first, faceLandmarks);
  out.waving = wave ? wave.update(first, t) : false;
  // Open-ish palm: thumb excluded because it reads unreliably at speed.
  const openish = out.fingersUp.filter((n) => n !== 'thumb').length >= 3;
  out.swipe = swipe ? swipe.update(first, openish, t) : null;
  return out;
}
