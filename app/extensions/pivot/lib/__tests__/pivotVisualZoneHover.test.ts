//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualZoneHover.test.ts
// PURPOSE: The canvas pivot box's zone answer is PURE, and its chrome hover
//          highlight follows the pointer from the document mousemove observer
//          (`updatePivotVisualHoverAt`) -- set only over the chrome of the box
//          Core's hit order says is TOPMOST there, cleared everywhere else.
// CONTEXT: BUG-0258 design phase 2 (M5 T4). The box's old `getCursor` WROTE the
//          hover highlight as a side effect of Core asking it for a pointer,
//          so the answer Core's press and hover read was not a pure function
//          of the point. `zoneAt` is asked on every hover move and once per
//          press before anything is selected, and its contract is purity. The
//          hover moved to the mousemove observer, which must not light up a
//          box another object covers (the old getCursor never ran for a
//          covered box: Core asks the topmost object only).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  top: null as null | { id: string; type: string; data?: Record<string, unknown> },
  redraw: vi.fn(),
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

// Which floating object is TOPMOST at the pointer is Core's hit order's
// answer; the test states it.
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  topFloatingRegionAtClient: () => h.top,
  requestOverlayRedraw: h.redraw,
}));

vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));

vi.mock("../pivot-api", () => ({
  updatePivotProperties: vi.fn(),
  getPivotCellWindow: vi.fn(),
  getCellDisplayValue: (v: unknown) => (v == null ? "" : String(v)),
}));

vi.mock("../pivotChromeActions", () => ({
  togglePivotHeaderAt: vi.fn(async () => true),
  openPivotReportFilterAt: vi.fn(async () => true),
  openPivotHeaderFilter: vi.fn(),
  cancelPivotLoading: vi.fn(),
  getPivotViewCell: vi.fn(),
}));

vi.mock("../pivotCellDoubleClick", () => ({ runPivotCellDoubleClick: vi.fn(() => true) }));

