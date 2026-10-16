//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotBoxContainer.test.ts
// PURPOSE: WP-C S10 -- a canvas pivot box inside its VISUAL CONTAINER, paint ==
//          hit. Core's own sequence is run here exactly as
//          core/lib/gridRenderer paints a floating region (measure the layout,
//          record it, paint the container UNDER, the family's render, paint the
//          container OVER), then:
//          - with padding 16 and a Core-painted title, the box's cells are
//            painted from the CONTENT rect's origin and the first header cell
//            is hit there; the padding / title band is Core's frame
//            ("container"), never a cell;
//          - ONE owner of the box background (review R1-8): with the container
//            background #FFF4E5 a point BELOW the last row shows #FFF4E5 -- the
//            box no longer floods its own valueBackground over it -- while a
//            point on a cell still shows the cell's own fill;
//          - the box paints no outline of its own (the container border is
//            Core's).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const api = vi.hoisted(() => ({
  updatePivotProperties: vi.fn(),
}));

vi.mock("@api", () => ({
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  getTaskPaneManuallyClosed: () => [],
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  emitAppEvent: vi.fn(),
  showToast: vi.fn(),
  isPointerClaimed: () => false,
}));
vi.mock("@api/pivot", () => ({ pivot: { getAtCell: vi.fn() } }));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({
    zoom: 1,
    surface: "canvas",
    displayHeadings: false,
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    sheetContext: { activeSheetIndex: 2 },
  }),
  resolveHeaderSizes: () => ({ rowHeaderWidth: 0, colHeaderHeight: 0 }),
}));
vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));
vi.mock("../pivot-api", () => ({
  updatePivotProperties: api.updatePivotProperties,
  getPivotCellWindow: vi.fn(),
  getCellDisplayValue: (v: unknown) => (v == null ? "" : String(v)),
}));
vi.mock("../pivotChromeActions", () => ({
  togglePivotHeaderAt: vi.fn(),
  openPivotReportFilterAt: vi.fn(),
  openPivotHeaderFilter: vi.fn(),
  cancelPivotLoading: vi.fn(),
  getPivotViewCell: vi.fn(),
}));
vi.mock("../pivotCellDoubleClick", () => ({ runPivotCellDoubleClick: vi.fn() }));

import {
  getGridRegions,
  registerGridOverlay,
  resolveFloatingZone,
  setGridRegions,
  type GridRegion,
  type OverlayRegistration,
} from "@api/gridOverlays";
import {
  containerLayoutSignature,
  measureVisualContainerLayout,
  paintVisualContainerOver,
  paintVisualContainerUnder,
  recordPaintedContainerLayout,
  resetPaintedContainerLayouts,
  type ContainerRegion,
} from "@api/visualContainerPaint";
import { createRecordingCtx, type Rect } from "../../../_shared/lib/__tests__/recordingCtx";
import { installPivotVisual, pivotCellSheetRect, pivotVisualZoneAt } from "../pivotVisualOverlay";
import { publishPivotRegions, resetPivotVisualRegionState, PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";
import { getPivotVisualRecord, resetPivotVisualHits, viewCellAtCanvasPoint } from "../pivotVisualHits";
import { setCachedPivotView, deleteCachedPivotView } from "../pivotViewStore";
import { resetSelectionHandlerState, updateCachedRegions } from "../../handlers/selectionHandler";
import { resetObjectSelectionProviders } from "@api/objectSelection";
import { DEFAULT_PIVOT_THEME } from "../../rendering/pivot";
import type { PivotRegionData } from "../../types";
import type { PivotViewResponse } from "../pivot-api";

const BG = "#FFF4E5";

/** Frame (100, 80) 300 x 200; padding 16 on every side; a Core title; background #FFF4E5. */
const boxPivot: PivotRegionData = {
  pivotId: "cp1",
  name: "Sales",
  startRow: 0,
  startCol: 1024,
  endRow: 3,
  endCol: 1025,
  isEmpty: false,
  isModel: false,
  canvasFrame: {
    x: 100,
    y: 80,
    width: 300,
    height: 200,
    container: {
      padding: { top: 16, right: 16, bottom: 16, left: 16 },
      title: { show: true, text: "Sales by region" },
      background: { color: BG },
    },
  },
};

/** 4 rows (a header + 3) x 2 columns: far less than the box, so area below the last row is empty. */
function smallView(): PivotViewResponse {
  const rows = Array.from({ length: 4 }, (_, i) => ({
    viewRow: i,
    rowType: i === 0 ? "ColumnHeader" : "Data",
    depth: 0,
    visible: true,
    cells: [
      { cellType: i === 0 ? "RowLabelHeader" : "RowHeader", value: null, formattedValue: i === 0 ? "Row Labels" : `Item ${i}`, backgroundStyle: "Normal" },
      { cellType: "Data", value: i, formattedValue: String(i), backgroundStyle: "Normal" },
    ],
  }));
  return {
    pivotId: "cp1",
    version: 1,
    rowCount: 4,
    colCount: 2,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows,
    columns: [],
  } as unknown as PivotViewResponse;
}

type Fill = { rect: Rect; clip: Rect | null; style: string };

let overlay: OverlayRegistration | null = null;
let cleanups: Array<() => void> = [];

beforeEach(() => {
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  resetPivotVisualRegionState();
  resetPivotVisualHits();
  resetPaintedContainerLayouts();
  setGridRegions([]);
  cleanups = installPivotVisual({ getTheme: () => DEFAULT_PIVOT_THEME }, (reg) => {
    overlay = reg;
    const off = registerGridOverlay(reg);
    return () => {
      off();
      overlay = null;
    };
  });
  publishPivotRegions([boxPivot]);
  updateCachedRegions([boxPivot]);
  setCachedPivotView("cp1", smallView());
});

afterEach(() => {
  deleteCachedPivotView("cp1");
  cleanups.forEach((c) => c());
  cleanups = [];
});

function boxRegion(): ContainerRegion {
  return getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE) as ContainerRegion;
}

