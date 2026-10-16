//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotVisualContextMenu.test.ts
// PURPOSE: open-items 2.af -- "a pivot box on a canvas has no right-click
//          menu". Through the REAL install (`installPivotVisual`) and a real
//          window `contextmenu` event:
//          - a right-click on the box opens the pivot menu -- the pivot group's
//            items only, never Core's cell items -- with the hidden-grid cell
//            under the pointer as the clicked cell, and claims the event;
//          - an item runs with that context; a sub-menu opens on hover;
//          - an object ON TOP of the box keeps its own menu (not claimed);
//          - while the menu is open it owns Escape (the canvas's Escape binding
//            asks first), and Escape closes it;
//          - under the pivot's items, the "Size and Position..." row every
//            object menu carries (BUG-0258 phase 5b): it opens the dialog for
//            the BOX's region, and is greyed when nothing can open one;
//          - and "Format...", the object pane's door every family menu
//            carries (WP-C review R2-15b): it opens the ONE object pane on the
//            BOX's Format tab as a command, greyed with the reason when no
//            pane can show the box.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  top: null as Record<string, unknown> | null,
  items: [] as Array<Record<string, unknown>>,
  contexts: [] as unknown[],
  clicked: [] as Array<{ id: string; context: unknown }>,
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
  gridExtensions: {
    getContextMenuItemsForContext: (context: unknown) => {
      h.contexts.push(context);
      return h.items;
    },
  },
}));

vi.mock("@api/pivot", () => ({ pivot: { getAtCell: vi.fn() } }));

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({
    zoom: 1,
    surface: "canvas",
    displayHeadings: false,
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    sheetContext: { activeSheetIndex: 2, activeSheetName: "Canvas1" },
  }),
  resolveHeaderSizes: () => ({ rowHeaderWidth: 0, colHeaderHeight: 0 }),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  topFloatingRegionAtClient: () => h.top,
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

import { installPivotVisual } from "../pivotVisualOverlay";
import { setPivotVisualRecord, resetPivotVisualHits } from "../pivotVisualHits";
import { resetPivotVisualRegionState, PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";
import { resetObjectSelectionProviders, objectOwnsKey } from "@api/objectSelection";
import { resetSelectionHandlerState, isPivotVisualSelected, updateCachedRegions } from "../../handlers/selectionHandler";
import { closePivotBoxMenu, pivotBoxMenuTargetAt } from "../pivotVisualContextMenu";
import {
  extendPivotCellSelection,
  getPivotCellSelection,
  resetPivotCellSelection,
  setPivotCellAnchor,
} from "../pivotVisualCellSelection";
import { openTaskPane, showToast } from "@api";
import { buildPivotVisualGeometry } from "../../rendering/pivotVisualRenderer";
import { registerSizeAndPositionOpener, resetObjectPosition, SIZE_AND_POSITION_LABEL } from "@api/objectPosition";
import {
  OBJECT_PANE_FORMAT_LABEL,
  OBJECT_PANE_NO_PROVIDER,
  registerObjectPaneHost,
  registerObjectPaneProvider,
  resetObjectPane,
  type ObjectPaneOpenRequest,
} from "@api/objectPane";
import { DEFAULT_PIVOT_THEME } from "../../rendering/pivot";
import type { PivotViewResponse } from "../pivot-api";

const BOX_REGION = {
  id: "pivot-visual-cp1",
  type: PIVOT_VISUAL_REGION_TYPE,
  startRow: 0,
  startCol: 1024,
  endRow: 49,
  endCol: 1026,
  data: { pivotId: "cp1" },
};

let cleanups: Array<() => void> = [];
let area: HTMLDivElement;

function paintedBox(width = 300): void {
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
  setPivotVisualRecord({
    pivotId: "cp1",
    box: { x: 100, y: 80, width, height: 200 },
    bounds: { expandCollapseIcons: new Map(), filterButtons: new Map(), headerFilterButtons: new Map() },
    cancel: null,
    geometry: buildPivotVisualGeometry(view, true, { columnWidth: () => 100, rowHeight: () => 24 }),
    scroll: { left: 0, top: 120 },
    startRow: 0,
    startCol: 1024,
  });
}

function rightClick(x: number, y: number): MouseEvent {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y });
  area.dispatchEvent(e);
  return e;
}

