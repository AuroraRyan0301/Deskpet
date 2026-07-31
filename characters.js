// Character packs and the action system. DOM-free so it runs under node --test.
//
// A pack declares two kinds of animation:
//   states  — continuous, driven by the fast loop (the user's posture/expression)
//   actions — one-shot, driven by the slow loop (what the language model decided)
//
// The action vocabulary is what gets injected into the model prompt, so adding an
// action to a pack manifest makes it selectable by the model with no code change.
//
// Two renderers:
//   procedural — the built-in blob, drawn with canvas paths, no assets
//   sheet      — sprite sheets laid out as a row-major grid of equal cells, which is
//                the Desktop_Gremlin layout: index i -> (i % columns, i / columns)

export const STATE_NAMES = ['idle', 'happy', 'sleepy', 'annoyed', 'curious', 'away'];

// Shipped action vocabulary for procedural packs. Sheet packs replace this with
// whatever animations they actually ship (see tools/import-gremlin.mjs).
export const BUILTIN_ACTIONS = {
  nod: { durationMs: 900, desc: '点头，表示同意、收到、赞同' },
  shake: { durationMs: 900, desc: '摇头，表示不同意、否认' },
  jump: { durationMs: 700, desc: '原地跳一下，表示开心、兴奋、惊喜' },
  wave: { durationMs: 1200, desc: '挥手，打招呼或告别' },
  stretch: { durationMs: 1400, desc: '伸懒腰，表示困、无聊、久坐' },
  sulk: { durationMs: 1600, desc: '生闷气、沉下去，表示不满或被忽视' },
  cheer: { durationMs: 1300, desc: '欢呼庆祝，表示鼓励、夸奖' },
  peek: { durationMs: 1100, desc: '探头张望，表示好奇、想看清楚' },
  tilt: { durationMs: 900, desc: '歪头，表示疑惑、没听懂' },
  spin: { durationMs: 1000, desc: '转一圈，表示得意、玩闹' },
};

// Procedural packs need no per-state data; the state name alone drives the drawing.
const PROC_STATES = { idle: {}, happy: {}, sleepy: {}, annoyed: {}, curious: {}, away: {} };

// `look` parameterises the procedural renderer, so several distinct-looking
// characters exist with zero image assets — which keeps 切换人物 working even when no
// sheet pack is installed, and keeps the shipped default license-clean.
const DEFAULT_LOOK = {
  shape: 'blob',   // blob | cat | ghost
  ears: 'round',   // round | pointy | none
  eyes: 'dot',     // dot | big
  outline: null,
  palette: {
    idle: { body: '#8ec5b6', cheek: '#e8b4a0' },
    happy: { body: '#93d3a2', cheek: '#f0a68f' },
    sleepy: { body: '#9aa8c7', cheek: '#c9b6c7' },
    annoyed: { body: '#d79a86', cheek: '#c47a63' },
    curious: { body: '#c3bd8f', cheek: '#e0b48f' },
    away: { body: '#b9b9b9', cheek: '#cccccc' },
  },
};

export const DEFAULT_PACK = {
  id: 'blob',
  name: 'Pudding',
  renderer: 'procedural',
  scale: 1,
  persona: 'A small squishy pudding spirit. Short, gentle, faintly needy.',
  voice: { lang: 'en-US', voiceHint: 'Samantha', rate: 1, pitch: 1.05 },
  look: DEFAULT_LOOK,
  states: PROC_STATES,
  actions: { ...BUILTIN_ACTIONS },
};

