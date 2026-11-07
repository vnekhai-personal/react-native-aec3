// The reply on an echo canceller's timeline: the canceller reads it back
// for each stretch of the microphone it cancels.

import { createSampleTimeline } from '../src/sampleTimeline';
import { describe, expect, it } from 'vitest';

const samples = (...values: number[]) => Float32Array.from(values);
const read = (timeline: ReturnType<typeof createSampleTimeline>, from: number, length: number) =>
  [...timeline.readInto(from, new Float32Array(length))];

describe('a sample timeline', () => {
  it('reads back what plays where, with silence where nothing does', () => {
    const timeline = createSampleTimeline();
    timeline.add(2, samples(1, 2, 3));
    timeline.add(7, samples(4, 5));
    expect(read(timeline, 0, 10)).toEqual([0, 0, 1, 2, 3, 0, 0, 4, 5, 0]);
    expect(read(timeline, 3, 2)).toEqual([2, 3]);
    expect(read(timeline, 20, 3)).toEqual([0, 0, 0]);
  });

  it('clears what it reads into first, so a buffer can be read into again', () => {
    const timeline = createSampleTimeline();
    timeline.add(0, samples(1, 1));
    const into = Float32Array.from([9, 9, 9, 9]);
    expect([...timeline.readInto(0, into)]).toEqual([1, 1, 0, 0]);
  });

  it('lets a later stretch win where two overlap, and drops an empty one', () => {
    const timeline = createSampleTimeline();
    timeline.add(0, samples(1, 1, 1));
    timeline.add(1, samples(2, 2));
    timeline.add(5, new Float32Array(0));
    expect(read(timeline, 0, 4)).toEqual([1, 2, 2, 0]);
  });

  it('plays nothing from a cut on, keeping what played before it', () => {
    const timeline = createSampleTimeline();
    timeline.add(0, samples(1, 2, 3, 4));
    timeline.add(6, samples(5, 6));
    timeline.cut(2);
    expect(read(timeline, 0, 8)).toEqual([1, 2, 0, 0, 0, 0, 0, 0]);
    // What is added after the cut plays as usual.
    timeline.add(3, samples(7));
    expect(read(timeline, 0, 5)).toEqual([1, 2, 0, 7, 0]);
  });

  it('lets go only of stretches that end before the given sample', () => {
    const timeline = createSampleTimeline();
    timeline.add(0, samples(1, 2));
    timeline.add(4, samples(3, 4));
    timeline.forget(5);
    expect(read(timeline, 0, 6)).toEqual([0, 0, 0, 0, 3, 4]);
    timeline.forget(6);
    expect(read(timeline, 0, 6)).toEqual([0, 0, 0, 0, 3, 4]);
    timeline.forget(7);
    expect(read(timeline, 0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('lets go of an ended stretch added after a later one', () => {
    const timeline = createSampleTimeline();
    timeline.add(10, samples(5, 6));
    timeline.add(0, samples(1, 2));
    timeline.forget(5);
    expect(read(timeline, 0, 12)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 6]);
  });
});

describe("a sample timeline's copies", () => {
  it("keeps its own copy of each stretch, so the caller may reuse the array", () => {
    const timeline = createSampleTimeline();
    const scratch = samples(1, 2, 3);
    timeline.add(0, scratch);
    scratch.fill(9);
    expect(read(timeline, 0, 3)).toEqual([1, 2, 3]);
  });
});
