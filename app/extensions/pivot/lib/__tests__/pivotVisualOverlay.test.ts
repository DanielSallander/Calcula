//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualOverlay.test.ts
// PURPOSE: The canvas pivot box's wiring (M6), end to end through the real
//          window events Core dispatches:
//          - SELECTION BRIDGE. `floatingObject:selected` on a pivot-visual makes
//            it the active pivot (tabs registered, "pivot" context key set) and
//            opens the field list from the hidden-grid anchor; a press on any
//            other object deselects it; a keyboard select (the object-selection
//            provider) opens no pane; a pane the user closed stays closed.
//          - CHROME. `floatingObject:bodyDragStart` over a +/- toggles THAT view
//            cell; the second press of a double-click is dropped.
//          - FRAME EDITS. moveComplete / resizeComplete persist through
//            update_pivot_properties({pivotId, canvasFrame}).
//          - DOUBLE-CLICK. A body cell maps view cell -> hidden-grid cell and
//            runs the shared toggle / drill.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const api = vi.hoisted(() => ({
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  manuallyClosed: [] as string[],
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  emitAppEvent: vi.fn(),
  showToast: vi.fn(),
  getAtCell: vi.fn(),
  updatePivotProperties: vi.fn(),
  togglePivotHeaderAt: vi.fn(async () => true),
  openPivotReportFilterAt: vi.fn(async () => true),
  openPivotHeaderFilter: vi.fn(),
  cancelPivotLoading: vi.fn(),
  getPivotViewCell: vi.fn(),
  runPivotCellDoubleClick: vi.fn(() => true),
}));

vi.mock("@api", () => ({
  openTaskPane: api.openTaskPane,
  closeTaskPane: api.closeTaskPane,
  getTaskPaneManuallyClosed: () => api.manuallyClosed,
  addTaskPaneContextKey: api.addTaskPaneContextKey,
  removeTaskPaneContextKey: api.removeTaskPaneContextKey,
  registerPanel: api.registerPanel,
  unregisterPanel: api.unregisterPanel,
  emitAppEvent: api.emitAppEvent,
  showToast: api.showToast,
  isPointerClaimed: () => false,
}));

vi.mock("@api/pivot", () => ({
  pivot: { getAtCell: api.getAtCell },
}));

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
  togglePivotHeaderAt: api.togglePivotHeaderAt,
  openPivotReportFilterAt: api.openPivotReportFilterAt,
  openPivotHeaderFilter: api.openPivotHeaderFilter,
  cancelPivotLoading: api.cancelPivotLoading,
  getPivotViewCell: api.getPivotViewCell,
}));

vi.mock("../pivotCellDoubleClick", () => ({
  runPivotCellDoubleClick: api.runPivotCellDoubleClick,
}));