export const BUILTIN_PACKS = [
  DEFAULT_PACK,
  {
    id: 'cat', name: 'Mochi', renderer: 'procedural', scale: 1.05,
    persona: 'A slightly tsundere cat. Brief, occasionally withering, secretly invested in you.',
    voice: { lang: 'en-US', voiceHint: 'Karen', rate: 1.05, pitch: 0.95 },
    states: PROC_STATES,
    look: {
      shape: 'cat', ears: 'pointy', eyes: 'big', outline: 'rgba(60,45,40,0.35)',
      palette: {
        idle: { body: '#e8c9a0', cheek: '#f0a89a' },
        happy: { body: '#f0d5a8', cheek: '#f59a86' },
        sleepy: { body: '#c9bda8', cheek: '#d8b6ac' },
        annoyed: { body: '#d9a884', cheek: '#c07a5c' },
        curious: { body: '#f2d8b0', cheek: '#f0a68f' },
        away: { body: '#c4bcb2', cheek: '#d0c8c0' },
      },
    },
  },
  {
    id: 'ghost', name: 'Wisp', renderer: 'procedural', scale: 0.98,
    persona: 'A quiet little ghost. Speaks lightly and slowly, like a whisper beside your ear.',
    voice: { lang: 'en-US', voiceHint: 'Moira', rate: 0.95, pitch: 1.15 },
    states: PROC_STATES,
    look: {
      shape: 'ghost', ears: 'none', eyes: 'big', outline: 'rgba(90,100,140,0.35)',
      palette: {
        idle: { body: '#cfd8f0', cheek: '#b9c4e8' },
        happy: { body: '#d8e4ff', cheek: '#b0c8ff' },
        sleepy: { body: '#b8bed6', cheek: '#a8b0cc' },
        annoyed: { body: '#c0b0cc', cheek: '#a890b8' },
        curious: { body: '#dcdcf8', cheek: '#bcc0f0' },
        away: { body: '#c8c8d0', cheek: '#c0c0c8' },
      },
    },
  },
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const TAU = Math.PI * 2;

// Procedural motion curves: progress 0..1 -> transform. Sheet packs also get these
// applied on top of their frames when a curve exists for the action name, so an
// imported pack still has motion where it has no dedicated animation.
const CURVES = {
  nod: (p) => ({ dy: Math.sin(p * TAU * 2) * 0.10, rot: Math.sin(p * TAU * 2) * 0.05 }),
  shake: (p) => ({ dx: Math.sin(p * TAU * 2.5) * 0.12, rot: Math.sin(p * TAU * 2.5) * 0.06 }),
  jump: (p) => ({ dy: -Math.abs(Math.sin(p * Math.PI)) * 0.45, squash: 1 + Math.sin(p * Math.PI) * 0.12 }),
  wave: (p) => ({ rot: Math.sin(p * TAU * 2) * 0.16, dx: Math.sin(p * TAU * 2) * 0.05 }),
  stretch: (p) => ({ squash: 1 + Math.sin(p * Math.PI) * 0.3, dy: -Math.sin(p * Math.PI) * 0.08 }),
  sulk: (p) => ({ dy: Math.sin(p * Math.PI) * 0.18, squash: 1 - Math.sin(p * Math.PI) * 0.16 }),
  cheer: (p) => ({
    dy: -Math.abs(Math.sin(p * TAU)) * 0.32,
    rot: Math.sin(p * TAU * 3) * 0.1,
    squash: 1 + Math.abs(Math.sin(p * TAU)) * 0.08,
  }),
  peek: (p) => ({ dx: Math.sin(p * Math.PI) * 0.28, rot: Math.sin(p * Math.PI) * 0.08 }),
  tilt: (p) => ({ rot: Math.sin(p * Math.PI) * 0.26 }),
  spin: (p) => ({ rot: p * TAU, squash: 1 + Math.sin(p * Math.PI) * 0.06 }),
};

const ZERO = { dx: 0, dy: 0, rot: 0, squash: 1 };

function isSheetClip(def) {
  return typeof def?.sheet === 'string' && Number.isFinite(def?.frames) && def.frames > 0;
}

export function validatePack(pack) {
  const errors = [];
  if (!pack || typeof pack !== 'object') return ['pack 不是对象'];
  if (!pack.id) errors.push('缺少 id');
  if (!pack.name) errors.push('缺少 name');
  const renderer = pack.renderer ?? 'procedural';
  if (!['procedural', 'sheet'].includes(renderer)) {
    errors.push(`renderer 只能是 procedural 或 sheet，收到 ${renderer}`);
  }
  const states = pack.states ?? {};
  for (const s of STATE_NAMES) if (!(s in states)) errors.push(`states 缺少 ${s}`);

  if (renderer === 'sheet') {
    const cell = pack.cell;
    if (!cell || !(cell.w > 0) || !(cell.h > 0)) errors.push('sheet 包需要 cell:{w,h}');
    if (!(pack.columns > 0)) errors.push('sheet 包需要 columns > 0');
    for (const [name, def] of Object.entries(states)) {
      // `away` is allowed to render nothing at all.
      if (name === 'away' && def && Object.keys(def).length === 0) continue;
      if (!isSheetClip(def)) errors.push(`states.${name} 需要 {sheet, frames>0}`);
    }
    for (const [name, def] of Object.entries(pack.actions ?? {})) {
      if (!isSheetClip(def)) errors.push(`actions.${name} 需要 {sheet, frames>0}`);
    }
  }
  for (const [name, def] of Object.entries(pack.actions ?? {})) {
    const ms = def?.durationMs;
    if (ms != null && !(ms > 0)) errors.push(`actions.${name}.durationMs 必须是正数`);
  }
  // An alias pointing at a non-existent action would silently swallow that reaction,
  // which is exactly the kind of thing nobody notices until the demo.
  for (const [from, to] of Object.entries(pack.aliases ?? {})) {
    if (!(pack.actions ?? {})[to]) errors.push(`aliases.${from} 指向不存在的动作 ${to}`);
  }
  return errors;
}

function withFps(clips, defaultFps) {
  const out = {};
  for (const [name, def] of Object.entries(clips)) {
    out[name] = isSheetClip(def) ? { ...def, fps: def.fps ?? defaultFps } : def;
  }
  return out;
}

// Fills in durationMs for sheet clips from frames/fps, so a manifest only has to
// state the frame count that the sprite sheet actually contains.
function withDurations(actions, defaultFps) {
  const out = {};
  for (const [name, def] of Object.entries(actions)) {
    const fps = def.fps ?? defaultFps;
    const durationMs = def.durationMs
      ?? (isSheetClip(def) ? Math.round((def.frames / fps) * 1000) : 1000);
    out[name] = { ...def, fps, durationMs };
  }
  return out;
}

export function normalizePack(pack) {
  const errors = validatePack(pack);
  if (errors.length > 0) throw new Error(`角色包不合法:\n  - ${errors.join('\n  - ')}`);
  const renderer = pack.renderer ?? 'procedural';
  const fps = pack.fps ?? 60;
  const actions = Object.keys(pack.actions ?? {}).length > 0
    ? pack.actions
    : { ...BUILTIN_ACTIONS };
  const look = pack.look ?? {};
  return {
    ...DEFAULT_PACK,
    ...pack,
    renderer,
    fps,
    scale: pack.scale ?? 1,
    persona: pack.persona ?? '',
    aliases: pack.aliases ?? {},
    voice: { ...DEFAULT_PACK.voice, ...(pack.voice ?? {}) },
    look: { ...DEFAULT_LOOK, ...look, palette: { ...DEFAULT_LOOK.palette, ...(look.palette ?? {}) } },
    // States loop off the wall clock, so they need an fps but no duration; actions are
    // one-shots and need both.
    states: withFps({ ...(renderer === 'procedural' ? DEFAULT_PACK.states : {}), ...(pack.states ?? {}) }, fps),
    actions: withDurations(actions, fps),
  };
}

// One line per action, for the model prompt.
export function actionVocabulary(pack) {
  return Object.entries(pack.actions).map(([name, def]) => ({ name, desc: def.desc ?? name }));
}

export class ActionPlayer {
  constructor(pack) {
    this.setPack(pack);
  }

  setPack(pack) {
    this.pack = normalizePack(pack);
    this.state = 'away';
    this.action = null;
    this.actionStart = 0;
    this.actionEnd = 0;
    this.queue = [];
  }

  setState(name) {
    this.state = STATE_NAMES.includes(name) ? name : 'idle';
  }

  // The clip for a state, falling back to `idle` when the pack has nothing for it. Sprite
  // packs only ship the animations their source game had, so gaps are the normal case.
  stateClip(name) {
    const own = this.pack.states?.[name];
    if (isSheetClip(own) || this.pack.renderer !== 'sheet') return own ?? {};
    const idle = this.pack.states?.idle;
    return isSheetClip(idle) ? idle : (own ?? {});
  }

  // The fast loop asks for semantic names (nod / shake / peek …), but an imported pack
  // ships whatever the source game had (click / hover / intro …). `aliases` bridges
  // the two, so a pack with no `nod` still reacts when the user sits up straight.
  // Returns the pack's own action name, or null when nothing can serve the request.
  resolve(name) {
    if (this.pack.actions[name]) return name;
    const aliased = this.pack.aliases?.[name];
    return aliased && this.pack.actions[aliased] ? aliased : null;
  }

  // Unknown names are dropped rather than thrown: the model can hallucinate one and
  // a bad action must not take the pet down.
  playAction(requested, now, { queueIfBusy = false } = {}) {
    const name = this.resolve(requested);
    const def = name ? this.pack.actions[name] : null;
    if (!def) return false;
    if (this.action && now < this.actionEnd) {
      if (!queueIfBusy) return false;
      this.queue.push(name);
      return true;
    }
    this.action = name;
    this.actionStart = now;
    this.actionEnd = now + def.durationMs;
    return true;
  }

  get busy() {
    return this.action != null;
  }

  sample(now) {
    if (this.action && now >= this.actionEnd) {
      this.action = null;
      const next = this.queue.shift();
      if (next) this.playAction(next, now);
    }
    const progress = this.action
      ? clamp((now - this.actionStart) / Math.max(1, this.actionEnd - this.actionStart), 0, 1)
      : 0;

    let transform = ZERO;
    if (this.action && CURVES[this.action]) {
      transform = { ...ZERO, ...CURVES[this.action](progress) };
    }

    // A state with no drawable clip falls back to `idle`.
    //
    // This is not hypothetical: the Desktop_Gremlin packs have no "away" animation, so the
    // importer wrote `"away": {}`, and a sheet pack sitting in the away state therefore drew
    // nothing and degraded to the procedural grey body. Anyone who opened the page before
    // starting the camera picked an Arknights character and got a blob. Fixing it here rather
    // than in the five pack files means imported packs are covered too.
    const def = this.action
      ? this.pack.actions[this.action]
      : this.stateClip(this.state);

    let sprite = null;
    if (this.pack.renderer === 'sheet' && isSheetClip(def)) {
      const fps = def.fps ?? this.pack.fps;
      // One-shots march with progress so they always land on the final frame;
      // looping states run off the wall clock.
      const index = this.action
        ? Math.min(def.frames - 1, Math.floor(progress * def.frames))
        : Math.floor((now / 1000) * fps) % def.frames;
      sprite = {
        sheet: def.sheet,
        index,
        columns: this.pack.columns,
        cell: this.pack.cell,
        sx: (index % this.pack.columns) * this.pack.cell.w,
        sy: Math.floor(index / this.pack.columns) * this.pack.cell.h,
      };
    }

    return {
      state: this.state, action: this.action, progress, transform, sprite,
      renderer: this.pack.renderer, look: this.pack.look, scale: this.pack.scale,
    };
  }
}
