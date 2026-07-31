// Voice input sidecar. Microphone -> macOS 26 SpeechAnalyzer -> JSON lines on stdout.
//
// Electron cannot reach SpeechAnalyzer, so this exists. It is deliberately the *only*
// thing this binary does for now: no event synthesis, no Accessibility permission, so the
// first step of the multimodal work cannot damage anything (see DESIGN.md, "Build order").
//
// Two measured facts shape the whole thing (tools/asr-latency/):
//
//   * volatile results lag the audio they cover by ~7-40 ms, so they are fast enough to
//     drive commands, and they are what the reflex tier consumes.
//   * the first result of a session costs 2.7-3.9 s. That is per-analyzer, not per
//     utterance, so this process stays alive and pays it at launch — before the user has
//     said anything. A per-utterance process would pay it every time and voice input
//     would feel broken.
//
// Protocol, one JSON object per line.
//
//   out  {"type":"ready","sampleRate":16000,"channels":1,"locale":"en-US"}
//        {"type":"partial","text":"scroll down","t":1234}
//        {"type":"final","text":"Scroll down.","t":1234}
//        {"type":"level","rms":0.013,"peak":0.08}
//        {"type":"warm","ms":2840}
//        {"type":"error","message":"..."}
//        {"type":"error","code":"silent-input", ...}   <- see below
//   in   {"op":"context","strings":["Exusiai","scroll down"]}
//        {"op":"audio","pcm":"<base64 int16 16kHz mono>"}   (net-audio mode)
//        {"op":"quit"}
//
// `voiced --net-audio` opens NO microphone at all: the browser captures audio itself via
// getUserMedia (so the browser shows its own permission prompt and applies its own echo
// cancellation) and streams PCM here through the local server. The analyzer plumbing is
// identical to mic mode — same queue, same drain, same results stream.
//
// `voiced <file.wav>` streams a WAV instead of the microphone, paced to the wall clock.
// This is the deterministic test path. Verifying through the speakers into the microphone
// depends on output routing, volume and room acoustics, and produced contradictory results
// while this was being built; a file exercises the identical analyzer plumbing with none of
// that. It is also the voice counterpart of the video-file input the vision side accepts.
//
// `voiced <file.wav>` streams a WAV instead of the microphone, paced to the wall clock.
// This is the deterministic test path. Testing through the speakers into the microphone
// depends on output routing, volume and room acoustics, and proved flaky enough to produce
// contradictory results; a file exercises the identical analyzer plumbing with none of
// that. It is also the voice counterpart of the video-file input the vision side accepts.
//
// `voiced <file.wav>` streams a WAV instead of the microphone, paced to the wall clock.
// That is the deterministic test path — it exercises the identical analyzer plumbing
// without needing a microphone grant, which a headless test run will never have. It is
// also the voice counterpart of the video-file input the vision side already accepts.
//
// `t` is milliseconds on a monotonic clock shared with nothing else; the consumer uses it
// only for deltas.

import Foundation
import Speech
import AVFoundation
import CoreAudio

// AVAudioEngine's inputNode does NOT follow the system default input device on macOS: it
// binds to whatever device the audio unit happens to come up with. On a machine with a
// virtual loopback device installed (BlackHole, Loopback, Soundflower) that is frequently
// the virtual one, which faithfully delivers digital silence forever because nothing is
// playing into it. The symptom is indistinguishable from a denied microphone grant, so the
// device is selected explicitly and then *named* in the ready line.

func defaultInputDeviceID() -> AudioDeviceID? {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return st == noErr && id != 0 ? id : nil
}

func deviceName(_ id: AudioDeviceID) -> String {
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr,
          let n = name else { return "device \(id)" }
    return n.takeRetainedValue() as String
}

/// Points the engine's input at the system default device. Returns its name, or nil if the
/// device could not be set — in which case whatever the unit chose is used, and reported.
@discardableResult
func bindDefaultInput(_ engine: AVAudioEngine) -> String? {
    guard let unit = engine.inputNode.audioUnit, var dev = defaultInputDeviceID() else { return nil }
    let st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                  kAudioUnitScope_Global, 0, &dev,
                                  UInt32(MemoryLayout<AudioDeviceID>.size))
    return st == noErr ? deviceName(dev) : nil
}

