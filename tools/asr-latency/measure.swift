import Foundation
import Speech
import AVFoundation

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

@main struct Lat {
  static func main() async {
    let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "say.wav"
    let inst = await SpeechTranscriber.installedLocales
    let sup = await SpeechTranscriber.supportedLocales
    FileHandle.standardError.write("installed=\(inst.map{$0.identifier(.bcp47)}) supported=\(sup.count)\n".data(using:.utf8)!)

    let loc = Locale(identifier: "en-US")
    let t = SpeechTranscriber(locale: loc,
      transcriptionOptions: [], reportingOptions: [.volatileResults],
      attributeOptions: [.audioTimeRange])

    if !sup.contains(where: { $0.identifier(.bcp47).hasPrefix("en") }) {
      print("{\"error\":\"en not supported\"}"); return
    }
    if !inst.contains(where: { $0.identifier(.bcp47).hasPrefix("en-US") }) {
      FileHandle.standardError.write("en-US asset missing, requesting install…\n".data(using:.utf8)!)
      if let req = try? await AssetInventory.assetInstallationRequest(supporting: [t]) {
        try? await req.downloadAndInstall()
        FileHandle.standardError.write("install done\n".data(using:.utf8)!)
      }
    }

    guard let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t]) else {
      print("{\"error\":\"no format\"}"); return
    }
    FileHandle.standardError.write("analyzer format: \(fmt.sampleRate)Hz \(fmt.channelCount)ch\n".data(using:.utf8)!)

    guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
      print("{\"error\":\"cannot open \(path)\"}"); return
    }
    let src = file.processingFormat
    guard let conv = AVAudioConverter(from: src, to: fmt) else { print("{\"error\":\"no converter\"}"); return }

    let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: [t])

    let t0 = now()
    // Collector: log arrival lag for every result the transcriber emits.
    let collector = Task {
      var rows: [String] = []
      do {
        for try await r in t.results {
          let arrival = now() - t0
          let text = String(r.text.characters)
          // audioTimeRange is carried as an attribute on the attributed string runs.
          var endSec = -1.0
          var startSec = -1.0
          for run in r.text.runs {
            if let range = run.audioTimeRange {
              endSec = max(endSec, range.end.seconds)
              startSec = startSec < 0 ? range.start.seconds : min(startSec, range.start.seconds)
            }
          }
          rows.append("{\"kind\":\"\(r.isFinal ? "final" : "volatile")\",\"arrival\":\(String(format:"%.3f",arrival)),\"audioStart\":\(String(format:"%.3f",startSec)),\"audioEnd\":\(String(format:"%.3f",endSec)),\"lag\":\(String(format:"%.3f", endSec >= 0 ? arrival - endSec : -1)),\"text\":\(jsonStr(text))}")
        }
      } catch { rows.append("{\"error\":\(jsonStr("\(error)"))}") }
      return rows
    }

    try? await analyzer.start(inputSequence: stream)

    // Feed the file in 100 ms chunks, paced to wall clock, so lag is measured against
    // real-time streaming rather than a burst read.
    let chunkFrames = AVAudioFrameCount(src.sampleRate * 0.1)
    var pos: AVAudioFramePosition = 0
    // Timestamps must be on the *analyzer's* timeline, not the source file's: the buffers
    // handed over are the resampled ones, so counting source frames made buffer N's
    // duration disagree with buffer N+1's start and the analyzer rejected the overlap.
    var outPos: AVAudioFramePosition = 0
    while pos < file.length {
      guard let inBuf = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: chunkFrames) else { break }
      do { try file.read(into: inBuf, frameCount: chunkFrames) } catch { break }
      if inBuf.frameLength == 0 { break }
      let ratio = fmt.sampleRate / src.sampleRate
      guard let outBuf = AVAudioPCMBuffer(pcmFormat: fmt,
        frameCapacity: AVAudioFrameCount(Double(inBuf.frameLength) * ratio) + 1024) else { break }
      var err: NSError?
      var fed = false
      conv.convert(to: outBuf, error: &err) { _, st in
        if fed { st.pointee = .noDataNow; return nil }
        fed = true; st.pointee = .haveData; return inBuf
      }
      if err != nil { break }
      if outBuf.frameLength > 0 {
        cont.yield(AnalyzerInput(buffer: outBuf))
        outPos += AVAudioFramePosition(outBuf.frameLength)
      }
      pos += AVAudioFramePosition(inBuf.frameLength)
      // Pace: wait until this chunk's audio would have finished playing.
      let target = t0 + Double(pos) / src.sampleRate
      let d = target - now()
      if d > 0 { try? await Task.sleep(nanoseconds: UInt64(d * 1e9)) }
    }
    cont.finish()
    try? await analyzer.finalizeAndFinishThroughEndOfInput()
    let rows = await collector.value
    print("{\"audioDur\":\(String(format:"%.3f", Double(file.length)/src.sampleRate)),\"results\":[\n" + rows.joined(separator: ",\n") + "\n]}")
  }
}

func jsonStr(_ s: String) -> String {
  let d = try! JSONEncoder().encode([s])
  var out = String(data: d, encoding: .utf8)!
  out.removeFirst(); out.removeLast()
  return out
}
