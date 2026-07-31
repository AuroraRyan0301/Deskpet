// Spoken output. Web Speech API in both the browser and Electron; macOS ships the
// en_US voices (Samantha / Alex / Fred / …) so nothing needs downloading.
//
// The voice-picking rule is pure and tested — it is the part that silently breaks,
// because getVoices() returns [] until the engine has enumerated and the exact name
// strings differ across macOS versions.

// Match on the pack's voiceHint first, then any voice for the language, then whatever
// the platform considers default. Returns null when the list is genuinely empty.
export function pickVoice(voices, { lang = 'en-US', voiceHint = '' } = {}) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[_\s]/g, '-');
  const wantLang = norm(lang);
  const hint = norm(voiceHint);

  const sameLang = voices.filter((v) => norm(v.lang).startsWith(wantLang.slice(0, 2)));
  if (hint) {
    const exact = sameLang.find((v) => norm(v.name) === hint)
      ?? sameLang.find((v) => norm(v.name).includes(hint))
      ?? voices.find((v) => norm(v.name) === hint);
    if (exact) return exact;
  }
  const exactLang = sameLang.find((v) => norm(v.lang) === wantLang);
  if (exactLang) return exactLang;
  if (sameLang.length > 0) return sameLang[0];
  return voices.find((v) => v.default) ?? voices[0];
}

export class Voice {
  constructor({ synth = (typeof speechSynthesis !== 'undefined' ? speechSynthesis : null) } = {}) {
    this.synth = synth;
    this.voices = [];
    this.enabled = true;
    this.lastSpoken = null;
    this.spokenCount = 0;
    if (!this.synth) return;
    const load = () => { this.voices = this.synth.getVoices() ?? []; };
    load();
    // getVoices() is empty on first call in Chromium — the event is the only reliable
    // signal that the list is populated.
    this.synth.addEventListener?.('voiceschanged', load);
  }

  get available() {
    return Boolean(this.synth);
  }

  // Cancels whatever is still being said. A pet that queues up a backlog of stale
  // lines and recites them all sounds broken, so the newest line always wins.
  say(text, { lang = 'en-US', voiceHint = '', rate = 1, pitch = 1, volume = 1 } = {}) {
    if (!this.synth || !this.enabled) return false;
    const line = String(text ?? '').trim();
    if (!line) return false;
    try {
      this.synth.cancel();
      const u = new SpeechSynthesisUtterance(line);
      const v = pickVoice(this.voices.length ? this.voices : (this.synth.getVoices() ?? []), { lang, voiceHint });
      if (v) u.voice = v;
      u.lang = v?.lang ?? lang;
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;
      this.synth.speak(u);
      this.lastSpoken = line;
      this.spokenCount += 1;
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    try { this.synth?.cancel(); } catch { /* nothing to cancel */ }
  }
}
