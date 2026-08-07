//! FILENAME: app/src/core/lib/gridRenderer/cellDecorationZOrder.test.ts
// PURPOSE: A selected cell must still show its own indicators.
// CONTEXT: The active-cell highlight fills the cell and strokes a 2px border
//          inset 1px from its edge — over exactly the top-right corner where
//          the note/comment triangle lives. Selecting a commented cell hid the
//          mark that said it was commented (measured: 15 indicator pixels with
//          the selection parked elsewhere, 0 with the cell selected).
//
// HOW THIS IS VERIFIED. Not by eye and not by asserting a call order. The fake
// 2D context below is a small deterministic RASTERISER: it composites fillRect,
// strokeRect, axis-aligned strokes and filled polygons into an RGBA buffer with
// source-over alpha, so a translucent selection tint tints and an opaque border
// covers, exactly as the real canvas does. "Indicator pixels" is then the same
// measurement the defect report used: the number of pixels that DIFFER between
// a frame rendered with the decoration registered and the identical frame
// rendered without it.
//
// The frames go through the real `renderGrid`, so the pass order under test is
// the renderer's own, not a re-statement of it in the test.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderGrid } from "./core";
import { DEFAULT_THEME } from "./types";
import {
  registerCellDecoration,
  unregisterCellDecoration,
  type CellDecorationContext,
  type CellDecorationAnchor,
} from "../../../api/cellDecorations";
import {
  DEFAULT_GRID_CONFIG,
  createDefaultStyleCache,
  cellKey,
  type CellData,
  type CellDataMap,
  type GridConfig,
  type Selection,
  type Viewport,
} from "../../types";

// ============================================================================
// Deterministic rasteriser
// ============================================================================

const W = 320;
const H = 160;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "transparent" || v === "none") return null;
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    return null;
  }
  const m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length >= 3) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
  }
  // A few CSS names the renderer/theme uses.
  const named: Record<string, Rgba> = {
    white: { r: 255, g: 255, b: 255, a: 1 },
    black: { r: 0, g: 0, b: 0, a: 1 },
    red: { r: 255, g: 0, b: 0, a: 1 },
  };
  return named[v] ?? null;
}

/**
 * Records every composited pixel. Only the operations the paths under test
 * actually emit are rasterised; text and diagonal strokes are ignored, which is
 * safe here because the fixture has no diagonal borders and text cannot reach
 * the 6px corner the assertions read (and, being ignored in BOTH frames of a
 * comparison, could not bias a difference anyway).
 */
class Raster {
  readonly px: Float64Array; // r,g,b per pixel

  constructor() {
    this.px = new Float64Array(W * H * 3);
    this.px.fill(255);
  }

  blend(x: number, y: number, c: Rgba): void {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 3;
    const a = Math.max(0, Math.min(1, c.a));
    this.px[i] = this.px[i] * (1 - a) + c.r * a;
    this.px[i + 1] = this.px[i + 1] * (1 - a) + c.g * a;
    this.px[i + 2] = this.px[i + 2] * (1 - a) + c.b * a;
  }

  fillRect(x: number, y: number, w: number, h: number, c: Rgba): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    for (let py = Math.min(y0, y1); py < Math.max(y0, y1); py++) {
      for (let px = Math.min(x0, x1); px < Math.max(x0, x1); px++) {
        this.blend(px, py, c);
      }
    }
  }
}

type Point = { x: number; y: number };

/** Even-odd-free scanline fill for the convex corner triangles under test. */
function fillPolygon(raster: Raster, pts: Point[], c: Rgba): void {
  if (pts.length < 3) return;
  const minY = Math.floor(Math.min(...pts.map((p) => p.y)));
  const maxY = Math.ceil(Math.max(...pts.map((p) => p.y)));
  const minX = Math.floor(Math.min(...pts.map((p) => p.x)));
  const maxX = Math.ceil(Math.max(...pts.map((p) => p.x)));
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, pts)) raster.blend(x, y, c);
    }
  }
}

