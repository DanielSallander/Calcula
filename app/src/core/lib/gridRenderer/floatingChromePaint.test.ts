//! FILENAME: app/src/core/lib/gridRenderer/floatingChromePaint.test.ts
// PURPOSE: Core paints the selection chrome of every selected floating object
//          (BUG-0258 design phase 3), through the REAL renderGrid with a
//          recording 2D context:
//            - the outline is painted exactly ONCE per selected floating region
//              -- family-held and held by the canvas selection set alike --
//              and AFTER every floating object (so a selected object's
//              handles show above an object stacked over it), and BEFORE the
//              over-selection grid layers (the canvas's padlock paints over it);
//            - the handle squares are EXACTLY floatingHandleGeometry(...).paint
//              -- the geometry the resize hit test reads;
//            - a LOCKED object, and any object on a subscribed page, gets the
//              outline and NO handles; an UNSELECTED object gets nothing;
//            - a region publishing handles: "corners" gets four.
//          Plus the FAMILY CHROME CENSUS: the renderers that used to paint
//          their own selection frames and handles no longer do.
// CONTEXT: The stackingPaint.test.ts pattern (real renderGrid, overlay
//          renderers recorded in paint order).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const grid = vi.hoisted(() => ({
  snapshot: null as null | { surface: "grid" | "canvas"; zoom: number; sheetContext: { activeSheetIndex: number }; editing: null },
}));
vi.mock("../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/GridContext")>()),
  getGridStateSnapshot: () => grid.snapshot,
}));

import { renderGrid } from "./core";
import { floatingGripOf } from "../floatingGrip";
import { resetObjectHoverForTests, setHoveredFloatingRegion } from "../objectHover";
import { FLOATING_GRIP_HOVER_INK, FLOATING_GRIP_HOVER_PLATE } from "../floatingHandleMetrics";
import { DEFAULT_THEME } from "./types";
import {
  getOverlayRenderers,
  registerGridOverlay,
  registerRegionStacking,
  setGridRegions,
} from "../../../api/gridOverlays";
import {
  addToObjectSelection,
  clearObjectSelection,
  notifyObjectSelectionChanged,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  getSetHeldObjectRegions,
  type ObjectSelectionProvider,
} from "../../../api/objectSelection";
import { registerGridLayer } from "../../../api/gridLayers";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../layoutSurface";
import {
  FLOATING_SELECTION_COLOUR,
  floatingHandleGeometry,
  type FloatingCanvasRect,
} from "../floatingHandles";
import {
  DEFAULT_GRID_CONFIG,
  createDefaultStyleCache,
  type CellDataMap,
  type GridConfig,
  type Viewport,
} from "../../types";
import type { GridRegion, OverlayRegistration } from "./core";

const W = 800;
const H = 600;
const CONFIG: GridConfig = { ...DEFAULT_GRID_CONFIG, defaultCellWidth: 64, defaultCellHeight: 20, totalRows: 100, totalCols: 26 };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 12 };

type Op = { op: string; args: number[]; style: string };

