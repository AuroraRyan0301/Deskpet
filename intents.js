// Intent recognition and arbitration: voice partials → intents, and one bus where
// gesture, voice and model evidence meet. DOM-free and pure — every entry point takes `t`
// from the caller — so the fusion and gating rules are unit-tested rather than eyeballed
// against a live camera and a live microphone.
//
// Two halves that only touch at the event shape:
//
//   grammar — matches spoken commands on ASR *partials* (median 7–39 ms, p90 68 ms on
//             this machine) rather than finals (0.4–3.4 s). Finals are hopelessly slow
//             for a command and exactly right for conversation, so the split is by result
//             type within one channel, not by channel.
//   bus     — normalises every source into one event, fuses agreeing channels, and gates
//             each intent by what a false positive costs.
//
// Nothing here performs an OS operation. It decides, reports why, and hands the decision
// back; the caller owns the sidecar.

// ================================================================== normalisation ====

// Recognisers hand back capitalised, punctuated, filler-laden text: "Um, scroll down a
// bit." Matching on a raw substring of that is how you get a grammar that works in the
// demo and not in the room.
const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'ah', 'eh', 'hmm', 'mm']);

// Apostrophes are dropped rather than kept as boundaries so "don't" survives as one
// token; every other non-alphanumeric run becomes whitespace.
export function tokenise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0 && !FILLERS.has(w));
}

