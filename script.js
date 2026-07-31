// The verb script the model emits, parsed and played. DOM-free and clock-injected, so
// the whole thing runs under node --test.
//
//     look cursor; walk 0.72,0.31; emote wave; wait 300; say "over here?"
//
// A string rather than JSON because it is a timed sequence and output tokens are the
// dominant term in the 1–3 s round trip. The schema enforcement JSON would have given is
// recovered here instead, which means this parser is the only thing standing between
// untrusted model text and a body that moves. Two rules follow from that:
//
//   TOTAL — every input returns a result. Truncated replies, prose, an empty string, a
//           wall of semicolons: none of them throw, because the fast loop must keep
//           running when the slow loop emits garbage.
//   NEVER GUESS — an unknown verb, a bad coordinate, an out-of-range duration or an
//           action name that does not exist is dropped and reported, never repaired into
//           something that acts. A plausible-looking default is worse than silence: it
//           executes, and nobody notices it was invented.
//
// Rejections are returned alongside the accepted steps rather than swallowed, because
// they are the only signal that the prompt and the parser have drifted apart.

// ------------------------------------------------------------------- bounds ----

// Every bound exists because this is untrusted output driving a body. Values are
// deliberately tight: the model can always be given a longer script later, but a body
// that performs for eleven days cannot be taken back.
export const SCRIPT_LIMITS = {
  // The reply is capped at ~120 output tokens (see BRAIN_DEFAULTS.maxTokens), which is
  // roughly 480 characters of English. 600 leaves headroom for a verbose turn while
  // bounding the work done on a blob of prose that happens to contain semicolons.
  maxScriptChars: 600,
  // A dozen beats is more than "look, walk over, wave, say something" needs. Beyond that
  // the pet is performing at the user instead of reacting to them, and the deliberate
  // tier only fires a few times an hour — it does not get to monologue.
  maxSteps: 12,
  // Longest whole performance. Past ~8 s the thing that triggered the script is no
  // longer what the user is doing, so the reaction has stopped being a reaction.
  maxTotalMs: 8000,
  // A single silent pause longer than this reads as a hang rather than as timing.
  maxWaitMs: 3000,
  // DESIGN.md's example lease is `take 3000`. The ceiling is higher but still short,
  // because a lease suspends reflex animations and liveness must never depend on the
  // health of the model that asked for it.
  maxTakeMs: 5000,
  // One spoken line, same figure as BRAIN_DEFAULTS.maxLineChars — deliberately mirrored
  // rather than imported, so this module keeps zero dependencies like triggers.js.
  maxSayChars: 90,
  // A grant naming more capabilities than exist is not a grant, it is a scattergun.
  maxGrantsPerStep: 4,
  // Estimated speaking time per character, used only to keep the next step from cutting
  // the line off mid-word (Voice.say cancels whatever is still being spoken). ~60 ms/char
  // is about 200 wpm. It is an estimate of a physical process, not of the model's intent.
  sayMsPerChar: 60,
  minSayMs: 500,
  // Fallback one-shot animation length when the vocabulary entry carries no duration;
  // matches the shortest BUILTIN_ACTIONS (nod / shake / tilt).
  defaultEmoteMs: 900,
};

// THE SAFETY INVARIANT OF THE WHOLE SYSTEM: no verb here performs an OS operation.
// `grant` only *arms* a capability — it writes a name into a set and nothing else. The
// spending of it is always a live human signal reaching the local grammar on voice
// partials (~40 ms), never the model. So a model mistake cannot click, scroll or close
// anything, and this parser has no code path that could make it possible.
//
// Tiers are by reversibility, which is the axis that decides what a false positive costs.
// `keys` and `close_window` ship not grantable: a false positive there costs unsaved
// work, and the gesture recogniser's false-positive rate on this machine has not been
// measured yet. That is one flag, not a refusal.
export const CAPABILITIES = {
  cursor: { tier: 'free', grantable: true, desc: 'move the mouse pointer' },
  scroll: { tier: 'reversible', grantable: true, desc: 'scroll the focused window' },
  click: { tier: 'reversible', grantable: true, desc: 'click where the pointer is' },
  keys: { tier: 'destructive', grantable: false, desc: 'send a key combination' },
  close_window: { tier: 'destructive', grantable: false, desc: 'close the focused window' },
};