/** A recording context: every stroke/fill and every overlay render, in order. */
function recordingCtx(log: Op[]): CanvasRenderingContext2D {
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
      if (prop === "strokeRect") return (...a: number[]) => log.push({ op: "strokeRect", args: a, style: String(t.strokeStyle) });
      if (prop === "fillRect") return (...a: number[]) => log.push({ op: "fillRect", args: a, style: String(t.fillStyle) });
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

function floating(id: string, type: string, box: FloatingCanvasRect, data: Record<string, unknown> = {}, z?: number): GridRegion {
  return {
    id,
    type,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: box,
    data,
    ...(z === undefined ? {} : { z }),
  };
}

const log: Op[] = [];
const cleanups: Array<() => void> = [];
const held = new Map<string, Set<string>>();

/** A family provider holding ONE object (the chart convention), so a second member is set-held. */
function singleFamily(type: string): ObjectSelectionProvider {
  const ids = new Set<string>();
  held.set(type, ids);
  return {
    types: [type],
    isSelected: (r) => ids.has(r.id),
    select: (r) => {
      ids.clear();
      ids.add(r.id);
      notifyObjectSelectionChanged();
    },
    deselectAll: () => {
      if (ids.size === 0) return;
      ids.clear();
      notifyObjectSelectionChanged();
    },
  };
}

beforeEach(() => {
  log.length = 0;
  const render = (c: { region: GridRegion }) => {
    log.push({ op: "render", args: [], style: c.region.id });
  };
  cleanups.push(
    registerGridOverlay({ type: "chart", render, priority: 15 }),
    registerGridOverlay({ type: "slicer", render, priority: 14 }),
    registerObjectSelectionProvider(singleFamily("chart")),
    registerObjectSelectionProvider(singleFamily("slicer")),
  );
});

afterEach(() => {
  clearObjectSelection();
  setGridRegions([]);
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  held.clear();
});

/**
 * Publish `regions` (the selection seam reads the published list) and paint
 * one frame on a surface ("canvas": gutters 0; "grid": the config's).
 */
function paint(regions: GridRegion[], surface: "canvas" | "grid" = "canvas"): Op[] {
  log.length = 0;
  renderGrid(
    recordingCtx(log), W, H, CONFIG, VIEWPORT,
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
    surface,
  );
  return [...log];
}

function useSurface(over: Partial<LayoutSurface>): void {
  const s: LayoutSurface = {
    snapToGrid: false,
    gridSize: 16,
    showGrid: false,
    page: { width: 1280, height: 720 },
    editable: true,
    ...over,
  };
  cleanups.push(registerLayoutSurfaceProvider({ get: () => s }));
}

const outlines = (ops: Op[]) => ops.filter((o) => o.op === "strokeRect" && o.style === FLOATING_SELECTION_COLOUR);
const handleSquares = (ops: Op[]) => ops.filter((o) => o.op === "fillRect" && o.style === FLOATING_SELECTION_COLOUR);

const C1 = { x: 20, y: 30, width: 200, height: 120 };
const C2 = { x: 300, y: 30, width: 160, height: 100 };
const S1 = { x: 20, y: 200, width: 40, height: 40 };

describe("Core paints the selection chrome of every SELECTED floating object", () => {
  it("an UNSELECTED object gets nothing", () => {
    const ops = paint([floating("c1", "chart", C1)]);
    expect(outlines(ops)).toEqual([]);
    expect(handleSquares(ops)).toEqual([]);
  });

  it("the outline is painted ONCE per selected region -- family-held AND set-held -- inset by 1 for its 2px width", () => {
    const regions = [floating("c1", "chart", C1), floating("c2", "chart", C2)];
    setGridRegions(regions);
    addToObjectSelection(regions[0]); // the chart family holds c1
    addToObjectSelection(regions[1]); // ...so the SET holds c2
    expect(getSetHeldObjectRegions(regions).map((r) => r.id), "precondition: c2 is set-held").toEqual(["c2"]);
    const ops = paint(regions);
    const got = outlines(ops).map((o) => o.args);
    expect(got).toHaveLength(2);
    expect(got).toContainEqual([C1.x + 1, C1.y + 1, C1.width - 2, C1.height - 2]);
    expect(got).toContainEqual([C2.x + 1, C2.y + 1, C2.width - 2, C2.height - 2]);
  });

  it("after EVERY floating object is painted, and before the over-selection layers", () => {
    cleanups.push(
      registerGridLayer({
        id: "chrome-order-probe",
        anchor: "over-selection",
        paint: () => {
          log.push({ op: "layer", args: [], style: "" });
        },
      }),
    );
    const regions = [floating("c1", "chart", C1), floating("s1", "slicer", S1), floating("c2", "chart", C2)];
    setGridRegions(regions);
    addToObjectSelection(regions[0]);
    const ops = paint(regions);
    const lastRender = ops.map((o) => o.op).lastIndexOf("render");
    const firstChrome = ops.findIndex((o) => o.op === "strokeRect" && o.style === FLOATING_SELECTION_COLOUR);
    const layer = ops.findIndex((o) => o.op === "layer");
    expect(ops.filter((o) => o.op === "render")).toHaveLength(3);
    expect(firstChrome, "the chrome was painted before an object stacked above it").toBeGreaterThan(lastRender);
    expect(layer, "the over-selection layers ran before the chrome").toBeGreaterThan(firstChrome);
  });

  it("the handle squares are EXACTLY the geometry's paint rects (8 on a large object), at the painted gutters", () => {
    const regions = [floating("c1", "chart", C1)];
    setGridRegions(regions);
    addToObjectSelection(regions[0]);
    for (const surface of ["canvas", "grid"] as const) {
      const ops = paint(regions, surface);
      const gx = surface === "canvas" ? 0 : CONFIG.rowHeaderWidth ?? 0;
      const gy = surface === "canvas" ? 0 : CONFIG.colHeaderHeight ?? 0;
      const want = floatingHandleGeometry({ x: gx + C1.x, y: gy + C1.y, width: C1.width, height: C1.height }, "all")
        .map((h) => [h.paint.x, h.paint.y, h.paint.width, h.paint.height]);
      expect(want).toHaveLength(8);
      expect(handleSquares(ops).map((o) => o.args), surface).toEqual(want);
    }
  });

  it("a region publishing handles: 'corners' gets its four corners only", () => {
    const regions = [floating("c1", "chart", C1, { handles: "corners" })];
    setGridRegions(regions);
    addToObjectSelection(regions[0]);
    const want = floatingHandleGeometry(C1, "corners").map((h) => [h.paint.x, h.paint.y, h.paint.width, h.paint.height]);
    expect(handleSquares(paint(regions)).map((o) => o.args)).toEqual(want);
  });

  it("a LOCKED object gets the outline and NO handles", () => {
    useSurface({ isLocked: (r) => r.id === "c1" });
    const regions = [floating("c1", "chart", C1)];
    setGridRegions(regions);
    addToObjectSelection(regions[0]);
    const ops = paint(regions);
    expect(outlines(ops)).toHaveLength(1);
    expect(handleSquares(ops)).toEqual([]);
  });

  it("on a SUBSCRIBED page (consume mode) the outline and NO handles; resizable: false the same", () => {
    useSurface({ editable: false });
    const regions = [floating("c1", "chart", C1)];
    setGridRegions(regions);
    addToObjectSelection(regions[0]);
    let ops = paint(regions);
    expect(outlines(ops)).toHaveLength(1);
    expect(handleSquares(ops)).toEqual([]);
    cleanups.pop()!();
    const fixed = [floating("c1", "chart", C1, { resizable: false })];
    setGridRegions(fixed);
    ops = paint(fixed);
    expect(outlines(ops)).toHaveLength(1);
    expect(handleSquares(ops)).toEqual([]);
  });

  it("where two selected objects' handles overlap, the one painted LAST is the topmost -- the one a press grabs", () => {
    // Same top-left corner; z puts c2 on top (the hit order's first).
    cleanups.push(registerRegionStacking((r) => ({ c1: 1, c2: 2 })[r.id]));
    const A = { x: 40, y: 40, width: 200, height: 150 };
    const B = { x: 40, y: 40, width: 120, height: 90 };
    const regions = [floating("c2", "chart", B), floating("c1", "chart", A)];
    setGridRegions(regions);
    addToObjectSelection(regions[0]);
    addToObjectSelection(regions[1]);
    const outs = outlines(paint(regions)).map((o) => o.args);
    expect(outs[outs.length - 1], "the topmost object's chrome was not painted last").toEqual([B.x + 1, B.y + 1, B.width - 2, B.height - 2]);
  });
});

describe("the FAMILY CHROME CENSUS: no family paints selection chrome of its own", () => {
  const ext = (p: string) => readFileSync(resolve(__dirname, "../../../../extensions", p), "utf8");
  const RENDERERS = [
    "Charts/rendering/chartRenderer.ts",
    "Controls/Button/floatingRenderer.ts",
    "Controls/Shape/shapeRenderer.ts",
    "Controls/Image/imageRenderer.ts",
    "Pivot/rendering/pivotVisualRenderer.ts",
    "FloatingRange/rendering/frRenderer.ts",
    "Slicer/rendering/slicerRenderer.ts",
    "TimelineSlicer/rendering/timelineSlicerRenderer.ts",
  ];
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("no renderer draws resize handles", () => {
    for (const f of RENDERERS) {
      expect(code(ext(f)), f).not.toMatch(/drawResizeHandles|drawSelectionIndicators|showHandles/);
    }
  });

  it("no renderer strokes a frame in a branch taken because its object is SELECTED", () => {
    // `if (isXSelected(id)) { ... strokeRect / roundRect / strokeStyle ... }`
    // -- the shape every one of them had. A NEGATED check (the button's dotted
    // border marks an UNSELECTED button in Design Mode) is not selection chrome.
    const selectedBranch =
      /(?<![!\w])is(?:Chart|Slicer|Timeline|PivotVisual|FloatingControl|FloatingRange)Selected\([^)]*\)\)?\s*\{[^}]*?(strokeRect|roundRect|strokeStyle)/;
    for (const f of RENDERERS) {
      expect(code(ext(f)), f).not.toMatch(selectedBranch);
    }
  });

  it("the old selection-border colour is gone from the slicer, timeline and pivot-box renderers", () => {
    for (const f of RENDERERS.filter((p) => /Slicer|Timeline|pivotVisual/.test(p))) {
      expect(code(ext(f)), f).not.toMatch(/#0078D4/i);
    }
  });

  it("the canvas paints no set-held frame of its own (only the lock mark)", () => {
    const src = code(ext("CanvasSheet/lib/selectionChrome.ts"));
    expect(src).not.toMatch(/getSetHeldObjectRegions|strokeRect/);
    expect(src).toMatch(/paintLockMarks/);
  });

  it("census is non-vacuous: every file exists and the selected-branch pattern matches the OLD shape", () => {
    for (const f of RENDERERS) expect(ext(f).length, f).toBeGreaterThan(1000);
    const old = `if (isChartSelected(chartId)) {\n    ctx.strokeStyle = "#0e639c";\n    ctx.lineWidth = 2;`;
    expect(old).toMatch(
      /(?<![!\w])is(?:Chart|Slicer|Timeline|PivotVisual|FloatingControl|FloatingRange)Selected\([^)]*\)\)?\s*\{[^}]*?(strokeRect|roundRect|strokeStyle)/,
    );
  });
});

