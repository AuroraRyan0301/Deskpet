// Tier 1: where the finger points, and how the character gets there. DOM-free and pure —
// every function takes the timestamp it needs, so the whole servo path is testable
// without a clock and without a camera.
//
// Three pieces:
//   OneEuroFilter  — jitter out of the fingertip without paying an EMA's lag
//   fitHomography  — one-time 4-corner calibration, camera space → screen space
//   Locomotion     — step toward a goal and pick the directional clip a sprite pack has
//
// Finger *direction* is deliberately not used. DESIGN.md has the argument: the camera is
// embedded in the screen being pointed at, so pointing at the screen means pointing very
// nearly at the camera, and the direction vector is maximally foreshortened exactly where
// precision is needed. Fingertip *position* through a homography is a virtual trackpad
// wearing a pointing gesture, and it is far more accurate than the requirement.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const finitePoint = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

// ------------------------------------------------------------------ one euro ----

// Why not the Ema used elsewhere in the core: an EMA has one coefficient, so it buys
// smoothness with lag at a fixed exchange rate. Pointing needs both — a still finger must
// not shake the cursor, and a moving finger must not drag a tail behind it — and one
// coefficient cannot deliver both. The one-euro filter (Casiez et al., CHI 2012) makes the
// cutoff a function of the low-passed speed: slow means smooth, fast means responsive.
export const ONE_EURO = {
  // Resting cutoff, Hz. Chosen for the jitter actually present in MediaPipe fingertips
  // (a few thousandths of the frame at 30 fps): 1 Hz is ~0.17 of a step per frame, which
  // flattens that noise, and at rest lag costs nothing because nothing is moving.
  fcmin: 1.0,
  // Hz per (normalised unit / second). A deliberate pointing sweep crosses the frame in
  // under a second, so speeds of 1–2 units/s are normal; beta 1.5 turns that into a 2.5–4
  // Hz cutoff, i.e. roughly two frames of lag when moving instead of six.
  beta: 1.5,
  // Cutoff for the speed estimate itself. A raw frame-to-frame difference is nearly all
  // noise; without this the cutoff would be modulated by jitter rather than by motion.
  dcutoff: 1.0,
  // Beyond this, the gap is not a frame interval — the camera stalled or the hand left
  // the frame. See update() for why the gap is not simply fed in as a large dt.
  stallSec: 0.2,
  nominalDtSec: 1 / 30,
};

// Exponential smoothing coefficient for a first-order low-pass with this cutoff at this
// timestep. Derived from the cutoff rather than fixed, which is the whole point.
export function smoothingFactor(cutoffHz, dtSec) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return dtSec / (dtSec + tau);
}

export class OneEuroFilter {
  constructor(opt = {}) {
    this.opt = { ...ONE_EURO, ...opt };
    this.reset();
  }

  reset() {
    this.value = null;   // last filtered position
    this.raw = null;     // last input, for the derivative
    this.deriv = { x: 0, y: 0 };
    this.speed = 0;
    this.lastT = null;
  }