/// Watches the input level so a dead microphone is visible instead of merely quiet.
///
/// This exists because of how macOS denies microphone access: a process without the grant
/// gets a working tap that delivers *digital silence* rather than an error. "No results"
/// then looks identical to "nobody spoke", which is the single most confusing failure this
/// program can have. A real room always has a noise floor, so sustained exactly-zero
/// samples mean the audio is not reaching us at all.
final class LevelWatch {
    private var zeroRunMs = 0.0
    private var reported = false
    private var everHeardAudio = false
    private var lastEmit = 0
    // Generous, because microphone spin-up plus analyzer warm-up measured 5-9 s on this
    // machine. An earlier 4 s limit cried wolf on every single healthy start, which is
    // worse than no warning: it trains you to ignore the one time it is real.
    let silenceLimitMs = 12000.0

    /// Returns a line to emit, if anything is worth saying about the level right now.
    func observe(rms: Float, peak: Float, durationMs: Double) -> [String: Any]? {
        if peak == 0 {
            zeroRunMs += durationMs
            // Only ever complain about a microphone that has never produced a single
            // non-zero sample. Silence after real audio just means nobody is talking.
            if zeroRunMs >= silenceLimitMs && !reported && !everHeardAudio {
                reported = true
                return [
                    "type": "error",
                    "code": "silent-input",
                    "message": "the microphone has delivered nothing but digital silence for "
                        + "\(Int(zeroRunMs / 1000)) s. Two things produce exactly this: a denied "
                        + "microphone grant for the launching app, and a virtual loopback device "
                        + "(BlackHole, Loopback) being bound as the input with nothing playing into "
                        + "it. Check inputDevice in the ready line first, then Privacy & Security > "
                        + "Microphone.",
                ]
            }
            return nil
        }
        zeroRunMs = 0
        reported = false
        everHeardAudio = true
        let now = monoMs()
        // A level line every 500 ms is enough for a meter and for barge-in detection.
        guard now - lastEmit >= 500 else { return nil }
        lastEmit = now
        return ["type": "level", "rms": Double((rms * 1000).rounded()) / 1000,
                "peak": Double((peak * 1000).rounded()) / 1000]
    }
}

/// Streams a WAV into the analyzer paced to the wall clock. Pacing is the point: a burst
/// read lets the analyzer run ahead of real time, and any latency measured against it would
/// then describe throughput rather than lag.
/// Returns false if the file could not be read, so the caller can bail out instead of
/// waiting on results that will never arrive.
@discardableResult
func streamFile(_ path: String, into cont: AsyncStream<AnalyzerInput>.Continuation,
                analyzerFormat: AVAudioFormat) async -> Bool {
    guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
        emit(["type": "error", "message": "cannot open \(path)"])
        return false
    }
    let src = file.processingFormat
    guard let conv = AVAudioConverter(from: src, to: analyzerFormat) else {
        emit(["type": "error", "message": "cannot convert \(src.sampleRate)Hz to \(analyzerFormat.sampleRate)Hz"])
        return false
    }
    emit(["type": "ready", "sampleRate": analyzerFormat.sampleRate,
          "channels": Int(analyzerFormat.channelCount), "source": path,
          "durationSec": (Double(file.length) / src.sampleRate * 1000).rounded() / 1000])
    let ratio = analyzerFormat.sampleRate / src.sampleRate
    let chunk = AVAudioFrameCount(src.sampleRate * 0.1)
    let t0 = monoMs()
    var pos: AVAudioFramePosition = 0
    while pos < file.length {
        guard let ib = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: chunk) else { break }
        do { try file.read(into: ib, frameCount: chunk) } catch { break }
        if ib.frameLength == 0 { break }
        guard let ob = AVAudioPCMBuffer(pcmFormat: analyzerFormat,
            frameCapacity: AVAudioFrameCount(Double(ib.frameLength) * ratio) + 1024) else { break }
        var err: NSError?
        var fed = false
        conv.convert(to: ob, error: &err) { _, st in
            if fed { st.pointee = .noDataNow; return nil }
            fed = true; st.pointee = .haveData; return ib
        }
        if err != nil { break }
        if ob.frameLength > 0 { cont.yield(AnalyzerInput(buffer: ob)) }
        pos += AVAudioFramePosition(ib.frameLength)
        let dueMs = Double(t0) + Double(pos) / src.sampleRate * 1000
        let waitMs = dueMs - Double(monoMs())
        if waitMs > 0 { try? await Task.sleep(nanoseconds: UInt64(waitMs * 1_000_000)) }
    }
    return true
}
/// Input level, handling both sample formats.
///
/// The analyzer's preferred format turns out to be pcmInt16, so a float-only reading
/// silently returned zero for every buffer and the silence watchdog spent its life
/// reporting its own bug. Measured on the microphone's own buffer now, upstream of the
/// conversion, which is both the honest place to measure and format-stable.
func levels(_ buffer: AVAudioPCMBuffer) -> (rms: Float, peak: Float) {
    let n = Int(buffer.frameLength)
    guard n > 0 else { return (0, 0) }
    var sum: Float = 0
    var peak: Float = 0
    if let ch = buffer.floatChannelData {
        for i in 0..<n {
            let v = ch[0][i]
            sum += v * v
            peak = max(peak, abs(v))
        }
    } else if let ch = buffer.int16ChannelData {
        let scale = Float(Int16.max)
        for i in 0..<n {
            let v = Float(ch[0][i]) / scale
            sum += v * v
            peak = max(peak, abs(v))
        }
    } else {
        return (0, 0)
    }
    return ((sum / Float(n)).squareRoot(), peak)
}

