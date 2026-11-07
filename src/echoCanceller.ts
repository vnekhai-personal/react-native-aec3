import { SUPPORTED_RATES, isSupportedRate } from "./rates";
import { createSampleTimeline } from "./sampleTimeline";

import type { NativeEchoCanceller } from "./native";

/**
 * WebRTC's AEC3 over the microphone, on top of the platform's own echo canceller (iOS's voice processing or
 * echo-cancelled input, Android's voice-communication chain), for the far-end audio that canceller leaves.
 *
 * The app knows exactly what its speaker plays and when, so the far-end audio is laid on the speaker's own
 * clock as it is scheduled, each microphone buffer is placed on that clock as it arrives, and AEC3 cancels
 * each 10 ms of the microphone after the 10 ms of far-end audio that played over the same span: read as it
 * left the speaker, its schedule plus the output latency the platform measures. AEC3 finds the rest of the
 * delay itself (up to about half a second).
 */

/**
 * A microphone buffer's samples can only have been captured before it arrived, so a buffer that arrives
 * earlier than its placement says proves the placement late. Until the running AEC3 has heard any of the
 * far-end audio the placement moves back at once, which costs nothing. After that it moves only for a buffer
 * earlier than this tolerance: a placement that stays a little late is only delay to AEC3, while a move back
 * shrinks the delay AEC3 found, and a change of even one 4 ms block in that direction resets its filter: about
 * 1.1 s of echo at input level while it finds the delay again (a 17–27 ms move inside a reply leaked 7–12 of
 * the next 16 frames above −45 dBFS on the iOS 26.5 Simulator; with the tolerance, none; a move forward of
 * one block is absorbed and of two costs no leak). A new microphone's first
 * buffer arrives later after its samples than the ones after it, by 28 ms in each of seven sessions on one
 * iPhone and 9–20 ms on the simulators, so the tolerance covers it twice over, and AEC3's delay search
 * reaches about 0.5 s. A placement is never earlier than the arrivals prove: far-end audio paired ahead of
 * its echo cannot be cancelled. A buffer that keeps arriving later than LATE_SECONDS over a whole window
 * moves the placement forward: the microphone dropped audio, or its clock runs slow.
 */
const EARLY_TOLERANCE_SECONDS = 0.06;
const LATE_SECONDS = 0.03;
const LATE_WINDOW_SECONDS = 5;
/** How much of the far-end audio is kept behind the microphone, in seconds. */
const HISTORY_SECONDS = 2;
/**
 * How far behind the speaker's clock the far-end audio is kept for microphone buffers still on their way: a
 * JavaScript thread that falls further behind loses it for them, and a paused microphone keeps no more.
 */
const BACKLOG_SECONDS = 10;
/**
 * Of the measured output latency, what the pairing leaves to AEC3's own delay search: a measurement a
 * little high must never put the echo ahead of the audio it is paired with, which AEC3 cannot cancel.
 */
const LATENCY_HEADROOM_SECONDS = 0.04;
/**
 * After the microphone resumes from a pause, AEC3 has heard none of the far-end audio that played meanwhile:
 * the echo of what it missed cannot be cancelled, and it takes about half a second more to cancel what follows
 * as before (measured on the iOS 26.5 and 17.5 Simulators: the first 240 ms came back at the echo's own
 * level, the next 300 ms 5–15 dB down). For that long after a resume the microphone is handed on as silence
 * wherever the far end sounded: AEC3's delay as it found it plus half a second, within these bounds; a
 * sounding frame is one with a sample above −60 dBFS.
 */
const HOLD_MARGIN_SECONDS = 0.5;
const HOLD_MIN_SECONDS = 0.6;
const HOLD_MAX_SECONDS = 1;
const SOUNDING = 1e-3;

export interface EchoCancellerOptions {
  /** The microphone's sample rate: 8, 16, 24, 32, 44.1 or 48 kHz. Default 16 kHz. */
  readonly captureRate?: number;
  /** The far-end audio's sample rate, which AEC3 resamples itself: the same choices. Default 24 kHz. */
  readonly renderRate?: number;
  /** @internal A fresh AEC3 for those rates; null where this build has none. Default: the native module's. */
  readonly create?: () => NativeEchoCanceller | null;
  /** The speaker's clock in seconds (the audio context's `currentTime`), which the far-end audio is scheduled on. */
  readonly now: () => number;
  /**
   * Seconds from the speaker's clock to the speaker itself, as the platform measures them (the audio
   * context's `outputLatency`: Oboe's on Android, the audio session's on iOS); 0 where it does not know.
   */
  readonly outputLatency?: () => number;
  /** @internal Milliseconds, for timing AEC3's work. Default: `performance.now`. */
  readonly clock?: () => number;
  /** AEC3 failed: the session goes on with the platform's canceller alone. */
  readonly onFailure?: () => void;
}

