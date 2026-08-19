//! FILENAME: app/src/core/lib/gridRenderer/rendering/frozenPaneBorders.test.ts
// PURPOSE: Cell borders render inside a FROZEN or SPLIT pane, not only in the
//          ordinary unfrozen grid.
// CONTEXT: BUG-0102. `renderZone` (core.ts) paints every pane and delegates cell
//          content to `drawCellTextZone`, whose own header says it "runs INSTEAD
//          of drawCellText for every cell of every pane". `drawCellText` draws
//          all six border sides; `drawCellTextZone` contained no border code at
//          all — scanning its whole body for /border/i returned nothing. So the
//          moment a user froze a pane, every cell border in the workbook stopped
//          being drawn.
//
//          The bug was filed 2026-08-18 from a code reading and explicitly NOT
//          claimed to have been seen on screen. This test is what turns that
//          reading into a demonstration: it renders one frame with a freeze
//          active and looks for the stroke.
//
// WHY IT WAS INVISIBLE FOR SO LONG. Nothing else notices. The zone painter draws
// backgrounds, text and gridlines correctly, so a frozen sheet looks entirely
// normal unless the cells happen to carry borders — and the golden corpus has no
// frozen-pane capture that also carries a cell border.

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
  type StyleDataMap,
  type Viewport,
} from "../../../types";

const ROW = 3;
const COL = 3;
const BORDER_COLOR = "#ff0000";

interface Stroke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

/** Records stroked segments with the colour in force. */
function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; strokes: Stroke[] } {
  const strokes: Stroke[] = [];
  let last: { x: number; y: number } | null = null;
  let pending: { x: number; y: number } | null = null;

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
    canvas: { width: 800, height: 400 },
    getTransform() {
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    },
    save() {},
    restore() {},
    beginPath() {
      last = null;
      pending = null;
    },
    moveTo(x: number, y: number) {
      last = { x, y };
    },
    lineTo(x: number, y: number) {
      pending = { x, y };
    },
    closePath() {},
    rect() {},
    arc() {},
    clip() {},
    fill() {},
    stroke() {
      if (last && pending) {
        strokes.push({
          x1: last.x,
          y1: last.y,
          x2: pending.x,
          y2: pending.y,
          color: String(api.strokeStyle),
        });
      }
    },
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    fillText() {},
    strokeText() {},
    measureText(t: string) {
      return { width: String(t).length * 6 };
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
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes };
}

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 12,
  colCount: 10,
};

/**
 * Render one frame, optionally with a freeze active, and return the strokes.
 *
 * The SAME fixture is used for both cases, so the only difference between them
 * is the freeze — which is what makes the comparison meaningful.
 */
function renderWith(
  freeze: { freezeRow: number | null; freezeCol: number | null } | undefined,
  display = "",
): Stroke[] {
  const config: GridConfig = {
    ...DEFAULT_GRID_CONFIG,
    totalRows: 100,
    totalCols: 30,
  };

  const styleCache: StyleDataMap = new Map();
  styleCache.set(0, DEFAULT_STYLE);
  styleCache.set(1, {
    ...DEFAULT_STYLE,
    borderTop: { style: "medium", color: BORDER_COLOR, width: 1 },
    borderRight: { style: "medium", color: BORDER_COLOR, width: 1 },
    borderBottom: { style: "medium", color: BORDER_COLOR, width: 1 },
    borderLeft: { style: "medium", color: BORDER_COLOR, width: 1 },
  });

  const cells: CellDataMap = new Map();
  cells.set(cellKey(ROW, COL), {
    row: ROW,
    col: COL,
    display,
    formula: null,
    styleIndex: 1,
  } as CellData);

  const { ctx, strokes } = makeRecordingCtx();
  renderGrid(
    ctx,
    800,
    400,
    config,
    VIEWPORT,
    null,
    null,
    cells,
    DEFAULT_THEME,
    [],
    { columnWidths: new Map(), rowHeights: new Map() },
    styleCache,
    null,
    null,
    undefined,
    null,
    undefined,
    undefined,
    null,
    freeze,
  );
  return strokes;
}

const redStrokes = (s: Stroke[]): Stroke[] => s.filter((x) => x.color === BORDER_COLOR);

describe("cell borders survive a freeze (BUG-0102)", () => {
  it("the UNFROZEN grid draws the border — the control", () => {
    // Non-vacuity and the baseline in one: if this fails, the fixture is wrong
    // and the frozen case below would be measuring nothing.
    const strokes = renderWith(undefined);
    expect(
      redStrokes(strokes).length,
      "the fixture's bordered cell did not paint even without a freeze, so this " +
        "suite cannot say anything about panes",
    ).toBeGreaterThan(0);
  });

  it("a FROZEN pane draws the border too", () => {
    // The defect: `renderZone` -> `drawCellTextZone` painted backgrounds, text
    // and gridlines but never a cell border, so freezing a pane silently erased
    // every border in the workbook.
    const strokes = renderWith({ freezeRow: 2, freezeCol: 2 });
    expect(
      redStrokes(strokes).length,
      "no cell border was stroked with a freeze active. `drawCellTextZone` runs " +
        "INSTEAD of `drawCellText` for every cell of every pane, and it draws no " +
        "borders — so freezing a pane erases them all.",
    ).toBeGreaterThan(0);
  });

  // The two branches of the pane painter are SEPARATE code paths and a fix to
  // one does not touch the other. The cases above use an EMPTY cell, which takes
  // the no-content branch; a cell WITH content takes the other. Sabotaging the
  // content branch passed all three of the cases above, which is how this gap
  // was found.
  it("a frozen pane draws borders on a NON-EMPTY cell too", () => {
    const strokes = renderWith({ freezeRow: 2, freezeCol: 2 }, "42");
    expect(
      redStrokes(strokes).length,
      "a bordered cell WITH content painted no border inside a frozen pane -- the " +
        "content branch of the pane painter draws no borders",
    ).toBeGreaterThan(0);
  });

  it("a non-empty cell gets the same border count frozen and unfrozen", () => {
    const unfrozen = redStrokes(renderWith(undefined, "42")).length;
    const frozen = redStrokes(renderWith({ freezeRow: 2, freezeCol: 2 }, "42")).length;
    expect(frozen).toBe(unfrozen);
  });

  it("a frozen pane draws the SAME number of border strokes as the unfrozen grid", () => {
    // Stronger than "more than zero": a fix that drew only one edge, or drew the
    // border in just one of the four panes, would pass the case above.
    const unfrozen = redStrokes(renderWith(undefined)).length;
    const frozen = redStrokes(renderWith({ freezeRow: 2, freezeCol: 2 })).length;
    expect(frozen).toBe(unfrozen);
  });
});
