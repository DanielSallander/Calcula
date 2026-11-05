//! FILENAME: app/src/core/lib/gridRenderer/layout/textOrientation.test.ts
// PURPOSE: The geometry of rotated and STACKED cell text -- where Excel puts it
//          inside a cell, and how much room it needs -- as pure functions, so
//          the painter (rendering/cells.ts) and row/column AutoFit
//          (layout/autoFit.ts) can never disagree about it.
// CONTEXT: Every expectation below that names an Excel side or extent was
//          MEASURED on Excel 16 build 20430 (2026-10-04, renderer lane probe:
//          a fresh hidden instance, new unsaved workbook, PDF of a picture
//          sheet rendered and read back):
//            - Rotate Text Up (+90) with General alignment sits at the cell's
//              RIGHT edge; Rotate Text Down (-90) at its LEFT edge.
//            - +45 with General hugs the LEFT side; -45 the RIGHT side.
//            - Stacked (Vertical Text) with General is CENTRED.
//            - Vertical alignment places the block along the cell's height
//              (Top / Middle / Bottom) at every angle.
//            - Stacked AutoFit grows by one line per character, a SPACE
//              included ("Ab" 29.3pt, "A b" 43.5pt, 10 chars 143.3pt).
//            - Angled AutoFit follows w*|sin| + h*|cos| ("ABCDEFGHIJ": 90deg
//              60.4pt, 45deg 52.5pt, 30deg 42.4pt, 0deg 14.3pt).

import { describe, it, expect } from "vitest";
import {
  parseTextOrientation,
  rotatedTextExtent,
  layoutRotatedText,
  layoutStackedText,
  stackedTextExtent,
  rotatedHorizontalSide,
  rotatedWrapLength,
  layoutRotatedLines,
  ORIENTATION_LINE_HEIGHT_FACTOR,
} from "./textOrientation";

describe("rotated text on several lines (BUG-0363)", () => {
  // Excel [LIVE] 2026-11-04: Rotate Text Up with Wrap Text breaks at the ROW
  // HEIGHT (column AutoFit 117.75pt in a 30pt row, 60.75pt in a 60pt row; one
  // line 18pt), and at 45 degrees along the slant through the height.
  const BOX = { left: 0, top: 0, right: 100, bottom: 80 };
  const LH = 10;

  it("wraps along the text: the box height at +-90, the slant at an angle", () => {
    expect(rotatedWrapLength(90, BOX)).toBe(80);
    expect(rotatedWrapLength(-90, BOX)).toBe(80);
    expect(rotatedWrapLength(45, BOX)).toBeCloseTo(80 * Math.SQRT2, 9);
  });

  it("one line is placed exactly as a single rotated run", () => {
    const one = layoutRotatedLines({ degrees: 90, lines: [{ text: "ab", width: 30 }], lineHeight: LH, box: BOX, hAlign: "general", vAlign: "bottom" });
    const run = layoutRotatedText({ degrees: 90, textWidth: 30, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "bottom" });
    expect({ cx: one.cx, cy: one.cy, radians: one.radians }).toEqual({ cx: run.cx, cy: run.cy, radians: run.radians });
    expect(one.lines).toEqual([{ text: "ab", x: -15, y: 0 }]);
  });

  it("Rotate Text Up: lines stack across the cell, the first one LEFTMOST, each starting at the bottom", () => {
    const p = layoutRotatedLines({
      degrees: 90,
      lines: [{ text: "one two ", width: 48 }, { text: "three four", width: 60 }],
      lineHeight: LH,
      box: BOX,
      hAlign: "general",
      vAlign: "bottom",
    });
    // The block is 60 along the text by 2 lines across it, at the right edge
    // (General +90) and its start at the bottom.
    expect(p.cx).toBeCloseTo(100 - LH, 9);
    expect(p.cy).toBeCloseTo(80 - 30, 9);
    // In the rotated frame (-90deg on screen), +y is screen RIGHT: line 0 sits
    // left of line 1.
    expect(p.lines.map((l) => l.y)).toEqual([-LH / 2, LH / 2]);
    // Bottom-aligned Rotate Text Up: every line STARTS at the block's start.
    expect(p.lines.map((l) => l.x)).toEqual([-30, -30]);
  });

  it("Top alignment ends every line at the top; Rotate Text Down mirrors it", () => {
    const up = layoutRotatedLines({
      degrees: 90,
      lines: [{ text: "a", width: 20 }, { text: "bb", width: 40 }],
      lineHeight: LH, box: BOX, hAlign: "general", vAlign: "top",
    });
    expect(up.lines.map((l) => l.x + (l.text === "a" ? 20 : 40))).toEqual([20, 20]);
    const down = layoutRotatedLines({
      degrees: -90,
      lines: [{ text: "a", width: 20 }, { text: "bb", width: 40 }],
      lineHeight: LH, box: BOX, hAlign: "general", vAlign: "top",
    });
    // Rotate Text Down reads top-to-bottom: Top is where each line STARTS.
    expect(down.lines.map((l) => l.x)).toEqual([-20, -20]);
  });
});

