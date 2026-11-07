import { describe, expect, it } from "vitest";

import { createSharedBufferProcess } from "../src/sharedBuffers";

import type { SharedBufferCanceller } from "../src/sharedBuffers";

/** A native stand-in over its own buffers: negates each processed capture sample and counts the frames it saw. */
function fakeNative(captureFrame: number, renderFrame: number, maxFrames: number, refuseAtFrame = Infinity) {
  const capture = new ArrayBuffer(maxFrames * captureFrame * 4);
  const render = new ArrayBuffer(maxFrames * renderFrame * 4);
  const calls: number[] = [];
  let seen = 0;
  const raw: SharedBufferCanceller = {
    captureBuffer: () => capture,
    renderBuffer: () => render,
    process(frames) {
      calls.push(frames);
      const view = new Float32Array(capture, 0, frames * captureFrame);
      for (let f = 0; f < frames; f += 1) {
        if (seen + f >= refuseAtFrame) throw new Error("WebRTC refused the audio (-6)");
        for (let i = f * captureFrame; i < (f + 1) * captureFrame; i += 1) view[i] = -view[i]!;
      }
      seen += frames;
    },
    readings: () => ({ delayMs: null, echoReturnLossDb: null, echoReturnLossEnhancementDb: null }),
    release: () => undefined,
  };
  return { raw, calls };
}

describe("process over the shared buffers", () => {
  it("copies whole frames in, processes them, and copies the result back into the caller's array", () => {
    const { raw, calls } = fakeNative(160, 240, 100);
    const process = createSharedBufferProcess(raw, 160, 240, 100);
    const capture = Float32Array.from({ length: 1_600 }, (_, i) => i + 1);
    const render = new Float32Array(2_400);
    process(capture, render);
    expect(calls).toEqual([10]);
    expect(capture[0]).toBe(-1);
    expect(capture[1_599]).toBe(-1_600);
  });

  it("slices a chunk longer than the native buffers, in order", () => {
    const { raw, calls } = fakeNative(160, 240, 4);
    const process = createSharedBufferProcess(raw, 160, 240, 4);
    const capture = Float32Array.from({ length: 1_600 }, (_, i) => i + 1);
    process(capture, new Float32Array(2_400));
    expect(calls).toEqual([4, 4, 2]);
    expect(capture.every((value, i) => value === -(i + 1))).toBe(true);
  });

  it("leaves a view's other samples alone and never trusts a length it did not compute", () => {
    const { raw } = fakeNative(160, 240, 100);
    const process = createSharedBufferProcess(raw, 160, 240, 100);
    const backing = Float32Array.from({ length: 480 }, (_, i) => i + 1);
    const view = backing.subarray(160, 320);
    process(view, new Float32Array(240));
    expect(backing.subarray(0, 160).every((value, i) => value === i + 1)).toBe(true);
    expect(view.every((value, i) => value === -(161 + i))).toBe(true);
    expect(backing.subarray(320).every((value, i) => value === 321 + i)).toBe(true);
  });

  it("refuses samples that are not whole frames of each, before touching native code", () => {
    const { raw, calls } = fakeNative(160, 240, 100);
    const process = createSharedBufferProcess(raw, 160, 240, 100);
    expect(() => process(new Float32Array(150), new Float32Array(240))).toThrow(RangeError);
    expect(() => process(new Float32Array(160), new Float32Array(200))).toThrow(RangeError);
    expect(calls).toEqual([]);
  });

  it("refuses arrays that are not Float32Arrays, as a plain-JavaScript caller could pass", () => {
    const { raw, calls } = fakeNative(160, 240, 100);
    const process = createSharedBufferProcess(raw, 160, 240, 100);
    const pcm = new Int16Array(160) as unknown as Float32Array;
    expect(() => process(pcm, new Float32Array(240))).toThrow(TypeError);
    expect(() => process(new Float32Array(160), new Int16Array(240) as unknown as Float32Array)).toThrow(TypeError);
    expect(calls).toEqual([]);
  });

  it("keeps the slices written back before a refused one, and throws for it", () => {
    const { raw } = fakeNative(160, 240, 4, 6);
    const process = createSharedBufferProcess(raw, 160, 240, 4);
    const capture = Float32Array.from({ length: 1_600 }, (_, i) => i + 1);
    expect(() => process(capture, new Float32Array(2_400))).toThrow(/refused/);
    expect(capture.subarray(0, 640).every((value, i) => value === -(i + 1))).toBe(true);
    expect(capture.subarray(640).every((value, i) => value === 641 + i)).toBe(true);
  });
});
