// Decides when something is worth reacting to. DOM-free and pure.
//
// Edge detection alone is not enough. It fires whenever a value changes, so a person who
// slouches, straightens, and slouches again gets told to sit up every time — and a
// person who simply *is* a sloucher gets told constantly, because every re-entry is a
// fresh edge. What matters is not "did this change" but "is this unusual for them".
//
// So each channel keeps a long history and a state only counts as news when it occupied
// a small share of that window. Slouch for two minutes and slouching becomes the norm;
// the pet stops mentioning it. Sit up after those two minutes and *that* is the news.
//
// Channels also move at different speeds on purpose. A hand gesture is deliberate
// communication and deserves a fast answer; posture and expression are closer to habits
// and get windows measured in minutes.

export const CHANNELS = {
  hand: {
    // Gestures are aimed at the pet, so they are answered quickly and are always news.
    cooldownMs: 2500,
    windowMs: 20000,
    noveltyMax: 1.01,
    triggers: ['gesture', 'handShape', 'wave', 'handNearFace'],
  },
  posture: {
    cooldownMs: 75000,
    windowMs: 240000,
    // React only if this posture held under a third of the last four minutes.
    noveltyMax: 0.34,
    triggers: ['slump', 'good'],
  },
  expression: {
    cooldownMs: 60000,
    windowMs: 180000,
    noveltyMax: 0.30,
    triggers: ['expression'],
  },
  fatigue: {
    cooldownMs: 180000,
    windowMs: 600000,
    noveltyMax: 0.40,
    triggers: ['sleepy'],
  },
  presence: {
    cooldownMs: 20000,
    windowMs: 120000,
    noveltyMax: 1.01,
    triggers: ['return'],
  },
};

export const TRIGGER_CHANNEL = Object.fromEntries(
  Object.entries(CHANNELS).flatMap(([name, c]) => c.triggers.map((t) => [t, name])),
);

// Nothing may fire within this of anything else. Guards against several channels
// happening to come due on the same frame.
export const GLOBAL_FLOOR_MS = 2000;

// Channels the *user* initiated. A gesture aimed at the pet is a question, and a question
// deserves an answer every time — rate-limiting those would make the pet feel deaf.
export const SOLICITED = new Set(['hand']);

// Everything else is the pet volunteering an opinion, and that has to be rare. Per-channel
// cooldowns alone do not bound the total: posture every 75 s plus expression every 60 s plus
// fatigue every 180 s is still ~140 unprompted remarks an hour, which is nothing like the
// "a few times an hour" the prompt claims. The claim has to be enforced somewhere, so it is
// enforced here rather than left to the model's discretion.
export const UNSOLICITED_BUDGET = { count: 4, windowMs: 600000 };

// Tracks, per channel, how long each distinct value has been observed inside the window.
export class NoveltyGate {
  constructor(channels = CHANNELS, {
    globalFloorMs = GLOBAL_FLOOR_MS,
    budget = UNSOLICITED_BUDGET,
    solicited = SOLICITED,
  } = {}) {
    this.channels = channels;
    this.globalFloorMs = globalFloorMs;
    this.budget = budget;
    this.solicited = solicited;
    this.reset();
  }

  reset() {
    this.history = new Map();   // channel -> [{ t, value }]
    this.lastFired = new Map(); // channel -> t
    this.lastAny = null;
    this.unsolicited = [];      // timestamps of volunteered remarks, for the budget
  }

  // How many volunteered remarks remain in the current window. Exposed so the UI can show
  // it: "the pet has gone quiet" should be legible as a budget, not read as a bug.
  budgetLeft(t) {
    const { count, windowMs } = this.budget;
    const live = this.unsolicited.filter((x) => t - x < windowMs).length;
    return Math.max(0, count - live);
  }

  config(channel) {
    return this.channels[channel] ?? CHANNELS.hand;
  }

  // Call every frame with the current value of each channel, including nulls: a channel
  // sitting at null is still occupying the window, which is what makes "back to normal"
  // become news again later.
  observe(channel, value, t) {
    const { windowMs } = this.config(channel);
    const list = this.history.get(channel) ?? [];
    const last = list[list.length - 1];
    if (!last || last.value !== value) list.push({ t, value });
    // Keep one sample before the window so the oldest span can be measured.
    let cut = 0;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].t < t - windowMs) cut = i; else break;
    }
    if (cut > 0) list.splice(0, cut);
    this.history.set(channel, list);
  }

  // Time this channel held `value`, as a fraction of the *whole* window — not of the
  // time observed so far. Dividing by elapsed time would make every state occupy 100% of
  // a fresh session, so nothing would ever be novel and the pet would never speak. With
  // the window as the denominator, early on everything is news (correct: it is meeting
  // this person) and a state has to accumulate real minutes before it becomes their norm.
  share(channel, value, t) {
    const { windowMs } = this.config(channel);
    const list = this.history.get(channel) ?? [];
    if (list.length === 0) return 0;
    const from = t - windowMs;
    let held = 0;
    for (let i = 0; i < list.length; i += 1) {
      const start = Math.max(list[i].t, from);
      const end = i + 1 < list.length ? list[i + 1].t : t;
      if (end <= from) continue;
      if (list[i].value === value) held += Math.max(0, end - start);
    }
    return Math.min(1, held / windowMs);
  }

  // Returns a reason string when the trigger should fire, else null. The reason is for
  // logging and for the prompt — the model is told *why* it was woken.
  admit(trigger, value, t) {
    const channel = TRIGGER_CHANNEL[trigger] ?? 'hand';
    const cfg = this.config(channel);
    if (this.lastAny != null && t - this.lastAny < this.globalFloorMs) return null;
    const since = this.lastFired.get(channel);
    if (since != null && t - since < cfg.cooldownMs) return null;
    const share = this.share(channel, value, t);
    if (share > cfg.noveltyMax) return null;

    // Volunteered remarks draw on a shared budget; answers to the user do not.
    const volunteered = !this.solicited.has(channel);
    if (volunteered) {
      this.unsolicited = this.unsolicited.filter((x) => t - x < this.budget.windowMs);
      if (this.unsolicited.length >= this.budget.count) return null;
      this.unsolicited.push(t);
    }

    this.lastFired.set(channel, t);
    this.lastAny = t;
    return { channel, share, volunteered, budgetLeft: this.budgetLeft(t) };
  }

  // What the model is told about how usual this is, so it can pitch the remark.
  describe(channel, value, t) {
    const share = this.share(channel, value, t);
    if (share >= 0.6) return 'this has been their usual state for a while';
    if (share >= 0.3) return 'they have been like this on and off';
    return 'this is new for them';
  }
}