function menuRows(depth = 0): HTMLElement[] {
  const menu = document.querySelector(`[data-pivot-box-menu="${depth}"]`);
  return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
}

beforeEach(() => {
  h.top = BOX_REGION;
  h.contexts = [];
  h.clicked = [];
  const run = (id: string) => (context: unknown) => {
    h.clicked.push({ id, context });
  };
  h.items = [
    { id: "core:cut", label: "Cut", group: "clipboard", onClick: run("core:cut") },
    { id: "pivot:refresh", label: "Refresh", group: "pivot", onClick: run("pivot:refresh") },
    {
      id: "pivot:sort",
      label: "Sort",
      group: "pivot",
      onClick: run("pivot:sort"),
      children: [{ id: "pivot:sort:asc", label: "Sort A to Z", group: "pivot", onClick: run("pivot:sort:asc") }],
    },
    { id: "core:insertRow", label: "Insert Row", group: "structure", onClick: run("core:insertRow") },
  ];
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  area.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 2000, bottom: 2000, width: 2000, height: 2000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(area);
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  resetPivotVisualRegionState();
  resetPivotVisualHits();
  resetObjectPosition();
  resetPivotCellSelection();
  vi.mocked(openTaskPane).mockClear();
  updateCachedRegions([
    { pivotId: "cp1", name: "Sales", startRow: 0, startCol: 1024, endRow: 49, endCol: 1026, isEmpty: false, isModel: false },
  ]);
  cleanups = installPivotVisual({ getTheme: () => DEFAULT_PIVOT_THEME }, () => () => undefined);
  paintedBox();
});

afterEach(() => {
  closePivotBoxMenu();
  cleanups.forEach((c) => c());
  cleanups = [];
  area.remove();
});

