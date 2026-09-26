//! FILENAME: app/src/core/lib/gridRenderer/stackingPaint.test.ts
// PURPOSE: The renderer's above-selection pass honours the ONE z-order (M8):
//          with a stacking order in force, floating regions paint by z (not by
//          overlay priority), regions without a z paint on top, and the paint
//          order is EXACTLY `stackedFloatingRegions` -- whose reverse is what
//          every hit test walks. Without any z the pass is the historical one.
// CONTEXT: Through the real `renderGrid`, with a recording 2D context; the
//          assertion is the order in which the overlay renderers were called.

import { describe, it, expect, afterEach } from "vitest";
import { renderGrid } from "./core";
import { DEFAULT_THEME } from "./types";
import {
  getOverlayRenderers,
  registerGridOverlay,
  registerRegionStacking,
  stackedFloatingRegions,
  floatingHitOrder,
} from "../../../api/gridOverlays";
import {
  DEFAULT_GRID_CONFIG,
  createDefaultStyleCache,
  type CellDataMap,
  type GridConfig,
  type Viewport,
} from "../../types";
import type { GridRegion, OverlayRegistration } from "./core";

const W = 400;
const H = 240;

function recordingCtx(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = {
    canvas: { width: W, height: H },
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "11px Calibri",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
  };
  return new Proxy(state, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === "measureText") return (s: string) => ({ width: String(s).length * 6 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient" || prop === "createPattern") {
        return () => ({ addColorStop() {} });
      }
      if (prop === "getLineDash") return () => [];
      if (prop === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return () => {};
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const CONFIG: GridConfig = { ...DEFAULT_GRID_CONFIG, defaultCellWidth: 64, defaultCellHeight: 20, totalRows: 100, totalCols: 26 };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 12, colCount: 6 };

function floating(id: string, type: string, z?: number): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 10, y: 10, width: 100, height: 60 },
    ...(z === undefined ? {} : { z }),
  };
}

const rendered: string[] = [];
const record = (c: { region: GridRegion }) => {
  rendered.push(c.region.id);
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  rendered.length = 0;
});

/** Register the real overlay types in the registry and paint one canvas frame with them. */
function paint(regions: GridRegion[]): string[] {
  cleanups.push(
    registerGridOverlay({ type: "pivot-visual", render: record, priority: 12 }),
    registerGridOverlay({ type: "floating-control", render: record, priority: 12 }),
    registerGridOverlay({ type: "chart", render: record, priority: 15 }),
    registerGridOverlay({ type: "timeline-slicer", render: record, priority: 16 }),
  );
  rendered.length = 0;
  renderGrid(
    recordingCtx(), W, H, CONFIG, VIEWPORT,
    null, null, new Map() as CellDataMap, DEFAULT_THEME, [],
    { columnWidths: new Map(), rowHeights: new Map() },
    createDefaultStyleCache(),
    null, null, undefined,
    null, undefined, 0,
    null, undefined,
    regions, getOverlayRenderers() as OverlayRegistration[],
    "Canvas1", [], [], undefined, undefined,
    undefined, undefined,
    false, true, true, true, "A1",
    "canvas",
  );
  return [...rendered];
}

describe("renderGrid paints floating regions in the ONE stacking order", () => {
  it("without z: the historical pass (priority, registration order on ties, publication order)", () => {
    const regions = [floating("c1", "chart"), floating("t1", "timeline-slicer"), floating("k1", "floating-control"), floating("p1", "pivot-visual")];
    expect(paint(regions)).toEqual(["p1", "k1", "c1", "t1"]);
    // ...which is what the one helper says, and hit order is reverse PUBLICATION
    // order -- unchanged, for worksheets and for a canvas with an empty zOrder.
    expect(stackedFloatingRegions(regions).map((r) => r.id)).toEqual(["p1", "k1", "c1", "t1"]);
    expect(floatingHitOrder(regions).map((r) => r.id)).toEqual(["p1", "k1", "t1", "c1"]);
  });

  it("z beats overlay priority: a timeline (16) placed under a pivot box (12) paints first", () => {
    const regions = [floating("p1", "pivot-visual", 1), floating("t1", "timeline-slicer", 0)];
    expect(paint(regions)).toEqual(["t1", "p1"]);
  });

  it("an object without a z paints above every placed one (a new object is on top)", () => {
    const regions = [floating("new", "pivot-visual"), floating("t1", "timeline-slicer", 5), floating("c1", "chart", 2)];
    expect(paint(regions)).toEqual(["c1", "t1", "new"]);
  });

  it("the painted order IS stackedFloatingRegions, and the hit order is its exact reverse", () => {
    cleanups.push(registerRegionStacking((r) => ({ c1: 3, k1: 0, t1: 1 })[r.id]));
    const regions = [
      floating("c1", "chart"),
      floating("t1", "timeline-slicer"),
      floating("p1", "pivot-visual"),
      floating("k1", "floating-control"),
      floating("c2", "chart"),
    ];
    const painted = paint(regions);
    expect(painted).toEqual(["k1", "t1", "c1", "p1", "c2"]);
    expect(stackedFloatingRegions(regions).map((r) => r.id)).toEqual(painted);
    expect(floatingHitOrder(regions).map((r) => r.id)).toEqual([...painted].reverse());
  });
});
