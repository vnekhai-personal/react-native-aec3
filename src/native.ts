import { requireOptionalNativeModule } from "expo";

import { SUPPORTED_RATES, isSupportedRate } from "./rates";
import { createSharedBufferProcess } from "./sharedBuffers";

import type { SharedBufferCanceller } from "./sharedBuffers";

/**
 * AEC3's readings as of the last `process`, each null before the first. Until AEC3 has found the echo they hold
 * its starting values: a 12 ms delay, a loss of -30 dB and an enhancement of 0.2 dB.
 */
export interface EchoCancellerReadings {
  /** How far behind the far-end audio its echo reaches the microphone. */
  readonly delayMs: number | null;
  /** How far below the far-end audio the echo reaches the microphone. */
  readonly echoReturnLossDb: number | null;
  /** How much of the echo AEC3 removes. */
  readonly echoReturnLossEnhancementDb: number | null;
}

/** WebRTC's AEC3 over one microphone and the far-end audio played over it (CLAUDE.md, "Rules this code keeps"). */
export interface NativeEchoCanceller {
  /**
   * Cancels whole 10 ms frames of `capture` in place, each after the 10 ms of `render` over the same span.
   * Throws where they are not whole frames of each, or WebRTC refuses them.
   */
  process(capture: Float32Array, render: Float32Array): void;
  readings(): EchoCancellerReadings;
  /** Frees the canceller now rather than when JavaScript collects it. */
  release(): void;
}

/** At most this many 10 ms frames per native call; a longer chunk is processed in slices. 1 s of audio. */
const MAX_FRAMES = 100;

interface Aec3Native {
  readonly EchoCanceller: new (captureRate: number, renderRate: number, maxFrames: number) => SharedBufferCanceller;
  /** Android only: the communication device, by route name. */
  readonly communicationRoute?: () => string | null;
  readonly addListener?: (event: "onRouteChange", listener: (change: { route?: string | null }) => void) => { remove(): void };
}

// Optional: a build made before the module was added, and a test runner, have none, and the caller goes on
// with the platform's own canceller alone.
const native = requireOptionalNativeModule<Aec3Native>("Aec3");

/** Whether this build carries the native module. */
export function isAvailable(): boolean {
  return native !== null;
}

/**
 * A raw AEC3 for microphone audio at `captureRate` and far-end audio at `renderRate` (8, 16, 24, 32, 44.1 or
 * 48 kHz each); null where this build has no module. Throws a RangeError for any other rate, before the
 * native side sees it, and where WebRTC cannot make one.
 */
export function createNativeAec3(captureRate: number, renderRate: number): NativeEchoCanceller | null {
  for (const rate of [captureRate, renderRate]) {
    if (!isSupportedRate(rate)) throw new RangeError(`${rate} Hz is not a rate AEC3 runs at (${SUPPORTED_RATES.join(", ")})`);
  }
  if (native === null) return null;
  const raw = new native.EchoCanceller(captureRate, renderRate, MAX_FRAMES);
  return {
    process: createSharedBufferProcess(raw, captureRate / 100, renderRate / 100, MAX_FRAMES),
    readings: () => raw.readings(),
    release: () => raw.release(),
  };
}

/**
 * Where Android plays now: its communication device, by route name (`Aec3Module.kt`, `routeName`). Null on
 * iOS, where this build has no module, and where Android cannot tell.
 */
export function androidCommunicationRoute(): string | null {
  return native?.communicationRoute?.() ?? null;
}

/** Calls `listener` with the route each time Android's communication device or its devices change; never where `androidCommunicationRoute` cannot tell. */
export function addAndroidRouteListener(listener: (route: string | null) => void): { remove(): void } {
  if (native?.communicationRoute === undefined || native.addListener === undefined) return { remove: () => undefined };
  return native.addListener("onRouteChange", (change) => listener(change.route ?? null));
}
