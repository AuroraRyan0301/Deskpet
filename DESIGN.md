# Multimodal control: design

The pet currently senses (camera → landmarks) and expresses (a line + one animation). This
document is about the other half: **taking input by voice, and acting on the machine** —
walking to where a finger points, clicking, scrolling, closing a window — while keeping two
properties that pull in opposite directions.

- **Critical operations must be immediate.** A click that lands 800 ms late is worse than
  no click, because by then the user has already moved on and the click hits the wrong
  thing.
- **Social behaviour must be unhurried.** A greeting that fires in 40 ms feels like a
  reflex arc, not a companion. Being a bit slow is *correct* here.

The resolution is not a compromise between the two. It is a split: different signals travel
different paths with different budgets, and they meet at a single arbiter.

## Measured ground truth

Every latency claim below traces to `tools/asr-latency/` (voice) or the existing fast loop
(vision), measured on this machine — M4 Pro, macOS 26.0.1.

| path | measured |
| --- | --- |
| camera → landmark features | ~30 fps, 30–75 ms inference |
| voice **partial** → text | median 7–39 ms, p90 68 ms |
| voice **final** → text | 0.4 – 3.4 s |
| model round trip (Haiku via local gateway) | ~1 – 3 s |

The load-bearing discovery: **voice partials are as fast as gestures.** Both land inside
the ≈60 ms visuo-tactile simultaneity window from the 04/30 lecture, which means a spoken
command and a hand command can be treated as *simultaneous evidence about one intent*
rather than two events to be sequenced. That is what makes fusion honest rather than
decorative.

Its converse matters just as much: finals are 1–3 s, hopelessly slow for a command, but
that is the natural pace of conversation anyway. So the modality does not split by
channel — **it splits by result type within the same channel.** Partials command; finals
converse.

## Amendment (post-refactor): one author for the puppet

The original design let the fast loop play reflex animations on the puppet while the model
supplied language. Lived experience killed that: two authors made the puppet twitch, the
canned tables papered over model failures instead of surfacing them, and the classifier
names being fed to the model ("callMe", "gun") laundered guesses into facts. The standing
rules are now:

- **Detections have exactly two exits**: the OS reflex tier (intents.js — cursor, scroll,
  and the trigger gate) and the summons that wakes the model (annotated frame + keypoint
  readings). Nothing detected ever touches the puppet directly.
- **The puppet has one author.** Words, one-shot animations and the lasting mood all
  arrive as a verb script (`mood happy; emote wave; say hi`) parsed by the total parser in
  script.js and played by the ScriptRunner. The `mood` verb owns expression; the only
  local judgment left on the sprite is presence (away/here), because the camera — not the
  model — knows whether anyone is there.
- **The model gets readings, not classifications.** Per-finger states (`fingersUp`),
  expression scores, posture numbers, and the annotated frame. Classifier outputs stay
  local, where being wrong is cheap.

## Three tiers

Today there are two loops. Pointing needs a third, because "run to where I point" is
neither a reflex (it persists and has a goal) nor a model decision (it updates every
frame). Adding it as a tier keeps the model out of the 30 fps path, which is
non-negotiable.

```
 Tier 0  REFLEX          every frame, no model              budget < 60 ms
   gesture table + voice-partial grammar → intent
   → capability gate → OS operation | servo goal | animation

 Tier 1  SERVO           every frame, goal-driven           budget < 16 ms
   one-euro filtered fingertip → screen point (homography)
   locomotion controller → sprite clip | procedural IK
   goals are set by tier 0 or tier 2; neither sets positions

 Tier 2  DELIBERATE      event-triggered, Claude            budget 1–3 s
   novelty gate → prompt(state, transcript, annotated frame)
   → line + script (DSL) + capability grants + optional body lease
```

Tier 1 exists to absorb the impedance mismatch. Claude says *where to go*; a local
controller decides how to get there, every frame, forever. A model that emitted positions
would need to run at 30 fps, and a model that emitted a single position would produce
teleporting.

## The intent bus

