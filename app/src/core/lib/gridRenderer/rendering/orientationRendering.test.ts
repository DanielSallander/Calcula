//! FILENAME: app/src/core/lib/gridRenderer/rendering/orientationRendering.test.ts
// PURPOSE: The cell painter, end to end through `renderGrid`, for the four
//          things the Home-tab programme's renderer lane changed:
//            1. rotated text honours BOTH alignments and is anchored, not
//               centred and pre-cut to the cell height;
//            2. stacked ("vertical") text is painted one character per line;
//            3. symbol-AFTER accounting puts the number against the symbol
//               (survey defect A) and pins a minus to the left edge;
//            4. an indent is drawn the way Excel draws it -- from the right edge
//               for Right, not at all for Center, Left for an indented General
//               -- and a big indent no longer swallows the cell's fill.
//          Plus: fonts above 200pt (Excel's limit is 409) are painted at their
//          size instead of silently falling back to the theme's 11pt.
// CONTEXT: The geometry itself is pinned by layout/textOrientation.test.ts,
//          layout/cellIndent.test.ts and rendering/accountingLayout.test.ts.
//          This file proves the PAINTER uses it, in the main grid AND in a
//          frozen pane (`drawCellTextZone`, which used to draw every value
//          horizontally, unindented, with accounting as one string). The fake
//          2D context records what was painted; nothing here restates the
//          renderer's arithmetic beyond the published geometry.

import { describe, it, expect } from "vitest";

import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
import {
  DEFAULT_GRID_CONFIG,
  DEFAULT_STYLE,
  cellKey,
  type AccountingLayout,
  type CellData,
  type CellDataMap,
  type GridConfig,
  type StyleData,
  type StyleDataMap,
  type Viewport,
} from "../../../types";
import { ORIENTATION_LINE_HEIGHT_FACTOR } from "../layout/textOrientation";
import { INDENT_PX_PER_LEVEL } from "../layout/cellIndent";

// ============================================================================
// Recording context
// ============================================================================

type Op =
  | { op: "translate"; x: number; y: number }
  | { op: "rotate"; r: number }
  | { op: "fillText"; text: string; x: number; y: number; font: string; baseline: string }
  | { op: "fillRect"; x: number; y: number; w: number; h: number; style: string };

const CHAR_WIDTH = 6;

function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
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
    canvas: { width: 600, height: 400 },
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
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({ op: "fillRect", x, y, w, h, style: String(api.fillStyle) });
    },
    strokeRect() {},
    clearRect() {},
    fillText(text: string, x: number, y: number) {
      ops.push({ op: "fillText", text: String(text), x, y, font: api.font, baseline: api.textBaseline });
    },
    strokeText() {},
    measureText(text: string) {
      return { width: String(text).length * CHAR_WIDTH };
    },
    setLineDash() {},
    getLineDash() {
      return [];
    },
    translate(x: number, y: number) {
      ops.push({ op: "translate", x, y });
    },
    rotate(r: number) {
      ops.push({ op: "rotate", r });
    },
    scale() {},
    getTransform() {
      return { a: 1 };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return null;
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, ops };
}

// ============================================================================
// Fixture: one tall cell at (1, 1)
// ============================================================================

const ROW = 1;
const COL = 1;
const PAD_X = 3;
const PAD_Y = 2;

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: 100,
  defaultCellHeight: 80,
  rowHeaderWidth: 22,
  colHeaderHeight: 20,
  totalRows: 40,
  totalCols: 12,
};

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 4, colCount: 5 };

/** The fixture cell's rectangle and its content box. */
const CELL = { left: 22 + 100, top: 20 + 80, right: 22 + 200, bottom: 20 + 160 };
const BOX = { left: CELL.left + PAD_X, right: CELL.right - PAD_X, top: CELL.top + PAD_Y, bottom: CELL.bottom - PAD_Y };
/** 11pt default font in pixels, and the line pitch the painter uses. */
const FONT_PX = (11 * 96) / 72;
const LINE_H = FONT_PX * ORIENTATION_LINE_HEIGHT_FACTOR;

interface Fixture {
  display: string;
  style: Partial<StyleData>;
  accountingLayout?: AccountingLayout;
  overflow?: CellData["overflow"];
  freezeRow?: number;
}

function render(f: Fixture): Op[] {
  const { ctx, ops } = makeRecordingCtx();
  const styles: StyleDataMap = new Map();
  styles.set(0, DEFAULT_STYLE);
  styles.set(1, { ...DEFAULT_STYLE, ...f.style });
  const cells: CellDataMap = new Map();
  cells.set(cellKey(ROW, COL), {
    row: ROW,
    col: COL,
    display: f.display,
    formula: null,
    styleIndex: 1,
    accountingLayout: f.accountingLayout,
    overflow: f.overflow,
  } as CellData);
  // Occupied neighbours, so nothing spills.
  cells.set(cellKey(ROW, COL + 1), { row: ROW, col: COL + 1, display: "x", formula: null, styleIndex: 0 } as CellData);
  cells.set(cellKey(ROW, COL - 1), { row: ROW, col: COL - 1, display: "x", formula: null, styleIndex: 0 } as CellData);
  renderGrid(
    ctx, 600, 400, CONFIG, VIEWPORT, null, null, cells, DEFAULT_THEME, [],
    { columnWidths: new Map(), rowHeights: new Map() }, styles,
    null, null, "move", null, "none", 0, null,
    f.freezeRow !== undefined ? { freezeRow: f.freezeRow, freezeCol: null } : undefined,
  );
  return ops;
}