// The allowlist. `grant` accepts nothing outside it, so a hallucinated capability name
// cannot even be armed, let alone spent.
export const GRANTABLE = Object.entries(CAPABILITIES)
  .filter(([, c]) => c.grantable)
  .map(([name]) => name);

// ------------------------------------------------------------------- verbs ----

// The single source of truth for what the DSL is. `describeVerbs()` renders this into the
// system prompt and `parseScript()` dispatches on it, so the prompt cannot describe a
// verb the parser does not accept — the failure mode a hand-maintained prompt list has.
export const VERBS = {
  say: { arg: '<text>', effect: 'speak one line (quotes optional)' },
  emote: { arg: '<action>', effect: 'one-shot animation from the pack vocabulary' },
  mood: { arg: '<state>', effect: 'set the lasting stance, kept until you change it' },
  snap: { arg: '', effect: 'take a fresh annotated camera frame and ask yourself again with it' },
  look: { arg: 'cursor | user | <x>,<y>', effect: 'aim head and eyes' },
  walk: { arg: '<x>,<y>', effect: 'walk to a screen point' },
  run: { arg: '<x>,<y>', effect: 'same, faster' },
  wait: { arg: '<ms>', effect: 'pause before the next step' },
  grant: { arg: '<cap>[,<cap>]', effect: 'ARM a capability — never uses it' },
  release: { arg: '', effect: 'hand the body back to reflex control' },
  take: { arg: '<ms>', effect: 'drive the body for that long, then it expires' },
};

export const VERB_NAMES = Object.keys(VERBS);

// The lasting states a script may set. Mirrors the character packs' state sheets minus
// `away`, which is presence — measured by the camera, never decided by the model. Kept
// as its own list (not imported from characters.js) so this module stays dependency-free.
export const MOODS = ['idle', 'happy', 'curious', 'sleepy', 'annoyed'];

export const SCRIPT_EXAMPLE = 'look cursor; walk 0.72,0.31; emote wave; wait 300; say "over here?"';

// ------------------------------------------------------------------ parsing ----

// Only double quotes group, and only for the split. An apostrophe never does, because
// `say don't worry about it` is ordinary speech and treating ' as a quote would swallow
// the rest of the script.
const OPEN_QUOTES = new Set(['"', '“', '”', '「', '」']);
const QUOTE_PAIRS = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['`', '`']];

// Steps are separated by ';' — and by newlines too, because a model asked for one line
// frequently answers with several.
function splitSteps(src) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of src) {
    if (OPEN_QUOTES.has(ch)) { quoted = !quoted; cur += ch; continue; }
    if (!quoted && (ch === ';' || ch === '\n' || ch === '\r')) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// C0/C1 controls would corrupt the log line and mean nothing to TTS. Everything else,
// including every non-Latin script and emoji, is left exactly as the model wrote it.
const stripControls = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();

const preview = (s) => stripControls(String(s)).slice(0, 80);

// Coordinates are fractions of the screen. Out of range is rejected rather than clamped:
// `walk 5,5` is not a request to walk to the corner, it is a malformed request, and
// clamping it would invent a destination the model never asked for.
function parsePoint(arg) {
  const m = /^(-?\d+(?:\.\d+)?|-?\.\d+)\s*,\s*(-?\d+(?:\.\d+)?|-?\.\d+)$/.exec(arg.trim());
  if (!m) return { reason: 'bad-coords' };
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { reason: 'bad-coords' };
  if (x < 0 || x > 1 || y < 0 || y > 1) return { reason: 'coords-out-of-range (0..1)' };
  return { point: { x, y } };
}

// Durations are integer milliseconds. Same discipline as coordinates: `wait 999999999`
// is dropped, not silently rewritten to the cap, because a model asking to wait eleven
// days is not asking for a three second pause and pretending otherwise hides the bug.
function parseMs(arg, max) {
  if (!/^\d+$/.test(arg.trim())) return { reason: 'bad-duration' };
  const ms = Number(arg.trim());
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > max) return { reason: `duration-out-of-range (1..${max}ms)` };
  return { ms };
}

