//! FILENAME: app/src/core/lib/gridRenderer/rendering/cells.hardBreaks.test.ts
// PURPOSE: A hard break in a cell value breaks the LINE on the canvas.
// CONTEXT: The old behaviour was a SILENT WRONG ANSWER, not an error: the
//          newline survived the backend, survived the <textarea> editor that
//          showed it while you typed it, reached the painter intact -- and then
//          canvas `fillText` replaced it with U+0020, so `="a"&CHAR(10)&"b"`
//          painted `a b` on ONE line and nothing anywhere reported a problem.
//
// HOW THIS IS VERIFIED. Frames go through the real `renderGrid` with a
// recording 2D context, and the assertions read the glyph runs that reached
// fillText and the Y they landed on. EMPTY runs are kept on purpose: a
// deliberately blank line is a line, and dropping empty runs from the recording
// would make the three-line case indistinguishable from the two-line one.
//
// The fixture row is deliberately TALL (60px). Painting the break and growing
// the row for it are two halves of the same defect and they live in different
// files -- layout/autoFit.test.ts owns the height half. A short row here would
// clip the second line and confuse the two.

import { describe, it, expect } from "vitest";

import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
import { rowHeaderGutter, colHeaderGutter } from "../layout/headerVisibility";
import {
  DEFAULT_GRID_CONFIG,
  DEFAULT_STYLE,
  cellKey,
  type CellData,
  type CellDataMap,
  type GridConfig,
  type StyleData,
  type StyleDataMap,
  type Viewport,
} from "../../../types";

/** Glyph width at the DEFAULT cell font; the fake measurer scales from here. */
const CHAR_WIDTH = 6;
/** The default cell font in pixels -- 11pt at 96/72 (DEFAULT_STYLE.fontSize). */
const BASE_FONT_PX = (DEFAULT_STYLE.fontSize * 96) / 72;
/** The wrapped/broken line box: cells.ts multiplies the px font size by this. */
const LINE_HEIGHT = BASE_FONT_PX * 1.2;
/** paddingX in the cell renderer; the text box is the column minus 2x this. */
const PADDING_X = 3;

/** Room for exactly 6 glyphs (42 - 2*3 = 36px), for the spill cases. */
const NARROW_COLUMN = 42;
/** Room for 30 glyphs -- wide enough that nothing here wraps by accident. */
const WIDE_COLUMN = 186;
/** Tall enough to hold four line boxes, so nothing is clipped away. */
const TALL_ROW = 60;

const ROW = 1;
const COL = 1;

interface Glyphs {
  text: string;
  x: number;
  y: number;
}

function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; texts: Glyphs[] } {
  const texts: Glyphs[] = [];
  const api = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineCap: "butt",
    lineJoin: "miter",
    lineDashOffset: 0,
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    canvas: { width: 600, height: 200 },
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    rect() {},
    arc() {},
    clip() {},
    fill() {},
    stroke() {},
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    fillText(text: string, x: number, y: number) {
      texts.push({ text: String(text), x, y });
    },
    strokeText() {},
    measureText(text: string) {
      const px = /(\d+(?:\.\d+)?)px/.exec(this.font as string);
      const scale = px ? Number(px[1]) / BASE_FONT_PX : 1;
      return { width: String(text).length * CHAR_WIDTH * scale };
    },
    setLineDash() {},
    getLineDash() {
      return [];
    },
    translate() {},
    rotate() {},
    scale() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return null;
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, texts };
}

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 4,
  colCount: 6,
};

interface Fixture {
  /** The value in the cell under test. */
  display: string;
  /** Its style overrides -- `wrapText` above all. */
  style?: Partial<StyleData>;
  /** Column width; defaults to the wide one. */
  columnWidth?: number;
}

/**
 * Render one frame and return the glyph runs the CELL painted, in draw order.
 *
 * Row and column headers paint their own labels, and they are excluded BY
 * POSITION -- anything inside the top or left gutter -- rather than by matching
 * their text, so nothing here depends on a cell value never looking like a
 * header label.
 */