import type { OverlayRegistration } from "@api/gridOverlays";
import { setGridRegions, getGridRegions } from "@api/gridOverlays";
import { setCachedPivotView, deleteCachedPivotView } from "../pivotViewStore";
import { setPivotVisualScroll } from "../pivotVisualScroll";
import { getPivotVisualRecord } from "../pivotVisualHits";
import { createRecordingCtx } from "../../../_shared/lib/__tests__/recordingCtx";
import { resetObjectSelectionProviders, selectObject, deselectAllObjects } from "@api/objectSelection";
import { installPivotVisual, handlePivotVisualPress } from "../pivotVisualOverlay";
import { publishPivotRegions, resetPivotVisualRegionState, PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";
import { setPivotVisualRecord, resetPivotVisualHits } from "../pivotVisualHits";
import { notePivotCreated, adoptCreatedCanvasPivot, resetCreatedPivotTracking } from "../pivotVisualSelection";
import {
  updateCachedRegions,
  getActivePivotId,
  isPivotVisualSelected,
  resetSelectionHandlerState,
} from "../../handlers/selectionHandler";
import { buildPivotVisualGeometry } from "../../rendering/pivotVisualRenderer";
import type { PivotRegionData } from "../../types";
import type { PivotViewResponse } from "../pivot-api";
import { DEFAULT_PIVOT_THEME } from "../../rendering/pivot";

const canvasPivot: PivotRegionData = {
  pivotId: "cp1",
  name: "Sales",
  startRow: 0,
  startCol: 1024,
  endRow: 49,
  endCol: 1026,
  isEmpty: false,
  canvasFrame: { x: 100, y: 80, width: 300, height: 200, frozenHeaders: true },
};

let overlay: OverlayRegistration | null = null;
let cleanups: Array<() => void> = [];

function fire(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function visualDetail(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    regionId: "pivot-visual-cp1",
    regionType: PIVOT_VISUAL_REGION_TYPE,
    data: { pivotId: "cp1", name: "Sales", isEmpty: false, frozenHeaders: true },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  api.manuallyClosed = [];
  api.getAtCell.mockResolvedValue({
    pivotId: "cp1",
    sourceFields: [],
    fieldConfiguration: {
      rowFields: [],
      columnFields: [],
      valueFields: [],
      filterFields: [],
      layout: {},
      calculatedFields: [],
    },
  });
  api.updatePivotProperties.mockResolvedValue({});
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  resetPivotVisualRegionState();
  resetPivotVisualHits();
  resetCreatedPivotTracking();
  setGridRegions([]);
  cleanups = installPivotVisual({ getTheme: () => DEFAULT_PIVOT_THEME }, (reg) => {
    overlay = reg;
    return () => {
      overlay = null;
    };
  });
  publishPivotRegions([canvasPivot]);
  updateCachedRegions([canvasPivot]);
  vi.clearAllMocks();
});

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  vi.useRealTimers();
});