  // `t` in ms, `point` in whatever units the caller is filtering (normalised camera
  // coordinates here). Returns a fresh {x, y}, or null before the first valid sample.
  update(point, t) {
    // A dropped detection is not a position of (0,0); holding the last estimate is the
    // only answer that does not yank the cursor to the corner of the frame.
    if (!finitePoint(point) || !Number.isFinite(t)) return this.value && { ...this.value };

    if (this.value == null) {
      // First sample passes through untouched. Seeding from zero would start every
      // session with a visible slide in from the origin.
      this.value = { x: point.x, y: point.y };
      this.raw = { x: point.x, y: point.y };
      this.deriv = { x: 0, y: 0 };
      this.speed = 0;
      this.lastT = t;
      return { ...this.value };
    }

    let dtSec = (t - this.lastT) / 1000;
    // Two frames with the same timestamp, or a clock that went backwards: no time has
    // passed, so there is nothing to integrate and dividing by it would produce Infinity.
    // Hold the estimate and keep the old timestamp, so the next real frame still has a
    // sane dt to work with.
    if (!(dtSec > 0)) return { ...this.value };

    let stalled = false;
    if (dtSec > this.opt.stallSec) {
      // A 10 s gap fed in as dt makes the smoothing factor ≈ 1, which teleports the
      // output — and the position delta divided by 10 s reports a near-zero speed, so the
      // cutoff would sit at its slowest exactly when the filter has most to catch up on.
      // Instead treat the resumption as one ordinary frame and throw the speed estimate
      // away: motion measured across a gap the hand may have left the frame during is not
      // motion. The output then walks to the new position over a few frames.
      dtSec = this.opt.nominalDtSec;
      stalled = true;
    }

    const dx = (point.x - this.raw.x) / dtSec;
    const dy = (point.y - this.raw.y) / dtSec;
    const ad = smoothingFactor(this.opt.dcutoff, dtSec);
    if (stalled) {
      this.deriv = { x: 0, y: 0 };
    } else {
      this.deriv = {
        x: this.deriv.x + ad * (dx - this.deriv.x),
        y: this.deriv.y + ad * (dy - this.deriv.y),
      };
    }
    // Speed magnitude, not per-axis speed: a per-axis cutoff smooths the two axes by
    // different amounts, which bends a straight diagonal sweep into a curve.
    this.speed = Math.hypot(this.deriv.x, this.deriv.y);

    const cutoff = this.opt.fcmin + this.opt.beta * this.speed;
    const a = smoothingFactor(cutoff, dtSec);
    this.value = {
      x: this.value.x + a * (point.x - this.value.x),
      y: this.value.y + a * (point.y - this.value.y),
    };
    this.raw = { x: point.x, y: point.y };
    this.lastT = t;
    return { ...this.value };
  }
}

// ----------------------------------------------------------------- homography ----

export const FIT_FAILURE_REASONS = ['bad_input', 'too_few_points', 'coincident_points',
  'collinear_points', 'singular'];

// A calibration worse than this maps the finger to the wrong part of the screen, and the
// visible symptom is a character that confidently walks somewhere the user did not point.
// Better to make the user redo four taps: 0.02 of the screen is ~38 px on a 1920 display,
// well inside the "大概方位" the feature promises.
export const RESIDUAL_LIMIT = 0.02;

const fail = (reason, detail) => ({ ok: false, reason, detail: detail ?? null, h: null });

// Accepts [{ from, to }] — `from` in normalised camera coordinates, `to` in normalised
// screen coordinates. Returns null if anything is missing or not a number, so a single
// NaN landmark cannot poison a calibration.
function readPairs(pairs) {
  if (!Array.isArray(pairs)) return null;
  const out = [];
  for (const p of pairs) {
    if (!p || !finitePoint(p.from) || !finitePoint(p.to)) return null;
    out.push({ from: { x: p.from.x, y: p.from.y }, to: { x: p.to.x, y: p.to.y } });
  }
  return out;
}

// Largest pairwise distance: the natural length scale of a point set, used to turn
// absolute spacings and triangle areas into dimensionless ratios so the tolerances mean
// the same thing for a calibration across the whole frame and one in a corner of it.
function extent(pts) {
  let max = 0;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > max) max = d;
    }
  }
  return max;
}

function minSpacing(pts) {
  let min = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < min) min = d;
    }
  }
  return min;
}

// Triangle areas over every triple, as a fraction of the set's extent squared — so the
// numbers are dimensionless and the tolerance means the same thing for a calibration
// spanning the whole frame and one crammed into a corner of it.
//   max ≈ 0 — every point is on one line, and no homography exists however many were
//             collected.
//   min ≈ 0 — some three points are on one line. Only fatal at exactly four pairs; see
//             the caller for why.
function triangleAreas(pts) {
  const scale = extent(pts) ** 2;
  if (!(scale > 0)) return { min: 0, max: 0 };
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      for (let k = j + 1; k < pts.length; k += 1) {
        const cross = Math.abs((pts[j].x - pts[i].x) * (pts[k].y - pts[i].y)
          - (pts[j].y - pts[i].y) * (pts[k].x - pts[i].x));
        const a = cross / (2 * scale);
        if (a < min) min = a;
        if (a > max) max = a;
      }
    }
  }
  return { min, max };
}