function paintedLines(fixture: Fixture): Glyphs[] {
  const columnWidth = fixture.columnWidth ?? WIDE_COLUMN;
  const config: GridConfig = {
    ...DEFAULT_GRID_CONFIG,
    defaultCellWidth: columnWidth,
    defaultCellHeight: TALL_ROW,
    totalRows: 50,
    totalCols: 12,
  };

  const styleCache: StyleDataMap = new Map();
  styleCache.set(0, DEFAULT_STYLE);
  styleCache.set(1, { ...DEFAULT_STYLE, ...(fixture.style ?? {}) });

  const cells: CellDataMap = new Map();
  cells.set(cellKey(ROW, COL), {
    row: ROW,
    col: COL,
    display: fixture.display,
    formula: null,
    styleIndex: 1,
  } as CellData);

  const { ctx, texts } = makeRecordingCtx();
  renderGrid(
    ctx,
    600,
    200,
    config,
    VIEWPORT,
    null,
    null,
    cells,
    DEFAULT_THEME,
    [],
    { columnWidths: new Map(), rowHeights: new Map() },
    styleCache
  );

  const left = rowHeaderGutter(config);
  const top = colHeaderGutter(config);
  return texts.filter((t) => t.x >= left && t.y >= top);
}

/** Just the strings, in draw order -- empty lines included. */
function paintedText(fixture: Fixture): string[] {
  return paintedLines(fixture).map((t) => t.text);
}

// ============================================================================
// Wrap Text OFF -- the path that had no line breaking at all
// ============================================================================

describe("a hard break breaks the line with Wrap Text OFF", () => {
  it("paints CHAR(10) as two lines, not one run with a space in it", () => {
    // The whole defect in one assertion: this used to be a single fillText of
    // "a\nb", which canvas renders as "a b".
    expect(paintedText({ display: "a\nb" })).toEqual(["a", "b"]);
  });

  it("stacks the lines downwards, one line box apart", () => {
    const lines = paintedLines({ display: "a\nb" });
    expect(lines).toHaveLength(2);
    expect(lines[1].y - lines[0].y).toBeCloseTo(LINE_HEIGHT, 5);
  });

  it("starts every line at the same left inset", () => {
    const lines = paintedLines({ display: "first\nsecond" });
    expect(lines.map((l) => l.text)).toEqual(["first", "second"]);
    expect(lines[1].x).toBe(lines[0].x);
  });

  it("keeps a DELIBERATELY BLANK line -- three breaks-separated parts, three lines", () => {
    // `="a" & CHAR(10) & CHAR(10) & "b"` is three lines with an empty middle
    // one. The wrapper drops whitespace-only leftovers so a wrapped line never
    // starts with the space run that pushed it over; applied to a hard break
    // that same rule silently ate the blank line the user asked for.
    const lines = paintedLines({ display: "a\n\nb" });
    expect(lines.map((l) => l.text)).toEqual(["a", "", "b"]);
    expect(lines[2].y - lines[0].y).toBeCloseTo(LINE_HEIGHT * 2, 5);
  });

  it("leaves a value with no break as a single run", () => {
    // Positive control: the ordinary cell must not have grown a second path.
    expect(paintedText({ display: "plain value" })).toEqual(["plain value"]);
  });
});

// ============================================================================
// The spellings a paste arrives in
// ============================================================================

describe("CRLF and a bare CR break exactly once", () => {
  it("treats CRLF (a Windows paste) as ONE break", () => {
    // A `[\r\n]` character class would answer three lines here, with a blank
    // one wedged between every pair.
    expect(paintedText({ display: "a\r\nb" })).toEqual(["a", "b"]);
  });

  it("treats a bare CR as a break", () => {
    expect(paintedText({ display: "a\rb" })).toEqual(["a", "b"]);
  });

  it("mixes the spellings in one value without inventing lines", () => {
    expect(paintedText({ display: "a\r\nb\nc\rd" })).toEqual(["a", "b", "c", "d"]);
  });
});

