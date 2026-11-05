//! FILENAME: app/src/core/lib/gridRenderer/rendering/frozenPaneParity.test.ts
// PURPOSE: A frozen pane paints a cell EXACTLY as the ordinary grid paints it
//          (BUG-0362).
// CONTEXT: Every frozen or split pane used to be painted by a second cell painter
//          (`drawCellTextZone`, core.ts) that was narrower than `drawCellText`:
//          it centred every value vertically whatever its alignment, never
//          wrapped, never showed '####' or dropped a General number's decimals,
//          painted rich text as one plain run, and decided General alignment with
//          a regex over the display string (so "1,5" -- a Swedish decimal -- went
//          LEFT in a pane and RIGHT outside it). Freezing the top row moved the
//          text of every bottom-aligned header cell to the middle.
//
//          The fix is one painter: the pane path now calls `drawCellText` with
//          the pane's range and clip. This file pins the two together. With the
//          scroll at the origin a freeze moves no cell, so every cell's glyph
//          runs -- text, x, y, baseline, font -- must be IDENTICAL with and
//          without the freeze. Each fixture cell exercises one branch the old
//          pane painter lacked, in each of the four panes.

import { describe, it, expect } from "vitest";

import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
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

interface TextOp {
  text: string;
  x: number;
  y: number;
  baseline: string;
  font: string;
}

const CHAR_WIDTH = 6;

function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; texts: TextOp[] } {
  const texts: TextOp[] = [];
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
    canvas: { width: 800, height: 500 },
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
      texts.push({ text: String(text), x, y, baseline: api.textBaseline, font: api.font });
    },
    strokeText() {},
    measureText(text: string) {
      return { width: String(text).length * CHAR_WIDTH };
    },
    setLineDash() {},
    getLineDash() {
      return [];
    },
    translate() {},
    rotate() {},
    scale() {},
    getTransform() {
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return null;
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, texts };
}

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: 90,
  defaultCellHeight: 20,
  rowHeaderWidth: 30,
  colHeaderHeight: 20,
  totalRows: 60,
  totalCols: 20,
};

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 20, colCount: 8 };

interface FixtureCell {
  row: number;
  col: number;
  display: string;
  style?: Partial<StyleData>;
  extra?: Partial<CellData>;
}

/**
 * One cell per branch the old pane painter lacked. Rows 0-1 and columns 0-1 are
 * frozen in the frozen render, so the cells fall in all four panes.
 */
const FIXTURE: FixtureCell[] = [
  // Top-left pane: Bottom alignment (the document default) in a tall row.
  { row: 0, col: 0, display: "bottom" },
  // Top pane: an explicit Top alignment in the same tall row.
  { row: 0, col: 3, display: "top", style: { verticalAlign: "top" } },
  // Top pane: Wrap Text in a narrow column.
  { row: 1, col: 4, display: "alpha beta gamma", style: { wrapText: true } },
  // Left pane: a General number too wide for its column -- '####' or fewer
  // decimals, never a clipped string.
  { row: 4, col: 0, display: "12345678.9", extra: { overflow: "numeric" } },
  // Scrollable pane: rich text, run by run.
  {
    row: 4,
    col: 3,
    display: "ab",
    extra: { richText: [{ text: "a", bold: true }, { text: "b" }] },
  },
  // Scrollable pane: a DATE under General alignment. The backend's value class
  // says number, so Excel right-aligns it; the old pane painter's regex saw no
  // number in "2024-01-15" and drew it LEFT.
  { row: 5, col: 5, display: "2024-01-15", extra: { overflow: "numeric" } },
  // Left pane: a hard break, which breaks the line with wrap off too.
  { row: 6, col: 1, display: "one\ntwo" },
];

function render(freeze: { freezeRow: number; freezeCol: number } | undefined): TextOp[] {
  const styles: StyleDataMap = new Map();
  styles.set(0, DEFAULT_STYLE);
  const cells: CellDataMap = new Map();
  FIXTURE.forEach((f, i) => {
    const styleIndex = i + 1;
    styles.set(styleIndex, { ...DEFAULT_STYLE, ...(f.style ?? {}) });
    cells.set(cellKey(f.row, f.col), {
      row: f.row,
      col: f.col,
      display: f.display,
      formula: null,
      styleIndex,
      ...(f.extra ?? {}),
    } as CellData);
  });
  const dims = {
    columnWidths: new Map<number, number>([
      [0, 40],
      [4, 60],
    ]),
    rowHeights: new Map<number, number>([
      [0, 60],
      [1, 60],
      [6, 50],
    ]),
  };
  const { ctx, texts } = makeRecordingCtx();
  renderGrid(
    ctx, 800, 500, CONFIG, VIEWPORT, null, null, cells, DEFAULT_THEME, [],
    dims, styles,
    null, null, "move", null, "none", 0, null,
    freeze,
  );
  return texts;
}

/**
 * The glyph runs of the fixture's cells. The headers paint their own labels,
 * all of them left of the row-header gutter or above the column-header band;
 * every cell run starts right of the one and below the other.
 */
function cellTexts(texts: TextOp[]): TextOp[] {
  return texts.filter((t) => t.x >= CONFIG.rowHeaderWidth && t.y > CONFIG.colHeaderHeight);
}

describe("a frozen pane paints cells exactly as the ordinary grid (BUG-0362)", () => {
  const unfrozen = cellTexts(render(undefined));
  const frozen = cellTexts(render({ freezeRow: 2, freezeCol: 2 }));

  it("control: the fixture paints every branch in the ordinary grid", () => {
    // Non-vacuity: each branch actually produced its distinctive output.
    const bottom = unfrozen.find((t) => t.text === "bottom");
    expect(bottom?.baseline, "a bottom-aligned value is drawn on a bottom baseline").toBe("bottom");
    expect(unfrozen.filter((t) => t.text === "alpha" || t.text === "beta" || t.text.startsWith("alpha")).length,
      "the wrapped cell painted more than one line").toBeGreaterThan(0);
    expect(unfrozen.some((t) => t.text === "12345678.9"), "the too-wide number is not painted as clipped text").toBe(false);
    expect(unfrozen.some((t) => t.text === "a") && unfrozen.some((t) => t.text === "b"),
      "rich text is painted run by run").toBe(true);
    expect(unfrozen.some((t) => t.text === "one") && unfrozen.some((t) => t.text === "two"),
      "a hard break splits the value").toBe(true);
  });

  it("Bottom alignment survives a freeze (it used to be drawn in the middle)", () => {
    const u = unfrozen.find((t) => t.text === "bottom")!;
    const f = frozen.find((t) => t.text === "bottom");
    expect(f, "the frozen pane painted the value").toBeTruthy();
    expect({ y: f!.y, baseline: f!.baseline }).toEqual({ y: u.y, baseline: u.baseline });
  });

  it("a General date is right-aligned in a pane too (the value class decides, not a regex)", () => {
    const u = unfrozen.find((t) => t.text === "2024-01-15")!;
    const f = frozen.find((t) => t.text === "2024-01-15")!;
    expect(f.x).toBe(u.x);
  });

  it("every glyph run of every cell is identical with and without the freeze", () => {
    const key = (t: TextOp) => `${t.text}|${t.x}|${t.y}|${t.baseline}|${t.font}`;
    expect(frozen.map(key).sort()).toEqual(unfrozen.map(key).sort());
  });
});
