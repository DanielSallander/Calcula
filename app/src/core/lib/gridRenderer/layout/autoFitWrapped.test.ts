//! FILENAME: app/src/core/lib/gridRenderer/layout/autoFitWrapped.test.ts
// PURPOSE: BUG-0727 -- AutoFit of WRAPPED text, horizontal and rotated, as
//          Excel fits it [LIVE, Excel 16, 2026-11-06, lane uimisc probe2;
//          Calibri 11, "one two three four five six seven eight"]:
//            - Column AutoFit fits a wrapped value AS IT WRAPS AT THE COLUMN'S
//              CURRENT WIDTH (its widest line): 213.75pt -> 178.5 (one line),
//              161.25 -> 152.25, 82.5 -> 66.75. Calcula skipped every
//              wrap-text cell, so the column never moved.
//            - Column AutoFit of a wrapped ROTATED value fits the block wrapped
//              at the ROW's height: 90 degrees in a 30pt row -> 139.5pt, in a
//              60pt row -> 64.5pt (more lines in the shorter row).
//            - Row AutoFit of a wrapped rotated value fits it on ONE line,
//              exactly as with Wrap Text off: 178.5pt at +-90, 132pt at +-45,
//              99.75pt at 30, whatever the column width -- and the painter,
//              wrapping at that height, then draws it on one line.
// CONTEXT: The measuring context is a 10px-per-character mock (jsdom has no
//          canvas), as in autoFitOrientation.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { measureOptimalColumnWidth, measureOptimalRowHeight, setMeasureContextForTesting, wrapText } from "./autoFit";
import { rotatedWrapLength } from "./textOrientation";
import type { CellData, StyleData } from "../../../types";

function createMockCtx(): CanvasRenderingContext2D {
  return {
    font: "",
    measureText: vi.fn((text: string) => ({ width: text.length * 10 })),
  } as unknown as CanvasRenderingContext2D;
}

const THEME = { cellFontFamily: "TestFont", cellFontSize: 13 };
const MIN_WIDTH = 20;
const PADDING_X = 3;
const PADDING_Y = 2;
const FIT_MARGIN = 2;
const LINE_H = ((13 * 96) / 72) * 1.2;

const base = { bold: false, italic: false, fontSize: 0, fontFamily: "", wrapText: false } as StyleData;
const STYLES: StyleData[] = [
  base,
  { ...base, wrapText: true } as StyleData, // 1: wrapped
  { ...base, wrapText: true, textRotation: "rotate90" } as StyleData, // 2: wrapped, Rotate Text Up
  { ...base, textRotation: "rotate90" } as StyleData, // 3: Rotate Text Up, no wrap
  { ...base, wrapText: true, textRotation: "custom:45" } as StyleData, // 4: wrapped at 45
  { ...base, textRotation: "custom:45" } as StyleData, // 5: 45, no wrap
];

function cell(display: string, styleIndex: number, row = 0): CellData {
  return { row, col: 0, display, formula: null, styleIndex } as CellData;
}

const layout = (currentWidth: number, rowHeight = 20) => ({ currentWidth, rowHeight: () => rowHeight });

function colFit(display: string, styleIndex: number, l?: ReturnType<typeof layout>): number | null {
  return measureOptimalColumnWidth(0, [cell(display, styleIndex)], STYLES, THEME, MIN_WIDTH, true, undefined, l);
}

beforeEach(() => setMeasureContextForTesting(createMockCtx()));
afterEach(() => setMeasureContextForTesting(null));

describe("BUG-0727 column AutoFit of a WRAPPED value: its widest line at the current width", () => {
  it("narrows a wide column to the value on one line (Excel: 213.75pt -> 178.5pt)", () => {
    // "aaaa bbbb cccc" is 140px; a 300px column holds it on one line.
    expect(colFit("aaaa bbbb cccc", 1, layout(300))).toBe(140 + PADDING_X * 2 + FIT_MARGIN);
  });

  it("fits the widest WRAPPED line, not the run-together value (Excel: 82.5pt -> 66.75pt)", () => {
    // 100px column, 94px of room: "aaaa bbbb" | " cccc" -- the widest is 90px.
    expect(colFit("aaaa bbbb cccc", 1, layout(100))).toBe(90 + PADDING_X * 2 + FIT_MARGIN);
  });

  it("follows the width it has now: the same value fits another width in another column", () => {
    // 60px (54 of room): "aaaa" | "bbbb" | "cccc", each 40px.
    expect(colFit("aaaa bbbb cccc", 1, layout(60))).toBe(40 + PADDING_X * 2 + FIT_MARGIN);
  });

  it("without the column's geometry a wrapped value sizes nothing (the old answer)", () => {
    expect(colFit("aaaa bbbb cccc", 1)).toBeNull();
  });
});

