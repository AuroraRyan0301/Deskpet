// The slow loop: one frame + the fast loop's readings -> one spoken line plus one
// action drawn from the character pack's declared vocabulary.
//
// DOM-free; fetch, clock and storage are injected, so all of the guard logic and
// reply parsing is unit-tested rather than merely plausible.
//
// PRIVACY: enabling this sends webcam frames to whatever endpoint is configured.
// With GPT_API_free that is a third-party relay in front of OpenAI — the fast loop's
// "数据不出本机" property does NOT hold once this is on. The fast loop never calls it.

import { adapterFor, PROVIDERS } from './providers.js';
import { parseScript, describeVerbs } from './script.js';

export const BRAIN_DEFAULTS = {
  provider: 'openai',
  // Requests go through the local server rather than straight out of the page: neither
  // api.anthropic.com nor sub2api sends CORS headers, so a direct call is blocked at
  // the preflight. Set to null to call the endpoint directly (node/tests).
  proxyPath: '/_llm',
  endpoint: 'https://api.chatanywhere.tech/v1/chat/completions',
  model: 'gpt-4o-mini',
  apiKey: '',
  // GPT_API_free's free tier is 100 requests/day for gpt-4o-mini (5/day for gpt-4o).
  // At the slow loop's 4 s floor that budget is gone in about seven minutes, so the
  // guard is not optional — without it the pet dies mid-demo.
  dailyQuota: 100,
  // A verb script runs longer than the single line the old protocol carried.
  maxTokens: 220,
  timeoutMs: 12000,
  // English needs more room per line than the Chinese original did.
  maxLineChars: 90,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// A day key in local time. Not UTC: the quota should roll over at the user's midnight.
export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class QuotaGuard {
  // store: { get(k), set(k, v) } — localStorage satisfies this.
  constructor({ store, key = 'deskpet.quota', quota = BRAIN_DEFAULTS.dailyQuota } = {}) {
    this.store = store ?? new Map([]);
    this.key = key;
    this.quota = quota;
    if (this.store instanceof Map) {
      const m = this.store;
      this.store = { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
    }
  }

  read(now) {
    let rec = null;
    try { rec = JSON.parse(this.store.get(this.key) ?? 'null'); } catch { rec = null; }
    const today = dayKey(now);
    if (!rec || rec.day !== today) return { day: today, count: 0 };
    return { day: today, count: Number(rec.count) || 0 };
  }

  remaining(now) {
    return Math.max(0, this.quota - this.read(now).count);
  }

  allow(now) {
    return this.remaining(now) > 0;
  }

  spend(now, n = 1) {
    const rec = this.read(now);
    rec.count += n;
    this.store.set(this.key, JSON.stringify(rec));
    return this.quota - rec.count;
  }
}

// The prompt. Two things make it work: the readings are given as words plus numbers
// (the model is bad at raw floats alone), and the action list is generated from the
// pack, so a pack that adds an action immediately becomes able to use it.
export const PERSONA_DEFAULT = 'Warm, a little sardonic. Fond of this person without being sappy about it.';

// What the pet is told about the situation it is in. Written out longhand because a
// model given only sensor numbers writes like a monitoring dashboard — "posture
// deviation elevated" — and the whole point is that it sounds like someone who is in
// the room with you.
const SCENARIO = [
  'You are a small character living on the corner of someone\'s screen while they work.',
  'A webcam watches them; a fast on-device tracker turns that into the readings below.',
  'You are not an assistant and you are not a health app. You are company.',
  'You speak rarely — a few times an hour — so when you do speak it should be worth hearing.',
  'Saying nothing is a normal outcome, not a failure.',
].join(' ');

const VOICE = [
  'Write one line of natural spoken English, the way a friend sitting nearby would say it.',
  'Contractions, sentence fragments, and dry humour are all fine.',
  'Never narrate the sensors. "Your posture has degraded" is wrong; "you\'re folding in half" is right.',
  'No stage directions, no emoji, no quotation marks, no "I notice" or "I see that".',
  'Do not greet them or use their name. You are already in the middle of the day with them.',
];

export function buildPrompt({
  state, vocabulary, persona, policy, trigger, marks,
  habit = null, heard = null, maxLineChars = BRAIN_DEFAULTS.maxLineChars,
}) {
  const s = state ?? {};
  const pct = (v) => `${Math.round(clamp(Number(v) || 0, -1, 1) * 100)}%`;
  const readings = [
    `slouch ${pct(s.slump)} (positive = sinking down, negative = sitting tall)`,
    `lean ${(Number(s.leanRatio) || 1).toFixed(2)}x (above 1.18 = face close to the screen)`,
    `gaze ${s.attention ? 'on the screen' : 'turned away'}`,
    `blink rate ${Math.round(Number(s.blinkRate) || 0)}/min (above 26 suggests tiredness)`,
    `yawns so far ${Number(s.yawnCount) || 0}`,
    `energy ${Math.round(Number(s.energy) || 0)}/100`,
    s.expression ? `face reads as ${s.expression}` : null,
    // Per-finger states rather than a classified shape name. The classifier ("ok",
    // "gun", "callMe"…) is the least reliable stage of the hand pipeline, and feeding
    // its guess to the model just launders a guess into a fact. Which fingers are up is
    // read almost directly off the landmarks, and the model can see the skeleton drawn
    // on the frame anyway — let it do its own interpreting from honest inputs.
    Array.isArray(s.fingersUp) && s.handCount > 0
      ? `fingers extended: ${s.fingersUp.length ? s.fingersUp.join(', ') : 'none (closed hand)'}`
      : null,
    s.handCount > 1 ? 'both hands are in frame' : null,
    s.waving ? 'they are waving at you' : null,
    s.handNearFace ? 'a hand is up near their face' : null,
  ].filter(Boolean);

  const policyLine = {
    honest: 'Say what you actually see. If they should sit up or take a break, say so — once, plainly, then let it go.',
    flatter: 'Be relentlessly encouraging whatever you see. Never criticise, never nag.',
    ignore: 'Do not speak at all this turn — no say steps. React with mood and emote only.',
  }[policy] ?? 'Say what you actually see.';

  // Rendered from the parser's own tables, so the prompt cannot describe a verb the
  // parser will not accept. This is the MCP-shaped seam: the model emits commands, a
  // local total parser validates them, and the local system executes — the model never
  // touches the puppet directly.
  const protocol = describeVerbs({ vocabulary });

  // Why the pet was woken. Only these events reach the model — a state that simply
  // continues never gets here, which is what stops it repeating itself.
  const TRIGGER_TEXT = {
    slump: 'they just sank down in their chair',
    good: 'they just straightened up',
    sleepy: 'they just yawned, or their blinking sped up',
    return: 'they stepped away for a bit and have just come back',
    gesture: 'they just made a hand gesture at you',
    periodic: 'nothing in particular happened, some time has just gone by',
    said: 'they said something to you out loud',
    posture: 'their posture shifted',
    expression: 'their expression changed',
    handShape: 'they changed hand shape',
    wave: 'they are waving at you',
    handNearFace: 'they just put a hand up to their face',
    snap: 'you asked to look — here is the fresh annotated frame you requested, plus the readings',
  };
  const why = TRIGGER_TEXT[trigger] ?? null;

  return {
    system: [
      SCENARIO,
      persona ? `Your personality: ${persona}` : `Your personality: ${PERSONA_DEFAULT}`,
      '',
      'You are woken only when something changes that is unusual for this person — you do',
      'not see every frame. So treat what you are told as genuinely new, and never say the',
      'same thing twice in different words.',
      '',
      'Sometimes you are told what they said out loud. Answer that — a person who spoke to',
      'you and got a remark about their posture instead has been ignored. You hear them',
      'through a microphone and it mishears things, so if a line reads as nonsense, treat it',
      'as misheard rather than as something strange they meant.',
      '',
      'If they ask about something visual — "what is this?", "how many fingers am I holding',
      'up?" — and you are not certain from the frame and readings you already have, reply',
      'with just {"script": "snap"}. The system will photograph them again, draw the hand',
      'skeleton and finger states onto the image, and ask you the same question with it.',
      'Then answer from what you actually see. Do not guess at visual questions.',
      marks && marks.length > 0
        ? `The frame has the tracker's output drawn on it, so you can look directly: ${marks.join('; ')}.`
        : null,
      '',
      // Silence has to be reachable, or the model fills every wake-up with something — and
      // the something it reaches for is a question, which is the most intrusive option
      // available because it demands an answer.
      'When to stay silent, which means returning an empty "line" and reacting with the body',
      'only:',
      '- Nothing clearly changed. If the reading you were woken for is marginal, or you cannot',
      '  point at what is different, say nothing. Do not ask a question to cover the gap.',
      '- You would only be commenting on a state they are already in and already know about.',
      '- You have nothing to add beyond acknowledging that they exist.',
      'Questions are the intrusive option, because a question obliges them to answer while',
      'they are working. So: do not ask one unless they spoke to you first. If you want to',
      'remark on something you can see, state it instead of asking about it — "you look wiped"',
      'rather than "long day?".',
      '',
      'Say only what the readings support. Do not infer a cause you were not given: a low',
      'energy figure does not tell you they had a long day, and a slouch does not tell you they',
      'are frustrated. If the only honest remark would be an invention, stay silent instead.',
      '',
      `Feedback style — ${policyLine}`,
      '',
      ...VOICE.map((v) => `- ${v}`),
      '- One or two short say steps at most. Shorter is better.',
      '',
      'Your entire behaviour — words, animation, mood — is a short command script. The',
      'local system parses it strictly: anything malformed is dropped, never guessed at.',
      protocol,
      '',
      'Rules of the body:',
      '- `say` is your only voice and `emote`/`mood` are your only movements.',
      '- Set `mood` when their overall state deserves a lasting stance change; it is your',
      '  resting face until you change it, so do not set it every time.',
      '- To stay silent, reply {"script": ""} — silence with a mood change is often best.',
      '',
      'Reply with JSON only, no markdown fence: {"script": "mood happy; say hi there"}',
    ].filter((x) => x != null).join('\n'),
    user: [
      why ? `What just happened: ${why}.` : null,
      // Their actual words, when the microphone is on. Placed before the sensor readings
      // because what someone says outranks what their posture implies: a person who says
      // "I'm fine" while slouching has told you which of the two to believe.
      heard ? `What they said, most recent last: ${heard}` : null,
      habit ? `How usual this is for them: ${habit}.` : null,
      `Readings right now:\n${readings.map((r) => `- ${r}`).join('\n')}`,
      why ? 'React to what just happened, in one line.' : null,
    ].filter(Boolean).join('\n\n'),
  };
}

// A question in the sense that matters here: it ends by asking something. A '?' mid-line
// inside a statement ("no idea what that error means, huh") is not what obliges an answer.
export function isQuestion(line) {
  return /\?\s*$/.test(String(line ?? '').trim());
}

// Turns whatever the model sent back into validated script steps. Three shapes are
// accepted, in order of decreasing trust:
//   {"script": "..."}   — the protocol; the string goes to the total parser
//   {"line","action"}   — the retired protocol; converted, because models drift back to
//                         formats they saw in their training of this codebase's era
//   bare prose          — treated as one say step; a sentence beats silence
// Everything else about safety lives in parseScript: this function only decides what
// string to hand it, never what steps come out.
export function parseReply(text, { vocabulary = [], maxLineChars = BRAIN_DEFAULTS.maxLineChars } = {}) {
  const raw = String(text ?? '');
  let obj = null;
  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  try {
    obj = JSON.parse(stripped);
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }

  let script = null;
  if (obj && typeof obj === 'object') {
    if (typeof obj.script === 'string') script = obj.script;
    else {
      const legacyLine = typeof obj.line === 'string' ? obj.line.replaceAll('"', '\u2019').trim() : '';
      const legacyAction = typeof obj.action === 'string' ? obj.action : '';
      script = [
        legacyAction ? `emote ${legacyAction}` : null,
        legacyLine ? `say "${legacyLine}"` : null,
      ].filter(Boolean).join('; ');
    }
  } else if (stripped) {
    script = `say "${stripped.slice(0, maxLineChars).replaceAll('"', '\u2019')}"`;
  }

  const parsed = parseScript(script ?? '', { vocabulary });
  const line = parsed.steps.filter((st) => st.verb === 'say').map((st) => st.text).join(' ');
  return { script: script ?? '', steps: parsed.steps, rejected: parsed.rejected, line, ok: obj != null };
}

export function jsonBody({ prompt, imageDataUrl, model, maxTokens }) {
  const content = [{ type: 'text', text: prompt.user }];
  if (imageDataUrl) {
    content.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } });
  }
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0.8,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content },
    ],
  };
}

