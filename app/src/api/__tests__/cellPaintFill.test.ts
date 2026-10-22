//! FILENAME: app/src/api/__tests__/cellPaintFill.test.ts
// PURPOSE: @api/cellPaint isExplicitCellFill -- whether the grid paints a cell
//          background as given -- is the grid painter's own rule: a style's
//          "no fill" (absent, transparent, white) paints the active skin's cell
//          background instead, and so does anything the painter cannot read.
// CONTEXT: The writeback rejected-value ink chooses its colour by the fill a
//          cell SHOWS; under the Dark skin a style that says #ffffff shows dark
//          grey, so reading the style's colour alone would pick the wrong ink.

import { describe, it, expect } from "vitest";
import { isExplicitCellFill } from "../cellPaint";
import { isDefaultBackgroundColor, isValidColor } from "../../core/lib/gridRenderer/styles/styleUtils";

describe("isExplicitCellFill", () => {
  it("a style's 'no fill' paints the skin's background: absent, empty, transparent, white in its spellings", () => {
    for (const c of [undefined, null, "", "transparent", "#ffffff", "#FFFFFF", "#fff", "white", "rgb(255, 255, 255)", "rgba(0,0,0,0)"]) {
      expect(isExplicitCellFill(c), String(c)).toBe(false);
    }
  });

  it("a real fill is painted as given", () => {
    for (const c of ["#ffc7ce", "#1F4E79", "ffc7ce", "rgb(31, 78, 121)", "rgba(255, 0, 0, 0.5)", "red"]) {
      expect(isExplicitCellFill(c), c).toBe(true);
    }
  });

  it("something the grid painter cannot read is not a fill it paints", () => {
    for (const c of ["not a colour", "var(--x)", "#12"]) {
      expect(isExplicitCellFill(c), c).toBe(false);
    }
  });

  it("is exactly the grid painter's rule (cells.ts paints a background when it is valid and not the default)", () => {
    for (const c of [undefined, "", "#ffffff", "#fff", "white", "transparent", "#ffc7ce", "red", "rgb(1, 2, 3)", "oops"]) {
      expect(isExplicitCellFill(c), String(c)).toBe(isValidColor(c) && !isDefaultBackgroundColor(c));
    }
  });
});
