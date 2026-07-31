// Desk pet core: feature frames in, pet state out. No DOM, no MediaPipe — so this
// runs under `node --test` as well as in the browser.

import { NoveltyGate, TRIGGER_CHANNEL } from './triggers.js';

export const POLICIES = ['flatter', 'honest', 'ignore'];

export const DEFAULTS = {
  policy: 'honest',
  // Visible reaction is held back by this much. From the haptics literature: the
  // visuo-tactile simultaneity window is ~60 ms and perceived conflict peaks at
  // 30-120 ms of delay, so 0 is not automatically the best setting — it is a knob
  // the evaluation is supposed to sweep.
  reactionDelayMs: 40,
  calibrationFrames: 30,
  // slump = (centerY - baseline) / 0.2, so a threshold of T means the face centroid
  // moved T * 0.2 of the frame height. The old single 0.06 was 1.2% of frame — about
  // six pixels at 480p — which breathing and landmark jitter cross constantly.
  // Enter/exit differ so hovering at the boundary cannot flip slump <-> good, and the
  // dwell requirement is what separates "slouched" from "moved".
  slumpEnter: 0.28,
  slumpExit: 0.14,
  slumpDwellMs: 1600,
  leanInThreshold: 1.18,
  yawnHoldMs: 700,
  awayGraceMs: 900,
  sleepyBlinkRate: 26,
  // Yawns age out. Without this a single yawn pins `sleepy` true for the whole
  // session, and every flicker of another state re-fires the sleepy line.
  yawnWindowMs: 300000,
  // A hand shape has to be *held* before it counts as a gesture. Without this, typing was
  // read as communication: fingers moving over keys flip through shapes continuously, every
  // flip was a fresh trigger, and the hand channel's 2.5 s cooldown then allowed a remark
  // every 2.5 seconds — around 24 a minute. A deliberate sign is held still; a keystroke is
  // not, and 600 ms separates the two cleanly.
  handShapeDwellMs: 600,
  // Trigger pacing lives in triggers.js: per-channel cooldowns, per-channel novelty
  // windows, and one global floor. Flat cooldowns used to live here and were removed —
  // they could not express "hands fast, posture slow".
  energyDrainPerMin: 8,
  slowPeriodMs: 8000,
  slowMinIntervalMs: 4000,
  returnAfterMs: 3000,
  logLimit: 20000,
  // Blendshape cut-offs. These are the numbers that actually need tuning against a
  // real face — blendshape scales differ a lot between people and lighting.
  blinkOn: 0.5,
  blinkOff: 0.3,
  smileOn: 0.35,
  jawOn: 0.45,
  attentionYawDeg: 25,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Ema {
  constructor(alpha, initial = null) {
    this.alpha = alpha;
    this.value = initial;
  }
  push(x) {
    if (x == null || Number.isNaN(x)) return this.value;
    this.value = this.value == null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }
}

export function makeFeatures(partial = {}) {
  return {
    t: 0,
    facePresent: false,
    smile: 0,
    jawOpen: 0,
    blink: 0,
    browDown: 0,
    headPitch: 0,
    headYaw: 0,
    faceCenterY: 0.5,
    faceSize: 0.25,
    gesture: null,
    gestureScore: 0,
    // From perception.js. All of these are discrete facts about this frame; the core
    // turns changes in them into triggers rather than reacting continuously.
    expression: null,
    handShape: null,
    handCount: 0,
    fingers: null,
    fingersUp: [],
    waving: false,
    handNearFace: false,
    ...partial,
  };
}

export class PetCore {
  constructor(options = {}) {
    this.opt = { ...DEFAULTS, ...options };
    if (!POLICIES.includes(this.opt.policy)) {
      throw new Error(`unknown policy: ${this.opt.policy}`);
    }
    this.rand = mulberry32(options.seed ?? 12345);
    this.reset();
  }

  reset() {
    this.centerY = new Ema(0.25);
    this.size = new Ema(0.25);
    this.smileEma = new Ema(0.3, 0);
    this.baseline = null;
    this.calibCount = 0;
    this.calibSumY = 0;
    this.calibSumSize = 0;

    this.blinkHigh = false;
    this.blinkTimes = [];
    this.jawHighSince = null;
    this.yawnCounted = false;
    this.yawnTimes = [];

    this.startT = null;
    this.lastSeenT = null;
    this.awayMs = 0;
    this.wasAway = false;
    this.focusStreakMs = 0;
    this.slumping = false;
    this.slumpCandidateSince = null;
    this.wasSleepy = false;
    this.lastExpression = null;
    this.lastHandShape = null;
    this.wasWaving = false;
    this.wasHandNearFace = false;
    // Per-channel rates and novelty live here now: hands answer in seconds, posture and
    // expression in minutes, and a state that has become the person's norm stops being
    // reported at all.
    this.gate = new NoveltyGate();
    this.lastTriggerAt = new Map();
    this.lastAnyTriggerAt = null;
    this.channelShare = {};
    this.handShapeCandidate = null;
    this.handShapeCandidateSince = null;
    this.lastReportedHandShape = null;

    this.energy = 100;
    this.mood = 0.5;
    // The lasting stance, owned by the model's `mood` verb. Local code never writes a
    // judgment here.
    this.moodState = 'idle';
    this.lastT = null;

    this.pending = [];
    this.state = {
      sprite: 'away',
      gaze: { x: 0, y: 0 },
      slump: 0,
      attention: false,
      blinkRate: 0,
      yawnCount: 0,
      energy: 100,
      mood: 0.5,
      gesture: null,
      calibrated: false,
      latencyMs: 0,
      awayMs: 0,
    };
    this.lastGesture = null;
    this.lastSlowT = null;
    this.slowReason = null;
    this.semantic = null;
    this.semanticT = null;
    this.log = [];
  }

  setPolicy(policy) {
    if (!POLICIES.includes(policy)) throw new Error(`unknown policy: ${policy}`);
    this.opt.policy = policy;
  }

  get calibrated() {
    return this.baseline != null;
  }

  get yawnCount() {
    return this.yawnTimes.length;
  }

  // Returns the pet state that should be rendered at time f.t.
  updateFast(rawFrame) {
    const f = makeFeatures(rawFrame);
    const dt = this.lastT == null ? 0 : Math.max(0, f.t - this.lastT);
    this.lastT = f.t;
    // Timestamps are performance.now() in the browser, so rates must be measured
    // against the first frame seen rather than against zero.
    if (this.startT == null) this.startT = f.t;

    if (f.facePresent) {
      this.lastSeenT = f.t;
      this.centerY.push(f.faceCenterY);
      this.size.push(f.faceSize);
      this.smileEma.push(f.smile);

      if (!this.calibrated) {
        this.calibCount += 1;
        this.calibSumY += f.faceCenterY;
        this.calibSumSize += f.faceSize;
        if (this.calibCount >= this.opt.calibrationFrames) {
          this.baseline = {
            centerY: this.calibSumY / this.calibCount,
            size: this.calibSumSize / this.calibCount,
          };
        }
      }

      // Blink edges with hysteresis, so a single blink is one event.
      if (!this.blinkHigh && f.blink >= this.opt.blinkOn) {
        this.blinkHigh = true;
        this.blinkTimes.push(f.t);
      } else if (this.blinkHigh && f.blink <= this.opt.blinkOff) {
        this.blinkHigh = false;
      }

      if (f.jawOpen >= this.opt.jawOn) {
        if (this.jawHighSince == null) this.jawHighSince = f.t;
        else if (f.t - this.jawHighSince >= this.opt.yawnHoldMs && !this.yawnCounted) {
          this.yawnTimes.push(f.t);
          this.yawnCounted = true;
        }
      } else {
        this.jawHighSince = null;
        this.yawnCounted = false;
      }
    }

    this.blinkTimes = this.blinkTimes.filter((t) => f.t - t <= 60000);
    this.yawnTimes = this.yawnTimes.filter((t) => f.t - t <= this.opt.yawnWindowMs);
    const elapsed = f.t - this.startT;
    const windowMs = Math.min(60000, elapsed);
    const blinkRate = windowMs > 1000 ? (this.blinkTimes.length * 60000) / windowMs : 0;

    this.awayMs = this.lastSeenT == null ? f.t : f.t - this.lastSeenT;
    const present = this.awayMs <= this.opt.awayGraceMs;

    // Once the user has been gone a while, the smoothed geometry is stale. Drop it
    // so posture is re-seeded from the first frame after they come back, and never
    // report a posture reading for a face that is not there.
    if (!present && this.awayMs > this.opt.returnAfterMs && this.centerY.value != null) {
      this.centerY.value = null;
      this.size.value = null;
      this.smileEma.value = 0;
    }

    const measurable = present && this.calibrated && this.centerY.value != null;
    const slump = measurable
      ? clamp((this.centerY.value - this.baseline.centerY) / 0.2, -1, 1)
      : 0;
    const leanRatio = measurable && this.size.value != null
      ? this.size.value / this.baseline.size
      : 1;
    const attention = present && Math.abs(f.headYaw) <= this.opt.attentionYawDeg;

    this.focusStreakMs = attention ? this.focusStreakMs + dt : 0;

    if (dt > 0) {
      this.energy = clamp(this.energy - (this.opt.energyDrainPerMin * dt) / 60000, 0, 100);
      if (attention) this.energy = clamp(this.energy + (2 * dt) / 60000, 0, 100);
    }

    const wasSlumping = this.slumping;
    if (!this.slumping) {
      // Above the entry threshold, but it only counts once it has been held.
      if (slump > this.opt.slumpEnter) {
        if (this.slumpCandidateSince == null) this.slumpCandidateSince = f.t;
        if (f.t - this.slumpCandidateSince >= this.opt.slumpDwellMs) this.slumping = true;
      } else {
        this.slumpCandidateSince = null;
      }
    } else if (slump < this.opt.slumpExit) {
      this.slumping = false;
      this.slumpCandidateSince = null;
    }

    const newGesture = f.gesture && f.gesture !== 'None' && f.gesture !== this.lastGesture
      ? f.gesture
      : null;
    if (f.gesture !== this.lastGesture) this.lastGesture = f.gesture;

    const justReturned = this.wasAway && present;
    this.wasAway = !present && (this.wasAway || this.awayMs > this.opt.returnAfterMs);

    const sleepy = blinkRate >= this.opt.sleepyBlinkRate || this.energy < 25 || this.yawnTimes.length > 0;

    // Presence is the only judgment the fast loop still renders. Everything expressive —
    // annoyed at a slouch, happy at a smile — used to be mapped here from detections, which
    // made the puppet a second, dumber narrator running next to the model. Now the mood is
    // whatever the model last set (`mood` verb via setMood); the camera only decides
    // whether anyone is there to perform it to.
    const sprite = present ? this.moodState : 'away';

    const moodTarget = this.opt.policy === 'flatter'
      ? 0.9
      : this.opt.policy === 'ignore'
        ? 0.5
        : clamp(0.65 - slump * 0.5 + (this.smileEma.value ?? 0) * 0.3, 0, 1);
    if (dt > 0) this.mood += (moodTarget - this.mood) * Math.min(1, dt / 1500);

    // The pet looks at you when it is paying attention, and drifts away when not.
    const gaze = attention
      ? { x: clamp(-f.headYaw / 45, -1, 1), y: clamp(slump, -1, 1) }
      : { x: this.state.gaze.x * 0.9, y: this.state.gaze.y * 0.9 };

    let trigger = null;
    // Hand-shape dwell. `lastReportedHandShape` is separate from `lastHandShape` so that a
    // shape flickering past for one frame cannot consume the "already reported that" slot.
    if (f.handShape !== this.handShapeCandidate) {
      this.handShapeCandidate = f.handShape;
      this.handShapeCandidateSince = f.handShape ? f.t : null;
    }
    const heldHandShape = this.handShapeCandidate
      && this.handShapeCandidateSince != null
      && f.t - this.handShapeCandidateSince >= this.opt.handShapeDwellMs
      ? this.handShapeCandidate
      : null;
    if (!f.handShape) this.lastReportedHandShape = null;

    if (justReturned) trigger = 'return';
    else if (newGesture) trigger = 'gesture';
    else if (this.slumping && !wasSlumping) trigger = 'slump';
    else if (!this.slumping && wasSlumping) trigger = 'good';
    else if (sleepy && !this.wasSleepy) trigger = 'sleepy';
    // Perception triggers: a change in a discrete fact, never the fact itself, so a
    // held expression or a held hand shape fires once rather than every frame.
    else if (f.waving && !this.wasWaving) trigger = 'wave';
    else if (heldHandShape && heldHandShape !== this.lastReportedHandShape) trigger = 'handShape';
    else if (f.expression && f.expression !== this.lastExpression) trigger = 'expression';
    else if (f.handNearFace && !this.wasHandNearFace) trigger = 'handNearFace';

    this.wasSleepy = sleepy;
    this.wasWaving = f.waving;
    this.wasHandNearFace = f.handNearFace;
    if (present) {
      this.lastExpression = f.expression;
      this.lastHandShape = f.handShape;
    }

    // Every channel is observed every frame, including its null/idle value: a channel
    // resting at "normal" has to accumulate window time too, or going back to normal
    // could never become news again.
    const channelValue = {
      posture: this.slumping ? 'slumping' : 'upright',
      expression: f.expression ?? 'neutral',
      hand: f.handShape ?? 'none',
      fatigue: sleepy ? 'tired' : 'awake',
      presence: present ? 'here' : 'away',
    };
    for (const [ch, v] of Object.entries(channelValue)) this.gate.observe(ch, v, f.t);

    const TRIGGER_VALUE = {
      slump: 'slumping',
      good: 'upright',
      expression: channelValue.expression,
      handShape: heldHandShape ?? 'none',
      gesture: f.gesture ?? 'none',
      wave: 'wave',
      handNearFace: 'nearFace',
      sleepy: 'tired',
      return: 'here',
    };

    let admitted = null;
    if (trigger) {
      admitted = this.gate.admit(trigger, TRIGGER_VALUE[trigger] ?? 'x', f.t);
      if (!admitted) trigger = null;
      else {
        if (trigger === 'handShape') this.lastReportedHandShape = heldHandShape;
        this.lastTriggerAt.set(trigger, f.t);
        this.lastAnyTriggerAt = f.t;
        this.queueTrigger(trigger, f.t);
      }
    }
    // Carried into the state so the prompt can say how usual this is.
    this.channelShare = admitted
      ? { channel: admitted.channel, share: admitted.share,
          habit: this.gate.describe(admitted.channel, TRIGGER_VALUE[trigger] ?? 'x', f.t) }
      : this.channelShare;

    const due = this.dueReaction(f.t);

    this.state = {
      sprite,
      gaze,
      // What woke the slow loop on this frame, after the reaction delay; null on most
      // frames. Nothing local acts on it any more — it exists to be sent to the model.
      trigger: due?.trigger ?? null,
      slump,
      leanRatio,
      attention,
      blinkRate,
      yawnCount: this.yawnTimes.length,
      energy: this.energy,
      mood: this.mood,
      gesture: f.gesture ?? null,
      expression: f.expression ?? null,
      handShape: f.handShape ?? null,
      fingersUp: f.fingersUp ?? [],
      handCount: f.handCount ?? 0,
      fingers: f.fingers ?? null,
      waving: Boolean(f.waving),
      handNearFace: Boolean(f.handNearFace),
      calibrated: this.calibrated,
      awayMs: this.awayMs,
      focusStreakMs: this.focusStreakMs,
      semantic: this.semantic,
      // A second `trigger:` key used to sit here and silently override the delayed one
      // above — an object-literal duplicate the linter never saw — so reactionDelayMs
      // had applied to nothing since the novelty gate landed. The channel metadata
      // belongs to the surfaced trigger, and channelShare persists from its admission.
      channel: due?.trigger ? (TRIGGER_CHANNEL[due.trigger] ?? null) : null,
      habit: due?.trigger ? this.channelShare.habit ?? null : null,
      share: due?.trigger ? this.channelShare.share ?? null : null,
      latencyMs: 0,
      t: f.t,
    };

    if (trigger) {
      // The logged trigger is the one detected on this frame, not the delayed one that
      // state.trigger carries — the CSV is the detection stream, which is what the
      // posture-correction counts are computed from. The explicit key must win over
      // the spread, so it goes last.
      this.pushLog({ t: f.t, ...this.state, trigger });
    }
    return this.state;
  }

  // reactionDelayMs holds back the whole visible reaction, body and speech together —
  // The trigger is what rides the delay queue now. The fast loop no longer speaks and no
  // longer picks animations — it only decides *that* something happened; everything the
  // puppet does about it comes back from the model as a verb script.
  queueTrigger(trigger, t) {
    this.pending.push({ dueAt: t + this.opt.reactionDelayMs, trigger });
  }

  // Returns the trigger whose delay has elapsed, or null. Collapses a backlog to the
  // newest entry: a queue of stale triggers replayed in order looks broken.
  // The model's `mood` verb lands here. Unknown names are refused (the parser should
  // have caught them, but this is the last line of defence before the renderer).
  setMood(name) {
    if (['idle', 'happy', 'curious', 'sleepy', 'annoyed'].includes(name)) this.moodState = name;
  }

  dueReaction(t) {
    let out = null;
    while (this.pending.length > 0 && this.pending[0].dueAt <= t) {
      const next = this.pending.shift();
      out = { trigger: next.trigger ?? null };
    }
    return out;
  }


  // Slow loop gate: event-triggered, rate-limited. Semantics do not need 30 fps.
  shouldTriggerSlow(t) {
    if (this.lastSlowT != null && t - this.lastSlowT < this.opt.slowMinIntervalMs) return null;
    if (!this.calibrated) return null;
    const s = this.state;
    let reason = null;
    if (s.awayMs > this.opt.returnAfterMs) reason = null;
    else if (s.gesture && s.gesture !== 'None') reason = 'gesture';
    else if (this.slumping) reason = 'posture';
    else if (this.lastSlowT == null || t - this.lastSlowT >= this.opt.slowPeriodMs) reason = 'periodic';
    if (reason) {
      this.lastSlowT = t;
      this.slowReason = reason;
    }
    return reason;
  }

  ingestSemantic(text, t) {
    this.semantic = text;
    this.semanticT = t;
  }

  pushLog(row) {
    if (this.log.length >= this.opt.logLimit) this.log.shift();
    this.log.push({
      t: Math.round(row.t),
      policy: this.opt.policy,
      trigger: row.trigger ?? '',
      sprite: row.sprite,
      slump: round3(row.slump),
      leanRatio: round3(row.leanRatio),
      attention: row.attention ? 1 : 0,
      blinkRate: round3(row.blinkRate),
      yawnCount: row.yawnCount,
      energy: round3(row.energy),
      mood: round3(row.mood),
      gesture: row.gesture ?? '',
      expression: row.expression ?? '',
      handShape: row.handShape ?? '',
      handCount: row.handCount ?? 0,
      focusStreakMs: Math.round(row.focusStreakMs ?? 0),

    });
  }

  toCsv() {
    const cols = ['t', 'policy', 'trigger', 'sprite', 'slump', 'leanRatio', 'attention',
      'blinkRate', 'yawnCount', 'energy', 'mood', 'gesture', 'expression', 'handShape',
      'handCount', 'focusStreakMs'];
    const head = cols.join(',');
    const body = this.log.map((r) => cols.map((c) => r[c] ?? '').join(','));
    return [head, ...body].join('\n');
  }
}

function round3(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : '';
}

// Turns MediaPipe results into a feature frame. Kept here so the browser side
// stays thin and this mapping is testable.
export function featuresFromMediapipe({ faceResult, gestureResult, t, videoAspect = 1 }) {
  const out = makeFeatures({ t });
  const bs = faceResult?.faceBlendshapes?.[0]?.categories;
  const lm = faceResult?.faceLandmarks?.[0];
  if (bs && lm) {
    out.facePresent = true;
    const get = (name) => bs.find((c) => c.categoryName === name)?.score ?? 0;
    out.blink = Math.max(get('eyeBlinkLeft'), get('eyeBlinkRight'));
    out.smile = Math.max(get('mouthSmileLeft'), get('mouthSmileRight'));
    out.jawOpen = get('jawOpen');
    out.browDown = Math.max(get('browDownLeft'), get('browDownRight'));

    let sx = 0, sy = 0, minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const p of lm) {
      sx += p.x; sy += p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    out.faceCenterY = sy / lm.length;
    out.faceSize = Math.max(maxX - minX, (maxY - minY) / (videoAspect || 1));

    const m = faceResult?.facialTransformationMatrixes?.[0]?.data;
    if (m && m.length === 16) {
      // Column-major 4x4. Yaw/pitch from the rotation block.
      out.headYaw = (Math.atan2(-m[2], Math.hypot(m[0], m[1])) * 180) / Math.PI;
      out.headPitch = (Math.atan2(m[6], m[10]) * 180) / Math.PI;
    } else {
      const nose = lm[1], le = lm[33], re = lm[263];
      if (nose && le && re) {
        const mid = (le.x + re.x) / 2;
        const half = Math.abs(re.x - le.x) / 2 || 1e-6;
        out.headYaw = clamp(((nose.x - mid) / half) * 45, -90, 90);
      }
    }
  }
  const g = gestureResult?.gestures?.[0]?.[0];
  if (g && g.categoryName !== 'None') {
    out.gesture = g.categoryName;
    out.gestureScore = g.score;
  }
  return out;
}