function pointInPolygon(x: number, y: number, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

interface CanvasState {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
}

function makeRasterCtx(): { ctx: CanvasRenderingContext2D; raster: Raster } {
  const raster = new Raster();
  const stack: CanvasState[] = [];
  let path: Point[] = [];

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
    canvas: { width: W, height: H },

    save() {
      stack.push({
        fillStyle: api.fillStyle,
        strokeStyle: api.strokeStyle,
        lineWidth: api.lineWidth,
        globalAlpha: api.globalAlpha,
      });
    },
    restore() {
      const s = stack.pop();
      if (!s) return;
      api.fillStyle = s.fillStyle;
      api.strokeStyle = s.strokeStyle;
      api.lineWidth = s.lineWidth;
      api.globalAlpha = s.globalAlpha;
    },

    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push({ x, y });
    },
    lineTo(x: number, y: number) {
      path.push({ x, y });
    },
    closePath() {
      /* the polygon fill closes implicitly */
    },
    rect() {
      /* only ever used to build a clip region here */
    },
    arc(cx: number, cy: number, r: number) {
      // Bookmark dots. Approximated as a square of the circle's inscribed box;
      // fidelity is irrelevant so long as it is identical in both frames.
      path.push({ x: cx - r, y: cy - r }, { x: cx + r, y: cy - r }, { x: cx + r, y: cy + r }, { x: cx - r, y: cy + r });
    },
    clip() {
      /* no-op: the fixture cell is fully inside the viewport */
    },
    fill() {
      const c = parseColor(api.fillStyle);
      if (c) fillPolygon(raster, path, { ...c, a: c.a * api.globalAlpha });
    },
    stroke() {
      const c = parseColor(api.strokeStyle);
      if (!c || path.length < 2) return;
      const lw = Math.max(1, api.lineWidth);
      for (let i = 1; i < path.length; i++) {
        const p0 = path[i - 1];
        const p1 = path[i];
        if (p0.y === p1.y) {
          raster.fillRect(Math.min(p0.x, p1.x), p0.y - lw / 2, Math.abs(p1.x - p0.x), lw, {
            ...c,
            a: c.a * api.globalAlpha,
          });
        } else if (p0.x === p1.x) {
          raster.fillRect(p0.x - lw / 2, Math.min(p0.y, p1.y), lw, Math.abs(p1.y - p0.y), {
            ...c,
            a: c.a * api.globalAlpha,
          });
        }
        // Diagonals are not rasterised; the fixture emits none.
      }
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const c = parseColor(api.fillStyle);
      if (c) raster.fillRect(x, y, w, h, { ...c, a: c.a * api.globalAlpha });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      const c = parseColor(api.strokeStyle);
      if (!c) return;
      const lw = Math.max(1, api.lineWidth);
      const col = { ...c, a: c.a * api.globalAlpha };
      raster.fillRect(x - lw / 2, y - lw / 2, w + lw, lw, col); // top
      raster.fillRect(x - lw / 2, y + h - lw / 2, w + lw, lw, col); // bottom
      raster.fillRect(x - lw / 2, y - lw / 2, lw, h + lw, col); // left
      raster.fillRect(x + w - lw / 2, y - lw / 2, lw, h + lw, col); // right
    },
    clearRect(x: number, y: number, w: number, h: number) {
      raster.fillRect(x, y, w, h, { r: 255, g: 255, b: 255, a: 1 });
    },
    fillText() {
      /* text never reaches the corner under assertion */
    },
    strokeText() {},
    measureText(text: string) {
      return { width: String(text).length * 6 };
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

  return { ctx: api as unknown as CanvasRenderingContext2D, raster };
}

// ============================================================================
// Fixture
// ============================================================================

const ANNOTATED_ROW = 1;
const ANNOTATED_COL = 1;
const DECORATION_ID = "test-annotation-triangle";

/** Byte-for-byte the geometry of Review/rendering/triangleRenderer.ts. */
const TRIANGLE_SIZE = 6;
const NOTE_COLOR = "#FF0000";

function drawNoteTriangle(context: CellDecorationContext): void {
  const { ctx, row, col, cellRight, cellTop } = context;
  if (row !== ANNOTATED_ROW || col !== ANNOTATED_COL) return;
  ctx.save();
  ctx.fillStyle = NOTE_COLOR;
  ctx.beginPath();
  ctx.moveTo(cellRight - TRIANGLE_SIZE, cellTop);
  ctx.lineTo(cellRight, cellTop);
  ctx.lineTo(cellRight, cellTop + TRIANGLE_SIZE);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: 64,
  defaultCellHeight: 20,
  totalRows: 100,
  totalCols: 26,
};

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 20,
  colCount: 10,
};

function makeCells(): CellDataMap {
  const cells: CellDataMap = new Map();
  const cell: CellData = {
    row: ANNOTATED_ROW,
    col: ANNOTATED_COL,
    value: "x",
    display: "x",
    styleIndex: 0,
  } as CellData;
  cells.set(cellKey(ANNOTATED_ROW, ANNOTATED_COL), cell);
  return cells;
}

function renderFrame(selection: Selection | null): Raster {
  const { ctx, raster } = makeRasterCtx();
  renderGrid(
    ctx,
    W,
    H,
    CONFIG,
    VIEWPORT,
    selection,
    null,
    makeCells(),
    DEFAULT_THEME,
    [],
    { columnWidths: new Map(), rowHeights: new Map() },
    createDefaultStyleCache(),
  );
  return raster;
}

/**
 * Pixels the decoration is responsible for: those that differ between an
 * otherwise-identical pair of frames rendered with and without it registered.
 */
function indicatorPixels(selection: Selection | null, anchor: CellDecorationAnchor): number {
  unregisterCellDecoration(DECORATION_ID);
  const without = renderFrame(selection);

  registerCellDecoration(DECORATION_ID, drawNoteTriangle, 5, anchor);
  const with_ = renderFrame(selection);
  unregisterCellDecoration(DECORATION_ID);

  return diffPixels(without, with_);
}

