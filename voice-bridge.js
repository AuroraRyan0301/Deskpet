// Turns the voice sidecar's line protocol into intent-bus submissions and prompt material.
//
// This is the seam between two modules that are each correct on their own but do not quite
// meet. `VoiceGrammar` fires a command once per utterance, deliberately, so a revision storm
// cannot double-fire it. The `IntentBus` grants the `reversible` tier only after 200 ms of
// dwell — evidence that persisted rather than flickered. Put together naively, a spoken
// "scroll down" submits exactly once, never accumulates dwell, and silently never happens.
//
// So this layer supplies the missing notion: for a one-shot channel, persistence means *the
// utterance is still going*. A recognised command is held as live evidence and re-submitted
// while its utterance lasts, which is what the dwell requirement is actually asking about.
// Voice scroll therefore costs ~40 ms (partial lag) + 200 ms (dwell) ≈ 240 ms — slower than
// a gesture, and deliberately so, since the tier exists to make cheap-but-real operations
// require evidence rather than a syllable.
//
// DOM-free and clock-injected so it is testable in plain node, like triggers.js.

import { VoiceGrammar, isCommand, PARTIAL_CONFIDENCE } from './intents.js';

export const BRIDGE_DEFAULTS = {
  // How long a recognised command keeps being re-submitted as live evidence. Must exceed the
  // longest tier dwell (200 ms) with room for frame granularity, but stay short enough that
  // a phrase cannot keep voting long after the speaker moved on.
  sustainMs: 700,
  // Transcript kept for the model. Long enough to carry a short exchange, short enough that
  // the prompt does not turn into a chat log the model starts role-playing against.
  transcriptTurns: 6,
  // Conversation is driven by finals. A partial that merely *looks* conversational is not
  // worth waking a 1-3 s model for, and finals are the authoritative text anyway.
  speakOnPartial: false,
};

export class VoiceBridge {
  constructor(opt = {}) {
    this.opt = { ...BRIDGE_DEFAULTS, ...opt };
    this.grammar = new VoiceGrammar();
    this.reset();
  }

  reset() {
    this.grammar.reset();
    // The command currently being sustained, if any.
    this.live = null;
    this.transcript = [];
    this.lastPartial = '';
    this.ready = null;
    this.lastError = null;
    this.warmMs = null;
    this.level = null;
    this.running = false;
  }

  // Feed one parsed line from the sidecar. `t` is the host's clock, not the sidecar's: the
  // two are different monotonic origins, and every downstream deadline (dwell, fusion,
  // cooldowns) is expressed on the host's. The sidecar's `t` is kept only for measuring its
  // own lag.
  onLine(line, t) {
    if (!line || typeof line !== 'object') return { kind: 'ignored' };
    switch (line.type) {
      case 'ready':
        this.ready = line;
        this.running = true;
        this.lastError = null;
        return { kind: 'ready', ready: line };
      case 'warm':
        this.warmMs = line.ms;
        return { kind: 'warm', ms: line.ms };
      case 'level':
        this.level = { rms: line.rms ?? 0, peak: line.peak ?? 0, t };
        return { kind: 'level', level: this.level };
      case 'error':
        this.lastError = { code: line.code ?? null, message: line.message ?? 'voice error' };
        // An error does not stop the pet; voice simply becomes unavailable.
        if (line.code === 'not-built' || line.code === 'gave-up' || line.code === 'spawn-failed') {
          this.running = false;
        }
        return { kind: 'error', error: this.lastError };
      case 'stopped':
        this.running = false;
        this.live = null;
        return { kind: 'stopped' };
      case 'note':
        return { kind: 'note', message: line.message ?? '' };
      case 'partial':
        return this.#text(line.text ?? '', t, false);
      case 'final':
        return this.#text(line.text ?? '', t, true);
      default:
        return { kind: 'ignored' };
    }
  }

  #text(text, t, final) {
    if (final) this.lastPartial = '';
    else this.lastPartial = text;

    const result = final ? this.grammar.final(text, t) : this.grammar.partial(text, t);
    if (!result) return { kind: final ? 'final' : 'partial', text, submit: null, speak: null };

    if (isCommand(result)) {
      // Start sustaining. Confidence comes from the grammar, which rates a final higher than
      // a partial; the bus combines it with any corroborating channel.
      this.live = {
        intent: result.intent,
        confidence: result.confidence ?? PARTIAL_CONFIDENCE,
        args: result.args ?? {},
        utterance: result.utterance,
        until: t + this.opt.sustainMs,
        phrase: result.phrase,
      };
      return {
        kind: 'command',
        text,
        phrase: result.phrase,
        submit: this.#submission(t),
        speak: null,
      };
    }

    // Conversational. Recorded for the prompt so the pet answers what was actually said.
    const speakable = final || this.opt.speakOnPartial;
    if (speakable && text.trim()) {
      this.transcript.push({ t, text: text.trim(), intent: result.intent ?? null });
      if (this.transcript.length > this.opt.transcriptTurns) this.transcript.shift();
    }
    return {
      kind: 'conversation',
      text,
      intent: result.intent ?? null,
      submit: null,
      // Only a final asks the model to answer; a partial would wake it mid-sentence.
      speak: speakable ? { text: text.trim(), intent: result.intent ?? null, t } : null,
    };
  }

  // Called every frame. Returns a submission to re-post while a command is still live, or
  // null. Re-posting is how a one-shot utterance satisfies a dwell requirement.
  tick(t) {
    if (!this.live) return null;
    if (t > this.live.until) {
      this.live = null;
      return null;
    }
    return this.#submission(t);
  }

  // The bus itself deduplicates: once an intent fires, further submissions come back as
  // `absorbed`, so stopping the sustain on a fire is an optimisation rather than a
  // correctness requirement. Called by the host after a fire so the loop does no useless work.
  settled(intent) {
    if (this.live?.intent === intent) this.live = null;
  }

  #submission(t) {
    return {
      source: 'voice',
      intent: this.live.intent,
      confidence: this.live.confidence,
      args: this.live.args,
      t,
    };
  }

  // What the model is told the user said. Newest last, which is how a transcript reads.
  transcriptText() {
    return this.transcript.map((x) => x.text).join(' / ');
  }

  // Words fed to the recogniser as contextual bias. The command phrases plus the character's
  // name are the cheapest accuracy win available, and they have to be re-sent after a sidecar
  // restart, which is why the caller owns the list rather than the main process.
  static contextStrings(grammar, extra = []) {
    const phrases = grammar.flatMap((g) => g.phrases ?? []);
    return [...new Set([...phrases, ...extra])].filter(Boolean).slice(0, 200);
  }

  status() {
    return {
      running: this.running,
      ready: this.ready,
      warmMs: this.warmMs,
      error: this.lastError,
      level: this.level,
      live: this.live ? this.live.intent : null,
      transcript: this.transcript.length,
    };
  }
}