describe("BUG-0727 column AutoFit of a wrapped ROTATED value: wrapped at the ROW's height", () => {
  it("a shorter row breaks it into more lines, so the column must be wider (Excel: 30pt row 139.5pt, 60pt row 64.5pt)", () => {
    // Row 40px: content box 36px, so "aaa" | "bbb" | "ccc" -- three lines side by side.
    const short = colFit("aaa bbb ccc", 2, layout(100, 40));
    expect(short).toBe(Math.ceil(3 * LINE_H + PADDING_X * 2 + FIT_MARGIN));
    // Row 100px: content box 96px, so "aaa bbb " | "ccc" -- two lines.
    const tall = colFit("aaa bbb ccc", 2, layout(100, 100));
    expect(tall).toBe(Math.ceil(2 * LINE_H + PADDING_X * 2 + FIT_MARGIN));
    expect(short!).toBeGreaterThan(tall!);
  });

  it("a row tall enough for the whole value: one line, as with Wrap Text off", () => {
    expect(colFit("aaa bbb ccc", 2, layout(100, 200))).toBe(colFit("aaa bbb ccc", 3, layout(100, 200)));
  });
});

describe("BUG-0727 row AutoFit of a wrapped ROTATED value: ONE line, as Excel fits it", () => {
  const rowFit = (display: string, styleIndex: number, colWidth: number) =>
    measureOptimalRowHeight([cell(display, styleIndex)], STYLES, new Map([[0, colWidth]]), 100, THEME, 16, 24, 0);

  it("is the wrap-off height at 90 and 45 degrees, whatever the column width (Excel: 178.5pt / 132pt both ways)", () => {
    for (const width of [40, 200]) {
      expect(rowFit("aaa bbb ccc", 2, width)).toBe(rowFit("aaa bbb ccc", 3, width));
      expect(rowFit("aaa bbb ccc", 4, width)).toBe(rowFit("aaa bbb ccc", 5, width));
    }
    expect(rowFit("aaa bbb ccc", 2, 40)).toBe(110 + PADDING_Y * 2);
  });

  it("and at that height the painter wraps it on ONE line (no line is cut)", () => {
    const height = rowFit("aaa bbb ccc", 2, 40)!;
    const ctx = createMockCtx();
    const box = { left: 0, right: 40, top: PADDING_Y, bottom: height - PADDING_Y };
    expect(wrapText(ctx, "aaa bbb ccc", rotatedWrapLength(90, box))).toEqual(["aaa bbb ccc"]);
  });
});

// Ledger programme 2 wave 4 (dtcf4): a column NARROWER than the sheet's
// standard width wraps the value's words at the standard width for the fit
// [LIVE, Excel 16 over COM, 2026-11-06, dtui/probe4.ps1, Calibri 11, standard
// 48pt: "one two three four five six seven eight" fits 46.5pt at every width
// from 9pt to 45.75pt, 49.5 at 51pt; "WWWW WWWW" 41.25 at every width]. A word
// wider than the standard room keeps the current-width fit (Excel's character
// breaking follows another rule). SABOTAGE: make `wrappedFitRoom` always answer
// the current room -- fails at "WRAPPED AT THE NARROW WIDTH".
describe("column AutoFit of a wrapped value in a column narrower than the standard width", () => {
  const narrow = (currentWidth: number) => ({ currentWidth, rowHeight: () => 20, standardWidth: 64 });
  it("wraps the words at the standard width (Excel: 46.5pt from a 9pt column)", () => {
    // 64px standard, 58px of room: "aa bb" | "cc dd", 50px -- at the 30px
    // column's own 24px it would be "aa" | "bb" | "cc" | "dd", 20px.
    expect(colFit("aa bb cc dd", 1, narrow(30)), "WRAPPED AT THE NARROW WIDTH").toBe(50 + PADDING_X * 2 + FIT_MARGIN);
    expect(colFit("aa bb cc", 1, narrow(40)), "WRAPPED AT THE NARROW WIDTH (40px)").toBe(50 + PADDING_X * 2 + FIT_MARGIN);
    // "aaaa" | "bbbb" | "cccc", each 40px, from a 12px column.
    expect(colFit("aaaa bbbb cccc", 1, narrow(12))).toBe(40 + PADDING_X * 2 + FIT_MARGIN);
  });
  it("a column at least as wide as the standard wraps at its own width", () => {
    expect(colFit("aaaa bbbb cccc", 1, narrow(100))).toBe(90 + PADDING_X * 2 + FIT_MARGIN);
  });
  it("positive control: a word wider than the standard room keeps the current-width fit", () => {
    // "abcdefghijk" (110px) in a 30px column (24px): broken by character at 24.
    expect(colFit("abcdefghijk", 1, narrow(30))).toBe(colFit("abcdefghijk", 1, layout(30)));
  });
});