// Text is the one argument that is truncated instead of rejected, and the difference is
// principled: a shortened sentence is still the sentence the model meant, while a
// shortened duration or coordinate would be a fabricated command. Matches what
// brain.js parseReply already does to the spoken line.
function parseText(raw, limits) {
  let text = raw.trim();
  const pair = QUOTE_PAIRS.find(([open]) => text.startsWith(open));
  if (pair) {
    const close = pair[1];
    const body = text.slice(1);
    // An unterminated quote almost always means the reply itself was cut off mid-word, so
    // the rest of the sentence does not exist. Half a sentence sounds broken out loud,
    // which is why this is the one place a `say` is dropped rather than shortened.
    if (body.length < 1 || !body.endsWith(close)) return { reason: 'unterminated-quote' };
    text = body.slice(0, -1);
  }
  text = stripControls(text);
  if (!text) return { reason: 'empty-text' };
  if (text.length > limits.maxSayChars) text = `${text.slice(0, limits.maxSayChars - 1)}…`;
  return { text };
}

// Vocabulary comes from characters.js actionVocabulary(): [{ name, desc }]. Plain strings
// are accepted too so callers can pass a bare name list.
function vocabIndex(vocabulary) {
  const byLower = new Map();
  for (const entry of Array.isArray(vocabulary) ? vocabulary : []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !name) continue;
    byLower.set(name.toLowerCase(), { name, durationMs: Number(entry?.durationMs) || 0 });
  }
  return byLower;
}

// How long a step occupies the body. Only wait, emote and say hold it: `walk` sets a
// tier-1 goal and the servo owns arrival, so nothing here can know how long walking
// takes — sequencing after a walk is what the explicit `wait` verb is for. Blocking on
// arrival instead would let one unreachable goal stall the whole script.
export function stepDurationMs(step, limits = SCRIPT_LIMITS) {
  if (!step) return 0;
  if (step.verb === 'wait') return step.ms;
  if (step.verb === 'emote') return step.durationMs || limits.defaultEmoteMs;
  if (step.verb === 'say') return Math.max(limits.minSayMs, Math.round(step.text.length * limits.sayMsPerChar));
  return 0;
}