function textOps(ops: Op[], text: string): Extract<Op, { op: "fillText" }>[] {
  return ops.filter((o): o is Extract<Op, { op: "fillText" }> => o.op === "fillText" && o.text === text);
}

/** The translate + rotate that precede the paint of `text`. */
function rotationFor(ops: Op[], text: string): { translate: { x: number; y: number }; rotate: number; draw: Extract<Op, { op: "fillText" }> } {
  const i = ops.findIndex((o) => o.op === "fillText" && o.text === text);
  expect(i, `"${text}" was painted`).toBeGreaterThanOrEqual(0);
  let rotate: number | null = null;
  let translate: { x: number; y: number } | null = null;
  for (let j = i - 1; j >= 0 && (rotate === null || translate === null); j--) {
    const o = ops[j];
    if (o.op === "rotate" && rotate === null) rotate = o.r;
    if (o.op === "translate" && translate === null) translate = { x: o.x, y: o.y };
    if (o.op === "fillText") break;
  }
  expect(rotate, `"${text}" was painted rotated`).not.toBeNull();
  expect(translate).not.toBeNull();
  return { translate: translate!, rotate: rotate!, draw: ops[i] as Extract<Op, { op: "fillText" }> };
}

// ============================================================================
// 1. Rotated text
// ============================================================================

describe("rotated text: anchored by both alignments", () => {
  const TEXT = "Sample";
  const TW = TEXT.length * CHAR_WIDTH;

  it("Rotate Text Up, General, Bottom (the defaults): right edge, starting at the bottom", () => {
    const { translate, rotate, draw } = rotationFor(render({ display: TEXT, style: { textRotation: "rotate90" } }), TEXT);
    expect(rotate).toBeCloseTo(-Math.PI / 2, 9);
    expect(translate.x).toBeCloseTo(BOX.right - LINE_H / 2, 6);
    expect(translate.y).toBeCloseTo(BOX.bottom - TW / 2, 6);
    // Drawn centred on the translate point.
    expect(draw.x).toBeCloseTo(-TW / 2, 6);
    expect(draw.y).toBeCloseTo(0, 6);
    expect(draw.baseline).toBe("middle");
  });

  it("Top alignment moves Rotate Text Up to the TOP of the cell (it used to be ignored)", () => {
    const { translate } = rotationFor(
      render({ display: TEXT, style: { textRotation: "rotate90", verticalAlign: "top" } }),
      TEXT,
    );
    expect(translate.y).toBeCloseTo(BOX.top + TW / 2, 6);
  });

  it("Angle Counterclockwise, General: bottom-LEFT corner", () => {
    const { translate, rotate } = rotationFor(render({ display: TEXT, style: { textRotation: "custom:45" } }), TEXT);
    const side = (TW + LINE_H) * Math.SQRT1_2;
    expect(rotate).toBeCloseTo(-Math.PI / 4, 9);
    expect(translate.x).toBeCloseTo(BOX.left + side / 2, 6);
    expect(translate.y).toBeCloseTo(BOX.bottom - side / 2, 6);
  });

  it("a frozen pane paints rotated text too (it used to draw it horizontally)", () => {
    const { translate, rotate } = rotationFor(
      render({ display: TEXT, style: { textRotation: "rotate90" }, freezeRow: 3 }),
      TEXT,
    );
    expect(rotate).toBeCloseTo(-Math.PI / 2, 9);
    expect(translate.x).toBeCloseTo(BOX.right - LINE_H / 2, 6);
  });
});

// ============================================================================
// 2. Stacked text
// ============================================================================

describe("stacked (vertical) text", () => {
  // Lower case on purpose: the column headers paint "A", "B", ... themselves.
  it("one character per line, centred under General", () => {
    const ops = render({ display: "pq", style: { textRotation: "vertical", verticalAlign: "top" } });
    const a = textOps(ops, "p");
    const b = textOps(ops, "q");
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(textOps(ops, "pq").length, "the value is not painted as one run").toBe(0);
    const centre = (BOX.left + BOX.right) / 2;
    expect(a[0].x + CHAR_WIDTH / 2).toBeCloseTo(centre, 6);
    expect(a[0].y).toBeCloseTo(BOX.top + LINE_H / 2, 6);
    expect(b[0].y).toBeCloseTo(BOX.top + LINE_H * 1.5, 6);
  });

  it("in a frozen pane as well", () => {
    const ops = render({ display: "pq", style: { textRotation: "vertical" }, freezeRow: 3 });
    expect(textOps(ops, "p").length).toBe(1);
    expect(textOps(ops, "pq").length).toBe(0);
  });
});

