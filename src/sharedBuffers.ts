import type { EchoCancellerReadings, NativeEchoCanceller } from "./native";

/**
 * The native object as both platforms expose it: AEC3 over buffers the native side owns, shared with JavaScript
 * as ArrayBuffers over the same memory. `process(frames)` cancels the first `frames` 10 ms frames of the capture
 * buffer in place, each after the render buffer's 10 ms over the same span (CLAUDE.md, "Rules this code keeps").
 */
export interface SharedBufferCanceller {
  captureBuffer(): ArrayBuffer;
  renderBuffer(): ArrayBuffer;
  process(frames: number): void;
  readings(): EchoCancellerReadings;
  release(): void;
}

/**
 * `process(capture, render)` over the shared buffers: whole 10 ms frames of each, copied in at most `maxFrames`
 * at a time, processed, and copied back into `capture`. Native code never sees a pointer, a length or an offset
 * from JavaScript, so no claim a script can make about its arrays reaches native memory.
 */
export function createSharedBufferProcess(
  raw: SharedBufferCanceller,
  captureFrame: number,
  renderFrame: number,
  maxFrames: number,
): NativeEchoCanceller["process"] {
  const captureView = new Float32Array(raw.captureBuffer());
  const renderView = new Float32Array(raw.renderBuffer());
  if (captureView.length < maxFrames * captureFrame || renderView.length < maxFrames * renderFrame) {
    throw new RangeError("the native module's buffers are smaller than their declared frame count");
  }
  return (capture, render) => {
    // A plain-JavaScript caller could hand over Int16Array PCM, which `set` would convert sample by sample into
    // nonsense rather than refuse.
    if (!(capture instanceof Float32Array) || !(render instanceof Float32Array)) {
      throw new TypeError("process takes Float32Arrays");
    }
    const frames = capture.length / captureFrame;
    if (!Number.isInteger(frames) || render.length !== frames * renderFrame) {
      throw new RangeError(`${capture.length} microphone and ${render.length} far-end samples are not whole 10 ms frames of each`);
    }
    for (let done = 0; done < frames; done += maxFrames) {
      const count = Math.min(maxFrames, frames - done);
      captureView.set(capture.subarray(done * captureFrame, (done + count) * captureFrame));
      renderView.set(render.subarray(done * renderFrame, (done + count) * renderFrame));
      // A refused frame throws here: the slices before this one are already written back, as the C contract
      // keeps the frames before a refused one cancelled.
      raw.process(count);
      capture.set(captureView.subarray(0, count * captureFrame), done * captureFrame);
    }
  };
}
