//! FILENAME: app/src/core/lib/gridRenderer/rendering/headers.corner.test.ts
// PURPOSE: The select-all corner carries Excel's triangle glyph, and it stays
//          inside the corner box.
//
// CONTEXT: `drawCorner` was a fillRect plus a strokeRect and nothing else, so
//          the one control in the grid that selects the WHOLE SHEET -- and that
//          now inserts the whole-sheet reference during formula entry -- looked
//          exactly like an empty header cell. Nothing in the repo, unit or e2e,
//          drew or clicked it.
//
// WHY THE CONTAINMENT TEST IS THE IMPORTANT ONE. headers.ts makes 18 stroke
// calls, several of them the gutter-edge gridlines at rowHeaderWidth + 0.5 and
// colHeaderHeight + 0.5, and the visual golden corpus is grid-bearing. A glyph
// that reaches one pixel past the gutter does not read as "a bigger triangle" in
// a diff -- it reads as a moved gridline, in every golden that shows the corner.

import { describe, it, expect } from "vitest";

import { drawCorner } from "./headers";
import { DEFAULT_THEME } from "../types";
import {
  DEFAULT_GRID_CONFIG,
  type CellDataMap,
  type GridConfig,
  type StyleDataMap,
  type Viewport,
} from "../../../types";
import type { RenderState } from "../types";

interface Point { x: number; y: number }

interface Painted {
  /** Every filled path, as its vertices, with the fill colour in force. */
  fills: Array<{ points: Point[]; color: string }>;
  /** Every axis-aligned rect painted or stroked, as x/y/w/h. */
  rects: Array<{ x: number; y: number; w: number; h: number; kind: "fill" | "stroke" }>;
}

/**
 * Records filled paths and rects. Path recording is deliberately literal --
 * moveTo/lineTo accumulate, fill() snapshots -- because the property under test
 * is WHERE the vertices are, not that some drawing happened.
 */
function makeRecordingCtx(): { ctx: CanvasRenderingContext2D; painted: Painted } {
  const painted: Painted = { fills: [], rects: [] };
  let path: Point[] = [];

  const api = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    beginPath() { path = []; },
    moveTo(x: number, y: number) { path.push({ x, y }); },
    lineTo(x: number, y: number) { path.push({ x, y }); },
    closePath() {},
    rect() {},
    clip() {},
    stroke() {},
    fill() { painted.fills.push({ points: [...path], color: String(api.fillStyle) }); },
    fillRect(x: number, y: number, w: number, h: number) {
      painted.rects.push({ x, y, w, h, kind: "fill" });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      painted.rects.push({ x, y, w, h, kind: "stroke" });
    },
    clearRect() {},
    fillText() {},
    measureText(t: string) { return { width: String(t).length * 6 }; },
    setLineDash() {},
    getLineDash() { return []; },
    translate() {},
    scale() {},
  };

  return { ctx: api as unknown as CanvasRenderingContext2D, painted };
}

const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };

function paintCorner(config: GridConfig): Painted {
  const { ctx, painted } = makeRecordingCtx();
  const state: RenderState = {
    ctx,
    width: 800,
    height: 400,
    config,
    viewport: VIEWPORT,
    selection: null,
    editing: null,
    theme: DEFAULT_THEME,
    cells: new Map() as CellDataMap,
    formulaReferences: [],
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
    styleCache: new Map() as StyleDataMap,
  };
  drawCorner(state);
  return painted;
}

/** The triangle: the only filled PATH drawCorner produces. */
const triangleOf = (painted: Painted) => painted.fills.filter((f) => f.points.length === 3);

describe("the select-all corner has a glyph", () => {
  it("fills a triangle inside the corner box", () => {
    const painted = paintCorner(DEFAULT_GRID_CONFIG);
    const triangles = triangleOf(painted);

    expect(triangles.length, "drawCorner filled no 3-point path, so there is no glyph").toBe(1);

    const w = DEFAULT_GRID_CONFIG.rowHeaderWidth;
    const h = DEFAULT_GRID_CONFIG.colHeaderHeight;
    for (const p of triangles[0].points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(w);
      expect(p.y).toBeLessThan(h);
    }
  });

  it("points at the grid: the right angle sits at the bottom-right", () => {
    // Excel's affordance. Two vertices share the maximum x and two share the
    // maximum y, which is what makes the filled corner the bottom-right one.
    const [triangle] = triangleOf(paintCorner(DEFAULT_GRID_CONFIG));
    const xs = triangle.points.map((p) => p.x);
    const ys = triangle.points.map((p) => p.y);

    expect(xs.filter((x) => x === Math.max(...xs)).length).toBe(2);
    expect(ys.filter((y) => y === Math.max(...ys)).length).toBe(2);
  });

  it("is drawn in the header text colour, not the background", () => {
    const [triangle] = triangleOf(paintCorner(DEFAULT_GRID_CONFIG));
    expect(triangle.color).toBe(DEFAULT_THEME.headerText);
  });
});

describe("nothing drawCorner paints escapes the corner box", () => {
  it("every rect and every vertex stays within rowHeaderWidth x colHeaderHeight", () => {
    // The gridline guard. A stroke at rowHeaderWidth + 0.5 belongs to
    // drawRowHeaders; anything from drawCorner reaching that far would read as a
    // moved gridline in every grid-bearing golden.
    const w = DEFAULT_GRID_CONFIG.rowHeaderWidth;
    const h = DEFAULT_GRID_CONFIG.colHeaderHeight;
    const painted = paintCorner(DEFAULT_GRID_CONFIG);

    expect(painted.rects.length).toBeGreaterThan(0);
    for (const r of painted.rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(w);
      expect(r.y + r.h).toBeLessThanOrEqual(h);
    }
    for (const fill of painted.fills) {
      for (const p of fill.points) {
        expect(p.x).toBeLessThanOrEqual(w);
        expect(p.y).toBeLessThanOrEqual(h);
      }
    }
  });
});

describe("a gutter too small for the glyph gets none", () => {
  it("collapsed gutters (View > Headings off) draw no triangle", () => {
    const painted = paintCorner({ ...DEFAULT_GRID_CONFIG, rowHeaderWidth: 0, colHeaderHeight: 0 });
    expect(triangleOf(painted).length).toBe(0);
  });

  it("a gutter narrower than the glyph draws no triangle rather than a smudge", () => {
    const painted = paintCorner({ ...DEFAULT_GRID_CONFIG, rowHeaderWidth: 8, colHeaderHeight: 8 });
    expect(triangleOf(painted).length).toBe(0);
  });

  it("the shipped 22x20 gutters DO get one -- the non-vacuity control", () => {
    expect(triangleOf(paintCorner(DEFAULT_GRID_CONFIG)).length).toBe(1);
  });
});
