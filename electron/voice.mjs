// Supervises the Swift voice sidecar from the Electron main process.
//
// The sidecar is a separate process because Electron cannot reach macOS 26's SpeechAnalyzer,
// and it is long-lived because the first transcription result of a session costs 2.7-3.9 s
// (measured; see tools/asr-latency/). That cost is per-analyzer, not per utterance, so
// holding one process open pays it during startup instead of the first time someone speaks.
//
// Everything here is about the process, not about language: lines are forwarded verbatim to
// the renderer, which owns the grammar and the intent bus. Keeping the policy out of main
// means the matching logic stays testable in plain node.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export class VoiceSidecar {
  // `onLine` receives each parsed JSON object; `onExit` fires when the process goes away.
  constructor({ dir, onLine, onExit = () => {} }) {
    this.binary = join(dir, 'voiced');
    this.onLine = onLine;
    this.onExit = onExit;
    this.proc = null;
    this.buf = '';
    // Restarts are capped: a sidecar that dies instantly and forever would otherwise spin
    // a process loop for the life of the app.
    this.restarts = 0;
    this.maxRestarts = 3;
    this.stopping = false;
  }

  get running() { return this.proc != null; }

  start() {
    if (this.proc) return { ok: true, already: true };
    if (!existsSync(this.binary)) {
      // Reported rather than thrown: a missing sidecar must degrade to "no voice input",
      // never take the pet down with it.
      this.onLine({
        type: 'error',
        code: 'not-built',
        message: `voice sidecar not built at ${this.binary} — run native/build.sh`,
      });
      return { ok: false, reason: 'not-built' };
    }
    this.stopping = false;
    this.buf = '';
    const proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      const parts = this.buf.split('\n');
      this.buf = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          // A malformed line is a bug worth seeing, not worth crashing on.
          this.onLine({ type: 'error', code: 'bad-line', message: line.slice(0, 200) });
          continue;
        }
        this.onLine(obj);
      }
    });

    // The sidecar writes diagnostics to stderr on purpose, so they are not silently dropped.
    proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) this.onLine({ type: 'note', message: s.slice(0, 400) });
    });

    proc.on('error', (err) => {
      this.proc = null;
      this.onLine({ type: 'error', code: 'spawn-failed', message: err.message });
    });

    proc.on('close', (code, signal) => {
      this.proc = null;
      this.onExit({ code, signal });
      if (this.stopping) return;
      if (this.restarts < this.maxRestarts) {
        this.restarts += 1;
        this.onLine({
          type: 'note',
          message: `sidecar exited (${code ?? signal}); restart ${this.restarts}/${this.maxRestarts}`,
        });
        this.start();
      } else {
        this.onLine({
          type: 'error',
          code: 'gave-up',
          message: `voice sidecar exited ${this.maxRestarts} times; voice input is off`,
        });
      }
    });

    return { ok: true };
  }

  // Biases recognition toward the command grammar and the character's name. Cheapest
  // accuracy win available, and it has to be re-sent after a restart, which is why the
  // renderer keeps the list rather than main.
  setContext(strings) {
    this.#send({ op: 'context', strings: Array.isArray(strings) ? strings.slice(0, 200) : [] });
  }

  stop() {
    this.stopping = true;
    if (!this.proc) return;
    this.#send({ op: 'quit' });
    // The sidecar exits on `quit`; SIGTERM is the backstop if it is wedged in the analyzer.
    const proc = this.proc;
    setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); }, 1500);
  }

  #send(obj) {
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // A closed pipe means the process is already going away; the close handler deals with it.
    }
  }
}
