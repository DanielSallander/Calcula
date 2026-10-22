//! FILENAME: app/src/core/lib/gridRenderer/rendering/frozenPaneGridlines.test.ts
// PURPOSE: A frozen or split pane strokes its gridlines EXACTLY like the
//          unfrozen grid: one DEVICE pixel wide, on the same device pixel.
// CONTEXT: BUG-0586, found 2026-10-22 by the writeback frame review. `drawGridLines`
//          (grid.ts) strokes a 1-device-pixel hairline snapped with
//          (round(v * s) + 0.5) / s, but `drawGridLinesZone` (core.ts), which
//          paints every pane the moment anything is frozen or split, stroked a
//          1-CSS-px line at Math.floor(v) + 0.5. Default columns are 64.29px, so
//          a boundary lands on a fraction (150.58, 214.87, ...) and the two snaps
//          disagree on roughly every other line: Freeze Top Row moved half the
//          vertical gridlines one pixel sideways, doubled their weight at DPR 2
//          and smeared them at 125% -- and a painter that re-tints a gridline
//          (the writeback region frame, through @api/gridLayers) sat BESIDE the
//          grey line instead of on it. Both now read `gridlineGeometry`.

import { describe, it, expect } from "vitest";

import { renderGrid } from "../core";
import { DEFAULT_THEME } from "../types";
import { gridlineGeometry } from "./grid";
import {
  DEFAULT_GRID_CONFIG,
  DEFAULT_STYLE,
  type CellDataMap,
  type GridConfig,
  type StyleDataMap,
  type Viewport,
} from "../../../types";

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  lineWidth: number;
}

/** Records every stroked segment with the colour and width in force. */
function makeRecordingCtx(scale: number): { ctx: CanvasRenderingContext2D; segments: Segment[] } {
  const segments: Segment[] = [];
  let path: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  let at: { x: number; y: number } | null = null;

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
    canvas: { width: 900, height: 400 },
    getTransform() {
      return { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 };
    },
    save() {},
    restore() {},
    beginPath() {
      path = [];
      at = null;
    },
    moveTo(x: number, y: number) {
      at = { x, y };
    },
    lineTo(x: number, y: number) {
      if (at) path.push({ x1: at.x, y1: at.y, x2: x, y2: y });
      at = { x, y };
    },
    closePath() {},
    rect() {},
    arc() {},
    clip() {},
    fill() {},
    stroke() {
      for (const p of path) {
        segments.push({ ...p, color: String(api.strokeStyle), lineWidth: Number(api.lineWidth) });
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
    setTransform() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return null;
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, segments };
}

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 15,
  colCount: 12,
};

/** One frame at device scale `scale`, optionally frozen; the GRIDLINE strokes only. */
function gridlines(
  scale: number,
  freeze: { freezeRow: number | null; freezeCol: number | null } | undefined,
): Segment[] {
  const config: GridConfig = { ...DEFAULT_GRID_CONFIG, totalRows: 100, totalCols: 40 };
  const styleCache: StyleDataMap = new Map();
  styleCache.set(0, DEFAULT_STYLE);
  const cells: CellDataMap = new Map();
  const { ctx, segments } = makeRecordingCtx(scale);
  renderGrid(
    ctx,
    900,
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
  return segments.filter((s) => s.color === DEFAULT_THEME.gridLine);
}

const vertical = (s: Segment) => s.x1 === s.x2 && s.y1 !== s.y2;
const horizontal = (s: Segment) => s.y1 === s.y2 && s.x1 !== s.x2;
const sorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);

/** The vertical gridline positions in the canvas band below every frozen row. */
function verticalXs(segs: Segment[], belowY: number): number[] {
  return sorted(segs.filter((s) => vertical(s) && Math.max(s.y1, s.y2) > belowY).map((s) => s.x1));
}

const FREEZE_TOP_ROW = { freezeRow: 1, freezeCol: null };
const FREEZE_BOTH = { freezeRow: 2, freezeCol: 2 };

