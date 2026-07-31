# Streaming ASR latency, measured

Apple publishes throughput for macOS 26's `SpeechAnalyzer` (74–89× real-time; ~2× faster
than Whisper Large V3 Turbo), but **not streaming latency** — and latency is the number
that decides whether voice can sit in the reflex tier next to gestures. So it is measured
here rather than assumed.

`measure.swift` synthesises nothing itself: it takes a WAV, streams it through
`SpeechAnalyzer` in 100 ms chunks **paced to the wall clock** (a burst read would report
throughput, not lag), and for every result records when it arrived versus the audio
position it covers.

```sh
say -v Samantha -o s.aiff "close this window. now scroll down a bit. hey, come over here."
ffmpeg -y -i s.aiff -ar 48000 -ac 1 -c:a pcm_s16le s.wav
swiftc -O -parse-as-library -target arm64-apple-macos26.0 measure.swift -o measure
./measure s.wav
```

## Results — M4 Pro, 24 GB, macOS 26.0.1, en-US

| | lag behind the audio it covers |
| --- | --- |
| volatile (partial) results | **median 7–39 ms, p90 20–68 ms** |
| final results | **0.4 – 3.4 s** (waits for a sentence boundary) |
| first result of a session | **2.7 – 3.9 s** (one-time, not per utterance) |

Three things follow, and the whole voice design rests on them:

1. **Partials are fast enough to be a reflex.** 39 ms median is inside the ≈60 ms
   visuo-tactile simultaneity window from the haptics literature, so a voice command and a
   gesture command land in the same perceptual instant and can be fused without feeling
   out of step.
2. **Finals are far too slow for commands** but exactly right for conversation, which is
   a 1–3 s activity anyway. So: partials drive commands, finals drive dialogue.
3. **The session warm-up must be paid before the user speaks.** It is once per analyzer,
   not once per utterance — volatile results kept flowing at ~40 ms across all four
   sentences and their pauses. A sidecar held open from launch pays it during startup.

## Pitfalls hit while measuring

- `bestAvailableAudioFormat` is static on `SpeechAnalyzer`, not on `SpeechTranscriber`.
- Hand-computed `bufferStartTime` values drift into `SFSpeechErrorDomain Code=2`
  "Audio input timestamp overlaps or precedes prior audio input". The source file's frame
  positions are the wrong clock — the buffers handed over are the *resampled* ones. Just
  use `AnalyzerInput(buffer:)` and let the analyzer keep its own continuity, which is also
  what a live mic gives it.
- `en-US` assets are not installed by default. `AssetInventory.assetInstallationRequest`
  fetches them; it worked unattended here and took a few seconds.
- Feeding under ~4 s of audio yields *no* incremental output at all — everything arrives
  at the end. Short clips therefore cannot be used to measure streaming lag, which is why
  the fixture is ~19 s.