// ============================================================================
// 3. Accounting, symbol after (defect A)
// ============================================================================

describe("symbol-after accounting", () => {
  const NBSP = " ";

  it("draws '1 234,50 kr ' as ONE run ending at the right edge", () => {
    const ops = render({
      display: `1${NBSP}234,50  kr`,
      style: { numberFormat: "Accounting (kr, 2 decimals, symbol after)" },
      accountingLayout: { symbol: "kr", symbolBefore: false, value: `1${NBSP}234,50 ` },
      overflow: "numeric",
    });
    const run = `1${NBSP}234,50 kr `;
    const drawn = textOps(ops, run);
    expect(drawn.length, "number and symbol are one right-edge run").toBe(1);
    expect(drawn[0].x).toBeCloseTo(BOX.right - run.length * CHAR_WIDTH, 6);
    // The old layout drew the number from the LEFT edge.
    expect(ops.some((o) => o.op === "fillText" && o.x === BOX.left && o.text.startsWith("1"))).toBe(false);
  });

  it("pins a minus-style negative's minus to the left edge", () => {
    const ops = render({
      display: "-42,00  kr",
      style: { numberFormat: "Accounting (kr, 2 decimals, symbol after)" },
      accountingLayout: { symbol: "kr", symbolBefore: false, value: "-42,00 " },
      overflow: "numeric",
    });
    expect(textOps(ops, "-")[0]?.x).toBeCloseTo(BOX.left, 6);
    expect(textOps(ops, "42,00 kr ")[0]?.x).toBeCloseTo(BOX.right - 9 * CHAR_WIDTH, 6);
  });

  it("a frozen pane splits the runs too (it used to paint the one-string fallback)", () => {
    const ops = render({
      display: `1${NBSP}234,50  kr`,
      style: { numberFormat: "Accounting (kr, 2 decimals, symbol after)" },
      accountingLayout: { symbol: "kr", symbolBefore: false, value: `1${NBSP}234,50 ` },
      overflow: "numeric",
      freezeRow: 3,
    });
    expect(textOps(ops, `1${NBSP}234,50 kr `).length).toBe(1);
  });
});

// ============================================================================
// 4. Indent
// ============================================================================

describe("indent, as Excel draws it", () => {
  const VALUE = "Total";
  const W = VALUE.length * CHAR_WIDTH;
  const INDENT = 2 * INDENT_PX_PER_LEVEL;

  it("Right: the value ends one indent short of the RIGHT edge", () => {
    const ops = render({ display: VALUE, style: { textAlign: "right", indent: 2 } });
    expect(textOps(ops, VALUE)[0].x).toBeCloseTo(BOX.right - INDENT - W, 6);
  });

  it("Left: one indent in from the left edge (unchanged)", () => {
    const ops = render({ display: VALUE, style: { textAlign: "left", indent: 2 } });
    expect(textOps(ops, VALUE)[0].x).toBeCloseTo(BOX.left + INDENT, 6);
  });

  it("Center: the indent is ignored -- Excel has no centred indent", () => {
    const ops = render({ display: VALUE, style: { textAlign: "center", indent: 2 } });
    expect(textOps(ops, VALUE)[0].x).toBeCloseTo(BOX.left + (BOX.right - BOX.left - W) / 2, 6);
  });

  it("an indented General NUMBER is drawn Left, as Excel converts it", () => {
    const ops = render({ display: "123", style: { textAlign: "general", indent: 1 }, overflow: "numeric" });
    expect(textOps(ops, "123")[0].x).toBeCloseTo(BOX.left + INDENT_PX_PER_LEVEL, 6);
  });

  it("an indent wider than the cell still paints the cell's FILL (it used to skip the whole cell)", () => {
    const ops = render({ display: VALUE, style: { textAlign: "left", indent: 20, backgroundColor: "#ff0000" } });
    const fill = ops.find((o) => o.op === "fillRect" && o.style === "#ff0000");
    expect(fill, "the cell's background was painted").toBeTruthy();
  });

  it("a frozen pane indents a Right value from the right edge too", () => {
    const ops = render({ display: VALUE, style: { textAlign: "right", indent: 2 }, freezeRow: 3 });
    expect(textOps(ops, VALUE)[0].x).toBeCloseTo(BOX.right - INDENT - W, 6);
  });
});

// ============================================================================
// Font sizes above 200pt
// ============================================================================

describe("font size", () => {
  it("a 250pt cell is painted at 250pt, not at the theme's 11pt", () => {
    const ops = render({ display: "Big", style: { fontSize: 250 } });
    const px = (250 * 96) / 72;
    expect(textOps(ops, "Big")[0].font).toContain(`${px}px`);
  });

  it("a half-point size is painted at that size", () => {
    const ops = render({ display: "Half", style: { fontSize: 10.5 } });
    expect(textOps(ops, "Half")[0].font).toContain(`${(10.5 * 96) / 72}px`);
  });
});