describe("gridlines in a frozen pane are the unfrozen grid's hairline", () => {
  for (const scale of [1, 1.25, 2]) {
    it(`at device scale ${scale}: one device pixel wide, frozen or not`, () => {
      for (const freeze of [undefined, FREEZE_TOP_ROW, FREEZE_BOTH]) {
        const segs = gridlines(scale, freeze);
        expect(segs.length, `no gridline was stroked (${JSON.stringify(freeze)})`).toBeGreaterThan(10);
        const widths = sorted(segs.map((s) => s.lineWidth));
        expect(widths, `freeze ${JSON.stringify(freeze)}`).toEqual([1 / scale]);
      }
    });

    it(`at device scale ${scale}: Freeze Top Row keeps every vertical gridline on the unfrozen grid's pixel`, () => {
      // Below the frozen row the same columns are on screen frozen or not.
      const belowFrozen = DEFAULT_GRID_CONFIG.colHeaderHeight + DEFAULT_GRID_CONFIG.defaultCellHeight + 1;
      const unfrozen = verticalXs(gridlines(scale, undefined), belowFrozen);
      const frozen = verticalXs(gridlines(scale, FREEZE_TOP_ROW), belowFrozen);
      expect(unfrozen.length).toBeGreaterThan(5);
      expect(frozen).toEqual(unfrozen);
    });

    it(`at device scale ${scale}: every gridline of every pane is on a device pixel's centre`, () => {
      // A device pixel's centre is k + 0.5 device pixels for a whole k.
      const onPixelCentre = (v: number) => {
        const device = v * scale - 0.5;
        return Math.abs(device - Math.round(device)) < 1e-6;
      };
      for (const freeze of [FREEZE_TOP_ROW, FREEZE_BOTH]) {
        const segs = gridlines(scale, freeze);
        for (const s of segs.filter(vertical)) {
          expect(onPixelCentre(s.x1), `vertical at ${s.x1} (${JSON.stringify(freeze)})`).toBe(true);
        }
        for (const s of segs.filter(horizontal)) {
          expect(onPixelCentre(s.y1), `horizontal at ${s.y1} (${JSON.stringify(freeze)})`).toBe(true);
        }
      }
    });
  }

  it("a fractional column boundary (64.29px columns) lands where the unfrozen snap puts it", () => {
    // Column B's left edge: the row header (22) + 64.29 = 86.29; C's = 150.58.
    // The old zone snap put 150.58 on pixel 150 (Math.floor) where the grid put
    // it on pixel 151 (Math.round) -- the doubled line beside the frame.
    const header = DEFAULT_GRID_CONFIG.rowHeaderWidth;
    const w = DEFAULT_GRID_CONFIG.defaultCellWidth;
    const boundary = header + 2 * w;
    const frozen = verticalXs(gridlines(1, FREEZE_TOP_ROW), 60);
    expect(frozen).toContain((Math.round(boundary) + 0.5) / 1);
    expect(frozen).not.toContain(Math.floor(boundary) + 0.5);
  });
});

describe("gridlineGeometry", () => {
  it("is one device pixel on the device-pixel grid, at any scale", () => {
    for (const scale of [1, 1.25, 1.5, 2, 3]) {
      const g = gridlineGeometry(makeRecordingCtx(scale).ctx);
      expect(g.deviceScale).toBe(scale);
      expect(g.lineWidth).toBe(1 / scale);
      for (const v of [0, 86.29, 150.58, 214.87, 1000.5]) {
        expect(g.snap(v)).toBe((Math.round(v * scale) + 0.5) / scale);
      }
    }
  });

  it("a context without getTransform reads as scale 1, as Core always has", () => {
    const g = gridlineGeometry({} as CanvasRenderingContext2D);
    expect(g.deviceScale).toBe(1);
    expect(g.lineWidth).toBe(1);
    expect(g.snap(150.58)).toBe(151.5);
  });
});
