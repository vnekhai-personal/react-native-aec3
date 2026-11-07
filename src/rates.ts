/** The sample rates WebRTC's audio processing accepts, for the microphone and for the far-end audio alike. */
export const SUPPORTED_RATES: readonly number[] = [8_000, 16_000, 24_000, 32_000, 44_100, 48_000];

/** Whether `rate` is one of them: a finite whole number, never NaN, infinity or anything the native side cannot hold. */
export function isSupportedRate(rate: number): boolean {
  return Number.isInteger(rate) && SUPPORTED_RATES.includes(rate);
}