/** Pixels whose composited colour differs between two frames (all channels). */
function diffPixels(a: Raster, b: Raster): number {
  let differing = 0;
  for (let i = 0; i < a.px.length; i += 3) {
    if (
      Math.abs(a.px[i] - b.px[i]) > 0.5 ||
      Math.abs(a.px[i + 1] - b.px[i + 1]) > 0.5 ||
      Math.abs(a.px[i + 2] - b.px[i + 2]) > 0.5
    ) {
      differing++;
    }
  }
  return differing;
}

const ELSEWHERE: Selection = { startRow: 8, startCol: 4, endRow: 8, endCol: 4 };
const ON_THE_CELL: Selection = {
  startRow: ANNOTATED_ROW,
  startCol: ANNOTATED_COL,
  endRow: ANNOTATED_ROW,
  endCol: ANNOTATED_COL,
};

afterEach(() => {
  unregisterCellDecoration(DECORATION_ID);
});

// ============================================================================
// Tests
// ============================================================================

describe("cell decorations under the selection chrome", () => {
  it("the probe sees the indicator at all when the cell is not selected", () => {
    // Establishes the measurement itself is live. Without this, "the counts
    // match" would pass trivially at 0 === 0.
    expect(indicatorPixels(ELSEWHERE, "over-selection")).toBeGreaterThan(0);
  });

  it("an under-selection decoration is what the defect measured: erased by the highlight", () => {
    // The old behaviour, kept as a test so the two anchors are demonstrably
    // different rather than the new one being assumed to do something.
    const unselected = indicatorPixels(ELSEWHERE, "under-selection");
    const selected = indicatorPixels(ON_THE_CELL, "under-selection");

    expect(unselected).toBeGreaterThan(0);
    expect(selected).toBeLessThan(unselected);
  });

  it("an over-selection decoration survives the active-cell highlight intact", () => {
    const unselected = indicatorPixels(ELSEWHERE, "over-selection");
    const selected = indicatorPixels(ON_THE_CELL, "over-selection");

    // Every pixel the triangle owns is still its own: it now paints after the
    // fill and the border, so the covered SET is identical. Not merely "more
    // than zero" — a partial rescue would still hide most of a 6px mark.
    expect(selected).toBe(unselected);
  });

  it("keeps the selection border legible: the chrome still paints", () => {
    // The fix must not have been "stop drawing the selection on decorated
    // cells". Selecting the cell must still change the frame substantially.
    unregisterCellDecoration(DECORATION_ID);
    const clean = renderFrame(null);
    const selected = renderFrame(ON_THE_CELL);

    // A 64x20 cell of tint plus a 2px border is far more than the 21px triangle.
    expect(diffPixels(clean, selected)).toBeGreaterThan(200);
  });

  it("also survives when the cell is part of a larger selected range", () => {
    const range: Selection = {
      startRow: ANNOTATED_ROW - 1,
      startCol: ANNOTATED_COL - 1,
      endRow: ANNOTATED_ROW + 2,
      endCol: ANNOTATED_COL + 2,
    };
    expect(indicatorPixels(range, "over-selection")).toBe(
      indicatorPixels(ELSEWHERE, "over-selection"),
    );
  });

  it("also survives under the clipboard marching-ants range", () => {
    // Same class of chrome, painted immediately after the selection.
    const withAnts = (register: boolean): Raster => {
      unregisterCellDecoration(DECORATION_ID);
      if (register) registerCellDecoration(DECORATION_ID, drawNoteTriangle, 5, "over-selection");
      const { ctx, raster } = makeRasterCtx();
      renderGrid(
        ctx,
        W,
        H,
        CONFIG,
        VIEWPORT,
        ELSEWHERE,
        null,
        makeCells(),
        DEFAULT_THEME,
        [],
        { columnWidths: new Map(), rowHeights: new Map() },
        createDefaultStyleCache(),
        null,
        null,
        undefined,
        ON_THE_CELL,
        "copy",
        0,
      );
      unregisterCellDecoration(DECORATION_ID);
      return raster;
    };

    const without = withAnts(false);
    const with_ = withAnts(true);
    expect(diffPixels(without, with_)).toBe(indicatorPixels(ELSEWHERE, "over-selection"));
  });
});

describe("the indicator extensions declare the anchor", () => {
  // The renderer half is useless if no decoration opts in, and the opt-in is a
  // single argument that is easy to drop in a refactor.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => readFileSync(resolve(HERE, p), "utf8");

  it("Review registers its annotation triangles over-selection", () => {
    expect(read("../../../../extensions/Review/index.ts")).toMatch(
      /"annotation-triangles",[\s\S]{0,120}?"over-selection"/,
    );
  });

  it("ErrorChecking registers its error triangles over-selection", () => {
    expect(read("../../../../extensions/ErrorChecking/index.ts")).toMatch(
      /"error-checking-triangles",[\s\S]{0,160}?"over-selection"/,
    );
  });

  it("CellBookmarks registers its dot over-selection", () => {
    expect(read("../../../../extensions/BuiltIn/CellBookmarks/index.ts")).toContain(
      'drawBookmarkDot, 20, "over-selection"',
    );
  });
});