// Returns { steps, rejected, totalMs }. Never throws, for any input, ever — that is the
// point of the module. `rejected` entries are { index, raw, reason } and exist to be
// logged: a reason appearing repeatedly is how a prompt problem gets noticed.
export function parseScript(text, {
  vocabulary = [],
  capabilities = GRANTABLE,
  limits = SCRIPT_LIMITS,
} = {}) {
  const steps = [];
  const rejected = [];
  let totalMs = 0;
  const lim = { ...SCRIPT_LIMITS, ...limits };
  const actions = vocabIndex(vocabulary);
  const allowed = new Set(Array.isArray(capabilities) ? capabilities : [...(capabilities ?? [])]);
  const drop = (index, raw, reason) => { rejected.push({ index, raw: preview(raw), reason }); };

  // Anything that is not a string is not a script. No coercion: String(someObject) would
  // produce "[object Object]" and then try to parse it.
  if (typeof text !== 'string' || text.trim() === '') {
    return { steps, rejected, totalMs };
  }

  let src = text;
  if (src.length > lim.maxScriptChars) {
    // Truncating rather than refusing the lot: the head of an over-long reply is usually
    // the real script, and the tail is where the model started rambling.
    drop(-1, src.slice(lim.maxScriptChars), `script-too-long (>${lim.maxScriptChars} chars)`);
    src = src.slice(0, lim.maxScriptChars);
  }

  const raws = splitSteps(src);
  for (let i = 0; i < raws.length; i += 1) {
    const raw = raws[i].trim();
    // Empty and whitespace-only steps are skipped in silence. A trailing ';' and a
    // doubled ';;' are punctuation, not problems, and logging them would bury the
    // rejections that actually mean something.
    if (raw === '') continue;

    if (steps.length >= lim.maxSteps) { drop(i, raw, `too-many-steps (max ${lim.maxSteps})`); continue; }

    const m = /^(\S+)\s*([\s\S]*)$/.exec(raw);
    // The verb is matched case-insensitively and a trailing ':' is tolerated, because
    // `Look: cursor` is unambiguously the `look` verb. Tolerating a spelling is not the
    // same as guessing an argument — the argument still has to validate on its own.
    const verb = (m?.[1] ?? '').toLowerCase().replace(/:$/, '');
    const arg = (m?.[2] ?? '').trim();
    if (!Object.prototype.hasOwnProperty.call(VERBS, verb)) {
      drop(i, raw, `unknown-verb (${preview(verb)})`);
      continue;
    }

    let step = null;
    switch (verb) {
      case 'say': {
        const r = parseText(arg, lim);
        if (r.reason) { drop(i, raw, r.reason); continue; }
        step = { verb, text: r.text };
        break;
      }
      case 'emote': {
        const hit = actions.get(arg.toLowerCase());
        // Case-insensitive resolution to the pack's own spelling is resolution, not
        // guessing: the name has to already exist in the vocabulary to match at all.
        if (!hit) { drop(i, raw, `unknown-action (${preview(arg) || 'none'})`); continue; }
        step = { verb, action: hit.name, durationMs: hit.durationMs };
        break;
      }
      case 'mood': {
        const state = arg.toLowerCase();
        if (!MOODS.includes(state)) { drop(i, raw, `unknown-mood (${preview(arg) || 'none'})`); continue; }
        step = { verb, state };
        break;
      }
      case 'snap':
        // Tool call, MCP-shaped: the model asks the harness to look. Trailing junk is
        // ignored the way `release` ignores it — asking to look is always safe.
        step = { verb };
        break;
      case 'look': {
        const target = arg.toLowerCase();
        if (target === 'cursor' || target === 'user') { step = { verb, target }; break; }
        const r = parsePoint(arg);
        if (r.reason) { drop(i, raw, `bad-look-target (${r.reason})`); continue; }
        step = { verb, target: 'point', ...r.point };
        break;
      }
      case 'walk':
      case 'run': {
        const r = parsePoint(arg);
        if (r.reason) { drop(i, raw, r.reason); continue; }
        step = { verb, gait: verb, ...r.point };
        break;
      }
      case 'wait': {
        const r = parseMs(arg, lim.maxWaitMs);
        if (r.reason) { drop(i, raw, r.reason); continue; }
        step = { verb, ms: r.ms };
        break;
      }
      case 'take': {
        const r = parseMs(arg, lim.maxTakeMs);
        if (r.reason) { drop(i, raw, r.reason); continue; }
        step = { verb, ms: r.ms };
        break;
      }
      case 'grant': {
        const names = arg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        // Unknown names are dropped individually and the valid ones still go through:
        // arming `click` is safe whatever else was on the line, and the bad name still
        // reaches the log, which is where it can be fixed.
        const caps = [];
        for (const n of names.slice(0, lim.maxGrantsPerStep)) {
          if (!allowed.has(n)) {
            drop(i, raw, CAPABILITIES[n] ? `capability-not-grantable (${n})` : `unknown-capability (${preview(n)})`);
            continue;
          }
          if (!caps.includes(n)) caps.push(n);
        }
        for (const n of names.slice(lim.maxGrantsPerStep)) {
          drop(i, raw, `too-many-capabilities (max ${lim.maxGrantsPerStep}, dropped ${preview(n)})`);
        }
        if (caps.length === 0) { if (names.length === 0) drop(i, raw, 'missing-capability'); continue; }
        step = { verb, caps };
        break;
      }
      case 'release':
        // Trailing junk is ignored rather than rejected. Handing the body back to reflex
        // control is always the safe direction, so a stray token must never be a reason
        // to keep the lease.
        step = { verb };
        break;
      default:
        // Unreachable while VERBS and this switch agree; the guard keeps them honest.
        drop(i, raw, `unimplemented-verb (${verb})`);
        continue;
    }

    const ms = stepDurationMs(step, lim);
    if (totalMs + ms > lim.maxTotalMs) {
      drop(i, raw, `exceeds-total-duration (max ${lim.maxTotalMs}ms)`);
      continue;
    }
    totalMs += ms;
    steps.push(step);
  }

  return { steps, rejected, totalMs };
}

