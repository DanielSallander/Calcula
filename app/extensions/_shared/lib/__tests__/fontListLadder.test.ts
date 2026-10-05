//! FILENAME: app/extensions/_shared/lib/__tests__/fontListLadder.test.ts
// PURPOSE: The Home tab reaches Excel's Increase / Decrease Font Size ladder
//          through this folder, the shell's mini toolbar through @api -- and
//          both must be the SAME ladder, not a copy (review finding (i),
//          2026-10-04: the toolbar's copy had no 26 and wrote past both ends).

import { describe, it, expect } from "vitest";
import { FONT_SIZE_LADDER, fontSizeStep } from "../fontList";
import * as api from "@api/fontSizeLadder";

describe("_shared/lib/fontList's ladder", () => {
  it("is @api's ladder itself, not a second copy", () => {
    expect(FONT_SIZE_LADDER).toBe(api.FONT_SIZE_LADDER);
    expect(fontSizeStep).toBe(api.fontSizeStep);
  });

  it("steps as Excel does (spot check: 24 -> 26, nothing past 72)", () => {
    expect(fontSizeStep(24, 1)).toBe(26);
    expect(fontSizeStep(72, 1)).toBeNull();
  });
});
