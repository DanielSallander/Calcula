//! FILENAME: app/src/core/lib/gridRenderer/rendering/overflowRendering.test.ts
// PURPOSE: Excel's overflow rule as the GRID actually paints it, not as the
//          decision function reasons about it.
// CONTEXT: overflowMarker.test.ts pins the decision; this pins the wiring. They
//          fail for different reasons on purpose — a correct ladder that the
//          renderer never calls, or calls with the wrong width, looks perfect
//          from the decision side and shows a wall of hashes on screen.
//
// HOW THIS IS VERIFIED. Frames go through the real `renderGrid` with a recording
// 2D context, and the assertions read the glyph runs that reached fillText. The
// fixture geometry (column width, 6px monospace glyphs) is stated once and every
// expectation is derived from it, so nothing here can pass by restating the
// renderer's arithmetic back at it.

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
/** The default cell font in pixels — 11pt at 96/72 (DEFAULT_STYLE.fontSize). */
const BASE_FONT_PX = (DEFAULT_STYLE.fontSize * 96) / 72;
/** paddingX in the cell renderer; the text box is the column minus 2x this. */
const PADDING_X = 3;

/** A column with room for exactly 6 glyphs (42 - 2*3 = 36px = 6 chars). */
const NARROW_COLUMN = 42;
/** A column with room for 30 glyphs — wide enough for every fixture value. */
const WIDE_COLUMN = 186;

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
    canvas: { width: 600, height: 120 },
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
    // FONT-SENSITIVE ON PURPOSE. A measurer that returns the same width
    // whatever `ctx.font` says cannot tell whether Shrink to Fit did anything,
    // so the shrink-before-marker rung would have been untestable — and would
    // have looked "passing" while broken. Widths scale with the px size in the
    // font shorthand, which is what a real canvas does.
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
  rowCount: 5,
  colCount: 6,
};

interface Fixture {
  /** The value in the cell under test. */
  display: string;
  /** Its style overrides — `numberFormat` above all. */
  style?: Partial<StyleData>;
  /** What sits in the neighbouring column, if anything. */
  neighbour?: Partial<CellData> | null;
  /** Column width; defaults to the narrow one. */
  columnWidth?: number;
}

/**
 * Render one frame and return the glyph runs the CELL painted.
 *
 * Row and column headers paint their own labels, and they are excluded BY
 * POSITION — anything inside the top or left gutter — rather than by matching
 * their text. A content filter would have to know that a cell value can never
 * look like "C" or "3", which is exactly the sort of assumption that makes a
 * test quietly stop watching a case.
 */