// ------------------------------------------------------------------- prompt ----

// Renders the grammar for the system prompt out of the same tables the parser uses. This
// exists because a hand-written list in the prompt drifts: a verb gets renamed here, the
// prompt keeps advertising the old one, and the model's scripts start getting silently
// dropped with nobody the wiser.
export function describeVerbs({ vocabulary = [], capabilities = GRANTABLE, limits = SCRIPT_LIMITS } = {}) {
  const lim = { ...SCRIPT_LIMITS, ...limits };
  const names = [...vocabIndex(vocabulary).values()].map((a) => a.name);
  const caps = [...(Array.isArray(capabilities) ? capabilities : capabilities ?? [])];
  const pad = Math.max(...VERB_NAMES.map((v) => `${v} ${VERBS[v].arg}`.length));
  const detail = {
    say: `at most ${lim.maxSayChars} characters`,
    emote: names.length ? `one of: ${names.join(', ')}` : 'no actions available — do not use',
    mood: `one of: ${MOODS.join(', ')} — this is your resting face between scripts`,
    snap: 'use when they ask about something you need to SEE (what is this? how many fingers?) — you will be re-asked with a fresh frame, hand skeleton and finger states drawn on',
    look: 'x,y are fractions of the screen, 0..1',
    walk: 'x,y are fractions of the screen, 0..1',
    run: 'x,y are fractions of the screen, 0..1',
    wait: `1..${lim.maxWaitMs}`,
    grant: caps.length ? `one of: ${caps.join(', ')}` : 'nothing is grantable — do not use',
    take: `1..${lim.maxTakeMs}`,
    release: '',
  };
  const lines = VERB_NAMES.map((v) => {
    const sig = `${v} ${VERBS[v].arg}`.trim();
    const note = detail[v] ? ` (${detail[v]})` : '';
    return `- ${sig.padEnd(pad)}  ${VERBS[v].effect}${note}`;
  });
  return [
    'Body script: steps separated by ";", played in order.',
    ...lines,
    `At most ${lim.maxSteps} steps and ${lim.maxTotalMs} ms in total.`,
    'Every step is validated; anything not matching the grammar above is dropped, so do',
    'not invent verbs, action names or capabilities, and never write prose here.',
    `Example: ${SCRIPT_EXAMPLE}`,
  ].join('\n');
}

// ------------------------------------------------------------------- runner ----

// Plays accepted steps against an injected sink. Time comes in as a parameter the way
// triggers.js takes `t`, so there is no Date.now, no setTimeout and no DOM anywhere in
// here: the fast loop already ticks every frame and owns the clock.
//
// sink (all optional): { step(step, t), say(text), emote(name), look(target),
//                        move({ x, y, gait }), grant(caps), revoke(caps, reason),
//                        release(reason), take(ms) }
export class ScriptRunner {
  constructor(sink = {}, { limits = SCRIPT_LIMITS } = {}) {
    this.sink = sink ?? {};
    this.limits = { ...SCRIPT_LIMITS, ...limits };
    this.reset();
  }

  reset() {
    this.steps = [];
    this.index = 0;
    this.nextAt = 0;
    this.leaseUntil = 0;
    this.granted = new Set();
    // Bumped on every start and cancel. An async sink can compare it and notice that the
    // script it belonged to was abandoned while it was away.
    this.epoch = 0;
    this.lastReason = null;
    this.lastError = null;
    this.ran = 0;
  }

  get playing() {
    return this.index < this.steps.length;
  }

  leaseActive(t) {
    return this.leaseUntil > 0 && t < this.leaseUntil;
  }