import type { GridRegion, OverlayHitTestContext } from "@api/gridOverlays";
import { clearPivotVisualHoverUnlessHovered, pivotVisualZoneAt, updatePivotVisualHoverAt } from "../pivotVisualOverlay";
import { setGridRegions } from "@api/gridOverlays";
import { PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";
import {
  anyPivotVisualHover,
  getPivotVisualHover,
  resetPivotVisualHits,
  setPivotVisualRecord,
} from "../pivotVisualHits";

/** The box at canvas (100, 80), 300 x 200; a +/- at box-local (6, 78); a report filter at (150, 3). */
function recordWithChrome(pivotId = "cp1", box = { x: 100, y: 80, width: 300, height: 200 }): void {
  setPivotVisualRecord({
    pivotId,
    box,
    bounds: {
      expandCollapseIcons: new Map([["7-0", { x: 6, y: 78, width: 12, height: 12, row: 7, col: 0, isExpanded: true, isRow: true }]]),
      filterButtons: new Map([["filter-2", { x: 150, y: 3, width: 18, height: 18, fieldIndex: 2, row: 0, col: 1 }]]),
      headerFilterButtons: new Map(),
    },
    cancel: null,
    geometry: null,
    scroll: { left: 0, top: 0 },
    startRow: 0,
    startCol: 1024,
  });
}

const BOX_REGION: GridRegion = {
  id: "pivot-visual-cp1",
  type: PIVOT_VISUAL_REGION_TYPE,
  startRow: 0,
  startCol: 1024,
  endRow: 0,
  endCol: 0,
  floating: { x: 100, y: 80, width: 300, height: 200 },
  data: { pivotId: "cp1" },
};

/** A +/- icon and a plain body cell, in canvas px (= client px: the grid area sits at 0,0, zoom 1). */
const ICON = { x: 112, y: 164 };
const CELL = { x: 250, y: 200 };

function ctx(p: { x: number; y: number }): OverlayHitTestContext {
  return { region: BOX_REGION, canvasX: p.x, canvasY: p.y, row: 0, col: 0 };
}

let area: HTMLElement;

beforeEach(() => {
  resetPivotVisualHits();
  h.top = null;
  h.redraw.mockClear();
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  area.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 2000, bottom: 2000, width: 2000, height: 2000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(area);
});

afterEach(() => {
  area.remove();
});

describe("the zone answer is PURE", () => {
  it("fifty answers over chrome and cells write no hover and request no repaint", () => {
    recordWithChrome();
    for (let i = 0; i < 50; i++) {
      const zone = pivotVisualZoneAt(ctx(i % 2 === 0 ? ICON : CELL));
      expect(zone?.kind ?? null).toBe(i % 2 === 0 ? "content" : null);
    }
    expect(anyPivotVisualHover()).toBe(false);
    expect(getPivotVisualHover("cp1")).toBeUndefined();
    expect(h.redraw).not.toHaveBeenCalled();
  });
});

describe("the chrome hover follows the pointer (updatePivotVisualHoverAt)", () => {
  it("over the TOPMOST box's chrome: highlighted (one repaint); off the box: cleared", () => {
    recordWithChrome();
    h.top = BOX_REGION;
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(getPivotVisualHover("cp1")).toEqual({ iconKey: "7-0" });
    expect(h.redraw).toHaveBeenCalledTimes(1);

    // The same point again changes nothing, so nothing is repainted.
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(h.redraw).toHaveBeenCalledTimes(1);

    h.top = null;
    updatePivotVisualHoverAt(900, 900, area);
    expect(anyPivotVisualHover()).toBe(false);
    expect(h.redraw).toHaveBeenCalledTimes(2);
  });

  it("over a plain CELL of the box: no highlight (a lit one clears)", () => {
    recordWithChrome();
    h.top = BOX_REGION;
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(anyPivotVisualHover()).toBe(true);
    updatePivotVisualHoverAt(CELL.x, CELL.y, area);
    expect(anyPivotVisualHover()).toBe(false);
  });

  it("a box ANOTHER object covers never lights up from behind it", () => {
    recordWithChrome();
    // A chart sits on top of the box's +/-: Core's hit order answers the chart.
    h.top = { id: "chart-c1", type: "chart", data: { chartId: "c1" } };
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(anyPivotVisualHover()).toBe(false);
    expect(h.redraw).not.toHaveBeenCalled();

    // And a highlight lit before the chart came over it is cleared.
    h.top = BOX_REGION;
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(anyPivotVisualHover()).toBe(true);
    h.top = { id: "chart-c1", type: "chart", data: { chartId: "c1" } };
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(anyPivotVisualHover()).toBe(false);
  });

  it("of two boxes, only the TOPMOST one's chrome lights up", () => {
    recordWithChrome("cp1");
    recordWithChrome("cp2");
    h.top = { ...BOX_REGION, id: "pivot-visual-cp2", data: { pivotId: "cp2" } };
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(getPivotVisualHover("cp2")).toEqual({ iconKey: "7-0" });
    expect(getPivotVisualHover("cp1")).toBeUndefined();
  });

  it("over DOM stacked above the grid (a menu, a dialog) nothing is highlighted", () => {
    recordWithChrome();
    h.top = BOX_REGION;
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(anyPivotVisualHover()).toBe(true);
    const menu = document.createElement("div");
    document.body.appendChild(menu);
    updatePivotVisualHoverAt(ICON.x, ICON.y, menu);
    expect(anyPivotVisualHover()).toBe(false);
    menu.remove();
  });
});

describe("Core's hover leaving every box clears the highlight (clearPivotVisualHoverUnlessHovered)", () => {
  // BUG-0258 design phase 5: Core's floating-object hover (core/lib/objectHover.ts)
  // ends when the pointer leaves the grid, the grid scrolls or the sheet
  // changes -- none of which sends the document mousemove above. Pivot/index.ts
  // hands every hover change to this function (pivotVisualHoverWiring.test.ts).
  const CHART: GridRegion = { ...BOX_REGION, id: "chart-c1", type: "chart", data: { chartId: "c1" } };

  function lit(): void {
    recordWithChrome();
    h.top = BOX_REGION;
    updatePivotVisualHoverAt(ICON.x, ICON.y, area);
    expect(getPivotVisualHover("cp1"), "precondition: the +/- is lit").toEqual({ iconKey: "7-0" });
    h.redraw.mockClear();
  }

  afterEach(() => setGridRegions([]));

  it("nothing hovered (the pointer left the grid, it scrolled, the sheet changed): cleared, one repaint", () => {
    setGridRegions([BOX_REGION, CHART]);
    lit();
    clearPivotVisualHoverUnlessHovered(null);
    expect(anyPivotVisualHover()).toBe(false);
    expect(h.redraw).toHaveBeenCalledTimes(1);
  });

  it("another object hovered: cleared", () => {
    setGridRegions([BOX_REGION, CHART]);
    lit();
    clearPivotVisualHoverUnlessHovered("chart-c1");
    expect(anyPivotVisualHover()).toBe(false);
  });

  it("the box itself hovered: KEPT (the per-button highlight is the mousemove's)", () => {
    setGridRegions([BOX_REGION, CHART]);
    lit();
    clearPivotVisualHoverUnlessHovered(BOX_REGION.id);
    expect(getPivotVisualHover("cp1")).toEqual({ iconKey: "7-0" });
    expect(h.redraw).not.toHaveBeenCalled();
  });

  it("nothing lit: nothing to do, no repaint", () => {
    setGridRegions([BOX_REGION]);
    recordWithChrome();
    clearPivotVisualHoverUnlessHovered(null);
    expect(h.redraw).not.toHaveBeenCalled();
  });
});
