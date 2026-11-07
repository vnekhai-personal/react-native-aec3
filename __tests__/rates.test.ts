import { describe, expect, it } from "vitest";

import { SUPPORTED_RATES, isSupportedRate } from "../src/rates";

describe("the rates AEC3 runs at", () => {
  it("are WebRTC's six, as whole numbers", () => {
    for (const rate of SUPPORTED_RATES) expect(isSupportedRate(rate)).toBe(true);
    expect(SUPPORTED_RATES).toEqual([8_000, 16_000, 24_000, 32_000, 44_100, 48_000]);
  });

  // A value the native side cannot hold must never reach it: Swift's Int32 conversion traps on 2^31, and a
  // NaN or an infinity traps earlier, in the number-to-integer conversion.
  it.each([NaN, Infinity, -Infinity, 2 ** 31, 2 ** 53, -16_000, 16_000.5, 22_050, 0])("refuse %s", (rate) => {
    expect(isSupportedRate(rate)).toBe(false);
  });
});