  status(t = 0) {
    return {
      playing: this.playing,
      index: this.index,
      total: this.steps.length,
      lease: this.leaseActive(t) ? this.leaseUntil - t : 0,
      granted: [...this.granted],
      epoch: this.epoch,
      lastReason: this.lastReason,
      lastError: this.lastError,
    };
  }

  // A sink is page code; if it throws, the script must still advance and the fast loop
  // must not see the exception.
  emit(name, ...args) {
    try {
      this.sink[name]?.(...args);
      return true;
    } catch (e) {
      this.lastError = `${name}: ${String(e?.message ?? e)}`;
      return false;
    }
  }

  // Accepts a parseScript() result or a bare step array. Pre-empts whatever was playing:
  // a newer script always wins, because it was written about a newer situation.
  start(script, t) {
    const steps = Array.isArray(script) ? script : (script?.steps ?? []);
    // Also pre-empts a finished script that still holds a lease or an armed capability:
    // reflex owns the body between scripts, so every script has to ask for it again.
    if (this.playing || this.leaseUntil > 0 || this.granted.size > 0) this.cancel(t, 'preempted');
    else this.epoch += 1;
    this.steps = steps.slice();
    this.index = 0;
    this.nextAt = t;
    this.lastReason = null;
    return this.update(t);
  }

  // Abandons the remaining steps. Returns the body and disarms anything this script
  // armed: an abandoned performance must not leave a capability live with nobody
  // watching it, and must not hold a lease it is no longer using.
  cancel(t, reason = 'cancelled') {
    const had = this.playing || this.leaseUntil > 0 || this.granted.size > 0;
    this.steps = [];
    this.index = 0;
    this.epoch += 1;
    this.lastReason = reason;
    if (this.granted.size > 0) {
      const caps = [...this.granted];
      this.granted.clear();
      this.emit('revoke', caps, reason);
    }
    if (this.leaseUntil > 0) {
      this.leaseUntil = 0;
      this.emit('release', reason);
    }
    return had;
  }

  // Call every frame. Runs whatever is due, expires the lease, returns how many steps
  // ran this tick.
  update(t) {
    // Expiry first, and outside the playing check: the lease has to come back on its own
    // timer even if the script ended, or hung, or never had a second step. Liveness must
    // not depend on the health of the slowest component.
    if (this.leaseUntil > 0 && t >= this.leaseUntil) {
      this.leaseUntil = 0;
      this.lastReason = 'lease-expired';
      this.emit('release', 'lease-expired');
    }

    let ran = 0;
    while (this.playing && t >= this.nextAt) {
      const step = this.steps[this.index];
      this.index += 1;
      this.perform(step, t);
      ran += 1;
      this.ran += 1;
      // Measured from when the step actually ran, not from when it was due. After a
      // stalled frame that costs a little drift; the alternative dumps several
      // animations into one frame to catch up, which looks like a glitch.
      this.nextAt = t + stepDurationMs(step, this.limits);
    }
    return ran;
  }

  perform(step, t) {
    this.emit('step', step, t);
    switch (step.verb) {
      case 'say':
        this.emit('say', step.text);
        break;
      case 'emote':
        this.emit('emote', step.action);
        break;
      case 'mood':
        this.emit('mood', step.state);
        break;
      case 'snap':
        this.emit('snap');
        break;
      case 'look':
        this.emit('look', step.target === 'point' ? { x: step.x, y: step.y } : step.target);
        break;
      case 'walk':
      case 'run':
        // A goal, not a position: tier 1 decides how to get there, every frame.
        this.emit('move', { x: step.x, y: step.y, gait: step.gait });
        break;
      case 'wait':
        // Nothing to do — the delay is the effect, and update() already applied it.
        break;
      case 'grant':
        // Arming only. There is deliberately no code here, or anywhere in this file,
        // that can perform the capability being armed.
        for (const c of step.caps) this.granted.add(c);
        this.emit('grant', step.caps);
        break;
      case 'release':
        this.leaseUntil = 0;
        this.emit('release', 'script');
        break;
      case 'take':
        this.leaseUntil = t + step.ms;
        this.emit('take', step.ms);
        break;
      default:
        break;
    }
  }
}
