//! FILENAME: app/src/core/lib/gridRenderer/rendering/frozenPaneInterceptors.test.ts
// PURPOSE: Style interceptors — i.e. CONDITIONAL FORMATTING — reach a frozen or
//          split pane, not only the ordinary unfrozen grid.
// CONTEXT: BUG-0105, found while fixing BUG-0102 (borders missing in panes) and
//          filed rather than folded in, because it is strictly bigger.
//
//          `renderZone` paints every pane through `drawCellTextZone`, which runs
//          INSTEAD of `drawCellText` for every cell of every pane. `drawCellText`
//          consults `applyStyleInterceptors` per cell (cells.ts:1070); the zone
//          painter did not call it at all — a repo-wide grep of core.ts for
//          hasStyleInterceptors / applyStyleInterceptors / useInterceptors
//          returned NOTHING.
//
//          So the moment a user froze a pane or split the window, every
//          conditional-formatting fill, font colour and data bar stopped being
//          drawn in that pane and the cell reverted to its static style. The
//          BUG-0102 fix passed an empty `{}` where the main painter passes the
//          interceptor-resolved style, with a comment saying exactly that; this
//          closes it.
//
// WHY A REGISTERED INTERCEPTOR RATHER THAN A CF FIXTURE. Conditional formatting
// is one CONSUMER of the interceptor seam (the extension registers through it).
// Asserting at the seam covers CF and everything else that uses it, and needs no
// CF rule engine in a renderer unit test.

import { describe, it, expect, afterEach } from "vitest";

import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
import {
  registerStyleInterceptor,
  unregisterStyleInterceptor,
} from "../../../../api/styleInterceptors";
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
/** The colour only an interceptor can produce — nothing static uses it. */
const CF_FILL = "#abcdef";
const INTERCEPTOR_ID = "bug-0105-test";

afterEach(() => {
  unregisterStyleInterceptor(INTERCEPTOR_ID);
});

interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; fills: Fill[] } {
  const fills: Fill[] = [];
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
      fills.push({ x, y, w, h, color: String(api.fillStyle) });
    },
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
  return { ctx: api as unknown as CanvasRenderingContext2D, fills };
}

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 12,
  colCount: 10,
};

function renderWith(
  freeze: { freezeRow: number | null; freezeCol: number | null } | undefined,
  display = "42",
): Fill[] {
  const config: GridConfig = {
    ...DEFAULT_GRID_CONFIG,
    totalRows: 100,
    totalCols: 30,
  };
  const styleCache: StyleDataMap = new Map();
  styleCache.set(0, DEFAULT_STYLE);

  const cells: CellDataMap = new Map();
  cells.set(cellKey(ROW, COL), {
    row: ROW,
    col: COL,
    display,
    formula: null,
    styleIndex: 0,
  } as CellData);

  const { ctx, fills } = makeRecordingCtx();
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
  return fills;
}

/** Paint the target cell only, the way a conditional format would. */
function registerFillInterceptor(): void {
  registerStyleInterceptor(INTERCEPTOR_ID, (_value, style, cellRef) => {
    if (cellRef.row === ROW && cellRef.col === COL) {
      return { ...style, backgroundColor: CF_FILL };
    }
    return style;
  });
}

const cfFills = (f: Fill[]): Fill[] =>
  f.filter((x) => x.color.toLowerCase() === CF_FILL.toLowerCase());

describe("style interceptors reach a frozen pane (BUG-0105)", () => {
  it("the UNFROZEN grid honours the interceptor — the control", () => {
    // Non-vacuity: if this fails the seam is not wired at all and the frozen
    // case below would be measuring nothing.
    registerFillInterceptor();
    expect(
      cfFills(renderWith(undefined)).length,
      "the interceptor did not paint even without a freeze, so this suite cannot " +
        "say anything about panes",
    ).toBeGreaterThan(0);
  });

  it("a FROZEN pane honours the interceptor too", () => {
    // The defect: `drawCellTextZone` never called `applyStyleInterceptors`, so
    // freezing a pane reverted every conditionally-formatted cell in it to its
    // static style.
    registerFillInterceptor();
    expect(
      cfFills(renderWith({ freezeRow: 2, freezeCol: 2 })).length,
      "no interceptor fill was painted with a freeze active. The pane painter " +
        "runs INSTEAD of drawCellText and consulted no interceptors, so " +
        "conditional formatting never reached a frozen or split pane.",
    ).toBeGreaterThan(0);
  });

  it("no interceptor means no extra fill, frozen or not", () => {
    // The other direction: a fix that unconditionally painted something would
    // satisfy the cases above while inventing formatting nobody asked for.
    expect(cfFills(renderWith(undefined)).length).toBe(0);
    expect(cfFills(renderWith({ freezeRow: 2, freezeCol: 2 })).length).toBe(0);
  });

  it("an EMPTY cell's interceptor fill also reaches the pane", () => {
    // The pane painter handles empty and non-empty cells on SEPARATE paths — the
    // lesson from BUG-0102, where a fix to one branch left the other untested and
    // the sabotage passed. Conditional formatting applies to empty cells too
    // (a rule on a blank cell is ordinary).
    registerFillInterceptor();
    expect(
      cfFills(renderWith({ freezeRow: 2, freezeCol: 2 }, "")).length,
      "an interceptor fill on an EMPTY cell did not reach the frozen pane",
    ).toBeGreaterThan(0);
  });
});