/** 8px per character, the measure every case below uses. */
const measure = (text: string): number => text.length * 8;

const BOX = { left: 103, top: 202, right: 197, bottom: 298 }; // 94 x 96 content box

describe("parseTextOrientation: every spelling the backend reports", () => {
  it("reads the named values and custom angles", () => {
    expect(parseTextOrientation("none")).toEqual({ kind: "horizontal" });
    expect(parseTextOrientation(undefined)).toEqual({ kind: "horizontal" });
    expect(parseTextOrientation("")).toEqual({ kind: "horizontal" });
    expect(parseTextOrientation("rotate90")).toEqual({ kind: "angle", degrees: 90 });
    expect(parseTextOrientation("rotate270")).toEqual({ kind: "angle", degrees: -90 });
    expect(parseTextOrientation("custom:45")).toEqual({ kind: "angle", degrees: 45 });
    expect(parseTextOrientation("custom:-45")).toEqual({ kind: "angle", degrees: -45 });
    expect(parseTextOrientation("vertical")).toEqual({ kind: "stacked" });
  });

  it("treats a zero angle as horizontal and clamps to Excel's -90..90", () => {
    expect(parseTextOrientation("custom:0")).toEqual({ kind: "horizontal" });
    expect(parseTextOrientation("custom:120")).toEqual({ kind: "angle", degrees: 90 });
    expect(parseTextOrientation("custom:-300")).toEqual({ kind: "angle", degrees: -90 });
  });

  it("an unknown value paints horizontally rather than at some guessed angle", () => {
    expect(parseTextOrientation("sideways")).toEqual({ kind: "horizontal" });
    expect(parseTextOrientation("custom:abc")).toEqual({ kind: "horizontal" });
  });
});

describe("rotatedTextExtent: the axis-aligned box a rotated line occupies", () => {
  it("at 90 degrees the text's length becomes the height", () => {
    const e = rotatedTextExtent(60, 18, 90);
    expect(e.width).toBeCloseTo(18, 9);
    expect(e.height).toBeCloseTo(60, 9);
  });

  it("at 45 degrees both sides are (w + h) / sqrt 2, whichever way it leans", () => {
    for (const deg of [45, -45]) {
      const e = rotatedTextExtent(60, 18, deg);
      expect(e.width).toBeCloseTo(78 * Math.SQRT1_2, 9);
      expect(e.height).toBeCloseTo(78 * Math.SQRT1_2, 9);
    }
  });

  it("reproduces Excel's measured 0 / 30 / 45 / 90 ordering for one string", () => {
    // Not Excel's pixels (its font is not ours) -- its SHAPE: taller with the
    // angle, never taller than the 90-degree height plus one line.
    const h = (deg: number) => rotatedTextExtent(60, 18, deg).height;
    expect(h(30)).toBeGreaterThan(h(0));
    expect(h(45)).toBeGreaterThan(h(30));
    expect(h(90)).toBeGreaterThan(h(45));
  });
});