/** What the canceller has done so far: counts and levels only. */
export interface EchoCancellerDiagnostics {
  /** `unavailable` (no module in this build), `on`, or `failed` (AEC3 could not be made or threw). */
  state: "on" | "unavailable" | "failed";
  /** 10 ms frames AEC3 cancelled. */
  frames: number;
  /** Microphone audio passed through while it stood by, or at a rate it does not run at. */
  bypassedMs: number;
  /** AEC3's time per 100 ms of microphone, and its slowest single call, in ms. */
  processingMs: number;
  maxProcessingMs: number;
  /** Placement moves, what they add up to and the largest, in ms. */
  moves: number;
  movedMs: number;
  maxMoveMs: number;
  /** AEC3s made afresh: a new microphone, or the far-end audio coming back where the microphone hears it. */
  restarts: number;
  /** Microphone audio handed on as silence after resumes. */
  heldMs: number;
  /** The output latency the platform measured at the last placement; absent where it reports none. */
  outputLatencyMs?: number;
  /** AEC3's last readings; absent before the first AEC3 cancels, and kept from the last one while it stands by. */
  delayMs?: number;
  echoReturnLossDb?: number;
  echoReturnLossEnhancementDb?: number;
}

export interface EchoCanceller {
  /** A chunk of far-end audio starts playing at `at` seconds on the speaker's clock. */
  scheduled(samples: Float32Array, at: number): void;
  /** The speaker dropped what it had queued, at `at` seconds. */
  playbackStopped(at: number): void;
  /** A microphone buffer as it arrives; returns what to send in its place (whole 10 ms frames). */
  process(samples: Float32Array, sampleRate: number): Float32Array;
  /** The microphone was replaced: AEC3 starts over, and the new microphone's buffers are placed afresh. */
  restart(): void;
  /** The microphone resumes after a pause: its next buffer is placed afresh. */
  resumed(): void;
  /**
   * Whether the far-end audio plays where the microphone hears it. Away from there (a headset, a car) the
   * canceller stands by and passes the microphone through; back there, AEC3 starts over on the new echo.
   */
  setActive(active: boolean): void;
  /** Cancelling now: AEC3 was made, has not failed, and the canceller is not standing by. */
  isCancelling(): boolean;
  diagnostics(): EchoCancellerDiagnostics;
  stop(): void;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const defaultClock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function createEchoCancellerWith(
  options: EchoCancellerOptions,
  defaultCreate: (captureRate: number, renderRate: number) => NativeEchoCanceller | null = () => null,
): EchoCanceller {
  const captureRate = options.captureRate ?? 16_000;
  const renderRate = options.renderRate ?? 24_000;
  for (const rate of [captureRate, renderRate]) {
    if (!isSupportedRate(rate)) throw new RangeError(`${rate} Hz is not a rate AEC3 runs at (${SUPPORTED_RATES.join(", ")})`);
  }
  const outputLatency = options.outputLatency ?? (() => 0);
  const clock = options.clock ?? defaultClock;
  const onFailure = options.onFailure ?? (() => undefined);
  const create = options.create ?? (() => defaultCreate(captureRate, renderRate));
  /** 10 ms, AEC3's frame: of the microphone, and of the far-end audio. */
  const CAPTURE_FRAME = captureRate / 100;
  const RENDER_FRAME = renderRate / 100;
  const HISTORY_SAMPLES = HISTORY_SECONDS * renderRate;
  const BACKLOG_SAMPLES = BACKLOG_SECONDS * renderRate;
  const LATE_WINDOW_SAMPLES = LATE_WINDOW_SECONDS * captureRate;

  let aec: NativeEchoCanceller | null = null;
  // A build without the module has no AEC3; one whose AEC3 cannot be made has failed, and either way the
  // session starts with the platform's canceller alone.
  let state: EchoCancellerDiagnostics["state"] = "failed";
  try {
    aec = create();
    state = aec === null ? "unavailable" : "on";
  } catch {
    // Reported in the diagnostics and to `onFailure`, never thrown at the caller: a callback that throws here
    // would abort the construction and with it the pass-through the session falls back on.
    try {
      onFailure();
    } catch {
      // The caller's own callback failed; the session still starts, passing the microphone through.
    }
  }
  let active = true;
  let stopped = false;
  const timeline = createSampleTimeline();
  /** Where, on the speaker's clock, the placed microphone's first sample was captured; null until placed. */
  let anchor: number | null = null;
  /** Microphone samples placed since the anchor. */
  let placed = 0;
  /** The earliest any buffer arrived after its placement in the current window, in seconds. */
  let windowLate = Infinity;
  let windowStart = 0;
  /** How much earlier than its own span each microphone buffer reads the far end: the output latency, less headroom. */
  let shift = 0;
  /**
   * A fresh AEC3 measures the latency at its first placement. A microphone placed again for the same AEC3
   * (after a pause) keeps it, so the echo stays where AEC3 found it.
   */
  let remeasure = true;
  /** The output latency as last measured, in ms, for the diagnostics; null while the platform does not know. */
  let latencyMs: number | null = null;
  /**
   * What the moves since this microphone was first placed add up to, in seconds: how much earlier than its
   * arrival its first buffer was captured, which the buffers after it found. A microphone placed again
   * after a pause starts from it, so AEC3 sees no move while it cancels; a new microphone finds its own.
   */
  let correction = 0;
  /**
   * Whether AEC3 has heard any far-end audio since it started: until then a move costs it nothing. Read from
   * what it is given, not from the schedule: audio queued ahead, or already playing when a fresh AEC3 starts
   * after a stall or a route change, counts once it reaches AEC3.
   */
  let replyHeard = false;
  /** Microphone samples still to hold after a resume, and how far back a sounding far end holds one, in render samples. */
  let holdLeft = 0;
  let holdWindow = 0;
  /** The far end's last sounding sample, on the timeline, as the microphone's reads passed it. */
  let lastSounding = -Infinity;
  /** Whether the hold has looked at the far end before its first frame: nothing new can appear there. */
  let beforeScanned = false;
  let heldSamples = 0;
  /** What the moves add up to and the largest, in seconds, for the diagnostics: how steady the microphone's arrivals are. */
  let movedSeconds = 0;
  let maxMoveSeconds = 0;
  /** Placed samples not yet a whole frame, the first of which is sample `pendingIndex`. */
  let pending = new Float32Array(CAPTURE_FRAME * 32);
  let pendingCount = 0;
  let pendingIndex = 0;
  let render = new Float32Array(RENDER_FRAME * 10);
  let frames = 0;
  let bypassedSamples = 0;
  let busyMs = 0;
  let maxMs = 0;
  let moves = 0;
  let restarts = 0;
  let readings: Pick<EchoCancellerDiagnostics, "delayMs" | "echoReturnLossDb" | "echoReturnLossEnhancementDb"> = {};

  function make(): NativeEchoCanceller | null {
    try {
      return create();
    } catch {
      return null;
    }
  }

  function release() {
    try {
      aec?.release();
    } catch {
      // Released already.
    }
    aec = null;
  }

  /** AEC3's latest readings, kept for the diagnostics; reading never fails the session. */
  function read() {
    if (aec === null) return;
    try {
      const { delayMs, echoReturnLossDb, echoReturnLossEnhancementDb } = aec.readings();
      // A fresh AEC3 has none yet: the last one's stay until it has its own.
      if (delayMs === null && echoReturnLossDb === null && echoReturnLossEnhancementDb === null) return;
      readings = {
        ...(delayMs === null ? {} : { delayMs: round2(delayMs) }),
        ...(echoReturnLossDb === null ? {} : { echoReturnLossDb: round2(echoReturnLossDb) }),
        ...(echoReturnLossEnhancementDb === null ? {} : { echoReturnLossEnhancementDb: round2(echoReturnLossEnhancementDb) }),
      };
    } catch {
      // Diagnostics never cost the session anything.
    }
  }

  function fail() {
    state = "failed";
    release();
    try {
      onFailure();
    } catch {
      // The caller's own callback failed; the session goes on without it, as the audio must.
    }
  }

  /** The platform's output latency in seconds, 0 where it reports none it knows; reading it never fails the session. */
  function measuredLatency(): number {
    try {
      const latency = outputLatency();
      return Number.isFinite(latency) && latency > 0 ? latency : 0;
    } catch {
      return 0;
    }
  }

  /** The samples placed but not yet cancelled, as they came: when the canceller stops cancelling them. */
  function flush(): Float32Array {
    const rest = pending.slice(0, pendingCount);
    pendingCount = 0;
    return rest;
  }

  /** Places a buffer of `length` samples that arrived `arrival` seconds into the speaker's clock. */
  function place(length: number, arrival: number) {
    if (anchor === null) {
      // As if it arrived the moment its last sample was captured; any later buffer that arrives sooner
      // than that moves it back. Samples still waiting for a whole frame were captured just before. A
      // correction that moved the placement back is kept (the buffers after this one would find it again);
      // one that moved it forward is not: it would place this buffer later than its arrival proves, pairing
      // the microphone with far-end audio that had not played yet, and a slow clock shows again in the window.
      if (correction > 0) correction = 0;
      anchor = arrival - length / captureRate + correction;
      placed = 0;
      pendingIndex = -pendingCount;
      windowLate = Infinity;
      windowStart = 0;
      if (remeasure) {
        const latency = measuredLatency();
        shift = Math.max(0, latency - LATENCY_HEADROOM_SECONDS);
        latencyMs = latency > 0 ? Math.round(latency * 1_000) : null;
        remeasure = false;
      }
    } else {
      const late = arrival - (anchor + (placed + length) / captureRate);
      if (late < -(replyHeard ? EARLY_TOLERANCE_SECONDS : 0.001)) {
        anchor += late;
        correction += late;
        moves += 1;
        movedSeconds -= late;
        maxMoveSeconds = Math.max(maxMoveSeconds, -late);
      }
      windowLate = Math.min(windowLate, Math.max(0, late));
      if (placed + length - windowStart >= LATE_WINDOW_SAMPLES) {
        if (windowLate !== Infinity && windowLate > LATE_SECONDS) {
          anchor += windowLate;
          correction += windowLate;
          moves += 1;
          movedSeconds += windowLate;
          maxMoveSeconds = Math.max(maxMoveSeconds, windowLate);
        }
        windowLate = Infinity;
        windowStart = placed + length;
      }
    }
    placed += length;
  }

  /** Whether any sample of this stretch of far-end audio sounds. */
  function sounds(stretch: Float32Array): boolean {
    for (let i = 0; i < stretch.length; i += 1) if (Math.abs(stretch[i]!) > SOUNDING) return true;
    return false;
  }

  /**
   * After a resume: each cancelled 10 ms frame whose far end sounded within the hold window is handed on as
   * silence, AEC3 keeping what it heard. The window before the first frame is read from the timeline, for
   * far-end audio that stopped just before the microphone came back.
   */
  function hold(capture: Float32Array, reply: Float32Array, from: number, count: number): void {
    if (!beforeScanned) {
      beforeScanned = true;
      const before = timeline.readInto(from - holdWindow, new Float32Array(holdWindow));
      for (let i = before.length - RENDER_FRAME; i >= 0; i -= RENDER_FRAME) {
        if (sounds(before.subarray(i, i + RENDER_FRAME))) {
          lastSounding = from - holdWindow + i + RENDER_FRAME;
          break;
        }
      }
    }
    for (let i = 0; i < count && holdLeft > 0; i += 1) {
      const at = from + i * RENDER_FRAME;
      if (sounds(reply.subarray(i * RENDER_FRAME, (i + 1) * RENDER_FRAME))) lastSounding = at + RENDER_FRAME;
      if (at + RENDER_FRAME - lastSounding <= holdWindow) {
        capture.fill(0, i * CAPTURE_FRAME, (i + 1) * CAPTURE_FRAME);
        heldSamples += CAPTURE_FRAME;
      }
      holdLeft -= CAPTURE_FRAME;
    }
  }

  const cancelling = () => !stopped && state === "on" && active && aec !== null;

  return {
    scheduled(samples, at) {
      timeline.add(Math.round(at * renderRate), samples);
      // The microphone's reads let the far-end audio go as they pass it (`process`); one standing by or paused
      // reads none, so it is let go of here too, far enough behind for buffers still on their way.
      timeline.forget(Math.round(options.now() * renderRate) - BACKLOG_SAMPLES);
    },

    playbackStopped(at) {
      timeline.cut(Math.round(at * renderRate));
    },

    process(samples, sampleRate) {
      if (stopped || state !== "on" || !active || aec === null || sampleRate !== captureRate) {
        bypassedSamples += Math.round((samples.length * captureRate) / Math.max(1, sampleRate));
        anchor = null;
        if (pendingCount === 0) return samples;
        const rest = flush();
        // A rate AEC3 is not running at cannot join what is left of the last one.
        if (sampleRate !== captureRate) return samples;
        const out = new Float32Array(rest.length + samples.length);
        out.set(rest);
        out.set(samples, rest.length);
        return out;
      }
      place(samples.length, options.now());
      if (pendingCount + samples.length > pending.length) {
        const grown = new Float32Array(pendingCount + samples.length + CAPTURE_FRAME * 16);
        grown.set(pending.subarray(0, pendingCount));
        pending = grown;
      }
      pending.set(samples, pendingCount);
      pendingCount += samples.length;
      const count = Math.floor(pendingCount / CAPTURE_FRAME);
      if (count === 0) return new Float32Array(0);
      const capture = pending.slice(0, count * CAPTURE_FRAME);
      if (render.length < count * RENDER_FRAME) render = new Float32Array(count * RENDER_FRAME);
      const from = Math.round((anchor! + pendingIndex / captureRate - shift) * renderRate);
      const reply = timeline.readInto(from, render.subarray(0, count * RENDER_FRAME));
      if (!replyHeard && sounds(reply)) replyHeard = true;
      const startedAt = clock();
      try {
        aec.process(capture, reply);
      } catch {
        // Everything placed and not yet handed on, as it came: the whole frames just attempted (native code
        // may have cancelled some before refusing one) and the remainder waiting for its frame. Taken before
        // the caller is told, so nothing the callback does can keep this audio from being handed back.
        const rest = flush();
        fail();
        return rest;
      }
      const spent = clock() - startedAt;
      busyMs += spent;
      maxMs = Math.max(maxMs, spent);
      frames += count;
      if (holdLeft > 0) hold(capture, reply, from, count);
      pending.copyWithin(0, count * CAPTURE_FRAME, pendingCount);
      pendingCount -= count * CAPTURE_FRAME;
      pendingIndex += count * CAPTURE_FRAME;
      timeline.forget(from - HISTORY_SAMPLES);
      return capture;
    },

    restart() {
      if (state !== "on" || stopped) return;
      read();
      release();
      anchor = null;
      pendingCount = 0;
      holdLeft = 0;
      correction = 0;
      replyHeard = false;
      // Standing by, nothing is cancelled: an AEC3 is made when the far-end audio comes back where it is heard.
      if (!active) return;
      aec = make();
      if (aec === null) {
        fail();
        return;
      }
      restarts += 1;
      remeasure = true;
    },

    resumed() {
      anchor = null;
      pendingCount = 0;
      if (!cancelling()) return;
      read();
      const delay = typeof readings.delayMs === "number" ? readings.delayMs / 1_000 : 0;
      const seconds = Math.min(HOLD_MAX_SECONDS, Math.max(HOLD_MIN_SECONDS, delay + HOLD_MARGIN_SECONDS));
      holdLeft = Math.round(seconds * captureRate);
      holdWindow = Math.round(seconds * renderRate);
      lastSounding = -Infinity;
      beforeScanned = false;
    },

    setActive(next) {
      if (next === active) return;
      active = next;
      holdLeft = 0;
      if (state !== "on" || stopped) return;
      if (!next) {
        read();
        release();
        return;
      }
      release();
      aec = make();
      if (aec === null) {
        fail();
        return;
      }
      restarts += 1;
      anchor = null;
      remeasure = true;
      replyHeard = false;
    },

    isCancelling: cancelling,

    diagnostics() {
      read();
      return {
        state,
        frames,
        bypassedMs: Math.round((bypassedSamples / captureRate) * 1_000),
        // AEC3's work per 100 ms of the microphone's audio, as the JavaScript thread waited for it.
        processingMs: frames === 0 ? 0 : round2(busyMs / (frames / 10)),
        maxProcessingMs: round2(maxMs),
        moves,
        movedMs: Math.round(movedSeconds * 1_000),
        maxMoveMs: Math.round(maxMoveSeconds * 1_000),
        restarts,
        heldMs: Math.round((heldSamples / captureRate) * 1_000),
        ...(latencyMs === null ? {} : { outputLatencyMs: latencyMs }),
        ...readings,
      };
    },

    stop() {
      if (stopped) return;
      read();
      stopped = true;
      release();
    },
  };
}