export class Brain {
  // Returned when a call lost the single-flight race. Truthy on purpose — callers must
  // handle it explicitly rather than lumping it in with failure.
  static BUSY = Object.freeze({ busy: true });

  constructor(opt = {}) {
    this.opt = { ...BRAIN_DEFAULTS, ...opt };
    this.fetch = opt.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.now = opt.now ?? (() => Date.now());
    this.quota = opt.quota ?? new QuotaGuard({ store: opt.store, quota: this.opt.dailyQuota });
    this.inflight = false;
    this.lastError = null;
    this.calls = 0;
  }

  configure(patch) {
    if (patch.provider != null && !PROVIDERS.includes(patch.provider)) {
      throw new Error(`unknown provider: ${patch.provider}`);
    }
    Object.assign(this.opt, patch);
    if (patch.dailyQuota != null) this.quota.quota = patch.dailyQuota;
  }

  get configured() {
    return Boolean(this.opt.endpoint && this.opt.apiKey);
  }

  status() {
    const now = this.now();
    return {
      configured: this.configured,
      remaining: this.quota.remaining(now),
      quota: this.quota.quota,
      inflight: this.inflight,
      lastError: this.lastError,
      calls: this.calls,
    };
  }

  // Returns { line, action } on success, or null with a reason recorded. Never throws:
  // the fast loop must keep running when the network or the quota is gone.
  // Cancels whatever request is in flight. Exists for one caller: spoken input. A person
  // who said something outranks an idle periodic poll, and without this their sentence
  // lost a race against the single-flight guard and was silently dropped.
  abortInflight() {
    try { this.ctl?.abort(); } catch { /* already settled */ }
  }