/**
 * Core's paint of one floating region, in Core's order (gridRenderer core.ts),
 * on a recording context that also records the fill style of every fill. Page
 * scroll 0 and no headings: canvas == sheet px.
 */
function paintLikeCore(): { fills: Fill[]; strokes: Array<{ rect: Rect; style: string }>; outer: Rect; layout: ReturnType<typeof measureVisualContainerLayout> } {
  const rec = createRecordingCtx();
  const ctx = rec.ctx as unknown as Record<string, unknown>;
  const fills: Fill[] = [];
  const strokes: Array<{ rect: Rect; style: string }> = [];
  for (const name of ["fillRect", "fill"] as const) {
    const orig = ctx[name] as (...a: unknown[]) => void;
    ctx[name] = function (this: Record<string, unknown>, ...args: unknown[]) {
      orig.apply(this, args);
      const op = rec.ops[rec.ops.length - 1];
      fills.push({ rect: op.rect, clip: op.clip, style: String(this.fillStyle) });
    };
  }
  for (const name of ["strokeRect", "stroke"] as const) {
    const orig = ctx[name] as (...a: unknown[]) => void;
    ctx[name] = function (this: Record<string, unknown>, ...args: unknown[]) {
      orig.apply(this, args);
      const op = rec.ops[rec.ops.length - 1];
      strokes.push({ rect: op.rect, style: String(this.strokeStyle) });
    };
  }
  // traceRoundRect may use arcTo / quadraticCurveTo for rounded corners.
  ctx.arcTo = () => undefined;
  ctx.quadraticCurveTo = () => undefined;
  ctx.getTransform = () => ({ a: 1, d: 1 });

  const region = boxRegion();
  const f = region.floating!;
  const c = region.container!;
  const layout = measureVisualContainerLayout(rec.ctx, f, c);
  recordPaintedContainerLayout(region.id, containerLayoutSignature(f, c), layout);
  paintVisualContainerUnder(rec.ctx, layout, c, { dx: f.x, dy: f.y });
  overlay!.render({
    ctx: rec.ctx,
    region,
    config: { rowHeaderWidth: 0, colHeaderHeight: 0, defaultCellWidth: 100, defaultCellHeight: 24 } as never,
    viewport: { scrollX: 0, scrollY: 0 } as never,
    dimensions: { columnWidths: new Map(), rowHeights: new Map() } as never,
    canvasWidth: 1200,
    canvasHeight: 800,
  });
  paintVisualContainerOver(rec.ctx, layout, c, { dx: f.x, dy: f.y });
  return { fills, strokes, outer: { x: f.x, y: f.y, width: f.width, height: f.height }, layout };
}

