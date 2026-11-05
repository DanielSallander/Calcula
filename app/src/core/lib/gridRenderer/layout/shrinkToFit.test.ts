//! FILENAME: app/src/core/lib/gridRenderer/layout/shrinkToFit.test.ts
// PURPOSE: Shrink to Fit scales the font CONTINUOUSLY, as Excel does (BUG-0364).
// CONTEXT: Excel 16 [LIVE] 2026-11-04 set three Shrink to Fit cells of 11pt
//          Calibri at 5.76 / 4.20 / 7.56pt (PDF Tf operands) -- no whole or half
//          points. Both Calcula painters floored the size to a whole point.

import { describe, it, expect } from "vitest";
import { shrinkToFitFontSize } from "./shrinkToFit";

describe("shrinkToFitFontSize", () => {
  it("scales by available / width, without flooring to a whole point", () => {
    // 11pt text 100px wide in 52px: 5.72pt (the floor made it 5pt).
    expect(shrinkToFitFontSize(11, 100, 52)).toBeCloseTo(5.72, 9);
  });

  it("the scaled text fits the room exactly", () => {
    const size = shrinkToFitFontSize(11, 137, 61);
    // Text width is proportional to the size.
    expect((137 * size) / 11).toBeCloseTo(61, 9);
  });

  it("never enlarges a value that already fits", () => {
    expect(shrinkToFitFontSize(11, 40, 52)).toBe(11);
    expect(shrinkToFitFontSize(11, 52, 52)).toBe(11);
  });

  it("never goes below 1pt", () => {
    expect(shrinkToFitFontSize(11, 10_000, 5)).toBe(1);
  });
});
