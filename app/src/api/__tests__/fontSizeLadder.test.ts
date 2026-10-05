//! FILENAME: app/src/api/__tests__/fontSizeLadder.test.ts
// PURPOSE: Excel's Increase / Decrease Font Size ladder, ONE copy for every
//          door: the Home tab's buttons and the mini format toolbar's Grow /
//          Shrink (review finding (i), 2026-10-04).
// CONTEXT: The mini toolbar kept a ladder of its own with no 26 and wrote past
//          both ends: at 24pt Home gave 26 and the toolbar 28, at 72pt Home wrote
//          nothing and the toolbar wrote 74 (an undo step for nothing), at 8pt
//          the toolbar wrote 6. Measured live in Excel 16 (rust-format probe1):
//          Decrease from 11 gives 10, 9, 8, 8; Increase from 72 and from 400
//          changes nothing; Decrease from 10.3 gives 10.

import { describe, it, expect } from "vitest";
import { FONT_SIZE_LADDER, fontSizeStep } from "../fontSizeLadder";

describe("Excel's font-size ladder", () => {
  it("is Excel's sixteen steps, 26 included", () => {
    expect(FONT_SIZE_LADDER).toEqual([8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]);
  });

  it("steps up and down one rung", () => {
    expect(fontSizeStep(24, 1)).toBe(26);
    expect(fontSizeStep(26, -1)).toBe(24);
    expect(fontSizeStep(11, 1)).toBe(12);
    expect(fontSizeStep(11, -1)).toBe(10);
  });

  it("a size between rungs moves to the next rung in the button's direction", () => {
    expect(fontSizeStep(10.5, 1)).toBe(11);
    expect(fontSizeStep(10.3, -1)).toBe(10);
  });

  it("past either end Excel changes NOTHING: null, so nothing is written", () => {
    expect(fontSizeStep(72, 1)).toBeNull();
    expect(fontSizeStep(400, 1)).toBeNull();
    expect(fontSizeStep(8, -1)).toBeNull();
    expect(fontSizeStep(6, -1)).toBeNull();
  });

  // That extensions reach the SAME ladder through _shared/lib/fontList (no
  // second copy) is pinned on that side: extensions/_shared/lib/__tests__/
  // fontListLadder.test.ts (@api may not import an extension folder).
});