// Whole-token runs, never substrings. A substring grammar fires "click" inside
// "unclickable" and "stop" inside "stopped", and the failure only shows up on real speech.
function findRun(tokens, phrase) {
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (tokens[i + j] !== phrase[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

// ======================================================================= grammar ====

// `route` is the load-bearing column. A command goes on the bus and may reach the OS; a
// conversation phrase is small talk aimed at the pet and must never be treated as
// control, however confidently it matched. "Hello" is not an instruction.
//
// `priority` exists for one case: cancel. "Stop" is a single token and would otherwise
// lose the longest-match tie-break to whatever longer phrase it was spoken over, which is
// precisely backwards — a person interrupting themselves means the interruption.
export const GRAMMAR = [
  {
    intent: 'cancel',
    route: 'command',
    priority: 2,
    phrases: ['stop', 'never mind', 'nevermind', 'forget it', 'cancel that', 'cancel'],
  },
  { intent: 'scroll_down', route: 'command', phrases: ['scroll down', 'page down'] },
  { intent: 'scroll_up', route: 'command', phrases: ['scroll up', 'page up'] },
  { intent: 'click', route: 'command', phrases: ['click that', 'click this', 'click there', 'click', 'tap that', 'tap'] },
  {
    intent: 'close_window',
    route: 'command',
    phrases: ['close this window', 'close the window', 'close that window', 'close this', 'close it'],
  },
  { intent: 'come_here', route: 'command', phrases: ['come over here', 'come here', 'over here'] },
  { intent: 'greeting', route: 'conversation', phrases: ['hello', 'hi', 'hi there', 'hey', 'hey there'] },
  { intent: 'good_morning', route: 'conversation', phrases: ['good morning'] },
];

// A partial with no update for this long means the speaker stopped, so whatever arrives
// next belongs to a different utterance. It has to be shorter than the 0.4–3.4 s a final
// takes, because waiting for the final's authoritative boundary would mean holding the
// fast path hostage to the slow one.
export const UTTERANCE_GAP_MS = 800;

// Second, independent guard against double-firing. Utterance tracking is a heuristic over
// a noisy stream; this is arithmetic. A revision storm for one phrase plays out in tens of
// milliseconds, while saying the same command twice on purpose takes most of a second, so
// a repeat inside this window is the recogniser, not the user.
export const COMMAND_REFRACTORY_MS = 700;

// Partials are provisional by construction, so a command matched on one is worth less than
// the same command on a settled final. Both are well clear of the bus's tier thresholds;
// the gap matters when a partial-matched intent fuses with a gesture.
export const PARTIAL_CONFIDENCE = 0.72;
export const FINAL_CONFIDENCE = 0.9;

// Longest match wins, cancel outranks length, and a later position outranks an earlier one
// — in a growing partial the rightmost phrase is the most recently spoken.
function preferred(a, b) {
  if (!b) return true;
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.length !== b.length) return a.length > b.length;
  return a.at > b.at;
}

export function matchGrammar(tokens, grammar = GRAMMAR) {
  let best = null;
  for (const entry of grammar) {
    for (const phrase of entry.phrases) {
      const p = tokenise(phrase);
      const at = findRun(tokens, p);
      if (at < 0) continue;
      const cand = {
        intent: entry.intent,
        route: entry.route,
        phrase,
        priority: entry.priority ?? 0,
        length: p.length,
        at,
      };
      if (preferred(cand, best)) best = cand;
    }
  }
  if (!best) return null;
  return { intent: best.intent, route: best.route, phrase: best.phrase };
}

// Matches commands on a stream of partials, at most once per utterance.
//
// The hard part is not the matching, it is the stream. A partial is revised token by
// token — "Sc" → "Scroll" → "Scroll down" → "Scroll down a bit." — so a matcher that
// simply tests each partial fires four times for one spoken command. Firing on the first
// match and suppressing the rest needs an utterance boundary, and the only boundary
// signals available are: an occasional final, silence, and the shape of the text itself.
//
// The third one is what makes this work. Streaming recognisers commit left to right: the
// leading words of an utterance stop moving almost immediately and revisions rewrite the
// tail. So the first word is the most stable fact about an utterance, and a partial whose
// first word disagrees with the one this utterance started under is not a revision — the
// recogniser has moved on to a new phrase. The first word is only trusted once a second
// token exists behind it, because until then it is itself half-typed ("Sc" → "Scroll").
export class VoiceGrammar {
  constructor({
    grammar = GRAMMAR,
    gapMs = UTTERANCE_GAP_MS,
    refractoryMs = COMMAND_REFRACTORY_MS,
    partialConfidence = PARTIAL_CONFIDENCE,
    finalConfidence = FINAL_CONFIDENCE,
  } = {}) {
    this.grammar = grammar;
    this.gapMs = gapMs;
    this.refractoryMs = refractoryMs;
    this.partialConfidence = partialConfidence;
    this.finalConfidence = finalConfidence;
    this.reset();
  }

  reset() {
    this.utterance = 0;
    this.head = null;          // first committed token of the current utterance
    this.lastT = null;
    this.lastText = '';
    this.firedCommands = new Set();
    this.firedTopics = new Set();
    this.cancelled = false;
    this.lastFired = new Map(); // intent -> t, survives utterance boundaries on purpose
  }

  // Bumping the id is the whole of "start a new utterance": the per-utterance fired sets
  // are what suppress revision storms, so clearing them is the only state that matters.
  #nextUtterance() {
    this.utterance += 1;
    this.head = null;
    this.firedCommands.clear();
    this.firedTopics.clear();
    this.cancelled = false;
  }

  #boundary(tokens, t) {
    if (this.lastT == null) return;
    if (t - this.lastT > this.gapMs) { this.#nextUtterance(); return; }
    // An empty partial is how several recognisers announce that they have reset their
    // hypothesis. Treat it as a boundary and nothing else.
    if (tokens.length === 0) { this.#nextUtterance(); return; }
    if (this.head !== null && tokens[0] !== this.head) this.#nextUtterance();
  }

  // Returns null, a command result, or a conversation result. A command result is already
  // in bus shape and can be handed straight to IntentBus.submit().
  partial(text, t) {
    const tokens = tokenise(text);
    this.#boundary(tokens, t);
    this.lastT = t;
    this.lastText = String(text ?? '');
    if (tokens.length === 0) return null;
    if (this.head === null && tokens.length >= 2) this.head = tokens[0];

    const m = matchGrammar(tokens, this.grammar);
    if (!m) return null;

    if (m.route === 'conversation') {
      if (this.firedTopics.has(m.intent)) return null;
      this.firedTopics.add(m.intent);
      // Social phrases are reported for what they are and stop here. Being answered in
      // 40 ms would make the pet a reflex arc rather than company; the model gets this on
      // the final, at conversational pace.
      return {
        route: 'conversation', intent: m.intent, phrase: m.phrase,
        text: this.lastText.trim(), utterance: this.utterance, t, final: false,
      };
    }

    // Once the speaker has cancelled inside this utterance, nothing later in the same
    // breath is a command. "Stop, close this window" is a person stopping.
    if (this.cancelled && m.intent !== 'cancel') return null;
    if (this.firedCommands.has(m.intent)) return null;
    const last = this.lastFired.get(m.intent);
    if (last != null && t - last < this.refractoryMs) return null;

    this.firedCommands.add(m.intent);
    this.lastFired.set(m.intent, t);
    if (m.intent === 'cancel') this.cancelled = true;
    return {
      route: 'command', source: 'voice', intent: m.intent, confidence: this.partialConfidence,
      args: {}, t, phrase: m.phrase, utterance: this.utterance, text: this.lastText.trim(),
      final: false, late: false,
    };
  }

  // A final always carries conversation text — that is what joins the prompt. It also
  // closes the utterance, which is the one authoritative boundary the recogniser gives us.
  //
  // It can additionally carry a *late* command, for the case where the phrase only became
  // recognisable after the recogniser revised itself ("scroll doubt" → "scroll down"). A
  // second or two late is bad for a command, but it is not worse than never, and the
  // per-utterance and refractory guards make a duplicate impossible.
  final(text, t) {
    const tokens = tokenise(text);
    const clean = String(text ?? '').trim();
    const utterance = this.utterance;
    const m = tokens.length > 0 ? matchGrammar(tokens, this.grammar) : null;
    let out;
    if (m && m.route === 'command' && !this.cancelled
        && !this.firedCommands.has(m.intent)
        && !(this.lastFired.get(m.intent) != null && t - this.lastFired.get(m.intent) < this.refractoryMs)) {
      this.lastFired.set(m.intent, t);
      out = {
        route: 'command', source: 'voice', intent: m.intent, confidence: this.finalConfidence,
        args: {}, t, phrase: m.phrase, utterance, text: clean, final: true, late: true,
      };
    } else {
      out = {
        route: 'conversation', intent: m && m.route === 'conversation' ? m.intent : null,
        phrase: m?.phrase ?? null, text: clean, utterance, t, final: true,
      };
    }
    this.#nextUtterance();
    this.lastT = t;
    this.lastText = clean;
    return out;
  }
}

export const isCommand = (result) => Boolean(result) && result.route === 'command';

// =================================================================== the bus =======

// Every source normalises to { source, intent, confidence, args, t }. Fusion happens at
// the intent, not at the recogniser — a hand and a voice have nothing comparable at the
// feature level and everything comparable here.
export const SOURCES = ['gesture', 'voice', 'model'];

// The gate a tier applies, chosen by what a false positive costs — reversibility, not
// difficulty. Exported so the arming UI can render the table it is enforcing instead of
// duplicating it.
export const TIERS = {
  free: {
    desc: 'cursor move, character motion, look — nothing to undo',
    dwellMs: 0,
    needsConfirmation: false,
    needsArmed: false,
    enabledByDefault: true,
  },
  reversible: {
    desc: 'scroll, click — cheap and undoable, single channel plus dwell',
    // ~6 camera frames. Long enough that one mis-classified frame cannot spend it, short
    // enough to stay under the ~250 ms where a delay stops feeling instantaneous.
    dwellMs: 200,
    needsConfirmation: false,
    needsArmed: false,
    enabledByDefault: true,
  },
  destructive: {
    desc: 'close window, key combos — a false positive costs unsaved work',
    dwellMs: 0,
    needsConfirmation: true,
    needsArmed: true,
    // Ships off. The gesture recogniser's false-positive rate on this machine has not
    // been characterised, and until it has, this is a default rather than a refusal.
    enabledByDefault: false,
  },
};

export const INTENT_TIERS = {
  move_up: 'free', move_down: 'free', move_left: 'free', move_right: 'free',
  // free
  cursor_move: 'free',
  look: 'free',
  walk: 'free',
  come_here: 'free',
  emote: 'free',
  greeting: 'free',
  good_morning: 'free',
  cancel: 'free',
  // cheap and reversible
  scroll_up: 'reversible',
  scroll_down: 'reversible',
  click: 'reversible',
  // destructive
  close_window: 'destructive',
  key_combo: 'destructive',
};

// Orthogonal to tier: `cursor_move` is free but touches the machine, `come_here` is not
// free of consequence but only moves a sprite. The kill switch keys on this axis, because
// what it promises is "nothing reaches the OS", not "nothing happens".
export const OS_INTENTS = new Set(['cursor_move', 'scroll_up', 'scroll_down', 'click', 'close_window', 'key_combo']);

// Deixis: the voice carries the verb, the hand carries the argument. "Click that" is
// underspecified in language and overspecified in pointing; together they are exactly
// right. This is Bolt's *Put-that-there* (SIGGRAPH 1980) with a bare hand in place of the
// magnetic wand — worse resolution, unchanged structure.
export const REQUIRED_ARGS = {
  click: ['point'],
  cursor_move: ['point'],
};

// A pointer older than this is not "that". The hand keeps pointing while the words come
// out, so a fresh point is the normal case; resolving "that" to wherever the finger was a
// second ago is worse than refusing and saying why.
export const POINTER_TTL_MS = 600;

// The ≈60 ms visuo-tactile simultaneity window from the 04/30 lecture is the principled
// floor: inside it, two signals are one perceptual event, so a spoken command and a hand
// command are evidence about one intent rather than two things to sequence.
//
// 60 ms is the *perceptual* window though, and what we observe is arrival times after two
// pipelines of different length — 30–75 ms for camera → landmarks, 7–68 ms for voice
// partials. Two signals produced in the same perceptual instant can therefore arrive up to
// ~60 ms apart purely from pipeline skew, so budgeting only 60 ms would reject genuine
// simultaneity about half the time. 120 ms = 60 ms perceptual + 60 ms measured skew, and
// it stays well under the ~200 ms at which people begin to perceive order rather than
// simultaneity — so the window is generous without becoming a claim we cannot defend.
export const FUSION_WINDOW_MS = 120;

// How long a run of assertions survives a gap before it counts as a new run. The vision
// loop delivers every ~33 ms and voice partials every ~40 ms, so 400 ms absorbs a dozen
// dropped frames without mistaking a held gesture for a released one.
export const DWELL_CONTINUITY_MS = 400;

// Default for `grant` when the model does not say. Long enough to say a phrase and raise a
// hand, short enough that a forgotten grant lapses on its own.
export const ARM_WINDOW_MS = 5000;

export const tierOf = (intent) => INTENT_TIERS[intent] ?? null;
export const touchesOS = (intent) => OS_INTENTS.has(intent);

// Independent evidence, combined as a noisy-or rather than averaged or maxed. Averaging
// would let a confident channel be dragged down by a hesitant one, and max would ignore
// the second channel entirely — but agreement is the whole point, so the combination has
// to be strictly greater than either input. Capped short of 1: nothing here is certain.
const fuseConfidence = (a, b) => Math.min(0.99, 1 - (1 - a) * (1 - b));

const listSources = (set) => [...set].sort().join(' + ');

export class IntentBus {
  constructor({
    fusionWindowMs = FUSION_WINDOW_MS,
    dwellContinuityMs = DWELL_CONTINUITY_MS,
    pointerTtlMs = POINTER_TTL_MS,
    tiers = TIERS,
    intentTiers = INTENT_TIERS,
    historyMax = 64,
  } = {}) {
    this.fusionWindowMs = fusionWindowMs;
    this.dwellContinuityMs = dwellContinuityMs;
    this.pointerTtlMs = pointerTtlMs;
    this.tiers = tiers;
    this.intentTiers = intentTiers;
    this.historyMax = historyMax;
    this.killed = false;
    this.killReason = null;
    this.enabled = new Set(
      Object.keys(intentTiers).filter((i) => tiers[intentTiers[i]]?.enabledByDefault !== false),
    );
    this.reset();
  }

  // Clears evidence, never permissions. A reset that released the kill switch or
  // re-armed a capability would make the kill switch a suggestion.
  reset() {
    this.runs = new Map();      // intent -> { first, last, sources: Map, fired: event|null }
    this.armedUntil = new Map();
    this.pointer = null;
    this.history = [];
  }

  // ---- host-only controls. Deliberately not reachable from submit(): a bus event is
  // whatever the recognisers thought they heard, and no amount of that may hand itself
  // more authority than it already has.

  engageKill(reason = 'kill switch engaged') {
    this.killed = true;
    this.killReason = reason;
    // Arming does not survive the kill switch. Coming back from a panic stop into a
    // still-armed destructive capability is exactly the wrong resting state.
    this.armedUntil.clear();
  }

  releaseKill() {
    this.killed = false;
    this.killReason = null;
  }

  enable(intent) { this.enabled.add(intent); }

  disable(intent) { this.enabled.delete(intent); }

  isEnabled(intent) { return this.enabled.has(intent); }

  // DESIGN's `grant` verb: arms a capability, never spends one. Claude may reach this;
  // only a live human signal can spend what it arms.
  arm(intents, ms = ARM_WINDOW_MS, t = 0) {
    for (const i of [].concat(intents)) this.armedUntil.set(i, t + ms);
  }

  disarm(intents = null) {
    if (intents == null) { this.armedUntil.clear(); return; }
    for (const i of [].concat(intents)) this.armedUntil.delete(i);
  }

  armed(intent, t) {
    const until = this.armedUntil.get(intent);
    return until != null && t < until;
  }

  // Anything armed must be visible, never silent — this is what the indicator reads.
  armedList(t) {
    return [...this.armedUntil.entries()].filter(([, until]) => t < until).map(([i]) => i);
  }

  // The hand's contribution to deixis. Supplied by the caller because the homography and
  // the one-euro filter live in tier 1, not here.
  setPointer(point, t) {
    this.pointer = point == null ? null : { x: point.x, y: point.y, t };
  }

  pointerAt(t) {
    if (!this.pointer) return null;
    if (t - this.pointer.t > this.pointerTtlMs) return null;
    return { x: this.pointer.x, y: this.pointer.y };
  }

  #record(decision) {
    this.history.push(decision);
    if (this.history.length > this.historyMax) this.history.shift();
    return decision;
  }

  #withheld(ev, code, reason) {
    return this.#record({
      status: 'withheld', intent: ev.intent, source: ev.source, t: ev.t,
      tier: tierOf(ev.intent), code, reason,
    });
  }

  // Accumulates assertions per intent so dwell and agreement can be read off one record.
  #run(ev) {
    const prev = this.runs.get(ev.intent);
    const seen = { t: ev.t, confidence: ev.confidence };
    if (!prev || ev.t - prev.last > this.dwellContinuityMs) {
      const run = { first: ev.t, last: ev.t, sources: new Map([[ev.source, seen]]), fired: null };
      this.runs.set(ev.intent, run);
      return run;
    }
    prev.last = ev.t;
    prev.sources.set(ev.source, seen);
    return prev;
  }

  // Only sources that spoke inside the fusion window count as agreeing *now*. A gesture
  // from 300 ms ago is part of the same run for dwell purposes and is not simultaneous.
  #agreeing(run, t) {
    const out = new Map();
    for (const [source, seen] of run.sources) {
      if (t - seen.t <= this.fusionWindowMs) out.set(source, seen.confidence);
    }
    return out;
  }

  // Returns a decision: { status: 'fired' | 'absorbed' | 'withheld', ... }.
  //
  // 'absorbed' is agreement arriving after the intent already fired. It does not emit a
  // second event — it upgrades the one already emitted, in place, and hands the same
  // object back so the indicator can show it as multi-channel confirmed. Buffering for
  // the fusion window before emitting would produce a tidier data flow and would also add
  // 120 ms to every command on the fast path, which is the one thing this tier exists to
  // avoid. Latency wins; the mutation is the price.
  submit(raw) {
    const ev = {
      source: raw?.source ?? 'unknown',
      intent: raw?.intent,
      confidence: typeof raw?.confidence === 'number' ? raw.confidence : 0.6,
      args: { ...(raw?.args ?? {}) },
      t: raw?.t ?? 0,
    };

    const tier = tierOf(ev.intent);
    if (!tier) {
      return this.#withheld(ev, 'unknown_intent',
        `unknown intent "${ev.intent}": not in the capability table, so it has no gate and cannot run`);
    }
    const cfg = this.tiers[tier];

    // Checked before anything else for OS intents, because "the kill switch is on" is the
    // only reason the user needs to hear. Expressive intents keep flowing: the promise is
    // that nothing reaches the machine, not that the pet freezes.
    if (this.killed && touchesOS(ev.intent)) {
      return this.#withheld(ev, 'kill_switch',
        `${this.killReason}: ${ev.intent} would reach the OS, so it is withheld until the host releases the kill switch`);
    }

    // Recorded before the gates so a withheld assertion still accumulates dwell and can
    // still be corroborated — otherwise a destructive intent could never become confirmed,
    // since its first channel is always refused.
    const run = this.#run(ev);
    const agreeing = this.#agreeing(run, ev.t);
    const confirmed = agreeing.size >= 2;

    if (run.fired) {
      if (confirmed && !run.fired.confirmed) {
        run.fired.confidence = fuseConfidence(run.fired.confidence, ev.confidence);
        run.fired.confirmed = true;
        run.fired.sources = [...agreeing.keys()].sort();
      } else if (!run.fired.sources.includes(ev.source)) {
        run.fired.sources = [...new Set([...run.fired.sources, ev.source])].sort();
      }
      return this.#record({
        status: 'absorbed', intent: ev.intent, source: ev.source, t: ev.t, tier,
        event: run.fired,
        reason: `${ev.intent} already fired in this run; ${ev.source} corroborates it rather than repeating it`,
      });
    }

    const missing = (REQUIRED_ARGS[ev.intent] ?? []).filter((k) => ev.args[k] == null);
    for (const key of missing) {
      if (key !== 'point') continue;
      const p = this.pointerAt(ev.t);
      if (p) { ev.args.point = p; ev.args.pointFrom = 'pointer'; }
    }
    const stillMissing = (REQUIRED_ARGS[ev.intent] ?? []).filter((k) => ev.args[k] == null);
    if (stillMissing.length > 0) {
      return this.#withheld(ev, 'missing_arg',
        `${ev.intent} needs ${stillMissing.join(', ')} and nothing is pointing at anything — the words say what to do but not where`);
    }

    if (!this.isEnabled(ev.intent)) {
      return this.#withheld(ev, 'disabled',
        `${ev.intent} is switched off by default because a false positive is not undoable; enable it in settings first`);
    }

    if (cfg.needsArmed && !this.armed(ev.intent, ev.t)) {
      return this.#withheld(ev, 'not_armed',
        `${ev.intent} is only allowed inside an armed window and nothing is armed right now`);
    }

    if (cfg.needsConfirmation && !confirmed) {
      return this.#withheld(ev, 'needs_confirmation',
        `${ev.intent} needs two channels agreeing within ${this.fusionWindowMs} ms and only ${listSources(agreeing.keys()) || 'nothing'} asserted it`);
    }

    // Agreement substitutes for dwell. Dwell buys time to see whether one channel meant
    // it; a second channel saying the same thing in the same perceptual instant is
    // stronger evidence than any amount of waiting on one channel, and it is evidence the
    // user produced deliberately.
    const held = ev.t - run.first;
    if (cfg.dwellMs > 0 && !confirmed && held < cfg.dwellMs) {
      return this.#withheld(ev, 'needs_dwell',
        `${ev.intent} needs ${cfg.dwellMs} ms of dwell or a second channel; held ${held} ms so far`);
    }

    const event = {
      source: ev.source,
      sources: confirmed ? [...agreeing.keys()].sort() : [ev.source],
      intent: ev.intent,
      confidence: confirmed
        ? [...agreeing.values()].reduce((acc, c) => fuseConfidence(acc, c))
        : ev.confidence,
      args: ev.args,
      t: ev.t,
      tier,
      confirmed,
      touchesOS: touchesOS(ev.intent),
    };
    run.fired = event;
    return this.#record({ status: 'fired', intent: ev.intent, source: ev.source, t: ev.t, tier, event });
  }
}

// =============================================================== gesture mapping ====

// Hand shape → intent. The keys are the names `classifyHand` in perception.js actually
// returns (camelCase for the combos, `point_<dir>` for pointing) — not a parallel
// vocabulary that would drift out of sync the first time a shape is renamed.
export const GESTURE_INTENTS = {
  point_up: 'scroll_up',
  point_down: 'scroll_down',
  point_left: 'cursor_move',
  point_right: 'cursor_move',
  pinch: 'click',
  fist: 'close_window',
  openPalm: 'cancel',
};

// Shapes arrive every frame while the hand is held, which is exactly what the reversible
// tier's dwell requirement is measured against — so this is called per frame, not on an
// edge, and the bus decides when enough is enough.
export function gestureIntent(shape, t, { confidence = 0.7, args = {} } = {}) {
  const intent = GESTURE_INTENTS[shape];
  if (!intent) return null;
  return { source: 'gesture', intent, confidence, args: { ...args }, t };
}