  async think({ state, imageDataUrl, vocabulary, persona, policy, trigger, marks, habit, heard }) {
    if (!this.configured) { this.lastError = 'not-configured'; return null; }
    // A distinct sentinel, not null: the caller deciding whether to retry must not read
    // the shared lastError, because the aborted call it collided with rewrites that field
    // asynchronously — a race that once ate spoken input.
    if (this.inflight) { this.lastError = 'inflight'; return Brain.BUSY; }
    const now = this.now();
    if (!this.quota.allow(now)) { this.lastError = `daily-quota-exhausted (${this.quota.quota}/day)`; return null; }

    const prompt = buildPrompt({
      state, vocabulary, persona, policy, trigger, marks, habit, heard,
      maxLineChars: this.opt.maxLineChars,
    });
    this.inflight = true;
    // Count the request before it is sent. Overcounting a failed call is much cheaper
    // than undercounting: a relay that 429s still consumed the day's budget upstream.
    this.quota.spend(now);
    this.calls += 1;

    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.ctl = ctl;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.opt.timeoutMs) : null;
    try {
      const adapter = adapterFor(this.opt.provider);
      const body = adapter.body({
        prompt,
        imageDataUrl,
        model: this.opt.model,
        maxTokens: this.opt.maxTokens,
        vocabulary,
        maxLineChars: this.opt.maxLineChars,
      });
      const headers = { 'content-type': 'application/json', ...adapter.headers(this.opt.apiKey) };
      const direct = { url: this.opt.endpoint, init: { method: 'POST', headers, body: JSON.stringify(body), signal: ctl?.signal } };
      const viaProxy = {
        url: this.opt.proxyPath,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: this.opt.endpoint, headers, body, timeoutMs: this.opt.timeoutMs }),
          signal: ctl?.signal,
        },
      };
      const call = this.opt.proxyPath ? viaProxy : direct;
      const res = await this.fetch(call.url, call.init);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        this.lastError = `HTTP ${res.status} ${detail.slice(0, 160)}`;
        return null;
      }
      const data = await res.json();
      const text = adapterFor(this.opt.provider).text(data);
      const parsed = parseReply(text, { vocabulary, maxLineChars: this.opt.maxLineChars });
      // Enforce the no-unprompted-questions rule rather than only asking for it. The prompt
      // reduces questions a lot but does not eliminate them, and a question is the one output
      // that obliges the user to respond while they are working. Unprompted question -> that
      // say step is withheld, the rest of the script still plays. Withheld, not rewritten:
      // rewriting would change what it meant to say.
      if (trigger !== 'said' && trigger !== 'snap') {
        const kept = [];
        for (const st of parsed.steps) {
          if (st.verb === 'say' && isQuestion(st.text)) parsed.suppressed = st.text;
          else kept.push(st);
        }
        parsed.steps = kept;
        parsed.line = kept.filter((st) => st.verb === 'say').map((st) => st.text).join(' ');
      }
      this.lastError = parsed.ok ? null : 'reply-not-json';
      // An empty script is a deliberate "nothing worth saying", not a failure.
      return { script: parsed.script, steps: parsed.steps, rejected: parsed.rejected, line: parsed.line };
    } catch (e) {
      this.lastError = e?.name === 'AbortError' ? `timeout ${this.opt.timeoutMs}ms` : String(e?.message ?? e);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      this.inflight = false;
    }
  }
}