describe("rotatedHorizontalSide: what General means for rotated text", () => {
  it("matches Excel's measured sides", () => {
    expect(rotatedHorizontalSide("general", 90)).toBe("right");
    expect(rotatedHorizontalSide("general", -90)).toBe("left");
    expect(rotatedHorizontalSide("general", 45)).toBe("left");
    expect(rotatedHorizontalSide("general", -45)).toBe("right");
    expect(rotatedHorizontalSide("", 30)).toBe("left");
  });

  it("an explicit alignment is kept as it is", () => {
    for (const deg of [90, -90, 45, -45]) {
      expect(rotatedHorizontalSide("left", deg)).toBe("left");
      expect(rotatedHorizontalSide("center", deg)).toBe("center");
      expect(rotatedHorizontalSide("right", deg)).toBe("right");
    }
  });
});

describe("layoutRotatedText: Excel's placement inside the cell", () => {
  const LH = 18;
  const TW = 40;

  it("Rotate Text Up, General, Bottom: right edge, reading up from the bottom", () => {
    const p = layoutRotatedText({ degrees: 90, textWidth: TW, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "bottom" });
    expect(p.radians).toBeCloseTo(-Math.PI / 2, 9);
    expect(p.cx).toBeCloseTo(BOX.right - LH / 2, 9);
    expect(p.cy).toBeCloseTo(BOX.bottom - TW / 2, 9);
  });

  it("Rotate Text Down, General, Top: left edge, reading down from the top", () => {
    const p = layoutRotatedText({ degrees: -90, textWidth: TW, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "top" });
    expect(p.radians).toBeCloseTo(Math.PI / 2, 9);
    expect(p.cx).toBeCloseTo(BOX.left + LH / 2, 9);
    expect(p.cy).toBeCloseTo(BOX.top + TW / 2, 9);
  });

  it("vertical alignment moves the text along the cell's height (it used to be ignored)", () => {
    const at = (vAlign: "top" | "middle" | "bottom") =>
      layoutRotatedText({ degrees: 90, textWidth: TW, lineHeight: LH, box: BOX, hAlign: "general", vAlign }).cy;
    expect(at("top")).toBeCloseTo(BOX.top + TW / 2, 9);
    expect(at("middle")).toBeCloseTo((BOX.top + BOX.bottom) / 2, 9);
    expect(at("bottom")).toBeCloseTo(BOX.bottom - TW / 2, 9);
  });

  it("45 degrees, General, Bottom: the block sits in the bottom-LEFT corner", () => {
    const p = layoutRotatedText({ degrees: 45, textWidth: TW, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "bottom" });
    const side = (TW + LH) * Math.SQRT1_2;
    expect(p.radians).toBeCloseTo(-Math.PI / 4, 9);
    expect(p.cx).toBeCloseTo(BOX.left + side / 2, 9);
    expect(p.cy).toBeCloseTo(BOX.bottom - side / 2, 9);
  });

  it("-45 degrees, General, Top: the block sits in the top-RIGHT corner", () => {
    const p = layoutRotatedText({ degrees: -45, textWidth: TW, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "top" });
    const side = (TW + LH) * Math.SQRT1_2;
    expect(p.radians).toBeCloseTo(Math.PI / 4, 9);
    expect(p.cx).toBeCloseTo(BOX.right - side / 2, 9);
    expect(p.cy).toBeCloseTo(BOX.top + side / 2, 9);
  });

  it("explicit Center / Right move the block across the cell", () => {
    const c = layoutRotatedText({ degrees: 90, textWidth: TW, lineHeight: LH, box: BOX, hAlign: "center", vAlign: "bottom" });
    expect(c.cx).toBeCloseTo((BOX.left + BOX.right) / 2, 9);
    const l = layoutRotatedText({ degrees: 90, textWidth: TW, lineHeight: LH, box: BOX, hAlign: "left", vAlign: "bottom" });
    expect(l.cx).toBeCloseTo(BOX.left + LH / 2, 9);
  });

  it("text longer than the cell is anchored by its alignment, NOT shortened to the cell height", () => {
    // The old painter measured the run against `cell height - padding` and
    // pivoted on the cell centre, so a long value was centred and lost BOTH
    // ends. Excel anchors it: bottom-aligned Rotate Up shows its START.
    const long = 300;
    const p = layoutRotatedText({ degrees: 90, textWidth: long, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "bottom" });
    // The run's start (its bottom end) is exactly at the box bottom.
    expect(p.cy + long / 2).toBeCloseTo(BOX.bottom, 9);
  });
});

