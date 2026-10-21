//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualOverlay.test.ts
// PURPOSE: The canvas pivot box's wiring (M6), end to end through the real
//          window events Core dispatches:
//          - SELECTION BRIDGE. `floatingObject:selected` on a pivot-visual makes
//            it the active pivot (tabs registered, "pivot" context key set)
//            and opens NO pane of its own (WP-C D-PANE: the ONE object pane
//            opens by its own policy); a press on any other object deselects
//            it; a keyboard select (the object-selection provider) loads
//            nothing.
//          - CHROME. `floatingObject:bodyDragStart` over a +/- only STARTS a
//            press (pivotChromePress.ts); its release over the same +/-
//            toggles THAT view cell, the second click of a double-click is
//            dropped, and a release off it toggles nothing (BUG-0258 phase 4,
//            D5). The listener starts the press and never acts itself (a
//            source census); the held press owns Escape; teardown cancels it.
//          - FRAME EDITS. moveComplete / resizeComplete persist through
//            update_pivot_properties({pivotId, canvasFrame}).
//          - DOUBLE-CLICK. A body cell maps view cell -> hidden-grid cell and
//            runs the shared toggle / drill.
//          - REFERENCE PICK (D-PICK). `referenceAt` names the hidden-grid cell
//            under a point (frozen + scroll + the box's column block), the
//            cell beneath the chrome, null on blank area; it is pure; and a
//            pick drag Core publishes over the box is painted dashed there.

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
  applyPivotCrossFilterClick: vi.fn(() => "selected"),
  /** What Core's reference-pick session publishes for a drag (D-PICK); null = no pick drag. */
  pickPreview: null as unknown,
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

// Core's pick-drag preview is set by its pick session only; the test states it.
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFloatingReferencePickPreview: () => api.pickPreview,
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

vi.mock("../pivotCrossFilterClick", () => ({
  applyPivotCrossFilterClick: api.applyPivotCrossFilterClick,
}));