// Gaussian elimination with partial pivoting, in place. Returns null when the best
// available pivot is negligible against the scale of the matrix: that is a singular
// system, and the only honest answer is "no solution", not a vector of 1e17.
function solveGauss(m, rhs) {
  const n = rhs.length;
  let scale = 0;
  for (const row of m) for (const v of row) if (Math.abs(v) > scale) scale = Math.abs(v);
  if (!(scale > 0)) return null;
  const eps = 1e-12 * scale;

  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < eps) return null;
    if (piv !== col) {
      const tr = m[col]; m[col] = m[piv]; m[piv] = tr;
      const tb = rhs[col]; rhs[col] = rhs[piv]; rhs[piv] = tb;
    }
    for (let r = col + 1; r < n; r += 1) {
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c += 1) m[r][c] -= f * m[col][c];
      rhs[r] -= f * rhs[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = rhs[i];
    for (let c = i + 1; c < n; c += 1) s -= m[i][c] * x[c];
    x[i] = s / m[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

// Raw projective map, before any clamping. Separate from applyHomography because the fit
// needs the unclamped value to measure its own error honestly.
function project(h, p) {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(w) < 1e-9) return null;
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

// Fits a 3x3 projective transform, h[8] fixed at 1, from 4 or more correspondences.
//
// Each pair contributes two linear equations in the 8 remaining unknowns, so the system
// is 2N x 8: square and exact at N = 4, over-determined beyond it. Both are handled the
// same way, by forming the 8x8 normal equations AᵀA h = Aᵀb and eliminating. Squaring the
// system squares its conditioning too, which is why Hartley normalisation exists — but
// that is for data in pixel units where the x·u terms span six orders of magnitude. Both
// sides here are already 0..1, so the plain system is well enough scaled and the extra
// stage would only be another place for a bug to hide.
//
// Returns { ok: true, h, residual, maxResidual, points } or { ok: false, reason, detail }.
export function fitHomography(pairs, opt = {}) {
  const { coincidentTol = 1e-3, collinearTol = 1e-3 } = opt;
  const pts = readPairs(pairs);
  if (!pts) return fail('bad_input', 'a point was missing or not finite');
  if (pts.length < 4) {
    // Four is not a nicety: eight unknowns need eight equations.
    return fail('too_few_points', `${pts.length} pairs, 4 required`);
  }

  const from = pts.map((p) => p.from);
  const to = pts.map((p) => p.to);
  const span = extent(from);
  if (!(span > 0)) return fail('coincident_points', 'every camera point is the same point');
  if (minSpacing(from) / span < coincidentTol) {
    // Two taps at the same place are one constraint recorded twice, usually a
    // double-registered click during calibration.
    return fail('coincident_points', 'two camera points are effectively the same');
  }
  if (!(extent(to) > 0)) return fail('coincident_points', 'every screen point is the same point');

  for (const [name, set] of [['camera', from], ['screen', to]]) {
    const area = triangleAreas(set);
    if (area.max < collinearTol) {
      return fail('collinear_points', `all ${name} points lie on one line`);
    }
    // With exactly four pairs every triple is load-bearing, so one flat triple kills the
    // fit. With more pairs it does not: the remaining points still pin the transform
    // down, and refusing would reject a perfectly good nine-point calibration in which
    // three samples happened to line up. Anything this misses is still caught by the
    // pivot test in solveGauss, only with a vaguer reason.
    if (set.length === 4 && area.min < collinearTol) {
      return fail('collinear_points', `three ${name} points lie on one line`);
    }
  }

  // 2N x 8 system, one row pair per correspondence.
  const rows = [];
  const rhs = [];
  for (const { from: c, to: s } of pts) {
    rows.push([c.x, c.y, 1, 0, 0, 0, -c.x * s.x, -c.y * s.x]);
    rhs.push(s.x);
    rows.push([0, 0, 0, c.x, c.y, 1, -c.x * s.y, -c.y * s.y]);
    rhs.push(s.y);
  }

  const m = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const b = new Array(8).fill(0);
  for (let r = 0; r < rows.length; r += 1) {
    for (let i = 0; i < 8; i += 1) {
      b[i] += rows[r][i] * rhs[r];
      for (let j = i; j < 8; j += 1) m[i][j] += rows[r][i] * rows[r][j];
    }
  }
  for (let i = 0; i < 8; i += 1) for (let j = 0; j < i; j += 1) m[i][j] = m[j][i];

  const sol = solveGauss(m, b);
  if (!sol) return fail('singular', 'the calibration points do not determine a transform');
  const h = [...sol, 1];

  // Reprojection error in screen units, reported so a bad calibration can be rejected
  // by the caller instead of quietly aiming the character at the wrong window.
  let sum = 0;
  let maxResidual = 0;
  for (const { from: c, to: s } of pts) {
    const q = project(h, c);
    if (!q) return fail('singular', 'a calibration point maps to the vanishing line');
    const d = Math.hypot(q.x - s.x, q.y - s.y);
    sum += d * d;
    if (d > maxResidual) maxResidual = d;
  }
  const residual = Math.sqrt(sum / pts.length);
  if (!Number.isFinite(residual)) return fail('singular', 'fit produced a non-finite residual');

  return { ok: true, h, residual, maxResidual, points: pts.length };
}

// Maps a camera point to a screen point. `x`/`y` are clamped into 0..1 so a caller that
// ignores the flag still gets a goal that is on the screen, `inside` says whether the
// clamp did anything, and `raw` is there for callers that would rather ignore the sample
// than aim at the edge.
export function applyHomography(h, p) {
  if (!Array.isArray(h) || h.length !== 9 || !h.every(Number.isFinite)) {
    return { ok: false, reason: 'bad_input', detail: 'h is not a 3x3 matrix' };
  }
  if (!finitePoint(p)) return { ok: false, reason: 'bad_input', detail: 'point is not finite' };
  const q = project(h, p);
  // w ≈ 0 is the vanishing line of the transform: this camera point maps to infinity.
  // Dividing anyway would hand the caller ±1e12 as a screen coordinate.
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) {
    return { ok: false, reason: 'behind_horizon', detail: 'point maps to the vanishing line' };
  }
  const inside = q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1;
  return { ok: true, x: clamp01(q.x), y: clamp01(q.y), inside, raw: q };
}

// ----------------------------------------------------------------- locomotion ----

// Sprite packs have no joints, only pre-rendered directional clips, so a continuous
// heading has to be quantised down to one of four before anything can be drawn.
export const CLIPS = ['WALK_L', 'WALK_R', 'WALK_U', 'WALK_D', 'RUN_L', 'RUN_R', 'RUN_U', 'RUN_D'];

// The importer keys those same sheets by semantic name, so the controller emits that name
// too — the name `CharacterRig.resolve()` takes — rather than making every caller keep a
// copy of this table.
export const CLIP_ACTIONS = {
  WALK_L: 'walkLeft', WALK_R: 'walkRight', WALK_U: 'walkUp', WALK_D: 'walkDown',
  RUN_L: 'runLeft', RUN_R: 'runRight', RUN_U: 'runUp', RUN_D: 'runDown',
};

export const LOCOMOTION = {
  // Normalised screen units. Under ~4 px on a 1920 display: closer than this is not a
  // distance a user can see, and chasing it forever is how a character ends up vibrating
  // on its target for the rest of the session.
  tolerance: 0.002,
  // The off-axis component must beat the on-axis one by this much before the clip
  // changes. Without it, a path within a degree of 45° swaps clip every other frame,
  // which reads as a stutter rather than as walking.
  hysteresis: 0.25,
  // Above this speed the run sheets are used. Derived from speed rather than passed in,
  // so the DSL's `walk` and `run` verbs cannot disagree with the animation.
  runSpeed: 0.35,
};

const cardinal = (axis, dx, dy) => {
  // Screen y grows downward, so positive dy is 'D'. (perception.js flips the sign for
  // gesture naming because "point up" is about the world, not about the framebuffer.)
  if (axis === 'x') return dx > 0 ? 'R' : 'L';
  return dy > 0 ? 'D' : 'U';
};

// Holds only the last direction. The character's position stays with the caller that
// owns and renders it, so this controller cannot drift out of sync with what is on
// screen — it is asked "given where you are, where next", every frame.
export class Locomotion {
  constructor(opt = {}) {
    this.opt = { ...LOCOMOTION, ...opt };
    this.reset();
  }

  reset() {
    this.dir = null;
  }

  // `speed` is normalised screen units per second and `dt` is milliseconds, matching the
  // rest of the core. Returns { pos, arrived, dir, clip, action, moved, remaining }.
  //
  // `dir` survives arrival — a character that stops still has to stand facing somewhere —
  // but `clip` and `action` go null when nothing moved, so the caller does not play a walk
  // cycle on the spot. Position is passed in and returned rather than stored; see above.
  step({ pos, goal, speed, dt }) {
    const here = finitePoint(pos) ? { x: pos.x, y: pos.y } : { x: 0, y: 0 };
    const finish = (p, arrived, moved, remaining) => {
      const gait = speed >= this.opt.runSpeed ? 'RUN' : 'WALK';
      const clip = moved > 0 && this.dir ? `${gait}_${this.dir}` : null;
      return {
        pos: p, arrived, dir: this.dir, clip, action: clip ? CLIP_ACTIONS[clip] : null,
        moved, remaining,
      };
    };

    // A missing goal means nobody has asked for motion. Standing still is the answer, not
    // walking toward NaN.
    if (!finitePoint(goal)) return finish(here, true, 0, 0);

    const dx = goal.x - here.x;
    const dy = goal.y - here.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= this.opt.tolerance) {
      // Snapped to the goal, not merely flagged as arrived: leaving a sub-tolerance error
      // in place means the next frame derives a direction from what is now pure noise,
      // and the character shivers on its target forever.
      return finish({ x: goal.x, y: goal.y }, true, 0, 0);
    }

    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    let axis = ax >= ay ? 'x' : 'y';
    if (this.dir) {
      const lastAxis = this.dir === 'L' || this.dir === 'R' ? 'x' : 'y';
      const on = lastAxis === 'x' ? ax : ay;
      const off = lastAxis === 'x' ? ay : ax;
      // Hysteresis applies to the *axis* only. A genuine reversal along the same axis
      // (walking right, then left) switches immediately: that is not flicker, and holding
      // WALK_R while moving left would render the character sliding backwards.
      axis = off > on * (1 + this.opt.hysteresis) ? (lastAxis === 'x' ? 'y' : 'x') : lastAxis;
    }
    this.dir = cardinal(axis, dx, dy);

    const stride = Number.isFinite(speed) && Number.isFinite(dt) && speed > 0 && dt > 0
      ? (speed * dt) / 1000
      : 0;
    if (stride <= 0) return finish(here, false, 0, dist);
    // Never step past the goal: overshooting and coming back is the other way to build an
    // oscillator, and it happens whenever dt spikes.
    if (stride >= dist) return finish({ x: goal.x, y: goal.y }, true, dist, 0);
    return finish(
      { x: here.x + (dx / dist) * stride, y: here.y + (dy / dist) * stride },
      false, stride, dist - stride,
    );
  }
}
