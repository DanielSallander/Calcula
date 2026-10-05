//! FILENAME: app/src/core/lib/gridRenderer/layout/autoFitOrientation.test.ts
// PURPOSE: Row and column AutoFit for ROTATED and STACKED text, and the indent
//          rule AutoFit shares with the painter.
// CONTEXT: The Home tab's Orientation menu runs AUTOFIT_ROW_HEIGHT { growOnly }
//          after rotating text, which is how Excel keeps rotated text readable
//          (it grows the row: "Sample text" in a 14.3pt row went to 49.2pt at
//          45 degrees, 55.5pt at 90 and 157.5pt stacked -- measured live). Row
//          AutoFit had NO rotation term, so it handed back the default height
//          and the rotated text stayed cut in a 20px row.
//
//          The extents come from layout/textOrientation.ts, the same functions
//          the painter places the text with; these cases pin that AutoFit uses
//          them, with the padding the painter insets the text by.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  measureOptimalColumnWidth,
  measureOptimalRowHeight,
  setMeasureContextForTesting,
} from "./autoFit";
import type { CellData, StyleData } from "../../../types";

// Mock 2D context: 10px per character.
function createMockCtx(): CanvasRenderingContext2D {
  return {
    font: "",
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
  } as unknown as CanvasRenderingContext2D;
}

const THEME = { cellFontFamily: "TestFont", cellFontSize: 13 };
const MIN_WIDTH = 20;
const MIN_HEIGHT = 16;
const DEFAULT_ROW_HEIGHT = 24;
const DEFAULT_COL_WIDTH = 100;
const PADDING_Y = 2;
const PADDING_X = 3;
const FIT_MARGIN = 2;
/** 13pt in px, and the line pitch rotated / stacked text is laid out on. */
const LINE_H = ((13 * 96) / 72) * 1.2;

const base = { bold: false, italic: false, fontSize: 0, fontFamily: "", wrapText: false } as StyleData;
const STYLES: StyleData[] = [
  base,
  { ...base, textRotation: "rotate90" } as StyleData, // 1
  { ...base, textRotation: "custom:45" } as StyleData, // 2
  { ...base, textRotation: "vertical" } as StyleData, // 3
  { ...base, textRotation: "rotate270" } as StyleData, // 4
  { ...base, textAlign: "center", indent: 3 } as StyleData, // 5
  { ...base, textAlign: "right", indent: 3 } as StyleData, // 6
  { ...base, textAlign: "center", indent: 3, wrapText: true } as StyleData, // 7
];

function cell(display: string, styleIndex: number, overrides: Partial<CellData> = {}): CellData {
  return { row: 0, col: 0, display, formula: null, styleIndex, ...overrides } as CellData;
}

function rowHeight(cells: CellData[]): number | null {
  return measureOptimalRowHeight(cells, STYLES, new Map(), DEFAULT_COL_WIDTH, THEME, MIN_HEIGHT, DEFAULT_ROW_HEIGHT, 0);
}

beforeEach(() => setMeasureContextForTesting(createMockCtx()));
afterEach(() => setMeasureContextForTesting(null));

describe("measureOptimalRowHeight: rotated text", () => {
  it("Rotate Text Up: the row is as tall as the text is long", () => {
    // 10 chars * 10px = 100, plus the painter's top and bottom inset.
    expect(rowHeight([cell("abcdefghij", 1)])).toBe(Math.ceil(100 + PADDING_Y * 2));
    expect(rowHeight([cell("abcdefghij", 4)])).toBe(Math.ceil(100 + PADDING_Y * 2));
  });

  it("45 degrees: (w + h) / sqrt 2 -- Excel's w|sin| + h|cos|", () => {
    expect(rowHeight([cell("abcdefghij", 2)])).toBe(Math.ceil((100 + LINE_H) * Math.SQRT1_2 + PADDING_Y * 2));
  });

  it("is NOT clamped back to the default height (the one-line rule is for horizontal text)", () => {
    expect(rowHeight([cell("abcdefghij", 1)])).toBeGreaterThan(DEFAULT_ROW_HEIGHT);
  });

  it("a rotated value shorter than a line never shrinks the row below one line", () => {
    expect(rowHeight([cell("x", 1)])).toBe(DEFAULT_ROW_HEIGHT);
  });

  it("the tallest cell of the row wins", () => {
    expect(rowHeight([cell("abc", 0), cell("abcdefghij", 1, { col: 1 })])).toBe(104);
  });
});

describe("measureOptimalRowHeight: stacked (Vertical Text)", () => {
  it("one line per character", () => {
    expect(rowHeight([cell("abc", 3)])).toBe(Math.ceil(3 * LINE_H + PADDING_Y * 2));
  });

  it("a space keeps its line ('A b' is three lines in Excel)", () => {
    expect(rowHeight([cell("a b", 3)])).toBe(rowHeight([cell("abc", 3)]));
  });
});

describe("measureOptimalColumnWidth: rotated and stacked text", () => {
  it("Rotate Text Up needs one LINE of width, not the text's length", () => {
    // Horizontal, this value needs 100 + 6 + 2 = 108.
    expect(measureOptimalColumnWidth(0, [cell("abcdefghij", 1)], STYLES, THEME, MIN_WIDTH)).toBe(
      Math.ceil(LINE_H + PADDING_X * 2 + FIT_MARGIN),
    );
  });

  it("stacked text needs its widest character", () => {
    // Two columns ("ab" / "cd") of 10px glyphs and a quarter-line gap.
    expect(measureOptimalColumnWidth(0, [cell("ab\ncd", 3)], STYLES, THEME, MIN_WIDTH)).toBe(
      Math.ceil(10 + LINE_H * 0.25 + 10 + PADDING_X * 2 + FIT_MARGIN),
    );
  });
});

describe("AutoFit and the indent, as the painter draws it", () => {
  it("a CENTRED value's indent does not widen the column (Excel has no centred indent)", () => {
    expect(measureOptimalColumnWidth(0, [cell("abc", 5)], STYLES, THEME, MIN_WIDTH)).toBe(30 + 6 + 2);
  });

  it("a RIGHT-aligned value's indent does", () => {
    expect(measureOptimalColumnWidth(0, [cell("abc", 6)], STYLES, THEME, MIN_WIDTH)).toBe(30 + 3 * 8 + 6 + 2);
  });

  it("a centred WRAPPED value wraps at the full width, as the painter wraps it", () => {
    // 100 - 6 = 94px of room: "aaaa bbbb cccc" (140px) wraps to two lines at 94
    // and would wrap to THREE at 94 - 24 if the indent were (wrongly) taken off.
    const twoLines = Math.ceil(2 * LINE_H + PADDING_Y * 2);
    expect(rowHeight([cell("aaaa bbbb cccc", 7)])).toBe(twoLines);
  });
});