import type { OverlayRegistration } from "@api/gridOverlays";
import { setGridRegions, getGridRegions, contentGestureCursorFor, clearContentGestureCursor } from "@api/gridOverlays";
import { setCachedPivotView, deleteCachedPivotView } from "../pivotViewStore";
import { setPivotVisualScroll } from "../pivotVisualScroll";
import { getPivotVisualRecord } from "../pivotVisualHits";
import { createRecordingCtx } from "../../../_shared/lib/__tests__/recordingCtx";
import { resetObjectSelectionProviders, selectObject, deselectAllObjects } from "@api/objectSelection";
import { installPivotVisual, handlePivotVisualPress, pivotVisualReferenceAt } from "../pivotVisualOverlay";
import { isPivotChromePressActive } from "../pivotChromePress";
import { objectOwnsKey } from "@api/objectSelection";
import { readFileSync } from "fs";
import { resolve } from "path";
import { publishPivotRegions, resetPivotVisualRegionState, PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";
import { setPivotVisualRecord, resetPivotVisualHits, getPivotVisualHover } from "../pivotVisualHits";
import { notePivotCreated, adoptCreatedCanvasPivot, resetCreatedPivotTracking } from "../pivotVisualSelection";
import {
  updateCachedRegions,
  getActivePivotId,
  isPivotVisualSelected,
  resetSelectionHandlerState,
} from "../../handlers/selectionHandler";
import { buildPivotVisualGeometry, type PivotVisualGeometry } from "../../rendering/pivotVisualRenderer";
import { pivotCellSheetRect, PIVOT_BOX_BORDER_BAND } from "../pivotVisualOverlay";
import {
  extendPivotCellSelection,
  getPivotCellSelection,
  resetPivotCellSelection,
  setPivotCellAnchor,
} from "../pivotVisualCellSelection";
import { isPivotCellPressLive } from "../pivotCellPress";
import { prunePivotVisualRecords } from "../pivotVisualHits";
import { setFilteredPivotViewForTest } from "../pivotCrossFilterView";
import { setDesignMode } from "@api/designMode";
import { PivotEvents } from "../../../_shared/lib/pivotEvents";
import { INNER_SELECTION_BORDER, INNER_SELECTION_FILL } from "../../../_shared/lib/innerSelectionPaint";
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
  // NO container border (WP-C): the content rect IS the frame, so the
  // geometry pinned below reads exactly as before the container existed. The
  // container's own inset is pinned in pivotBoxContainer.test.ts.
  canvasFrame: { x: 100, y: 80, width: 300, height: 200, frozenHeaders: true, container: { border: { show: false } } },
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
  api.pickPreview = null;
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
  resetPivotCellSelection();
  setDesignMode(false);
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
  it("a press on the box makes it the active pivot -- and opens NO pane of its own (the object pane's policy does)", async () => {
    fire("floatingObject:selected", visualDetail());

    expect(getActivePivotId()).toBe("cp1");
    expect(isPivotVisualSelected("cp1")).toBe(true);
    expect(api.addTaskPaneContextKey).toHaveBeenCalledWith("pivot");
    expect(api.registerPanel.mock.calls.map((c) => (c[0] as { id: string }).id).sort()).toEqual([
      "pivot-analyze",
      "pivot-design",
    ]);
    await vi.runAllTimersAsync();
    // No worksheet field-list pane for a canvas box, and nothing read for one.
    expect(api.openTaskPane).not.toHaveBeenCalled();
    expect(api.getAtCell).not.toHaveBeenCalled();
    // The ribbon still hears the active pivot.
    expect(api.emitAppEvent).toHaveBeenCalledWith(expect.stringContaining("pivot"), { pivotId: "cp1", layout: {} });
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

  it("SOURCE: the box's press listener asks for no pane (the object pane owns it)", () => {
    const src = readFileSync(resolve(__dirname, "../pivotVisualOverlay.ts"), "utf8").replace(/\/\/.*$/gm, "");
    const at = src.indexOf('listen("floatingObject:selected"');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n  });", at));
    expect(body).toMatch(/selectPivotVisual\(pivotId\)/);
    expect(body).not.toMatch(/openPane|openTaskPane|openObjectPane/);
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

  it("a pivot created ON THE CANVAS opens the ONE object pane on its Fields tab once its box is published -- never the pivot-editor pane", async () => {
    const { registerObjectPaneHost, resetObjectPane } = await import("@api/objectPane");
    resetObjectPane();
    const opened: Array<{ regionId?: string; tab?: string; reason: string }> = [];
    const off = registerObjectPaneHost({
      open: (req) => {
        opened.push({ regionId: req.region?.id, tab: req.tab, reason: req.reason });
        return true;
      },
      close: () => undefined,
      state: () => ({ open: false, regionId: null, regionType: null, tabId: null }),
    });
    try {
      notePivotCreated("cp1", { openPane: true });
      adoptCreatedCanvasPivot([]); // not published yet: nothing opens
      expect(opened).toEqual([]);
      adoptCreatedCanvasPivot([canvasPivot]);
      expect(isPivotVisualSelected("cp1")).toBe(true);
      expect(opened).toEqual([{ regionId: "pivot-visual-cp1", tab: "fields", reason: "command" }]);
      // Once only: a later region list does not reopen it.
      adoptCreatedCanvasPivot([canvasPivot]);
      expect(opened).toHaveLength(1);
      expect(api.openTaskPane).not.toHaveBeenCalled();
    } finally {
      off();
      resetObjectPane();
    }
  });

  it("the box disappearing (deleted pivot, other sheet) tears the selection down", async () => {
    fire("floatingObject:selected", visualDetail());
    await vi.runAllTimersAsync();
    updateCachedRegions([]);
    expect(isPivotVisualSelected("cp1")).toBe(false);
    expect(getActivePivotId()).toBeNull();
  });
});

describe("chrome presses arrive as CONTENT (the zone answer) through bodyDragStart", () => {
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

  it("zoneAt: chrome is content with a hand; with no painted geometry the rest of the box is frame -- and the registration has no second answer", () => {
    recordWithIcon();
    const region = { id: "pivot-visual-cp1", type: PIVOT_VISUAL_REGION_TYPE, startRow: 0, startCol: 1024, endRow: 0, endCol: 0, data: { pivotId: "cp1" } };
    expect(overlay!.zoneAt!({ region, canvasX: 112, canvasY: 164, row: 0, col: 0 })).toEqual({
      kind: "content",
      cursor: "pointer",
      part: "icon",
    });
    expect(overlay!.zoneAt!({ region, canvasX: 259, canvasY: 90, row: 0, col: 0 })).toMatchObject({
      kind: "content",
      part: "filter",
    });
    // No geometry painted (geometry: null): no cell to name -- blank frame.
    expect(overlay!.zoneAt!({ region, canvasX: 250, canvasY: 200, row: 0, col: 0 })).toEqual({ kind: "frame", part: "blank" });
    // Outside the box: no answer (frame).
    expect(overlay!.zoneAt!({ region, canvasX: 50, canvasY: 50, row: 0, col: 0 })).toBeNull();
    // No second answer beside the zone (M5 T6 removed the old fields from the
    // type; the cast reads what the object actually carries).
    const fields = overlay as unknown as Record<string, unknown>;
    expect(fields.getCursor).toBeUndefined();
    expect(fields.getCellCursor).toBeUndefined();
    expect(fields.claimsBodyDrag).toBeUndefined();
  });

  // The release point is converted through the grid area (a jsdom box at
  // (0, 0), zoom 1 from the @api/grid mock): client px = canvas px here.
  let gridArea: HTMLElement | null = null;
  beforeEach(() => {
    gridArea = document.createElement("div");
    gridArea.setAttribute("data-grid-area", "");
    document.body.appendChild(gridArea);
  });
  afterEach(() => {
    gridArea?.remove();
    gridArea = null;
  });

  function releaseAt(x: number, y: number): void {
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, button: 0 }));
  }

  it("a +/- press toggles nothing until its RELEASE over the same +/-, which toggles THAT view cell; the second click of a double-click is dropped", () => {
    recordWithIcon();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164 }));
    expect(api.togglePivotHeaderAt, "the +/- acted on the PRESS").not.toHaveBeenCalled();
    releaseAt(113, 165);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledWith("cp1", 7, 0, true);
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164 }));
    releaseAt(112, 164);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
  });

  it("a +/- press released OFF the icon toggles nothing (a drag that starts on it)", () => {
    recordWithIcon();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 172, clientY: 164, buttons: 1 }));
    releaseAt(172, 164);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });

  it("the same press after the double-click window toggles again", () => {
    recordWithIcon();
    expect(handlePivotVisualPress("cp1", 112, 164, 1_000)).toMatchObject({ kind: "icon" });
    expect(handlePivotVisualPress("cp1", 112, 164, 1_100)).toBeNull();
    expect(handlePivotVisualPress("cp1", 112, 164, 2_000)).toMatchObject({ kind: "icon" });
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(2);
  });

  it("a report-filter press opens the menu at its RELEASE, for the hidden-grid cell of that combo", () => {
    recordWithIcon();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 259, canvasY: 90 }));
    expect(api.openPivotReportFilterAt, "the filter menu opened on the PRESS").not.toHaveBeenCalled();
    releaseAt(259, 90);
    expect(api.openPivotReportFilterAt).toHaveBeenCalledTimes(1);
    const [gridRow, gridCol, fieldIndex] = api.openPivotReportFilterAt.mock.calls[0] as unknown as number[];
    expect([gridRow, gridCol, fieldIndex]).toEqual([0, 1025, 2]);
  });

  it("the listener hands the press Core's REGION: the held press holds Core's pointer over the box (no grip, no handle under it), let go at the release", () => {
    recordWithIcon();
    clearContentGestureCursor();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164 }));
    expect(contentGestureCursorFor("pivot-visual-cp1"), "the box's chrome press does not hold Core's pointer").toBe("pointer");
    releaseAt(113, 165);
    expect(contentGestureCursorFor("pivot-visual-cp1")).toBeNull();
  });

  it("a press on another object type is ignored", () => {
    recordWithIcon();
    fire("floatingObject:bodyDragStart", { regionType: "chart", data: { pivotId: "cp1" }, canvasX: 112, canvasY: 164 });
    expect(isPivotChromePressActive()).toBe(false);
    releaseAt(112, 164);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });

  it("while the press is held the box owns Escape (a canvas does not deselect it under the pointer); not after", () => {
    recordWithIcon();
    expect(objectOwnsKey("Escape"), "control: an idle box claims Escape").toBe(false);
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164 }));
    expect(objectOwnsKey("Escape"), "a held chrome press does not own Escape").toBe(true);
    expect(objectOwnsKey("Tab"), "a held press claims another key").toBe(false);
    releaseAt(112, 164);
    expect(objectOwnsKey("Escape")).toBe(false);
  });

  it("the box's teardown cancels a held press: its release acts on nothing", () => {
    recordWithIcon();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164 }));
    expect(isPivotChromePressActive()).toBe(true);
    cleanups.forEach((c) => c());
    cleanups = [];
    expect(isPivotChromePressActive(), "the teardown left the press live").toBe(false);
    releaseAt(112, 164);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });

  it("SOURCE: the bodyDragStart listener starts a press (cell or chrome) and never runs the chrome itself", () => {
    const src = readFileSync(resolve(__dirname, "../pivotVisualOverlay.ts"), "utf8").replace(/\/\/.*$/gm, "");
    const at = src.indexOf('listen("floatingObject:bodyDragStart"');
    expect(at, "the bodyDragStart listener is gone").toBeGreaterThan(0);
    // The listener ends at its own closing line (two-space indent): the press
    // calls inside it close with a deeper `});`.
    const end = src.indexOf("\n  });", at);
    expect(end, "the listener's end was not found").toBeGreaterThan(at);
    const body = src.slice(at, end);
    expect(body).toMatch(/beginPivotChromePress\(\{/);
    expect(body).toMatch(/beginPivotCellPress\(\{/);
    expect(body, "the listener acts on the PRESS again").not.toMatch(/handlePivotVisualPress\(/);
  });
});

describe("frame edits persist through update_pivot_properties", () => {
  it("moveComplete saves the new position with the rest of the frame", async () => {
    fire("floatingObject:movePreview", visualDetail({ x: 140, y: 90 }));
    fire("floatingObject:moveComplete", visualDetail({ x: 144, y: 96 }));
    await vi.runAllTimersAsync();
    expect(api.updatePivotProperties).toHaveBeenCalledWith({
      pivotId: "cp1",
      canvasFrame: { x: 144, y: 96, width: 300, height: 200, frozenHeaders: true, container: { border: { show: false } } },
    });
  });

  it("resizeComplete saves the new size", async () => {
    fire("floatingObject:resizeComplete", visualDetail({ x: 100, y: 80, width: 360, height: 240 }));
    await vi.runAllTimersAsync();
    expect(api.updatePivotProperties).toHaveBeenCalledWith({
      pivotId: "cp1",
      canvasFrame: { x: 100, y: 80, width: 360, height: 240, frozenHeaders: true, container: { border: { show: false } } },
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

  /** A record of `rowCount` rows x 3 columns (100px x 24px) at box (100, 80, 300, 200), unscrolled. */
  function seedRecord(rowCount: number): void {
    const view = {
      pivotId: "cp1",
      version: 1,
      rowCount,
      colCount: 3,
      rowLabelColCount: 1,
      columnHeaderRowCount: 1,
      filterRowCount: 0,
      filterRows: [],
      rowFieldSummaries: [],
      columnFieldSummaries: [],
      rows: Array.from({ length: rowCount }, (_, i) => ({ viewRow: i, rowType: "Data", depth: 0, visible: true, cells: [] })),
      columns: [],
    } as unknown as PivotViewResponse;
    setPivotVisualRecord({
      pivotId: "cp1",
      box: { x: 100, y: 80, width: 300, height: 200 },
      bounds: { expandCollapseIcons: new Map(), filterButtons: new Map(), headerFilterButtons: new Map() },
      cancel: null,
      geometry: buildPivotVisualGeometry(view, true, { columnWidth: () => 100, rowHeight: () => 24 }),
      scroll: { left: 0, top: 0 },
      startRow: 0,
      startCol: 1024,
    });
    api.getPivotViewCell.mockReturnValue({ cellType: "Data", value: 5, backgroundStyle: "Normal", groupPath: [[0, 1]] });
  }

  function regionWith(data: Record<string, unknown> = {}) {
    return {
      id: "pivot-visual-cp1",
      type: PIVOT_VISUAL_REGION_TYPE,
      startRow: 0,
      startCol: 1024,
      endRow: 0,
      endCol: 0,
      data: { pivotId: "cp1", ...data },
    };
  }

  it("the 4px border band MOVES the box, so a double-click there is inert -- even over a cell (positive control beside it)", () => {
    seedRecord(50);
    // Box-local (2, 40): inside the band on the left edge, over the row-label column of view row 1.
    const onBand = overlay!.onDoubleClick!({ region: regionWith(), canvasX: 100 + 2, canvasY: 80 + 40, row: 0, col: 0 });
    expect(onBand).toBe(true); // swallowed: a canvas has no editor to fall through to
    expect(api.runPivotCellDoubleClick).not.toHaveBeenCalled();
    expect(api.getPivotViewCell).not.toHaveBeenCalled();

    // Control: PIVOT_BOX_BORDER_BAND px further in, the same row's cell drills.
    const inside = overlay!.onDoubleClick!({
      region: regionWith(),
      canvasX: 100 + 2 + PIVOT_BOX_BORDER_BAND,
      canvasY: 80 + 40,
      row: 0,
      col: 0,
    });
    expect(inside).toBe(true);
    expect(api.getPivotViewCell).toHaveBeenCalledWith("cp1", 1, 0);
    expect(api.runPivotCellDoubleClick).toHaveBeenCalledTimes(1);
    expect(api.runPivotCellDoubleClick).toHaveBeenCalledWith("cp1", expect.objectContaining({ cellType: "Data" }), 1, 1024, 0);
  });

  it("blank area past the content is inert", () => {
    seedRecord(2); // 2 rows x 24px: everything below box-local y 48 is blank
    const handled = overlay!.onDoubleClick!({ region: regionWith(), canvasX: 250, canvasY: 80 + 120, row: 0, col: 0 });
    expect(handled).toBe(true);
    expect(api.runPivotCellDoubleClick).not.toHaveBeenCalled();
  });

  it("in Design Mode the body grabs the box, so a double-click on a cell is inert; out of it, the same point drills", () => {
    seedRecord(50);
    const designed = overlay!.onDoubleClick!({ region: regionWith({ bodyGrab: true }), canvasX: 250, canvasY: 120, row: 0, col: 0 });
    expect(designed).toBe(true);
    expect(api.runPivotCellDoubleClick).not.toHaveBeenCalled();

    overlay!.onDoubleClick!({ region: regionWith(), canvasX: 250, canvasY: 120, row: 0, col: 0 });
    expect(api.runPivotCellDoubleClick).toHaveBeenCalledWith("cp1", expect.objectContaining({ cellType: "Data" }), 1, 1025, 1);
  });

  it("outside the box it is not the box's double-click (false)", () => {
    seedRecord(50);
    expect(overlay!.onDoubleClick!({ region: regionWith(), canvasX: 50, canvasY: 50, row: 0, col: 0 })).toBe(false);
    expect(api.runPivotCellDoubleClick).not.toHaveBeenCalled();
  });
});

describe("reference pick (D-PICK): referenceAt names the hidden-grid cell under the point", () => {
  /** A view of `rowCount` rows x 3 columns; with 100px columns and 24px rows, header row + row-label column frozen. */
  function pickView(rowCount = 50): PivotViewResponse {
    return {
      pivotId: "cp1",
      version: 1,
      rowCount,
      colCount: 3,
      rowLabelColCount: 1,
      columnHeaderRowCount: 1,
      filterRowCount: 0,
      filterRows: [],
      rowFieldSummaries: [],
      columnFieldSummaries: [],
      rows: Array.from({ length: rowCount }, (_, i) => ({ viewRow: i, rowType: "Data", depth: 0, visible: true, cells: [] })),
      columns: [],
    } as unknown as PivotViewResponse;
  }

  function record(
    opts: {
      geometry?: PivotVisualGeometry | null;
      scroll?: { left: number; top: number };
      startRow?: number;
      startCol?: number;
      withChrome?: boolean;
    } = {},
  ): void {
    setPivotVisualRecord({
      pivotId: "cp1",
      box: { x: 100, y: 80, width: 300, height: 200 },
      bounds: {
        expandCollapseIcons: opts.withChrome
          ? new Map([["7-0", { x: 6, y: 78, width: 12, height: 12, row: 7, col: 0, isExpanded: true, isRow: true }]])
          : new Map(),
        filterButtons: new Map(),
        headerFilterButtons: new Map(),
      },
      cancel: null,
      geometry:
        opts.geometry === undefined
          ? buildPivotVisualGeometry(pickView(), true, { columnWidth: () => 100, rowHeight: () => 24 })
          : opts.geometry,
      scroll: opts.scroll ?? { left: 0, top: 120 },
      startRow: opts.startRow ?? 0,
      startCol: opts.startCol ?? 1024,
    });
  }

  const region = {
    id: "pivot-visual-cp1",
    type: PIVOT_VISUAL_REGION_TYPE,
    startRow: 0,
    startCol: 1024,
    endRow: 0,
    endCol: 0,
    data: { pivotId: "cp1" },
  };
  const at = (canvasX: number, canvasY: number) => ({ region, canvasX, canvasY, row: 0, col: 0 });

  it("is the registration's referenceAt, beside its zoneAt", () => {
    expect(overlay!.referenceAt).toBe(pivotVisualReferenceAt);
    expect(overlay!.zoneAt).toBeDefined();
  });

  it("a point in the FROZEN header row names the header cell whatever the body scroll", () => {
    record({ scroll: { left: 0, top: 600 } });
    // Box-local (50, 5): header row 0, row-label column 0 -> hidden-grid (0, 1024).
    expect(pivotVisualReferenceAt(at(150, 85))).toEqual({ space: "sheet", row: 0, col: 1024 });
    // Box-local (150, 5): header row 0, column 1 -> (0, 1025).
    expect(pivotVisualReferenceAt(at(250, 85))).toEqual({ space: "sheet", row: 0, col: 1025 });
  });

  it("a point in the scrolled BODY adds the scroll (the scrolled cell, never the window cell)", () => {
    record({ scroll: { left: 0, top: 120 } });
    // Box-local (150, 30): 6px into the body at scroll 120 -> view row 6, column 1.
    expect(pivotVisualReferenceAt(at(250, 110))).toEqual({ space: "sheet", row: 6, col: 1025 });
    record({ scroll: { left: 50, top: 0 } });
    // Box-local (160, 30): body column at 160 + 50 = 210 -> column 2; row 1.
    expect(pivotVisualReferenceAt(at(260, 110))).toEqual({ space: "sheet", row: 1, col: 1026 });
    // The frozen row-label column is not scrolled: box-local x 50 is column 0.
    expect(pivotVisualReferenceAt(at(150, 110))).toEqual({ space: "sheet", row: 1, col: 1024 });
  });

  it("adds the box's own anchor: a box in another column block, a pivot not at row 0", () => {
    record({ startRow: 3, startCol: 2048 });
    expect(pivotVisualReferenceAt(at(250, 110))).toEqual({ space: "sheet", row: 9, col: 2049 });
  });

  it("over the CHROME (a +/-) it names the cell beneath: during a pick the chrome does not act", () => {
    record({ scroll: { left: 0, top: 100 }, withChrome: true });
    // Control: the zone answer there IS the chrome.
    expect(overlay!.zoneAt!(at(112, 164))).toMatchObject({ kind: "content", part: "icon" });
    // Box-local (12, 84): 60px into the body at scroll 100 -> view row 7, column 0.
    expect(pivotVisualReferenceAt(at(112, 164))).toEqual({ space: "sheet", row: 7, col: 1024 });
  });

  it("blank area past the content, outside the box, no painted geometry or no record: null (inert)", () => {
    // 5 rows x 24px = 120px of content in a 200px box.
    record({
      geometry: buildPivotVisualGeometry(pickView(5), true, { columnWidth: () => 100, rowHeight: () => 24 }),
      scroll: { left: 0, top: 0 },
    });
    expect(pivotVisualReferenceAt(at(250, 80 + 150))).toBeNull();
    expect(pivotVisualReferenceAt(at(250, 80 + 100)), "control: a cell inside the content").toEqual({
      space: "sheet",
      row: 4,
      col: 1025,
    });
    expect(pivotVisualReferenceAt(at(99, 100)), "left of the box").toBeNull();

    record({ geometry: null });
    expect(pivotVisualReferenceAt(at(250, 110))).toBeNull();

    resetPivotVisualHits();
    expect(pivotVisualReferenceAt(at(250, 110))).toBeNull();
    expect(pivotVisualReferenceAt({ ...at(250, 110), region: { ...region, data: {} } })).toBeNull();
  });

  it("is PURE: a sweep of a thousand points writes no hover, selects nothing, dispatches nothing", () => {
    record({ withChrome: true, scroll: { left: 0, top: 100 } });
    const before = getPivotVisualRecord("cp1");
    const dispatch = vi.spyOn(window, "dispatchEvent");
    try {
      let answered = 0;
      for (let i = 0; i < 1000; i++) {
        const x = 60 + ((i * 37) % 380);
        const y = 40 + ((i * 53) % 280);
        if (pivotVisualReferenceAt(at(x, y))) answered++;
      }
      expect(answered, "the sweep never hit a cell -- vacuous").toBeGreaterThan(100);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      dispatch.mockRestore();
    }
    expect(getPivotVisualHover("cp1")).toBeUndefined();
    expect(isPivotVisualSelected("cp1")).toBe(false);
    expect(getActivePivotId()).toBeNull();
    expect(getPivotVisualRecord("cp1"), "the record was rewritten").toBe(before);
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });
});

describe("reference pick (D-PICK): a pick drag across the box is painted dashed over the cells it names", () => {
  type Stroke = { style: string; rect: { x: number; y: number; width: number; height: number }; clip: unknown };

  function renderWith(preview: unknown): Stroke[] {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      viewRow: i,
      rowType: i === 0 ? "ColumnHeader" : "Data",
      depth: 0,
      visible: true,
      cells: [
        {
          cellType: i === 0 ? "RowLabelHeader" : "RowHeader",
          value: null,
          formattedValue: i === 0 ? "Row Labels" : `Item ${i}`,
          backgroundStyle: "Normal",
        },
        { cellType: "Data", value: i, formattedValue: String(i), backgroundStyle: "Normal" },
        { cellType: "Data", value: i * 2, formattedValue: String(i * 2), backgroundStyle: "Normal" },
      ],
    }));
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
      rows,
      columns: [],
    } as unknown as PivotViewResponse;
    setCachedPivotView("cp1", view);
    setPivotVisualScroll("cp1", { left: 0, top: 120 });
    api.pickPreview = preview;

    const rec = createRecordingCtx();
    const strokes: Stroke[] = [];
    const ctx = rec.ctx as unknown as Record<string, unknown>;
    const strokeRect = ctx.strokeRect as (x: number, y: number, w: number, h: number) => void;
    ctx.strokeRect = function (this: Record<string, unknown>, x: number, y: number, w: number, h: number) {
      strokeRect.call(this, x, y, w, h);
      const op = rec.ops[rec.ops.length - 1];
      strokes.push({ style: String(this.strokeStyle), rect: op.rect, clip: op.clip });
    };
    const region = getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE)!;
    try {
      overlay!.render({
        ctx: rec.ctx,
        region,
        config: { rowHeaderWidth: 0, colHeaderHeight: 0, defaultCellWidth: 100, defaultCellHeight: 24 } as never,
        viewport: { scrollX: 10, scrollY: 20 } as never,
        dimensions: { columnWidths: new Map(), rowHeights: new Map() } as never,
        canvasWidth: 1200,
        canvasHeight: 800,
      });
    } finally {
      deleteCachedPivotView("cp1");
    }
    return strokes;
  }

  const PICK_BLUE = "#1f6fd1";
  const regionId = () => getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE)!.id;
  const blue = (strokes: Stroke[]) => strokes.filter((s) => s.style === PICK_BLUE);

  it("Core's preview of THIS box (hidden-grid rows 6-7, columns 1025-1026) is stroked over those cells, inside the box", () => {
    const strokes = renderWith({
      regionId: regionId(),
      range: { space: "sheet", startRow: 6, startCol: 1025, endRow: 7, endCol: 1026 },
    });
    expect(blue(strokes).length, "no dashed preview was painted").toBe(1);
    // Box at (90, 60) (frame (100, 80), page scrolled (10, 20)); body scrolled 120:
    // view row 6 sits at 6*24 - 120 = 24, columns 1-2 at 100..300. Inset 0.75 for the 1.5px stroke.
    expect(blue(strokes)[0].rect).toEqual({ x: 90 + 100 + 0.75, y: 60 + 24 + 0.75, width: 200 - 1.5, height: 48 - 1.5 });
    expect(blue(strokes)[0].clip).toEqual({ x: 90, y: 60, width: 300, height: 200 });
  });

  it("a preview of another object, of an object space (a floating grid's cells), or none: nothing dashed here", () => {
    const sheetRange = { space: "sheet", startRow: 6, startCol: 1025, endRow: 7, endCol: 1026 };
    expect(blue(renderWith({ regionId: "floating-range-f1", range: sheetRange }))).toEqual([]);
    expect(blue(renderWith({ regionId: regionId(), range: { ...sheetRange, space: "object", name: "Float2" } }))).toEqual([]);
    expect(blue(renderWith(null))).toEqual([]);
  });
});

// ============================================================================
// D-CELLS (WP-A S5): the box's cells are CONTENT
// ============================================================================

describe("cells are content (D-CELLS): the zone answer", () => {
  /** 50 rows x 3 columns of 24 x 100 px (header row + row-label column frozen), or `rowCount` rows. */
  function cellView(rowCount = 50): PivotViewResponse {
    return {
      pivotId: "cp1",
      version: 1,
      rowCount,
      colCount: 3,
      rowLabelColCount: 1,
      columnHeaderRowCount: 1,
      filterRowCount: 0,
      filterRows: [],
      rowFieldSummaries: [],
      columnFieldSummaries: [],
      rows: Array.from({ length: rowCount }, (_, i) => ({ viewRow: i, rowType: "Data", depth: 0, visible: true, cells: [] })),
      columns: [],
    } as unknown as PivotViewResponse;
  }

  /** The box at canvas (100, 80), 300 x 200; a +/- at box-local (6, 78) when `withChrome`. */
  function paintRecord(opts: { rowCount?: number; withChrome?: boolean; scroll?: { left: number; top: number } } = {}): void {
    setPivotVisualRecord({
      pivotId: "cp1",
      box: { x: 100, y: 80, width: 300, height: 200 },
      bounds: {
        expandCollapseIcons: opts.withChrome
          ? new Map([["7-0", { x: 6, y: 78, width: 12, height: 12, row: 7, col: 0, isExpanded: true, isRow: true }]])
          : new Map(),
        filterButtons: new Map(),
        headerFilterButtons: new Map(),
      },
      cancel: null,
      geometry: buildPivotVisualGeometry(cellView(opts.rowCount), true, { columnWidth: () => 100, rowHeight: () => 24 }),
      scroll: opts.scroll ?? { left: 0, top: 0 },
      startRow: 0,
      startCol: 1024,
    });
    setPivotVisualScroll("cp1", opts.scroll ?? { left: 0, top: 0 });
  }

  const regionWith = (data: Record<string, unknown> = {}) => ({
    id: "pivot-visual-cp1",
    type: PIVOT_VISUAL_REGION_TYPE,
    startRow: 0,
    startCol: 1024,
    endRow: 49,
    endCol: 1026,
    floating: { x: 100, y: 80, width: 300, height: 200 },
    data: { pivotId: "cp1", ...data },
  });
  const bounds = { x: 100, y: 80, width: 300, height: 200 };
  const zoneAt = (x: number, y: number, data: Record<string, unknown> = {}) =>
    overlay!.zoneAt!({ region: regionWith(data), canvasX: x, canvasY: y, row: 0, col: 0, floatingCanvasBounds: bounds });

  it("a cell is content with the cell pointer (part 'cell'), in the header row and the body alike", () => {
    paintRecord();
    expect(zoneAt(250, 110)).toEqual({ kind: "content", cursor: "cell", part: "cell" });
    expect(zoneAt(150, 90)).toEqual({ kind: "content", cursor: "cell", part: "cell" });
  });

  it(`the ${PIVOT_BOX_BORDER_BAND}px band inside the edge is frame 'border' (it moves the box), on all four edges`, () => {
    paintRecord();
    expect(zoneAt(102, 150)).toEqual({ kind: "frame", part: "border" }); // left
    expect(zoneAt(250, 82)).toEqual({ kind: "frame", part: "border" }); // top
    expect(zoneAt(398, 150)).toEqual({ kind: "frame", part: "border" }); // right
    expect(zoneAt(250, 278)).toEqual({ kind: "frame", part: "border" }); // bottom
    // Control: just inside the band is a cell again.
    expect(zoneAt(105, 150)).toEqual({ kind: "content", cursor: "cell", part: "cell" });
  });

  it("blank area past the content is frame 'blank' (it moves the box)", () => {
    paintRecord({ rowCount: 5 }); // 120 px of content in a 200 px box
    expect(zoneAt(250, 80 + 150)).toEqual({ kind: "frame", part: "blank" });
    expect(zoneAt(250, 80 + 100), "control: inside the content").toMatchObject({ kind: "content", part: "cell" });
  });

  it("in DESIGN MODE the whole body is frame 'bodyGrab' -- the chrome still acts", () => {
    paintRecord({ withChrome: true });
    expect(zoneAt(250, 110, { bodyGrab: true })).toEqual({ kind: "frame", part: "bodyGrab" });
    expect(zoneAt(112, 164, { bodyGrab: true })).toEqual({ kind: "content", cursor: "pointer", part: "icon" });
    expect(zoneAt(250, 110, { bodyGrab: false }), "control: Design Mode off").toMatchObject({ part: "cell" });
  });

  it("a locked / immovable box's cells are STILL content (reading the report is not editing it)", () => {
    paintRecord();
    expect(zoneAt(250, 110, { movable: false, locked: true })).toEqual({ kind: "content", cursor: "cell", part: "cell" });
  });

  it("is PURE: a sweep of a thousand points writes no cell selection, hover or record, binds no listener, dispatches nothing", () => {
    paintRecord({ withChrome: true });
    const before = getPivotVisualRecord("cp1");
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const bind = vi.spyOn(window, "addEventListener");
    const docBind = vi.spyOn(document, "addEventListener");
    const parts = new Set<string>();
    try {
      for (let i = 0; i < 1000; i++) {
        const x = 60 + ((i * 37) % 380);
        const y = 40 + ((i * 53) % 280);
        const z = zoneAt(x, y);
        parts.add(z ? `${z.kind}:${z.part}` : "null");
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      expect(docBind).not.toHaveBeenCalled();
    } finally {
      dispatch.mockRestore();
      bind.mockRestore();
      docBind.mockRestore();
    }
    // Not vacuous: the sweep met cells, the band and the outside.
    expect([...parts].sort()).toEqual(expect.arrayContaining(["content:cell", "frame:border", "null"]));
    expect(getPivotCellSelection()).toBeNull();
    expect(getPivotVisualHover("cp1")).toBeUndefined();
    expect(getPivotVisualRecord("cp1")).toBe(before);
    expect(isPivotCellPressLive()).toBe(false);
  });
});

describe("cells are content (D-CELLS): the press, the clearing rules, the paint", () => {
  function cellView(rowCount = 50): PivotViewResponse {
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      viewRow: i,
      rowType: i === 0 ? "ColumnHeader" : "Data",
      depth: 0,
      visible: true,
      cells: [
        { cellType: i === 0 ? "RowLabelHeader" : "RowHeader", value: null, formattedValue: i === 0 ? "Row Labels" : `Item ${i}`, backgroundStyle: "Normal" },
        { cellType: "Data", value: i, formattedValue: String(i), backgroundStyle: "Normal" },
        { cellType: "Data", value: i * 2, formattedValue: String(i * 2), backgroundStyle: "Normal" },
      ],
    }));
    return {
      pivotId: "cp1",
      version: 1,
      rowCount,
      colCount: 3,
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

  function paintRecord(): void {
    setPivotVisualRecord({
      pivotId: "cp1",
      box: { x: 100, y: 80, width: 300, height: 200 },
      bounds: {
        expandCollapseIcons: new Map([["7-0", { x: 6, y: 78, width: 12, height: 12, row: 7, col: 0, isExpanded: true, isRow: true }]]),
        filterButtons: new Map(),
        headerFilterButtons: new Map(),
      },
      cancel: null,
      geometry: buildPivotVisualGeometry(cellView(), true, { columnWidth: () => 100, rowHeight: () => 24 }),
      scroll: { left: 0, top: 0 },
      startRow: 0,
      startCol: 1024,
    });
    setPivotVisualScroll("cp1", { left: 0, top: 0 });
  }

  let gridArea: HTMLElement | null = null;
  beforeEach(() => {
    gridArea = document.createElement("div");
    gridArea.setAttribute("data-grid-area", "");
    document.body.appendChild(gridArea);
  });
  afterEach(() => {
    gridArea?.remove();
    gridArea = null;
    setDesignMode(false);
  });

  it("a content press on a CELL (part 'cell') anchors it; Shift+press extends; the release keeps the cells", () => {
    paintRecord();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell", shiftKey: false }));
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
    expect(isPivotChromePressActive(), "a cell press started the chrome press").toBe(false);
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 250, clientY: 110, button: 0 }));
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 350, canvasY: 160, part: "cell", shiftKey: true }));
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 1, anchorCol: 1, endRow: 3, endCol: 2 });
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 350, clientY: 160, button: 0 }));
    expect(isPivotCellPressLive()).toBe(false);
    expect(getPivotCellSelection()).toMatchObject({ endRow: 3, endCol: 2 });
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
  });

  it("a chrome press (any other part) still starts the chrome press, not a cell press", () => {
    paintRecord();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164, part: "icon" }));
    expect(isPivotChromePressActive()).toBe(true);
    expect(isPivotCellPressLive()).toBe(false);
    expect(getPivotCellSelection()).toBeNull();
  });

  it("one press at a time: a cell press ends a held chrome press, and a chrome press ends a held cell press", () => {
    paintRecord();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164, part: "icon" }));
    expect(isPivotChromePressActive()).toBe(true);
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell" }));
    expect(isPivotChromePressActive(), "the chrome press outlived the cell press").toBe(false);
    expect(isPivotCellPressLive()).toBe(true);
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 112, canvasY: 164, part: "icon" }));
    expect(isPivotCellPressLive(), "the cell press outlived the chrome press").toBe(false);
    expect(isPivotChromePressActive()).toBe(true);
    // Its release over the +/- acts once: the cell press is gone, not acting too.
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 112, clientY: 164, button: 0 }));
    expect(api.togglePivotHeaderAt).toHaveBeenCalledTimes(1);
  });

  it("while the cell drag is held the box owns Escape (the canvas does not deselect it); after it, the SELECTED CELLS own it (S6) until they clear", () => {
    paintRecord();
    expect(objectOwnsKey("Escape")).toBe(false);
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell" }));
    expect(objectOwnsKey("Escape")).toBe(true);
    expect(objectOwnsKey("Delete"), "a held cell press: Delete must not delete the pivot").toBe(true);
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 250, clientY: 110, button: 0 }));
    expect(getPivotCellSelection(), "fixture: the press left cells selected").not.toBeNull();
    expect(objectOwnsKey("Escape"), "the cells' Escape clears them before the canvas deselects the box").toBe(true);
    expect(objectOwnsKey("Delete"), "Delete on selected cells must not delete the pivot").toBe(true);
    resetPivotCellSelection();
    expect(objectOwnsKey("Escape"), "no press, no cells: Escape is the canvas's").toBe(false);
  });

  it("the box's teardown ends a held cell press", () => {
    paintRecord();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell" }));
    expect(isPivotCellPressLive()).toBe(true);
    cleanups.forEach((c) => c());
    cleanups = [];
    expect(isPivotCellPressLive()).toBe(false);
  });

  it("selecting ANOTHER box clears the cells; re-selecting the same box keeps them; deselecting clears them", async () => {
    const second: PivotRegionData = { ...canvasPivot, pivotId: "cp2", startCol: 2048, endCol: 2050 };
    updateCachedRegions([canvasPivot, second]);
    fire("floatingObject:selected", visualDetail());
    setPivotCellAnchor("cp1", 2, 1);
    fire("floatingObject:selected", visualDetail());
    expect(getPivotCellSelection(), "a press on the same box cleared its cells").toMatchObject({ pivotId: "cp1" });

    fire("floatingObject:selected", {
      regionId: "pivot-visual-cp2",
      regionType: PIVOT_VISUAL_REGION_TYPE,
      data: { pivotId: "cp2" },
    });
    expect(getPivotCellSelection()).toBeNull();

    setPivotCellAnchor("cp2", 1, 1);
    fire("floatingObject:selected", { regionId: "slicer-1", regionType: "slicer", data: { slicerId: "s1" } });
    expect(isPivotVisualSelected("cp2")).toBe(false);
    expect(getPivotCellSelection(), "the cells outlived their box's selection").toBeNull();
    await vi.runAllTimersAsync();
  });

  it("a new view CLAMPS the cells into it (PIVOT_VIEW_UPDATED); one without the anchor clears them", () => {
    setPivotCellAnchor("cp1", 3, 1);
    extendPivotCellSelection(40, 2);
    setCachedPivotView("cp1", cellView(20));
    fire(PivotEvents.PIVOT_VIEW_UPDATED, { pivotId: "cp1", version: 2 });
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 3, anchorCol: 1, endRow: 19, endCol: 2 });
    setCachedPivotView("cp1", cellView(3));
    fire(PivotEvents.PIVOT_VIEW_UPDATED, { pivotId: "cp1", version: 3 });
    expect(getPivotCellSelection()).toBeNull();
    deleteCachedPivotView("cp1");
  });

  it("the box going away (pruned records: a deleted pivot, a page left) clears its cells; another box's prune does not", () => {
    setPivotCellAnchor("cp1", 3, 1);
    prunePivotVisualRecords(new Set(["cp1", "cp9"]));
    expect(getPivotCellSelection()).not.toBeNull();
    prunePivotVisualRecords(new Set(["cp9"]));
    expect(getPivotCellSelection()).toBeNull();
  });

  it("the region publishes the hover grip and, in Design Mode only, bodyGrab -- re-published when Design Mode flips", () => {
    const data = () => getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE)?.data;
    expect(data()).toMatchObject({ grip: "hover", bodyGrab: false });
    setDesignMode(true);
    expect(data()).toMatchObject({ grip: "hover", bodyGrab: true });
    setDesignMode(false);
    expect(data()).toMatchObject({ bodyGrab: false });
  });

  type Mark = { op: string; style: string; rect: { x: number; y: number; width: number; height: number }; clip: unknown };

  function render(): Mark[] {
    setCachedPivotView("cp1", cellView());
    setPivotVisualScroll("cp1", { left: 0, top: 120 });
    const rec = createRecordingCtx();
    const marks: Mark[] = [];
    const ctx = rec.ctx as unknown as Record<string, unknown>;
    for (const name of ["strokeRect", "fill"] as const) {
      const original = ctx[name] as (...args: unknown[]) => void;
      ctx[name] = function (this: Record<string, unknown>, ...args: unknown[]) {
        original.apply(this, args);
        const op = rec.ops[rec.ops.length - 1];
        marks.push({
          op: name,
          style: String(name === "fill" ? this.fillStyle : this.strokeStyle),
          rect: op.rect,
          clip: op.clip,
        });
      };
    }
    const region = getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE)!;
    try {
      overlay!.render({
        ctx: rec.ctx,
        region,
        config: { rowHeaderWidth: 0, colHeaderHeight: 0, defaultCellWidth: 100, defaultCellHeight: 24 } as never,
        viewport: { scrollX: 10, scrollY: 20 } as never,
        dimensions: { columnWidths: new Map(), rowHeights: new Map() } as never,
        canvasWidth: 1200,
        canvasHeight: 800,
      });
    } finally {
      deleteCachedPivotView("cp1");
    }
    return marks;
  }

  const green = (marks: Mark[]) => marks.filter((m) => m.op === "strokeRect" && m.style === INNER_SELECTION_BORDER);

  it("the selection is painted over the cells it names (scrolled body), inside the box, with the inner-selection ink", () => {
    setPivotCellAnchor("cp1", 6, 1);
    extendPivotCellSelection(7, 2);
    const marks = render();
    // Box at (90, 60); body scrolled 120: view row 6 at 6*24 - 120 = 24; columns 1-2 at 100..300. 2px border inset 1.
    expect(green(marks).map((m) => m.rect)).toEqual([{ x: 90 + 100 + 1, y: 60 + 24 + 1, width: 198, height: 46 }]);
    expect(green(marks)[0].clip).toEqual({ x: 90, y: 60, width: 300, height: 200 });
    expect(marks.some((m) => m.op === "fill" && m.style === INNER_SELECTION_FILL), "no selection fill").toBe(true);
  });

  it("a rectangle across the frozen header band is painted in both quadrants (paint == hit)", () => {
    setPivotCellAnchor("cp1", 0, 1);
    extendPivotCellSelection(6, 1);
    const pieces = green(render()).map((m) => m.rect);
    // Header row (frozen) at 0..24, body rows 5-6 shown from the band's edge (24) to 6*24+24-120 = 48.
    expect(pieces).toEqual([
      { x: 191, y: 61, width: 98, height: 22 },
      { x: 191, y: 85, width: 98, height: 22 },
    ]);
  });

  it("another pivot's cells, or none: nothing painted here", () => {
    expect(green(render())).toEqual([]);
    setPivotCellAnchor("cp9", 6, 1);
    expect(green(render())).toEqual([]);
  });

  it("cellSheetRect: the visible part of a cell in SHEET px (frame + box-local), null when not shown", () => {
    paintRecord();
    // Frame (100, 80) on the page; scroll 0: view row 2 at 48, column 1 at 100.
    expect(pivotCellSheetRect("cp1", 2, 1)).toEqual({ x: 200, y: 128, width: 100, height: 24 });
    // Row 20 is below the 200 px box.
    expect(pivotCellSheetRect("cp1", 20, 1)).toBeNull();
    expect(pivotCellSheetRect("cp1", 0, 7)).toBeNull();
    expect(pivotCellSheetRect("nope", 0, 0)).toBeNull();
  });
});