let stderrHandle = FileHandle.standardError

func monoMs() -> Int { Int(DispatchTime.now().uptimeNanoseconds / 1_000_000) }

/// Hands converted microphone buffers from the CoreAudio render thread to an async task.
///
/// Yielding into the analyzer's AsyncStream straight from the tap callback looks like it
/// works — levels flow, the feed rate is 1:1 — but volatile results never surface: every
/// transcript arrives in one burst at finalize. Feeding from an async task (the way file
/// mode does, which streams correctly) is the difference. So the tap only enqueues, and a
/// drain task does the yielding from async context.
final class BufferQueue: @unchecked Sendable {
    private var buffers: [AVAudioPCMBuffer] = []
    private let lock = NSLock()

    func push(_ b: AVAudioPCMBuffer) {
        lock.lock()
        buffers.append(b)
        // A stalled drain task must not grow this without bound; ~10 s of 85 ms buffers.
        if buffers.count > 120 { buffers.removeFirst(buffers.count - 120) }
        lock.unlock()
    }

    func drain() -> [AVAudioPCMBuffer] {
        lock.lock()
        let out = buffers
        buffers.removeAll()
        lock.unlock()
        return out
    }
}

/// Serialised, *synchronous* writes.
///
/// This was an actor with a fire-and-forget `Task { await ... }` wrapper, which was wrong in
/// a way a human reading the log would never notice: the timestamp is taken at the call site
/// but the write happened whenever the detached task got scheduled, so lines could reach
/// stdout in a different order than their `t` values. A consumer computing deltas then sees
/// time run backwards. A lock around the write keeps call order and write order identical,
/// and stdout writes are short enough that holding a lock across them costs nothing.
private let outLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]),
          var s = String(data: d, encoding: .utf8) else { return }
    s += "\n"
    guard let bytes = s.data(using: .utf8) else { return }
    outLock.lock()
    FileHandle.standardOutput.write(bytes)
    outLock.unlock()
}
func note(_ s: String) { stderrHandle.write("voiced: \(s)\n".data(using: .utf8)!) }

@main struct Voiced {
    static func main() async {
        // File mode reads a WAV and never opens the microphone, so it must not request
        // microphone access: a test run should not raise a permission prompt, and skipping it
        // also makes `ready` reliably the first line rather than racing an `auth` line.
        let filePath = CommandLine.arguments.dropFirst().first(where: { !$0.hasPrefix("-") })

        // Ask the system what it thinks, rather than inferring from silence. A CLI binary
        // with no bundle can end up .notDetermined and receive zeros instead of a prompt.
        let before = AVCaptureDevice.authorizationStatus(for: .audio)
        let granted = filePath == nil ? await AVCaptureDevice.requestAccess(for: .audio) : false
        let after = AVCaptureDevice.authorizationStatus(for: .audio)
        func label(_ s: AVAuthorizationStatus) -> String {
            switch s {
            case .authorized: return "authorized"
            case .denied: return "denied"
            case .restricted: return "restricted"
            case .notDetermined: return "notDetermined"
            @unknown default: return "unknown"
            }
        }
        if filePath == nil {
            emit(["type": "auth", "before": label(before), "granted": granted, "after": label(after)])
        }

        let locale = Locale(identifier: ProcessInfo.processInfo.environment["PET_ASR_LOCALE"] ?? "en-US")

        guard SpeechTranscriber.isAvailable else {
            emit(["type": "error", "message": "SpeechTranscriber unavailable on this system"])
            return
        }

        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            // Volatile results are the entire point: they are the fast path.
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )

