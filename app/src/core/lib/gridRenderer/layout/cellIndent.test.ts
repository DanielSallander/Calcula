//! FILENAME: app/src/core/lib/gridRenderer/layout/cellIndent.test.ts
// PURPOSE: Where an INDENTED value is drawn, as Excel draws it.
// CONTEXT: The painter used to indent every value from the LEFT edge (so a
//          right-aligned value showed no indent at all and a centred one slid
//          right by half of it). Measured on Excel 16 build 20430 (2026-10-04,
//          COM, fresh hidden instance, new unsaved workbook):
//            - setting IndentLevel 2 on General or Center turns the alignment
//              into LEFT; on Right it stays RIGHT (and the indent is measured
//              from the right edge);
//            - AutoFit width grows by one fixed step per level (Aptos Narrow 11:
//              8.625 / 14.25 / 19.875 / 25.5pt for levels 0..3).
//          So Excel never draws a centred value with an indent, and an indented
//          General value is drawn as a Left one.

import { describe, it, expect } from "vitest";
import {
  INDENT_PX_PER_LEVEL,
  alignmentWithIndent,
  effectiveIndentPx,
  indentedTextBox,
} from "./cellIndent";

describe("alignmentWithIndent", () => {
  it("an indented General value is drawn as Left, text or number", () => {
    expect(alignmentWithIndent("general", "right", 2)).toBe("left");
    expect(alignmentWithIndent("general", "left", 1)).toBe("left");
    expect(alignmentWithIndent("", "right", 1)).toBe("left");
  });

  it("without an indent General keeps the side the value earned", () => {
    expect(alignmentWithIndent("general", "right", 0)).toBe("right");
    expect(alignmentWithIndent("general", "center", 0)).toBe("center");
  });

  it("explicit alignments are kept", () => {
    expect(alignmentWithIndent("right", "right", 3)).toBe("right");
    expect(alignmentWithIndent("left", "left", 3)).toBe("left");
    expect(alignmentWithIndent("center", "center", 3)).toBe("center");
  });
});

describe("effectiveIndentPx", () => {
  it("is one step per level for Left, Right and General", () => {
    expect(effectiveIndentPx("left", 2)).toBe(2 * INDENT_PX_PER_LEVEL);
    expect(effectiveIndentPx("right", 3)).toBe(3 * INDENT_PX_PER_LEVEL);
    expect(effectiveIndentPx("general", 1)).toBe(INDENT_PX_PER_LEVEL);
  });

  it("is nothing for Center (Excel has no centred indent) or for no indent", () => {
    expect(effectiveIndentPx("center", 4)).toBe(0);
    expect(effectiveIndentPx("left", 0)).toBe(0);
    expect(effectiveIndentPx("left", undefined)).toBe(0);
  });
});

describe("indentedTextBox", () => {
  it("Left: the box starts one indent in from the left edge", () => {
    expect(indentedTextBox("left", 10, 110, 16)).toEqual({ x: 26, width: 84 });
  });

  it("Right: the box ends one indent in from the RIGHT edge", () => {
    // Drawn right-aligned inside it, the value's right end lands at 110 - 16.
    const box = indentedTextBox("right", 10, 110, 16);
    expect(box).toEqual({ x: 10, width: 84 });
    expect(box.x + box.width).toBe(94);
  });

  it("Center: the indent is ignored and the value is centred in the whole cell", () => {
    expect(indentedTextBox("center", 10, 110, 16)).toEqual({ x: 10, width: 100 });
  });
});