Gestures and speech do not fuse at the recogniser. They normalise into one event and fuse
at the intent:

```js
{ source: 'gesture' | 'voice' | 'model', intent: 'scroll_down',
  confidence: 0.82, args: { amount: 3 }, t: 12345 }
```

Two fusion rules earn their keep:

**Cross-channel agreement substitutes for a confirmation dialog.** Two independent
modalities asserting the same intent within the simultaneity window is strong evidence —
much stronger than either alone, and it is evidence the user produced *deliberately*. So
`close_window` does not need a modal "are you sure": it needs the voice and the hand to
agree. This is only sound because the two channels were measured to land in the same
perceptual instant; if voice lagged by a second, "agreement" would be meaningless.

**Deixis: the voice carries the verb, the hand carries the argument.** "Click that" is
underspecified in language and overspecified in pointing; together they are exactly right.
This is Bolt's *Put-that-there* (SIGGRAPH 1980) — the pointing device is now a bare hand,
and the resolution is worse, but the structure is unchanged. Worth naming in the paper as
the lineage rather than presenting as new.

## Claude's output: a verb script, not one action

The current schema returns one action from an enum. That is too small to express "look at
the cursor, walk over, then wave". Replace it with a short script string:

```
look cursor; walk 0.72,0.31; emote wave; wait 300; say "over here?"
```

| verb | argument | effect |
| --- | --- | --- |
| `say` | text | TTS |
| `emote` | pack action name | one-shot animation |
| `look` | `cursor` \| `user` \| `x,y` | head/eye aim |
| `walk` / `run` | `x,y` normalised screen | tier-1 servo goal |
| `wait` | ms | sequencing |
| `grant` | capability list | *arm* a capability, does not use it |
| `release` | — | return the body to reflex control |

A string rather than nested JSON because it is a timed sequence, it costs far fewer output
tokens than JSON (output tokens are the dominant term in that 1–3 s), and it is readable in
a log. The schema enforcement that JSON gave up is recovered in the **parser**, which is
total: an unknown verb, a bad argument, an out-of-range coordinate, or more than N steps is
dropped and logged, never guessed at. The parser has to be defensive regardless — a model
can emit a perfectly valid enum value at completely the wrong moment — so moving
enforcement there loses nothing real.

### The invariant that makes this safe

> **No verb performs an OS operation.** Claude can `grant` a capability; only a live human
> signal can spend it.

Voice commands reach the OS through the local grammar on partials (~40 ms), never through
the model. So the model is not in the OS path at all, and a model mistake cannot click,
scroll, or close anything. This falls out of the latency requirement rather than being
bolted on for safety: anything fast enough to be a command was never going to route through
a 1–3 s model anyway. The safety property and the performance property have the same cause.

## Who owns the body: an expiring lease

Claude may take over motion, but as a **lease, not a lock**:

- Default: reflex owns the body. Always responsive, zero latency.
- `take 3000` — Claude drives for 3 s, reflex *animations* suspended.
- The lease expires on a timer. If the model hangs, dies, or never replies, the body
  reverts with no dependency on a reply arriving.
- Any tier-0 **command** cancels the lease instantly. The user outranks the performance.
- Reflex **OS operations are never suspended**, lease or not. The pet doing a bit must
  never be able to swallow a click.

A timer rather than a lock is the whole point: liveness must not depend on the health of
the slowest component in the system.

## Pointing → screen coordinates

Ray-casting the finger direction is the obvious idea and the wrong one here. The camera is
*embedded in the screen being pointed at*, so pointing at the screen means pointing nearly
at the camera: the finger's direction vector is maximally foreshortened exactly where
precision is needed, and small landmark errors swing the hit point wildly.

Instead: map fingertip **position** in the camera frame to a screen point through a
homography fitted by a one-time 4-corner calibration, with the `point_*` gesture (already
detected in `perception.js`) gating it. Smoothing is a one-euro filter rather than the
EMA used elsewhere — EMA trades jitter against lag linearly, while one-euro adapts, which
is why it is the standard choice for interactive pointing.