describe("selection bridge", () => {
  it("a press on the box makes it the active pivot and opens the field list from the hidden-grid anchor", async () => {
    fire("floatingObject:selected", visualDetail());

    expect(getActivePivotId()).toBe("cp1");
    expect(isPivotVisualSelected("cp1")).toBe(true);
    expect(api.addTaskPaneContextKey).toHaveBeenCalledWith("pivot");
    expect(api.registerPanel.mock.calls.map((c) => (c[0] as { id: string }).id).sort()).toEqual([
      "pivot-analyze",
      "pivot-design",
    ]);
    expect(api.getAtCell).toHaveBeenCalledWith(0, 1024);
    await vi.runAllTimersAsync();
    expect(api.openTaskPane).toHaveBeenCalledTimes(1);
    expect(api.openTaskPane.mock.calls[0][0]).toBe("pivot-pane");
    expect((api.openTaskPane.mock.calls[0][1] as { pivotId: string }).pivotId).toBe("cp1");
  });

  it("a second press on the same box reloads nothing", async () => {
    fire("floatingObject:selected", visualDetail());
    await vi.runAllTimersAsync();
    fire("floatingObject:selected", visualDetail());
    await vi.runAllTimersAsync();
    expect(api.getAtCell).toHaveBeenCalledTimes(1);
  });

  it("a press on any other object deselects the box", async () => {
    fire("floatingObject:selected", visualDetail());
    await vi.runAllTimersAsync();
    fire("floatingObject:selected", { regionId: "slicer-1", regionType: "slicer", data: { slicerId: "s1" } });

    expect(getActivePivotId()).toBeNull();
    expect(isPivotVisualSelected("cp1")).toBe(false);
    expect(api.unregisterPanel).toHaveBeenCalledTimes(2);
    expect(api.removeTaskPaneContextKey).toHaveBeenCalledWith("pivot");
    expect(api.closeTaskPane).toHaveBeenCalledWith("pivot-pane");
  });

  it("a pane the user closed by hand stays closed; the ribbon still hears the active pivot", async () => {
    api.manuallyClosed = ["pivot-pane"];
    fire("floatingObject:selected", visualDetail());
    await vi.runAllTimersAsync();
    expect(api.getAtCell).not.toHaveBeenCalled();
    expect(api.openTaskPane).not.toHaveBeenCalled();
    expect(api.emitAppEvent).toHaveBeenCalledWith(expect.stringContaining("pivot"), { pivotId: "cp1", layout: {} });
    expect(getActivePivotId()).toBe("cp1");
  });

  it("the object-selection provider selects without opening the pane, and deselectAll tears down", async () => {
    const region = {
      id: "pivot-visual-cp1",
      type: PIVOT_VISUAL_REGION_TYPE,
      startRow: 0,
      startCol: 1024,
      endRow: 49,
      endCol: 1026,
      floating: { x: 100, y: 80, width: 300, height: 200 },
      data: { pivotId: "cp1" },
    };
    expect(selectObject(region)).toBe(true);
    await vi.runAllTimersAsync();
    expect(isPivotVisualSelected("cp1")).toBe(true);
    expect(getActivePivotId()).toBe("cp1");
    expect(api.openTaskPane).not.toHaveBeenCalled();
    expect(api.getAtCell).not.toHaveBeenCalled();

    deselectAllObjects();
    expect(isPivotVisualSelected("cp1")).toBe(false);
    expect(getActivePivotId()).toBeNull();
  });

  it("a keyboard step to ANOTHER box keeps an open pane in sync (no pane opened from nothing)", async () => {
    const second: PivotRegionData = { ...canvasPivot, pivotId: "cp2", startCol: 2048, endCol: 2050 };
    updateCachedRegions([canvasPivot, second]);
    const regionOf = (id: string, startCol: number) => ({
      id: `pivot-visual-${id}`,
      type: PIVOT_VISUAL_REGION_TYPE,
      startRow: 0,
      startCol,
      endRow: 0,
      endCol: 0,
      floating: { x: 0, y: 0, width: 10, height: 10 },
      data: { pivotId: id },
    });

    // Keyboard-select cp1 with no pane open: nothing is loaded.
    selectObject(regionOf("cp1", 1024));
    await vi.runAllTimersAsync();
    expect(api.getAtCell).not.toHaveBeenCalled();

    // A press opens cp1's pane; a keyboard step to cp2 moves the open pane along.
    fire("floatingObject:selected", visualDetail());
    await vi.runAllTimersAsync();
    expect(api.getAtCell).toHaveBeenLastCalledWith(0, 1024);
    selectObject(regionOf("cp2", 2048));
    await vi.runAllTimersAsync();
    expect(api.getAtCell).toHaveBeenLastCalledWith(0, 2048);
    expect(getActivePivotId()).toBe("cp2");
  });

  it("a pivot just created on a canvas starts selected (so a page click can deselect it); a worksheet one does not", () => {
    notePivotCreated("cp1");
    adoptCreatedCanvasPivot([]); // not in the list yet: stays pending
    expect(isPivotVisualSelected("cp1")).toBe(false);
    adoptCreatedCanvasPivot([canvasPivot]);
    expect(isPivotVisualSelected("cp1")).toBe(true);
    expect(api.openTaskPane).not.toHaveBeenCalled();

    deselectAllObjects();
    notePivotCreated("ws1");
    adoptCreatedCanvasPivot([{ ...canvasPivot, pivotId: "ws1", canvasFrame: undefined }]);
    expect(isPivotVisualSelected("ws1")).toBe(false);
  });

  it("the box disappearing (deleted pivot, other sheet) tears the selection down", async () => {
    fire("floatingObject:selected", visualDetail());
    await vi.runAllTimersAsync();
    updateCachedRegions([]);
    expect(isPivotVisualSelected("cp1")).toBe(false);
    expect(getActivePivotId()).toBeNull();
  });
});