// ============================================================================
// The six-dot GRIP (BUG-0258 design phase 5; core/lib/floatingGrip.ts)
// ============================================================================

describe("Core paints the GRIP of every object whose grip shows -- from the geometry its hit test reads", () => {
  const plateArgs = (r: GridRegion, surface: "canvas" | "grid", zoom = 1): number[] => {
    const gutters = surface === "canvas"
      ? { rowHeaderWidth: 0, colHeaderHeight: 0 }
      : { rowHeaderWidth: CONFIG.rowHeaderWidth ?? 0, colHeaderHeight: CONFIG.colHeaderHeight ?? 0 };
    const g = floatingGripOf(r, gutters, { scrollX: 0, scrollY: 0 }, zoom, surface === "canvas" ? { width: 1280, height: 720 } : null)!;
    return [g.plate.x, g.plate.y, g.plate.width, g.plate.height];
  };
  const platesAt = (ops: Op[], args: number[]) => ops.filter((o) => o.op === "fillRect" && JSON.stringify(o.args) === JSON.stringify(args));

  afterEach(() => {
    grid.snapshot = null;
    resetObjectHoverForTests();
  });

  it("a grip:'hover' slicer: nothing while neither hovered nor selected; HOVERED, a white plate with a grey border at the geometry's plate", () => {
    const s = floating("s1", "slicer", { x: 300, y: 200, width: 160, height: 120 }, { grip: "hover" });
    setGridRegions([s]);
    const want = plateArgs(s, "grid");
    expect(platesAt(paint([s], "grid"), want), "an idle header-less slicer shows a grip").toEqual([]);
    setHoveredFloatingRegion("s1");
    const ops = paint([s], "grid");
    const plate = platesAt(ops, want);
    expect(plate).toHaveLength(1);
    expect(plate[0].style).toBe(FLOATING_GRIP_HOVER_PLATE);
    expect(ops.some((o) => o.op === "strokeRect" && o.style === FLOATING_GRIP_HOVER_INK), "no grey border").toBe(true);
  });

  it("SELECTED, the plate is the selection blue", () => {
    const s = floating("s1", "slicer", { x: 300, y: 200, width: 160, height: 120 }, { grip: "hover" });
    setGridRegions([s]);
    addToObjectSelection(s);
    const plate = platesAt(paint([s], "grid"), plateArgs(s, "grid"));
    expect(plate).toHaveLength(1);
    expect(plate[0].style).toBe(FLOATING_SELECTION_COLOUR);
  });

  it("at zoom 2 the plate is painted where the zoom-2 geometry puts it (24 screen px, the painter reads the grid's zoom)", () => {
    grid.snapshot = { surface: "grid", zoom: 2, sheetContext: { activeSheetIndex: 0 }, editing: null };
    const s = floating("s1", "slicer", { x: 300, y: 200, width: 160, height: 120 }, { grip: "hover" });
    setGridRegions([s]);
    setHoveredFloatingRegion("s1");
    expect(platesAt(paint([s], "grid"), plateArgs(s, "grid", 2))).toHaveLength(1);
  });

  it("after EVERY object and BEFORE the selection chrome (a handle overlapping a grip is painted over it)", () => {
    const s = floating("s1", "slicer", { x: 300, y: 200, width: 160, height: 120 }, { grip: "hover" });
    const c = floating("c1", "chart", { x: 20, y: 30, width: 200, height: 120 });
    setGridRegions([s, c]);
    addToObjectSelection(s);
    const ops = paint([s, c], "grid");
    const plate = ops.findIndex((o) => o.op === "fillRect" && JSON.stringify(o.args) === JSON.stringify(plateArgs(s, "grid")));
    const lastRender = ops.map((o) => o.op).lastIndexOf("render");
    const firstChrome = ops.findIndex((o) => o.op === "strokeRect" && o.style === FLOATING_SELECTION_COLOUR);
    expect(plate).toBeGreaterThan(-1);
    expect(plate, "the grip was painted under an object").toBeGreaterThan(lastRender);
    expect(plate, "the grip was painted over the selection chrome (its handles)").toBeLessThan(firstChrome);
  });

  it("canvas: only the selection's PRIMARY member gets a grip (a chart too); a titled chart on a WORKSHEET gets none", () => {
    grid.snapshot = { surface: "canvas", zoom: 1, sheetContext: { activeSheetIndex: 0 }, editing: null };
    useSurface({});
    const c1 = floating("c1", "chart", { x: 20, y: 60, width: 200, height: 120 });
    const s1 = floating("s1", "slicer", { x: 300, y: 60, width: 160, height: 120 });
    setGridRegions([c1, s1]);
    addToObjectSelection(c1);
    addToObjectSelection(s1); // the primary
    const ops = paint([c1, s1], "canvas");
    expect(platesAt(ops, plateArgs(s1, "canvas")), "the primary member has no grip").toHaveLength(1);
    expect(platesAt(ops, plateArgs(c1, "canvas")), "a non-primary member has a grip").toEqual([]);

    grid.snapshot = { surface: "grid", zoom: 1, sheetContext: { activeSheetIndex: 0 }, editing: null };
    cleanups.pop()!();
    clearObjectSelection();
    setGridRegions([c1]);
    addToObjectSelection(c1);
    expect(platesAt(paint([c1], "grid"), plateArgs(c1, "grid")), "a selected worksheet chart shows a grip").toEqual([]);
  });

  it("never on a LOCKED object (the lock shows a padlock; a grip would promise a move)", () => {
    grid.snapshot = { surface: "canvas", zoom: 1, sheetContext: { activeSheetIndex: 0 }, editing: null };
    useSurface({ isLocked: (r) => r.id === "c1" });
    const c1 = floating("c1", "chart", { x: 20, y: 60, width: 200, height: 120 });
    setGridRegions([c1]);
    addToObjectSelection(c1);
    expect(platesAt(paint([c1], "canvas"), plateArgs(c1, "canvas"))).toEqual([]);
  });
});