        // Locale assets are not installed by default and the download is silent-fail-prone,
        // so it is reported rather than assumed.
        let installed = await SpeechTranscriber.installedLocales
        let want = locale.identifier(.bcp47)
        if !installed.contains(where: { $0.identifier(.bcp47) == want }) {
            note("locale \(want) not installed, requesting…")
            do {
                if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    try await req.downloadAndInstall()
                    note("locale \(want) installed")
                }
            } catch {
                emit(["type": "error", "message": "asset install failed: \(error)"])
                return
            }
        }

        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            emit(["type": "error", "message": "no compatible audio format"])
            return
        }

        let (inputStream, inputCont) = AsyncStream<AnalyzerInput>.makeStream()
        let analyzer = SpeechAnalyzer(modules: [transcriber])

        let startedAt = monoMs()
        var reportedWarm = false

        // Results task. Volatile and final are both forwarded; the consumer decides which
        // path each one takes, because that policy belongs in the intent bus, not here.
        let results = Task {
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    if !reportedWarm {
                        reportedWarm = true
                        emit(["type": "warm", "ms": monoMs() - startedAt])
                    }
                    emit([
                        "type": result.isFinal ? "final" : "partial",
                        "text": text,
                        "t": monoMs(),
                    ])
                }
            } catch {
                emit(["type": "error", "message": "results: \(error)"])
            }
        }

        // Net-audio mode: no engine, no microphone permission, no device binding. Audio
        // arrives as {"op":"audio"} stdin lines and rides the same queue as mic audio.
        if CommandLine.arguments.contains("--net-audio") {
            let queue = BufferQueue()
            let drain = Task {
                var outFrames: Int64 = 0
                while !Task.isCancelled {
                    for b in queue.drain() {
                        inputCont.yield(AnalyzerInput(
                            buffer: b,
                            bufferStartTime: CMTime(value: outFrames, timescale: CMTimeScale(analyzerFormat.sampleRate))))
                        outFrames += Int64(b.frameLength)
                    }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
            do {
                try await analyzer.start(inputSequence: inputStream)
            } catch {
                emit(["type": "error", "message": "analyzer start failed: \(error)"])
                return
            }
            emit([
                "type": "ready",
                "sampleRate": analyzerFormat.sampleRate,
                "channels": Int(analyzerFormat.channelCount),
                "locale": want,
                "source": "net-audio",
            ])
            let watch = LevelWatch()
            let stdinLoop = Task {
                for try await line in FileHandle.standardInput.bytes.lines {
                    guard let d = line.data(using: .utf8),
                          let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                          let op = obj["op"] as? String else { continue }
                    switch op {
                    case "audio":
                        guard let b64 = obj["pcm"] as? String, let pcm = Data(base64Encoded: b64),
                              pcm.count >= 2 else { continue }
                        let frames = AVAudioFrameCount(pcm.count / 2)
                        guard let buf = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: frames) else { continue }
                        buf.frameLength = frames
                        pcm.withUnsafeBytes { raw in
                            if let dst = buf.int16ChannelData?[0], let src = raw.bindMemory(to: Int16.self).baseAddress {
                                dst.update(from: src, count: Int(frames))
                            }
                        }
                        let lv = levels(buf)
                        if let line = watch.observe(rms: lv.rms, peak: lv.peak,
                                                    durationMs: Double(frames) / analyzerFormat.sampleRate * 1000) {
                            emit(line)
                        }
                        queue.push(buf)
                    case "context":
                        let strings = (obj["strings"] as? [String]) ?? []
                        let ctx = AnalysisContext()
                        ctx.contextualStrings = [.general: strings]
                        try? await analyzer.setContext(ctx)
                    case "quit":
                        return
                    default:
                        break
                    }
                }
            }
            _ = try? await stdinLoop.value
            drain.cancel()
            inputCont.finish()
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
            results.cancel()
            return
        }

        // A file argument replaces the microphone with a paced read. Everything downstream
        // — analyzer, results task, emitted lines — is the same code, so a test over a file
        // genuinely covers the live path rather than paralleling it.
        if let path = filePath {
            // The analyzer has to be consuming the sequence before anything is yielded into
            // it. Omitting this made the buffers pile up unread and the process wait forever
            // on results that could never come — a hang, not an error.
            do {
                try await analyzer.start(inputSequence: inputStream)
            } catch {
                emit(["type": "error", "message": "analyzer start failed: \(error)"])
                return
            }
            let ok = await streamFile(path, into: inputCont, analyzerFormat: analyzerFormat)
            inputCont.finish()
            // Without this, an unreadable file reported an error and then waited forever on
            // results that nothing could ever produce.
            if !ok {
                try? await analyzer.cancelAndFinishNow()
                results.cancel()
                return
            }
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
            _ = await results.value
            return
        }

        // Microphone. AVAudioEngine's tap is the simple route and works with the built-in
        // mic; it is known to never fire for some Bluetooth inputs, in which case this
        // needs to become an AVCaptureSession. That failure is reported rather than hung
        // on: silence with no error is the worst possible symptom.
        let engine = AVAudioEngine()
        // Must happen before the format is read — the format belongs to the bound device.
        let boundDevice = bindDefaultInput(engine)
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            emit(["type": "error", "message": "no microphone input (permission denied, or no input device)"])
            return
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
            emit(["type": "error", "message": "cannot convert \(inputFormat.sampleRate)Hz to \(analyzerFormat.sampleRate)Hz"])
            return
        }

        let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
        let watch = LevelWatch()
        let queue = BufferQueue()
        // Drains the tap's queue from async context every 50 ms and does the actual
        // yielding, with contiguous analyzer-clock timestamps.
        let drain = Task {
            var outFrames: Int64 = 0
            while !Task.isCancelled {
                for b in queue.drain() {
                    inputCont.yield(AnalyzerInput(
                        buffer: b,
                        bufferStartTime: CMTime(value: outFrames, timescale: CMTimeScale(analyzerFormat.sampleRate))))
                    outFrames += Int64(b.frameLength)
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        var dbgFed = 0.0
        var dbgIn = 0.0
        var dbgLast = 0
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
            guard let out = AVAudioPCMBuffer(
                pcmFormat: analyzerFormat,
                frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
            ) else { return }
            var err: NSError?
            var fed = false
            converter.convert(to: out, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            if err != nil || out.frameLength == 0 { return }
            if ProcessInfo.processInfo.environment["PET_ASR_DEBUG"] != nil {
                dbgFed += Double(out.frameLength) / analyzerFormat.sampleRate
                dbgIn += Double(buffer.frameLength) / inputFormat.sampleRate
                if Int(dbgIn) > dbgLast {
                    dbgLast = Int(dbgIn)
                    note(String(format: "fed %.2fs of analyzer audio for %.2fs of mic audio", dbgFed, dbgIn))
                }
            }
            let lv = levels(buffer)
            if let line = watch.observe(rms: lv.rms, peak: lv.peak,
                                        durationMs: Double(buffer.frameLength) / inputFormat.sampleRate * 1000) {
                emit(line)
            }
            queue.push(out)
        }

        do {
            try await analyzer.start(inputSequence: inputStream)
            engine.prepare()
            try engine.start()
        } catch {
            emit(["type": "error", "message": "start failed: \(error)"])
            return
        }

        emit([
            "type": "ready",
            "sampleRate": analyzerFormat.sampleRate,
            "channels": Int(analyzerFormat.channelCount),
            "locale": want,
            "inputSampleRate": inputFormat.sampleRate,
            // Named so that "the pet cannot hear me" is one glance from its cause.
            "inputDevice": boundDevice ?? "unknown (could not bind the system default)",
            "analyzerCommonFormat": analyzerFormat.commonFormat.rawValue,
            "analyzerInterleaved": analyzerFormat.isInterleaved,
        ])

        // stdin commands. Contextual strings bias recognition toward the command grammar
        // and the character's name, which is the cheapest accuracy win available.
        // Async stdin, NOT readLine. readLine is a synchronous blocking read that parks a
        // Swift cooperative-pool thread for the life of the process, and the analyzer's
        // result delivery starves behind it: every configuration with a readLine task
        // produced zero volatile results until finalize, and every configuration without
        // one streamed. This was THE bug that made the pet deaf in mic mode — levels
        // flowed (they come off the CoreAudio thread) while transcripts sat until quit.
        let stdinTask = Task {
            for try await rawLine in FileHandle.standardInput.bytes.lines {
                let line = rawLine
                guard let d = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                      let op = obj["op"] as? String else { continue }
                switch op {
                case "context":
                    let strings = (obj["strings"] as? [String]) ?? []
                    let ctx = AnalysisContext()
                    ctx.contextualStrings = [.general: strings]
                    try? await analyzer.setContext(ctx)
                    note("context set: \(strings.count) strings")
                case "quit":
                    return
                default:
                    note("unknown op \(op)")
                }
            }
        }

        _ = try? await stdinTask.value
        drain.cancel()
        engine.stop()
        input.removeTap(onBus: 0)
        inputCont.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        results.cancel()
    }
}