describe("chrome presses arrive through the body-drag claim", () => {
  function recordWithIcon() {
    setPivotVisualRecord({
      pivotId: "cp1",
      box: { x: 100, y: 80, width: 300, height: 200 },
      bounds: {
        expandCollapseIcons: new Map([["7-0", { x: 6, y: 78, width: 12, height: 12, row: 7, col: 0, isExpanded: true, isRow: true }]]),
        filterButtons: new Map([["filter-2", { x: 150, y: 3, width: 18, height: 18, fieldIndex: 2, row: 0, col: 1 }]]),
        headerFilterButtons: new Map(),
      },
      cancel: null,
      geometry: null,
      scroll: { left: 0, top: 100 },
      startRow: 0,
      startCol: 1024,
    });
  }

  it("claimsBodyDrag is true on chrome and false on a plain cell", () => {
    recordWithIcon();
    const region = { id: "pivot-visual-cp1", type: PIVOT_VISUAL_REGION_TYPE, startRow: 0, startCol: 1024, endRow: 0, endCol: 0, data: { pivotId: "cp1" } };
    expect(overlay!.claimsBodyDrag!({ region, canvasX: 112, canvasY: 164, row: 0, col: 0 })).toBe(true);
    expect(overlay!.claimsBodyDrag!({ region, canvasX: 250, canvasY: 200, row: 0, col: 0 })).toBe(false);
  });

  it("a +/- press toggles THAT view cell, and the second press of a double-click is dropped", () => {
    recordWithIcon();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164 }));
    expect(api.togglePivotHeaderAt).toHaveBeenCalledWith("cp1", 7, 0, true);
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164 }));
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
  });

  it("the same press after the double-click window toggles again", () => {
    recordWithIcon();
    expect(handlePivotVisualPress("cp1", 112, 164, 1_000)).toMatchObject({ kind: "icon" });
    expect(handlePivotVisualPress("cp1", 112, 164, 1_100)).toBeNull();
    expect(handlePivotVisualPress("cp1", 112, 164, 2_000)).toMatchObject({ kind: "icon" });
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(2);
  });

  it("a report-filter press opens the menu for the hidden-grid cell of that combo", () => {
    recordWithIcon();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 259, canvasY: 90 }));
    expect(api.openPivotReportFilterAt).toHaveBeenCalledTimes(1);
    const [gridRow, gridCol, fieldIndex] = api.openPivotReportFilterAt.mock.calls[0] as unknown as number[];
    expect([gridRow, gridCol, fieldIndex]).toEqual([0, 1025, 2]);
  });

  it("a press on another object type is ignored", () => {
    recordWithIcon();
    fire("floatingObject:bodyDragStart", { regionType: "chart", data: { pivotId: "cp1" }, canvasX: 112, canvasY: 164 });
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });
});

describe("frame edits persist through update_pivot_properties", () => {
  it("moveComplete saves the new position with the rest of the frame", async () => {
    fire("floatingObject:movePreview", visualDetail({ x: 140, y: 90 }));
    fire("floatingObject:moveComplete", visualDetail({ x: 144, y: 96 }));
    await vi.runAllTimersAsync();
    expect(api.updatePivotProperties).toHaveBeenCalledWith({
      pivotId: "cp1",
      canvasFrame: { x: 144, y: 96, width: 300, height: 200, frozenHeaders: true },
    });
  });

  it("resizeComplete saves the new size", async () => {
    fire("floatingObject:resizeComplete", visualDetail({ x: 100, y: 80, width: 360, height: 240 }));
    await vi.runAllTimersAsync();
    expect(api.updatePivotProperties).toHaveBeenCalledWith({
      pivotId: "cp1",
      canvasFrame: { x: 100, y: 80, width: 360, height: 240, frozenHeaders: true },
    });
  });

  it("a refused save is reported, not swallowed", async () => {
    api.updatePivotProperties.mockRejectedValueOnce(new Error("not a canvas pivot"));
    fire("floatingObject:moveComplete", visualDetail({ x: 144, y: 96 }));
    await vi.runAllTimersAsync();
    expect(api.showToast).toHaveBeenCalledWith(expect.stringContaining("not a canvas pivot"), { type: "error" });
  });
});