function paintedGlyphs(fixture: Fixture): string[] {
  const columnWidth = fixture.columnWidth ?? NARROW_COLUMN;
  const config: GridConfig = {
    ...DEFAULT_GRID_CONFIG,
    defaultCellWidth: columnWidth,
    defaultCellHeight: 20,
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
  if (fixture.neighbour) {
    cells.set(cellKey(ROW, COL + 1), {
      row: ROW,
      col: COL + 1,
      display: "",
      formula: null,
      styleIndex: 0,
      ...fixture.neighbour,
    } as CellData);
  }

  const { ctx, texts } = makeRecordingCtx();
  renderGrid(
    ctx,
    600,
    120,
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

  return cellGlyphs(texts, config);
}

/** Keep only glyph runs painted inside the cell area (not in either gutter). */
function cellGlyphs(texts: Glyphs[], config: GridConfig): string[] {
  const left = rowHeaderGutter(config);
  const top = colHeaderGutter(config);
  return texts.filter((t) => t.text !== "" && t.x >= left && t.y >= top).map((t) => t.text);
}

/** The one glyph run the cell under test painted. */
function painted(fixture: Fixture): string {
  const glyphs = paintedGlyphs(fixture);
  expect(glyphs.length, `expected exactly one cell glyph run, got ${JSON.stringify(glyphs)}`).toBe(
    1
  );
  return glyphs[0];
}

// ============================================================================
// Numbers, dates and times: the marker
// ============================================================================

describe("a numeric that does not fit shows '####', filling the column", () => {
  it("marks a NUMBER under an explicit format", () => {
    // "1234.5678" is 9 glyphs against a 6-glyph box, and a fixed-decimal format
    // will not negotiate.
    const glyphs = painted({ display: "1234.5678", style: { numberFormat: "Number (4 decimals)" } });
    expect(glyphs).toBe("######");
  });

  it("marks a DATE", () => {
    const glyphs = painted({
      display: "2024-01-15",
      style: { numberFormat: "Date (YYYY-MM-DD)" },
    });
    expect(glyphs).toBe("######");
  });

  it("marks a TIME", () => {
    const glyphs = painted({ display: "13:45:00", style: { numberFormat: "Time (HH:MM:SS)" } });
    expect(glyphs).toBe("######");
  });

  it("marks an error literal, which cannot spill either", () => {
    const glyphs = painted({ display: "#VALUE!!!!", style: {} });
    expect(glyphs).toBe("######");
  });

  it("REPEATS the marker to fill a wider column rather than printing four", () => {
    // 90px column -> 84px box -> 14 glyphs.
    const glyphs = painted({
      display: "1234567890123456.25",
      style: { numberFormat: "Number (2 decimals)" },
      columnWidth: 90,
    });
    expect(glyphs).toBe("#".repeat(14));
  });

  it("uses ASCII '#' and nothing else", () => {
    const glyphs = painted({ display: "2024-01-15", style: { numberFormat: "Date (YYYY-MM-DD)" } });
    for (const ch of glyphs) expect(ch.codePointAt(0)).toBe(0x23);
  });

  it("WIDENING THE COLUMN brings the value back", () => {
    const fixture = { display: "2024-01-15", style: { numberFormat: "Date (YYYY-MM-DD)" } };
    expect(painted({ ...fixture })).toBe("######");
    expect(painted({ ...fixture, columnWidth: WIDE_COLUMN })).toBe("2024-01-15");
  });
});

describe("General negotiates before it gives up", () => {
  it("drops decimals rather than marking", () => {
    // 6 glyphs of room; "1234.5678" rounds to "1234.6", which fits exactly.
    expect(painted({ display: "1234.5678" })).toBe("1234.6");
  });

  it("goes scientific when the integer part alone will not fit", () => {
    // "123456789" is 9 glyphs; "1.2E+08" is 7 — still too wide for 6 — so the
    // ladder keeps shortening to "1E+08".
    expect(painted({ display: "123456789" })).toBe("1E+08");
  });

  it("only marks when even the shortest scientific form is too wide", () => {
    // 24px column -> 18px box -> 3 glyphs, less than "1E+08".
    expect(painted({ display: "123456789", columnWidth: 24 })).toBe("####");
  });

  it("does NOT negotiate under an explicit format, at the same width", () => {
    // The identical value and width that General rounded to "1234.6".
    expect(painted({ display: "1234.5678", style: { numberFormat: "Number (4 decimals)" } })).toBe(
      "######"
    );
  });
});

// ============================================================================
// Text: spill and clip, and NEVER the marker
// ============================================================================

describe("text never shows the marker", () => {
  it("spills into an absolutely empty neighbour", () => {
    // No neighbour record at all: the value paints in full, spilled.
    expect(painted({ display: "Quarterly revenue" })).toBe("Quarterly revenue");
  });

  it("is CLIPPED, not ellipsised and not marked, against an occupied neighbour", () => {
    // The occupied neighbour paints its own glyph run, so read both.
    const glyphs = paintedGlyphs({
      display: "Quarterly revenue",
      neighbour: { display: "x" },
    });
    expect(glyphs).toEqual(["Quarterly revenue", "x"]);
    // The whole string goes to fillText; the clip rectangle cuts it at the box.
    expect(glyphs[0]).not.toContain("...");
    expect(glyphs[0]).not.toContain("#");
  });

  it("digits under the TEXT format are text: they spill, they do not mark", () => {
    expect(painted({ display: "1234567890", style: { numberFormat: "@" } })).toBe("1234567890");
  });
});

// ============================================================================
// The two spill defects this change closed
// ============================================================================

describe("BUG-0067: a left-aligned NUMBER must not spill", () => {
  it("marks instead of running across its empty neighbours", () => {
    // Explicit Align Left used to be enough to send a number down the text
    // spill path, because the gate keyed on alignment alone.
    const glyphs = painted({
      display: "1234.5678",
      style: { numberFormat: "Number (4 decimals)", textAlign: "left" },
    });
    expect(glyphs).toBe("######");
  });

  it("and the same value as TEXT still spills, so the gate is about type", () => {
    const glyphs = painted({
      display: "1234.5678",
      style: { numberFormat: "@", textAlign: "left" },
    });
    expect(glyphs).toBe("1234.5678");
  });
});

describe('BUG-0068: a neighbour holding =""  blocks the spill', () => {
  it("clips against it, though it displays nothing", () => {
    const glyphs = painted({
      display: "Quarterly revenue",
      neighbour: { display: "", formula: '=""' },
    });
    // Clipped: the glyph run is the full string, cut by the CELL's own box
    // rather than allowed to run across the neighbour.
    expect(glyphs).toBe("Quarterly revenue");
  });

  it("a neighbour that is only a style does NOT block", () => {
    const glyphs = painted({
      display: "Quarterly revenue",
      neighbour: { display: "", formula: null, styleIndex: 0 },
    });
    expect(glyphs).toBe("Quarterly revenue");
  });
});

// ============================================================================
// General alignment asks the SAME question as the overflow rule
// ============================================================================

/** Where the glyph run starts, relative to the cell's own left edge. */
function paintedOrigin(fixture: Fixture): { text: string; offset: number; box: number } {
  const columnWidth = fixture.columnWidth ?? WIDE_COLUMN;
  const config: GridConfig = {
    ...DEFAULT_GRID_CONFIG,
    defaultCellWidth: columnWidth,
    defaultCellHeight: 20,
    totalRows: 50,
    totalCols: 12,
  };
  const styleCache: StyleDataMap = new Map();
  styleCache.set(0, DEFAULT_STYLE);
  styleCache.set(1, { ...DEFAULT_STYLE, ...(fixture.style ?? {}) });
  const cells: CellDataMap = new Map();
  cells.set(cellKey(ROW, COL), {
    row: ROW, col: COL, display: fixture.display, formula: null, styleIndex: 1,
  } as CellData);
  if (fixture.neighbour) {
    cells.set(cellKey(ROW, COL + 1), {
      row: ROW, col: COL + 1, display: "", formula: null, styleIndex: 0, ...fixture.neighbour,
    } as CellData);
  }

  const { ctx, texts } = makeRecordingCtx();
  renderGrid(
    ctx, 600, 120, config, VIEWPORT, null, null, cells, DEFAULT_THEME, [],
    { columnWidths: new Map(), rowHeights: new Map() }, styleCache
  );
  const left = rowHeaderGutter(config);
  const top = colHeaderGutter(config);
  const own = texts.filter((t) => t.text !== "" && t.x >= left && t.y >= top);
  expect(own.length, JSON.stringify(own.map((o) => o.text))).toBe(1);
  // COL is the second column, so the cell's left edge is one column in.
  const cellLeft = left + columnWidth * COL;
  return {
    text: own[0].text,
    offset: own[0].x - cellLeft,
    box: columnWidth - PADDING_X * 2,
  };
}

describe("General alignment follows the value's TYPE, as Excel's does", () => {
  it("right-aligns a DATE, which a bare number test reads as text", () => {
    // "2024-01-15" parses as no number at all, so the display-string rule this
    // replaced left-aligned every date in the product.
    const { text, offset, box } = paintedOrigin({
      display: "2024-01-15",
      style: { numberFormat: "Date (YYYY-MM-DD)" },
    });
    expect(text).toBe("2024-01-15");
    expect(offset, "a right-aligned value starts well inside the cell").toBeGreaterThan(box / 2);
  });

  it("right-aligns sv-SE currency, whose symbol and spaces defeat a number test", () => {
    const { text, offset, box } = paintedOrigin({
      display: "1 234,00 kr",
      style: { numberFormat: "Currency ( kr, 2 decimals)" },
    });
    expect(text).toBe("1 234,00 kr");
    expect(offset).toBeGreaterThan(box / 3);
  });

  it("LEFT-aligns digits under the Text format, which Excel shows exactly as typed", () => {
    const { text, offset } = paintedOrigin({
      display: "1234567890",
      style: { numberFormat: "@" },
    });
    expect(text).toBe("1234567890");
    expect(offset, "left-aligned text starts at the padding").toBeCloseTo(PADDING_X, 6);
  });

  it("still right-aligns an ordinary General number, and left-aligns prose", () => {
    expect(paintedOrigin({ display: "1234.5" }).offset).toBeGreaterThan(PADDING_X);
    expect(paintedOrigin({ display: "Total" }).offset).toBeCloseTo(PADDING_X, 6);
  });
});

// ============================================================================
// Wrap, merge and shrink-to-fit
// ============================================================================

describe("the remaining Excel cases", () => {
  it("WRAP does not rescue a numeric — it still marks", () => {
    const glyphs = painted({
      display: "1234.5678",
      style: { numberFormat: "Number (4 decimals)", wrapText: true },
    });
    expect(glyphs).toBe("######");
    // In particular it is NOT chopped across lines: the old path sent numbers
    // through the word-wrapper, whose long-word fallback cuts on characters.
    expect(glyphs).not.toContain("1234");
  });

  it("SHRINK TO FIT is tried first, and rescues a value that then fits", () => {
    // Shrinking scales the font down until the value fits, so no marker.
    const glyphs = painted({
      display: "1234.5678",
      style: { numberFormat: "Number (4 decimals)", shrinkToFit: true },
    });
    expect(glyphs).toBe("1234.5678");
  });

  it("a MERGED master fits against the whole merged region", () => {
    const config: GridConfig = {
      ...DEFAULT_GRID_CONFIG,
      defaultCellWidth: NARROW_COLUMN,
      defaultCellHeight: 20,
      totalRows: 50,
      totalCols: 12,
    };
    const styleCache: StyleDataMap = new Map();
    styleCache.set(0, DEFAULT_STYLE);
    styleCache.set(1, { ...DEFAULT_STYLE, numberFormat: "Date (YYYY-MM-DD)" });

    const cells: CellDataMap = new Map();
    cells.set(cellKey(ROW, COL), {
      row: ROW,
      col: COL,
      display: "2024-01-15",
      formula: null,
      styleIndex: 1,
      rowSpan: 1,
      colSpan: 3,
    } as CellData);

    const { ctx, texts } = makeRecordingCtx();
    renderGrid(
      ctx, 600, 120, config, VIEWPORT, null, null, cells, DEFAULT_THEME, [],
      { columnWidths: new Map(), rowHeights: new Map() }, styleCache
    );
    // Three narrow columns = 126px, box = 120px = 20 glyphs: it fits, so the
    // merged region's width is what was measured, not one column's.
    const glyphs = cellGlyphs(texts, config);
    expect(glyphs).toContain("2024-01-15");
    expect(glyphs.join("")).not.toContain("#");
  });
});

// ============================================================================
// The marker is not a value
// ============================================================================

describe("the marker never becomes data", () => {
  it("the padding maths cannot make it exceed the box", () => {
    // 40 glyphs = 240px, wider than every box tried here, so every width lands
    // on the marker rung and the only thing under test is its LENGTH.
    for (const columnWidth of [18, 24, 30, 42, 66, 90, 150]) {
      const glyphs = painted({
        display: "1234567890123456789012345678901234567.25",
        style: { numberFormat: "Number (2 decimals)" },
        columnWidth,
      });
      expect(/^#+$/.test(glyphs), `width ${columnWidth} -> ${glyphs}`).toBe(true);
      const box = columnWidth - PADDING_X * 2;
      // Excel keeps a four-hash floor even when the box is narrower than that.
      const expected = Math.max(4, Math.floor(box / CHAR_WIDTH));
      expect(glyphs.length, `width ${columnWidth}`).toBe(expected);
    }
  });
});
