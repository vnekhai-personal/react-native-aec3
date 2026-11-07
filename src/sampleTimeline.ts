// Audio laid where it plays on a timeline of samples at one rate, and read back for any stretch, silent
// where nothing plays: the far-end audio as the speaker plays it, kept on the speaker's own clock, for the
// echo canceller to read the 10 ms that played over each 10 ms of the microphone.

export interface SampleTimeline {
  /** `samples` play from sample `start` on (copied, so the array may be reused). A later stretch that overlaps an earlier one wins there. */
  add(start: number, samples: Float32Array): void;
  /** Nothing plays from sample `at` on: the speaker dropped what it had queued. */
  cut(at: number): void;
  /** Fills `into` with what plays from sample `from` on, silence where nothing does, and returns it. */
  readInto(from: number, into: Float32Array): Float32Array;
  /** Lets go of every stretch that ends before sample `before`. */
  forget(before: number): void;
}

interface Stretch {
  readonly start: number;
  samples: Float32Array;
}

export function createSampleTimeline(): SampleTimeline {
  /** Oldest first. */
  let stretches: Stretch[] = [];
  return {
    add(start, samples) {
      // A copy: the caller may reuse its array for the next chunk the moment this returns.
      if (samples.length > 0) stretches.push({ start, samples: samples.slice() });
    },

    cut(at) {
      for (const stretch of stretches) {
        if (stretch.start + stretch.samples.length > at) stretch.samples = stretch.samples.subarray(0, Math.max(0, at - stretch.start));
      }
      stretches = stretches.filter((stretch) => stretch.samples.length > 0);
    },

    readInto(from, into) {
      into.fill(0);
      for (const stretch of stretches) {
        const a = Math.max(from, stretch.start);
        const b = Math.min(from + into.length, stretch.start + stretch.samples.length);
        if (b > a) into.set(stretch.samples.subarray(a - stretch.start, b - stretch.start), a - from);
      }
      return into;
    },

    forget(before) {
      // Stretches are kept in the order they were added, which need not be the order they play in.
      stretches = stretches.filter((stretch) => stretch.start + stretch.samples.length >= before);
    },
  };
}