describe("a canvas pivot box's right-click menu", () => {
  it("opens the pivot menu -- pivot items only -- for the hidden-grid cell under the pointer, and claims the event", () => {
    // Box-local (150, 30): column 1; 6px into the body at scroll 120 -> view row 6.
    const e = rightClick(250, 110);

    expect(e.defaultPrevented, "the grid's own menu handler must stand down").toBe(true);
    expect(menuRows().map((r) => r.textContent)).toEqual(["Refresh", "Sort>", SIZE_AND_POSITION_LABEL, OBJECT_PANE_FORMAT_LABEL]);
    expect(h.contexts[0]).toMatchObject({
      clickedCell: { row: 6, col: 1025 },
      selection: { startRow: 6, startCol: 1025, endRow: 6, endCol: 1025, type: "cells" },
      isWithinSelection: true,
      sheetIndex: 2,
      sheetName: "Canvas1",
    });
  });

  it("an item runs with the box's context; a sub-menu opens on hover and its item runs too", async () => {
    rightClick(250, 110);
    menuRows()[0].click();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.clicked.map((c) => c.id)).toEqual(["pivot:refresh"]);
    expect(h.clicked[0].context).toMatchObject({ clickedCell: { row: 6, col: 1025 } });
    expect(document.querySelector("[data-pivot-box-menu]"), "a click closes the menu").toBeNull();

    rightClick(250, 110);
    menuRows()[1].dispatchEvent(new MouseEvent("mouseenter"));
    expect(menuRows(1).map((r) => r.textContent)).toEqual(["Sort A to Z"]);
    menuRows(1)[0].click();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.clicked.map((c) => c.id)).toEqual(["pivot:refresh", "pivot:sort:asc"]);
  });

  it("an object on top of the box keeps its own menu: nothing is claimed", () => {
    h.top = { id: "chart-1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0, data: {} };
    const e = rightClick(250, 110);
    expect(e.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-pivot-box-menu]")).toBeNull();
  });

  it("a point on no cell of the box targets the pivot's anchor cell", () => {
    // Three 100px columns in a 300px box: the box is made wider than the
    // pivot, and the point lies right of its last column.
    paintedBox(500);
    rightClick(550, 110);
    expect(h.contexts[0]).toMatchObject({ clickedCell: { row: 0, col: 1024 } });
    expect(menuRows().length, "the pivot menu still opens").toBeGreaterThan(0);
  });

  it("Size and Position... opens the dialog for the BOX's region (BUG-0258 phase 5b)", async () => {
    const box = { ...BOX_REGION, floating: { x: 100, y: 80, width: 300, height: 200 } };
    h.top = box;
    const opened: Array<{ id: string }> = [];
    cleanups.push(registerSizeAndPositionOpener((region) => opened.push(region)));
    rightClick(250, 110);
    const row = menuRows().find((r) => r.textContent === SIZE_AND_POSITION_LABEL);
    expect(row, "the box menu has no Size and Position row").toBeTruthy();
    expect(row!.getAttribute("aria-disabled")).toBe("false");
    expect(row!.dataset.itemId).toBe("pivot.box.sizeAndPosition");
    row!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(opened.map((r) => r.id)).toEqual([box.id]);
    expect(h.clicked, "no pivot item ran").toEqual([]);
    expect(document.querySelector("[data-pivot-box-menu]"), "a click closes the menu").toBeNull();
  });

  it("Format... opens the ONE object pane on the BOX's Format tab, as a command (review R2-15b)", async () => {
    resetObjectPane();
    const box = { ...BOX_REGION, floating: { x: 100, y: 80, width: 300, height: 200 } };
    h.top = box;
    const opened: ObjectPaneOpenRequest[] = [];
    cleanups.push(registerObjectPaneProvider({ types: [PIVOT_VISUAL_REGION_TYPE], tabs: () => [] }));
    cleanups.push(
      registerObjectPaneHost({
        open: (req) => {
          opened.push(req);
          return true;
        },
        close: () => undefined,
        state: () => ({ open: false, regionId: null, regionType: null, tabId: null }),
      }),
    );
    rightClick(250, 110);
    const row = menuRows().find((r) => r.textContent === OBJECT_PANE_FORMAT_LABEL);
    expect(row, "the box menu has no Format... row").toBeTruthy();
    expect(row!.dataset.itemId).toBe("pivot.box.format");
    expect(row!.getAttribute("aria-disabled")).toBe("false");
    row!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toEqual([{ region: box, tab: "format", reason: "command" }]);
    expect(h.clicked, "no pivot item ran").toEqual([]);
    resetObjectPane();
  });

  it("Format... with no pane provider for the box is there, greyed WITH the reason, and runs nothing", async () => {
    resetObjectPane();
    h.top = { ...BOX_REGION, floating: { x: 100, y: 80, width: 300, height: 200 } };
    rightClick(250, 110);
    const row = menuRows().find((r) => r.textContent === OBJECT_PANE_FORMAT_LABEL);
    expect(row!.getAttribute("aria-disabled")).toBe("true");
    expect(row!.title).toBe(OBJECT_PANE_NO_PROVIDER);
  });

  it("with no dialog installed the row is there, greyed, and runs nothing", async () => {
    h.top = { ...BOX_REGION, floating: { x: 100, y: 80, width: 300, height: 200 } };
    rightClick(250, 110);
    const row = menuRows().find((r) => r.textContent === SIZE_AND_POSITION_LABEL);
    expect(row!.getAttribute("aria-disabled")).toBe("true");
    row!.click();
    await Promise.resolve();
    expect(document.querySelector("[data-pivot-box-menu]"), "a greyed row does not close the menu").not.toBeNull();
  });

  it("SELECTS an unselected box first (no pane: keyboard semantics), as every other family does", () => {
    expect(isPivotVisualSelected("cp1")).toBe(false);
    rightClick(250, 110);
    expect(isPivotVisualSelected("cp1"), "the right-click left the box unselected").toBe(true);
    expect(openTaskPane).not.toHaveBeenCalled();
    expect(menuRows().length).toBeGreaterThan(0);
  });

  it("on a cell OUTSIDE the box's cell selection it re-anchors there; the menu's selection is that cell", () => {
    setPivotCellAnchor("cp1", 1, 0);
    rightClick(250, 110); // view row 6, column 1
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 6, anchorCol: 1, endRow: 6, endCol: 1 });
    expect(h.contexts[0]).toMatchObject({
      clickedCell: { row: 6, col: 1025 },
      selection: { startRow: 6, startCol: 1025, endRow: 6, endCol: 1025, type: "cells" },
    });
  });

  it("on a cell INSIDE the selection it keeps it; the menu's selection is the whole rectangle in the hidden grid", () => {
    setPivotCellAnchor("cp1", 5, 1);
    extendPivotCellSelection(8, 2);
    rightClick(250, 110); // view row 6, column 1: inside 5..8 x 1..2
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 5, anchorCol: 1, endRow: 8, endCol: 2 });
    expect(h.contexts[0]).toMatchObject({
      clickedCell: { row: 6, col: 1025 },
      selection: { startRow: 5, startCol: 1025, endRow: 8, endCol: 1026, type: "cells" },
      isWithinSelection: true,
    });
  });

  it("another box's cells do not count as inside: the right-click anchors in THIS box", () => {
    setPivotCellAnchor("cp2", 6, 1);
    extendPivotCellSelection(9, 2);
    rightClick(250, 110);
    expect(getPivotCellSelection()).toEqual({ pivotId: "cp1", anchorRow: 6, anchorCol: 1, endRow: 6, endCol: 1 });
  });

  it("a point on no cell leaves the cells alone (the menu targets the anchor cell)", () => {
    paintedBox(500);
    setPivotCellAnchor("cp1", 3, 1);
    rightClick(550, 110);
    expect(getPivotCellSelection()).toMatchObject({ anchorRow: 3, anchorCol: 1 });
  });

  it("pivotBoxMenuTargetAt itself is PURE: it selects nothing and anchors nothing", () => {
    setPivotCellAnchor("cp1", 1, 0);
    const target = pivotBoxMenuTargetAt(250, 110);
    expect(target?.viewCell).toEqual({ viewRow: 6, viewCol: 1 });
    expect(getPivotCellSelection()).toMatchObject({ anchorRow: 1, anchorCol: 0 });
    expect(isPivotVisualSelected("cp1")).toBe(false);
  });

  it("a disabled row says WHY: its reason is the row's tooltip and accessible description (WP-A S9)", () => {
    h.items = [
      {
        id: "pivot:ec:expand",
        label: "Expand",
        group: "pivot",
        disabled: true,
        disabledReason: "Already expanded.",
        onClick: () => {},
      },
      { id: "pivot:refresh", label: "Refresh", group: "pivot", onClick: () => {} },
    ];
    rightClick(250, 110);
    const [expand, refresh] = menuRows();
    expect(expand.getAttribute("aria-disabled")).toBe("true");
    expect(expand.title).toBe("Already expanded.");
    expect(expand.getAttribute("aria-description")).toBe("Already expanded.");
    // An enabled row carries no reason.
    expect(refresh.title).toBe("");
    expect(refresh.hasAttribute("aria-description")).toBe(false);
  });

  it("a row whose action fails tells the USER with a toast, never the console alone (BUG-0096)", async () => {
    vi.mocked(showToast).mockClear();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.items = [
      {
        id: "pivot:refresh",
        label: "Refresh",
        group: "pivot",
        onClick: () => Promise.reject(new Error("Not reachable")),
      },
    ];
    rightClick(250, 110);
    menuRows()[0].click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(showToast).toHaveBeenCalledWith("Refresh failed: Not reachable", { variant: "error" });
    error.mockRestore();
  });

  it("owns Escape while open (the canvas's Escape binding asks first), and Escape closes it", () => {
    expect(objectOwnsKey("Escape"), "no menu: Escape is the canvas's").toBe(false);
    rightClick(250, 110);
    expect(objectOwnsKey("Escape")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector("[data-pivot-box-menu]")).toBeNull();
    // The right-click anchored a cell (D-CELLS): the SELECTED CELLS keep
    // Escape (S6) -- it clears them first -- until they are gone.
    expect(getPivotCellSelection(), "fixture: the right-click on a cell anchored it").not.toBeNull();
    expect(objectOwnsKey("Escape"), "the cells the right-click selected own Escape").toBe(true);
    resetPivotCellSelection();
    expect(objectOwnsKey("Escape"), "menu closed, no cells: Escape is the canvas's").toBe(false);
  });
});
