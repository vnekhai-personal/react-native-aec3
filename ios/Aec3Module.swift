import ExpoModulesCore

final class EchoCancellerException: GenericException<String>, @unchecked Sendable {
  override var reason: String { param }
}

/// WebRTC's AEC3 for a microphone (README.md): one canceller per session, made and fed from JavaScript.
public final class Aec3Module: Module {
  public func definition() -> ModuleDefinition {
    Name("Aec3")

    Class(EchoCanceller.self) {
      // Doubles, as JavaScript numbers are: a NaN, an infinity or a number too large for Int32 would trap in a
      // conversion before WebRTC could refuse it. Checked here, and again in C.
      Constructor { (captureRate: Double, renderRate: Double, maxFrames: Double) throws -> EchoCanceller in
        guard let capture = EchoCanceller.rate(captureRate), let render = EchoCanceller.rate(renderRate) else {
          throw EchoCancellerException("\(captureRate) Hz and \(renderRate) Hz are not rates AEC3 runs at")
        }
        guard let frames = EchoCanceller.frames(maxFrames), frames > 0, frames <= EchoCanceller.maxFramesLimit else {
          throw EchoCancellerException("\(maxFrames) is not a number of frames between 1 and \(EchoCanceller.maxFramesLimit)")
        }
        return try EchoCanceller(captureRate: capture, renderRate: render, maxFrames: frames)
      }

      // The audio lives in buffers the canceller owns and shares with JavaScript as ArrayBuffers over the same
      // memory: JavaScript copies each chunk in, calls `process` with a frame count, and copies the result out.
      // Native code never takes a pointer, a length or an offset from JavaScript (CLAUDE.md, "Rules this code keeps").
      Function("captureBuffer") { (canceller: EchoCanceller) -> ArrayBuffer in canceller.captureBuffer }
      Function("renderBuffer") { (canceller: EchoCanceller) -> ArrayBuffer in canceller.renderBuffer }

      // Synchronous on purpose, on the JavaScript thread as the microphone's audio arrives there: JavaScript
      // waits for it, so nothing reads or writes the shared buffers meanwhile. Never an AsyncFunction.
      Function("process") { (canceller: EchoCanceller, frames: Double) throws in
        guard let count = EchoCanceller.frames(frames) else { throw EchoCancellerException("\(frames) is not a frame count") }
        try canceller.process(frames: count)
      }

      Function("readings") { (canceller: EchoCanceller) throws -> [String: Double?] in
        try canceller.readings()
      }
    }
  }
}

final class EchoCanceller: SharedObject {
  private static let supportedRates: Set<Int32> = [8_000, 16_000, 24_000, 32_000, 44_100, 48_000]
  /// 10 s of audio at most per canceller: the buffers are allocated once, for the largest chunk a caller may hand over.
  static let maxFramesLimit = 1_000

  /// The rate as Int32 where it is one AEC3 runs at, else nil: never a trapping conversion.
  static func rate(_ value: Double) -> Int32? {
    guard let rate = Int32(exactly: value), supportedRates.contains(rate) else { return nil }
    return rate
  }

  /// A whole, non-negative frame count, else nil.
  static func frames(_ value: Double) -> Int? {
    guard let frames = Int(exactly: value), frames >= 0 else { return nil }
    return frames
  }

  private var handle: OpaquePointer?
  private let captureFrame: Int
  private let renderFrame: Int
  private let maxFrames: Int
  /// Owned here, shared with JavaScript as views over the same memory, and kept alive by whichever side holds them last.
  let captureBuffer: ArrayBuffer
  let renderBuffer: ArrayBuffer

  init(captureRate: Int32, renderRate: Int32, maxFrames: Int) throws {
    guard let made = rn_aec3_create(captureRate, renderRate) else {
      throw EchoCancellerException("WebRTC made no echo canceller for \(captureRate) Hz and \(renderRate) Hz")
    }
    handle = made
    captureFrame = Int(rn_aec3_capture_frame(made))
    renderFrame = Int(rn_aec3_render_frame(made))
    self.maxFrames = maxFrames
    captureBuffer = ArrayBuffer(size: maxFrames * captureFrame * MemoryLayout<Float>.size)
    renderBuffer = ArrayBuffer(size: maxFrames * renderFrame * MemoryLayout<Float>.size)
    super.init()
  }

  /// Cancels `frames` 10 ms frames of the capture buffer in place, each after the render buffer's 10 ms over the same span.
  func process(frames: Int) throws {
    guard let handle else { throw EchoCancellerException("the echo canceller was released") }
    guard frames <= maxFrames else { throw EchoCancellerException("\(frames) frames do not fit the \(maxFrames)-frame buffers") }
    if frames == 0 { return }
    let result = captureBuffer.withUnsafeMutableBytes { capture in
      renderBuffer.withUnsafeBytes { render in
        rn_aec3_process(
          handle,
          capture.baseAddress!.assumingMemoryBound(to: Float.self),
          render.baseAddress!.assumingMemoryBound(to: Float.self),
          Int32(frames))
      }
    }
    guard result == 0 else { throw EchoCancellerException("WebRTC refused the audio (\(result))") }
  }

  /// AEC3's readings as of the last frame processed, each nil before the first (rn_aec3.h).
  func readings() throws -> [String: Double?] {
    guard let handle else { throw EchoCancellerException("the echo canceller was released") }
    var stats = RnAec3Stats()
    rn_aec3_stats(handle, &stats)
    let reading = { (value: Double) -> Double? in value.isNaN ? nil : value }
    return [
      "delayMs": reading(stats.delay_ms),
      "echoReturnLossDb": reading(stats.echo_return_loss_db),
      "echoReturnLossEnhancementDb": reading(stats.echo_return_loss_enhancement_db),
    ]
  }

  override func sharedObjectDidRelease() {
    if let handle { rn_aec3_destroy(handle) }
    handle = nil
  }

  deinit {
    if let handle { rn_aec3_destroy(handle) }
  }
}