function within(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** The colour a real canvas would show at `p`: the LAST fill that covers it (clip respected). */
function pixelAt(fills: Fill[], p: { x: number; y: number }): string | null {
  let out: string | null = null;
  for (const f of fills) {
    if (!within(p, f.rect)) continue;
    if (f.clip && !within(p, f.clip)) continue;
    out = f.style;
  }
  return out;
}

describe("a canvas pivot box inside its container: paint == hit (WP-C S10)", () => {
  it("the cells are painted from the CONTENT origin (padding 16 + the Core title band), and the first header cell is hit there", () => {
    const { layout } = paintLikeCore();
    const content = layout.content;
    // The content rect really is inset: padding 16 + border 1 left, and the title band on top.
    expect(content.x).toBe(100 + 1 + 16);
    expect(content.y).toBeGreaterThan(80 + 1 + 16);
    expect(layout.titleRect, "the box's title is Core-painted").not.toBeNull();

    const record = getPivotVisualRecord("cp1")!;
    expect(record.box).toEqual({
      x: Math.round(content.x),
      y: Math.round(content.y),
      width: Math.round(content.width),
      height: Math.round(content.height),
    });
    expect(record.outer).toEqual({ x: 100, y: 80, width: 300, height: 200 });

    // The first header cell sits at the content origin -- and is named there.
    const origin = { x: record.box.x + 2, y: record.box.y + 2 };
    expect(viewCellAtCanvasPoint(record, origin.x, origin.y)).toEqual({ viewRow: 0, viewCol: 0 });
    const region = boxRegion();
    const ctx = { region, canvasX: origin.x, canvasY: origin.y, row: 0, col: 0, floatingCanvasBounds: record.outer };
    expect(resolveFloatingZone(ctx)).toMatchObject({ kind: "content", part: "cell" });
    // ...and the cell sheet rect a journey reads starts at the content origin.
    expect(pivotCellSheetRect("cp1", 0, 0)).toMatchObject({ x: record.box.x, y: record.box.y });
  });

  it("the padding / title band is Core's FRAME (part 'container'), never a cell -- and the box's own zone agrees", () => {
    paintLikeCore();
    const record = getPivotVisualRecord("cp1")!;
    const region = boxRegion();
    // 10px into the padding on the left, level with the first header cell.
    const band = { x: 100 + 10, y: record.box.y + 2 };
    const ctx = { region, canvasX: band.x, canvasY: band.y, row: 0, col: 0, floatingCanvasBounds: record.outer };
    expect(resolveFloatingZone(ctx)).toMatchObject({ kind: "frame", part: "container" });
    expect(viewCellAtCanvasPoint(record, band.x, band.y)).toBeNull();
    // A direct caller of the box's zone (its double-click) sees frame there too.
    expect(pivotVisualZoneAt(ctx)?.kind).toBe("frame");
    // In the title band (above the content, past the 4px edge band).
    const title = { x: record.box.x + 20, y: 80 + 12 };
    expect(resolveFloatingZone({ ...ctx, canvasX: title.x, canvasY: title.y })).toMatchObject({ kind: "frame", part: "container" });
  });

  it("ONE owner of the box background: below the last row the container's #FFF4E5 shows; on a cell, the cell's own fill", () => {
    const { fills } = paintLikeCore();
    const record = getPivotVisualRecord("cp1")!;
    const lastRowBottom = record.box.y + record.geometry!.rowOffsets[record.geometry!.rowCount];
    expect(lastRowBottom, "the view must end inside the box for this test").toBeLessThan(record.box.y + record.box.height - 10);
    const below = { x: record.box.x + 20, y: lastRowBottom + 6 };
    expect(pixelAt(fills, below)).toBe(BG);
    // Positive control: a point on a data cell shows a cell fill, not the container's.
    const onCell = { x: record.box.x + 150, y: record.box.y + 24 + 10 };
    const cellColour = pixelAt(fills, onCell);
    expect(cellColour).not.toBeNull();
    expect(cellColour).not.toBe(BG);
  });

  it("the box strokes NO outline of its own: the only outline is the container border Core paints", () => {
    const { strokes } = paintLikeCore();
    expect(strokes.some((s) => s.style.toLowerCase() === "#c8c8c8")).toBe(true);
    const outlineAtBox = strokes.filter(
      (s) => Math.abs(s.rect.x - 100.5) < 1 && Math.abs(s.rect.y - 80.5) < 1 && Math.abs(s.rect.width - 299) < 1,
    );
    expect(outlineAtBox.length, "only Core's border runs round the outer box").toBeLessThanOrEqual(1);
  });

  it("the wheel scrolls inside the CONTENT rect: its extent is the content box, not the frame", async () => {
    paintLikeCore();
    const record = getPivotVisualRecord("cp1")!;
    expect(record.box.height).toBeLessThan(200);
    // (The extent itself is pinned by createPivotVisualWheelTarget reading record.box.)
    const { createPivotVisualWheelTarget } = await import("../pivotVisualScroll");
    const target = createPivotVisualWheelTarget();
    const region: GridRegion = boxRegion();
    const s = target.getScroll(region);
    expect(s).not.toBeNull();
    // Four 24px rows never overflow the content box: nothing to scroll.
    expect(s!.maxTop).toBe(0);
  });
});