// ============================================================================
// Wrap Text ON -- the path that had a wrapper and still lost the break
// ============================================================================

describe("a hard break breaks the line with Wrap Text ON", () => {
  const wrap = { wrapText: true };

  it("breaks even when both halves would fit on one wrapped line", () => {
    // "ab cd" fits the box, so the wrapper had no reason to break it and the
    // newline went through as inter-word whitespace: ONE line, painted "ab cd".
    expect(paintedText({ display: "ab\ncd", style: wrap })).toEqual(["ab", "cd"]);
  });

  it("keeps a deliberately blank line through the wrapper too", () => {
    expect(paintedText({ display: "ab\n\ncd", style: wrap })).toEqual(["ab", "", "cd"]);
  });

  it("still soft-wraps each part at the column edge", () => {
    // 6-glyph box: "aaaa bbbb" wraps, then the hard break, then "cc".
    const lines = paintedText({
      display: "aaaa bbbb\ncc",
      style: wrap,
      columnWidth: NARROW_COLUMN,
    });
    expect(lines).toEqual(["aaaa ", "bbbb", "cc"]);
  });
});

// ============================================================================
// Spill
// ============================================================================

describe("a multi-line value does not spill into its neighbour", () => {
  it("centres the first line in its OWN cell, not in the borrowed run", () => {
    // Excel's spill rule is about one line running out of room, which is also
    // why a wrapped cell never spills. Measured run-together, "abc\ndef" is 7
    // glyphs against a 6-glyph box, so the spill block used to claim the empty
    // neighbour and widen the text box by a whole column -- and a CENTRED line
    // is painted at a different x in a widened box, which is what this reads.
    const broken = paintedLines({
      display: "abc\ndef",
      style: { textAlign: "center" },
      columnWidth: NARROW_COLUMN,
    });
    const unbroken = paintedLines({
      display: "abc",
      style: { textAlign: "center" },
      columnWidth: NARROW_COLUMN,
    });
    expect(broken.map((l) => l.text)).toEqual(["abc", "def"]);
    expect(unbroken.map((l) => l.text)).toEqual(["abc"]);
    expect(broken[0].x).toBeCloseTo(unbroken[0].x, 5);
  });

  it("still spills an ordinary single-line value", () => {
    // Positive control for the gate above: suppressing the spill for EVERY
    // value would pass the previous test and quietly break Excel's overflow
    // rule instead. "abcdefgh" is 8 glyphs against a 6-glyph box, so it claims
    // the empty neighbour, and being centred in the WIDENED box is what puts it
    // further right than a value that fits.
    const spilled = paintedLines({
      display: "abcdefgh",
      style: { textAlign: "center" },
      columnWidth: NARROW_COLUMN,
    });
    const fits = paintedLines({
      display: "abc",
      style: { textAlign: "center" },
      columnWidth: NARROW_COLUMN,
    });
    // Derived from the fixture, not from the renderer: the cell under test is
    // the second column, and the spill claims exactly one neighbour.
    const cellLeft = rowHeaderGutter(DEFAULT_GRID_CONFIG) + NARROW_COLUMN;
    const widenedBox = NARROW_COLUMN * 2 - PADDING_X * 2;
    const glyphRun = "abcdefgh".length * CHAR_WIDTH;
    expect(spilled[0].x).toBeCloseTo(cellLeft + PADDING_X + (widenedBox - glyphRun) / 2, 5);
    expect(spilled[0].x).toBeGreaterThan(fits[0].x);
  });
});

// ============================================================================
// Classification
// ============================================================================

describe("a hard break is decisive evidence of TEXT", () => {
  it("does not mark a broken pair of digits as a too-narrow number", () => {
    // `isNumericValue` strips ALL whitespace before parsing, so "1\n2" reads as
    // the number 12 whenever the backend's transported class is absent -- and a
    // numeric that does not fit is painted '######', never spilled. A value
    // with a newline in it is a string; no number format emits one.
    expect(paintedText({ display: "1\n2", columnWidth: NARROW_COLUMN })).toEqual(["1", "2"]);
  });
});