describe("layoutStackedText: Excel's Vertical Text", () => {
  const LH = 20;

  it("one character per line, centred under General, from the top under Top", () => {
    const draws = layoutStackedText({ text: "Ab", measure, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "top" });
    expect(draws.map((d) => d.text)).toEqual(["A", "b"]);
    const centre = (BOX.left + BOX.right) / 2;
    for (const d of draws) expect(d.x + measure(d.text) / 2).toBeCloseTo(centre, 9);
    expect(draws[0].y).toBeCloseTo(BOX.top + LH / 2, 9);
    expect(draws[1].y).toBeCloseTo(BOX.top + LH + LH / 2, 9);
  });

  it("a SPACE keeps its line, as Excel's AutoFit measured it does", () => {
    const draws = layoutStackedText({ text: "A b", measure, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "top" });
    // Two glyphs are painted, but "b" is on the THIRD line.
    expect(draws.map((d) => d.text)).toEqual(["A", "b"]);
    expect(draws[1].y).toBeCloseTo(BOX.top + 2 * LH + LH / 2, 9);
  });

  it("Bottom puts the LAST character on the bottom line; Middle centres the stack", () => {
    const bottom = layoutStackedText({ text: "abc", measure, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "bottom" });
    expect(bottom[2].y).toBeCloseTo(BOX.bottom - LH / 2, 9);
    const middle = layoutStackedText({ text: "abc", measure, lineHeight: LH, box: BOX, hAlign: "general", vAlign: "middle" });
    expect((middle[0].y + middle[2].y) / 2).toBeCloseTo((BOX.top + BOX.bottom) / 2, 9);
  });

  it("Left and Right put the stack against that edge", () => {
    const left = layoutStackedText({ text: "a", measure, lineHeight: LH, box: BOX, hAlign: "left", vAlign: "top" });
    expect(left[0].x).toBeCloseTo(BOX.left, 9);
    const right = layoutStackedText({ text: "a", measure, lineHeight: LH, box: BOX, hAlign: "right", vAlign: "top" });
    expect(right[0].x + 8).toBeCloseTo(BOX.right, 9);
  });

  it("characters of different widths share ONE centre line", () => {
    const wide = (t: string) => (t === "W" ? 16 : 4);
    const draws = layoutStackedText({ text: "Wi", measure: wide, lineHeight: LH, box: BOX, hAlign: "left", vAlign: "top" });
    expect(draws[0].x + 16 / 2).toBeCloseTo(draws[1].x + 4 / 2, 9);
    expect(draws[0].x).toBeCloseTo(BOX.left, 9);
  });

  it("a hard break starts a second column to the right", () => {
    const draws = layoutStackedText({ text: "ab\ncd", measure, lineHeight: LH, box: BOX, hAlign: "left", vAlign: "top" });
    expect(draws.map((d) => d.text)).toEqual(["a", "b", "c", "d"]);
    expect(draws[2].x).toBeGreaterThan(draws[0].x);
    expect(draws[2].y).toBeCloseTo(draws[0].y, 9);
  });

  it("splits on code points, so a surrogate pair stays one character", () => {
    const draws = layoutStackedText({ text: "a\u{1F600}", measure, lineHeight: LH, box: BOX, hAlign: "left", vAlign: "top" });
    expect(draws.map((d) => d.text)).toEqual(["a", "\u{1F600}"]);
  });

  it("stackedTextExtent counts lines the way the painter lays them out", () => {
    expect(stackedTextExtent("Ab", measure, LH)).toEqual({ width: 8, height: 2 * LH });
    expect(stackedTextExtent("A b", measure, LH).height).toBe(3 * LH);
    expect(stackedTextExtent("ab\nc", measure, LH).height).toBe(2 * LH);
    expect(stackedTextExtent("ab\nc", measure, LH).width).toBeGreaterThan(16);
  });

  it("the line pitch is the wrap painter's line height", () => {
    expect(ORIENTATION_LINE_HEIGHT_FACTOR).toBe(1.2);
  });
});