This is a virtual-trackpad mapping wearing a pointing gesture, not true 3D pointing, and it
should be described that way. The requirement was "大概方位" — approximate direction — and
absolute mapping delivers considerably better than that, so the honest framing costs
nothing.

## Rigging: only where rigs exist

"Directly manipulate rigging points" applies to the procedural characters, which are drawn
here and can carry a 2D skeleton with IK. The imported Arknights and Umamusume packs are
**sprite sheets** — pre-rendered frames with no joints, and no amount of engineering adds
joints to a PNG.

So `walk 0.7,0.3` compiles to two different implementations behind one verb:

- **sprite packs** — pick the directional clip the pack actually has (`WALK_L`, `RUN_U`, …)
  and translate the character across the screen. Real locomotion, works with the packs
  already imported.
- **procedural packs** — drive a skeleton, which additionally allows gaits and reaching
  that no sprite sheet contains.

Same goal, same verb, different renderer. Promising rig control over Arknights sprites
would be a promise that cannot be kept.

## The native sidecar

Electron cannot reach `SpeechAnalyzer`, and cannot synthesise input events. Both need
native code, and it is the *same* native code — one Swift process over stdio JSON lines,
not two:

```
                 ┌───────────────────────────────┐
   mic ──────────▶ SpeechAnalyzer                │
                 │   .volatileResults            │──▶ stdout {partial|final, text}
                 │                               │
   CGEvent   ◀───┤ click / scroll / move / key   │◀── stdin  {op, args}
   AXUIElement◀──┤ close window                  │
                 └───────────────────────────────┘
```

One process because it must be long-lived anyway: the 2.7–3.9 s analyzer warm-up has to be
paid at launch, before the user ever speaks. A per-utterance process would pay it every
time and voice input would feel broken.

Permissions needed, all of which macOS will prompt for: **Microphone**, **Accessibility**
(to post events and to read window structure). Ad-hoc signing breaks TCC grants across
rebuilds, so the sidecar needs a stable signing identity or the permissions will silently
evaporate on every build.

## Capability tiers, by reversibility

Not all operations deserve the same gate. The axis that matters is what a false positive
costs.

| tier | operations | gate |
| --- | --- | --- |
| free | cursor move, character motion, `look` | gesture alone |
| cheap, reversible | scroll, click | single channel + dwell |
| destructive | close window, key combos | **two channels agreeing**, inside an armed window |

Plus, unconditionally: a kill switch that disables all OS control instantly, an
always-visible indicator whenever any capability is armed (never silent), and every
operation logged to the feedback CSV alongside what triggered it.

**`close_window` ships disabled.** A false positive there costs unsaved work, and the
gesture recogniser's false-positive rate on this machine has not been characterised yet —
measuring it is a prerequisite, not a formality. Scroll and click are reversible enough to
enable once the arming UI exists. This is a default, not a refusal; it is one switch.

## Build order

Each step is independently useful and independently testable, and the risky work comes
after the boring work that de-risks it.

1. **Sidecar, voice in only.** Mic → partials/finals on stdout. No OS control yet, so no
   Accessibility permission and nothing can go wrong. Verifies warm-up, permissions, and
   the stdio protocol.
2. **Intent bus + voice grammar.** Partials → local command matching. Wire to *existing*
   pet behaviour (animations, lines) so the loop closes with zero OS risk.
3. **Claude takes transcripts.** Finals join the prompt; the pet answers what was actually
   said. This is the conversational loop the user asked for, and it needs no new
   permissions.
4. **DSL + lease.** Replace the single action with a parsed script; add the expiring lease.
5. **Full-screen overlay + servo.** The window must span the display before the character
   can walk across it. Pointing calibration and the one-euro filter land here.
6. **OS operations.** Accessibility permission, capability gates, arming UI, kill switch.
   Scroll and click first; `close_window` only after false-positive rates are measured.

Steps 1–4 are all reversible and carry no risk to the user's machine. Step 6 is the only
one that can do damage, and it is last on purpose.