describe("the overlay render entry", () => {
  it("places the box through the page scroll (zero canvas gutters), clips to it, and applies the session scroll", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      viewRow: i,
      rowType: i === 0 ? "ColumnHeader" : "Data",
      depth: 0,
      visible: true,
      cells: [
        { cellType: i === 0 ? "RowLabelHeader" : "RowHeader", value: null, formattedValue: i === 0 ? "Row Labels" : `Item ${i}`, backgroundStyle: "Normal" },
        { cellType: "Data", value: i, formattedValue: String(i), backgroundStyle: "Normal" },
      ],
    }));
    const view = {
      pivotId: "cp1",
      version: 1,
      rowCount: 50,
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
    setCachedPivotView("cp1", view);
    setPivotVisualScroll("cp1", { left: 0, top: 120 });

    const rec = createRecordingCtx();
    const region = getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE)!;
    overlay!.render({
      ctx: rec.ctx,
      region,
      config: { rowHeaderWidth: 0, colHeaderHeight: 0, defaultCellWidth: 100, defaultCellHeight: 24 } as never,
      viewport: { scrollX: 10, scrollY: 20 } as never,
      dimensions: { columnWidths: new Map(), rowHeights: new Map() } as never,
      canvasWidth: 1200,
      canvasHeight: 800,
    });

    // Frame (100, 80) on the page, page scrolled (10, 20): the box is at (90, 60).
    expect(rec.clips[0]).toEqual({ x: 90, y: 60, width: 300, height: 200 });
    expect(rec.ops.some((o) => o.op === "clearRect")).toBe(false);
    const record = getPivotVisualRecord("cp1")!;
    expect(record.box).toEqual({ x: 90, y: 60, width: 300, height: 200 });
    expect(record.scroll).toEqual({ left: 0, top: 120 });
    // Scrolled 120px (5 rows): "Item 6" is the first body row under the frozen header.
    const texts = rec.texts().filter((t) => t.clip && t.rect.y >= t.clip.y && t.rect.y <= t.clip.y + t.clip.height);
    const items = texts.filter((t) => t.text?.startsWith("Item "));
    expect(items.reduce((a, b) => (b.rect.y < a.rect.y ? b : a)).text).toBe("Item 6");
    deleteCachedPivotView("cp1");
  });
});

describe("double-click", () => {
  it("maps a body point to view cell -> hidden-grid cell and runs the shared toggle/drill", () => {
    const view = {
      pivotId: "cp1",
      version: 1,
      rowCount: 50,
      colCount: 3,
      rowLabelColCount: 1,
      columnHeaderRowCount: 1,
      filterRowCount: 0,
      filterRows: [],
      rowFieldSummaries: [],
      columnFieldSummaries: [],
      rows: Array.from({ length: 50 }, (_, i) => ({ viewRow: i, rowType: "Data", depth: 0, visible: true, cells: [] })),
      columns: [],
    } as unknown as PivotViewResponse;
    const geometry = buildPivotVisualGeometry(view, true, { columnWidth: () => 100, rowHeight: () => 24 });
    setPivotVisualRecord({
      pivotId: "cp1",
      box: { x: 100, y: 80, width: 300, height: 200 },
      bounds: { expandCollapseIcons: new Map(), filterButtons: new Map(), headerFilterButtons: new Map() },
      cancel: null,
      geometry,
      scroll: { left: 0, top: 120 },
      startRow: 0,
      startCol: 1024,
    });
    const dataCell = { cellType: "Data", value: 5, backgroundStyle: "Normal" };
    api.getPivotViewCell.mockReturnValue(dataCell);

    const region = { id: "pivot-visual-cp1", type: PIVOT_VISUAL_REGION_TYPE, startRow: 0, startCol: 1024, endRow: 0, endCol: 0, data: { pivotId: "cp1" } };
    // Box-local (150, 30): column 1; 6px into the body at scroll 120 -> view row 6.
    const handled = overlay!.onDoubleClick!({ region, canvasX: 250, canvasY: 110, row: 0, col: 0 });
    expect(handled).toBe(true);
    expect(api.getPivotViewCell).toHaveBeenCalledWith("cp1", 6, 1);
    expect(api.runPivotCellDoubleClick).toHaveBeenCalledWith("cp1", dataCell, 6, 1025, 1);
  });
});