describe("cross-filter (P4 S7): the filtered view, its badge, the click, the refusals", () => {
  function cellView(label: string, rowCount = 20): PivotViewResponse {
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      viewRow: i,
      rowType: i === 0 ? "ColumnHeader" : "Data",
      depth: 0,
      visible: true,
      cells: [
        { cellType: i === 0 ? "RowLabelHeader" : "RowHeader", value: null, formattedValue: i === 0 ? "Row Labels" : `${label} ${i}`, backgroundStyle: "Normal" },
        { cellType: "Data", value: i, formattedValue: String(i), backgroundStyle: "Normal" },
      ],
    }));
    return {
      pivotId: "cp1",
      version: 1,
      rowCount,
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

  function renderTexts(): string[] {
    const rec = createRecordingCtx();
    const region = getGridRegions().find((r) => r.type === PIVOT_VISUAL_REGION_TYPE)!;
    overlay!.render({
      ctx: rec.ctx,
      region,
      config: { rowHeaderWidth: 0, colHeaderHeight: 0, defaultCellWidth: 100, defaultCellHeight: 24 } as never,
      viewport: { scrollX: 0, scrollY: 0 } as never,
      dimensions: { columnWidths: new Map(), rowHeights: new Map() } as never,
      canvasWidth: 1200,
      canvasHeight: 800,
    });
    return rec.texts().map((t) => String(t.text ?? ""));
  }

  let gridArea: HTMLElement | null = null;
  beforeEach(() => {
    gridArea = document.createElement("div");
    gridArea.setAttribute("data-grid-area", "");
    document.body.appendChild(gridArea);
    setCachedPivotView("cp1", cellView("Real"));
  });
  afterEach(() => {
    gridArea?.remove();
    gridArea = null;
    setFilteredPivotViewForTest("cp1", null);
    deleteCachedPivotView("cp1");
  });

  it("paints the FILTERED view and 'Filtered by <source>'; the real view stays in the store", () => {
    setFilteredPivotViewForTest("cp1", { view: cellView("Shown"), sources: ["Sales chart"] });
    const texts = renderTexts();
    expect(texts).toContain("Shown 1");
    expect(texts.some((t) => t.startsWith("Real "))).toBe(false);
    expect(texts).toContain("Filtered by Sales chart");
  });

  it("a refusal paints the REAL view and 'Not filtered by <source>: <reason>'", () => {
    setFilteredPivotViewForTest("cp1", {
      error: "This PivotTable uses hierarchies, which a visual's selection cannot filter yet.",
      sources: ["Sales chart"],
    });
    const texts = renderTexts();
    expect(texts).toContain("Real 1");
    // The sentence wraps inside the box (300 px) rather than being cut off.
    const at = texts.findIndex((t) => t.startsWith("Not filtered by Sales chart:"));
    expect(at, texts.join("|")).toBeGreaterThanOrEqual(0);
    const badge = texts.slice(at).join(" ");
    expect(badge).toContain("Not filtered by Sales chart: This PivotTable uses hierarchies");
    expect(texts.slice(at).length, "it wrapped").toBeGreaterThan(1);
  });

  it("no selection: the real view and no badge", () => {
    const texts = renderTexts();
    expect(texts).toContain("Real 1");
    expect(texts.some((t) => t.includes("iltered by"))).toBe(false);
  });

  const releaseAt = (x: number, y: number) =>
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, button: 0 }));

  it("a plain or Ctrl CLICK on a cell cross-filters at its release; Shift and Design Mode do not", () => {
    renderTexts();
    // Box at (100, 80); view row 1 (24..48), column 1 (100..200).
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell" }));
    expect(api.applyPivotCrossFilterClick, "acted on the PRESS").not.toHaveBeenCalled();
    releaseAt(250, 110);
    expect(api.applyPivotCrossFilterClick).toHaveBeenCalledWith({ pivotId: "cp1", viewRow: 1, viewCol: 1, ctrl: false });

    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell", ctrlKey: true }));
    releaseAt(250, 110);
    expect(api.applyPivotCrossFilterClick).toHaveBeenLastCalledWith({ pivotId: "cp1", viewRow: 1, viewCol: 1, ctrl: true });
    expect(api.applyPivotCrossFilterClick).toHaveBeenCalledTimes(2);

    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell", shiftKey: true }));
    releaseAt(250, 110);
    expect(api.applyPivotCrossFilterClick, "a Shift-extend cross-filtered").toHaveBeenCalledTimes(2);

    setDesignMode(true);
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell" }));
    releaseAt(250, 110);
    expect(api.applyPivotCrossFilterClick, "Design Mode cross-filtered").toHaveBeenCalledTimes(2);
    setDesignMode(false);

    // The press kept its cell selection behaviour.
    expect(getPivotCellSelection()).toMatchObject({ pivotId: "cp1", anchorRow: 1, anchorCol: 1 });
  });

  it("a drag across cells selects them and never cross-filters", () => {
    renderTexts();
    fire("floatingObject:bodyDragStart", visualDetail({ canvasX: 250, canvasY: 110, part: "cell" }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 250, clientY: 160, buttons: 1 }));
    releaseAt(250, 160);
    expect(api.applyPivotCrossFilterClick).not.toHaveBeenCalled();
    expect(getPivotCellSelection()).toMatchObject({ anchorRow: 1, endRow: 3 });
  });

  it("while filtered, the box's chrome and its double-click REFUSE with the note and send nothing", () => {
    setFilteredPivotViewForTest("cp1", { view: cellView("Shown"), sources: ["Sales chart"] });
    setPivotVisualRecord({
      pivotId: "cp1",
      box: { x: 100, y: 80, width: 300, height: 200 },
      bounds: {
        expandCollapseIcons: new Map([["7-0", { x: 6, y: 78, width: 12, height: 12, row: 7, col: 0, isExpanded: true, isRow: true }]]),
        filterButtons: new Map([["filter-2", { x: 150, y: 3, width: 18, height: 18, fieldIndex: 2, row: 0, col: 1 }]]),
        headerFilterButtons: new Map(),
      },
      cancel: null,
      geometry: buildPivotVisualGeometry(cellView("Shown"), true, { columnWidth: () => 100, rowHeight: () => 24 }),
      scroll: { left: 0, top: 0 },
      startRow: 0,
      startCol: 1024,
    });
    const note = "Filtered by Sales chart -- clear the selection to change this PivotTable here";
    expect(handlePivotVisualPress("cp1", 112, 164, 1_000)).toMatchObject({ kind: "icon" });
    expect(handlePivotVisualPress("cp1", 259, 90, 5_000)).toMatchObject({ kind: "filter" });
    expect(api.togglePivotHeaderAt).not.toHaveBeenCalled();
    expect(api.openPivotReportFilterAt).not.toHaveBeenCalled();
    expect(api.showToast).toHaveBeenCalledWith(note, { variant: "info" });

    const region = { id: "pivot-visual-cp1", type: PIVOT_VISUAL_REGION_TYPE, startRow: 0, startCol: 1024, endRow: 0, endCol: 0, data: { pivotId: "cp1" } };
    expect(overlay!.onDoubleClick!({ region, canvasX: 250, canvasY: 110, row: 0, col: 0 })).toBe(true);
    expect(api.getPivotViewCell).not.toHaveBeenCalled();
    expect(api.runPivotCellDoubleClick).not.toHaveBeenCalled();

    // Control: once the selection is gone the same +/- acts.
    setFilteredPivotViewForTest("cp1", null);
    handlePivotVisualPress("cp1", 112, 164, 9_000);
    expect(api.togglePivotHeaderAt).toHaveBeenCalledWith("cp1", 7, 0, true);
  });

  it("a filtered view coming clamps the cell selection into the grid shown", () => {
    setPivotCellAnchor("cp1", 15, 1);
    setFilteredPivotViewForTest("cp1", { view: cellView("Shown", 5), sources: ["Sales chart"] });
    expect(getPivotCellSelection(), "row 15 is not in the 5-row view shown").toBeNull();
  });
});
