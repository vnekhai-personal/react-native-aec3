import { createEchoCancellerWith } from "./echoCanceller";
import { createNativeAec3 } from "./native";

import type { EchoCanceller, EchoCancellerOptions } from "./echoCanceller";

/**
 * WebRTC's AEC3 over the microphone, paired with the far-end audio on the speaker's clock, on top of the
 * platform's own echo canceller (README.md), made with this build's native AEC3.
 */
export function createEchoCanceller(options: EchoCancellerOptions): EchoCanceller {
  return createEchoCancellerWith(options, createNativeAec3);
}

export type { EchoCanceller, EchoCancellerDiagnostics, EchoCancellerOptions } from "./echoCanceller";
export { addAndroidRouteListener, androidCommunicationRoute, createNativeAec3, isAvailable } from "./native";
export type { EchoCancellerReadings, NativeEchoCanceller } from "./native";
export { androidRouteReachesMic, iosOutputReachesMic } from "./routes";
export { SUPPORTED_RATES, isSupportedRate } from "./rates";
