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
//            the BOX's region, and is greyed when nothing can open one.

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
import { resetSelectionHandlerState } from "../../handlers/selectionHandler";
import { closePivotBoxMenu } from "../pivotVisualContextMenu";
import { buildPivotVisualGeometry } from "../../rendering/pivotVisualRenderer";
import { registerSizeAndPositionOpener, resetObjectPosition, SIZE_AND_POSITION_LABEL } from "@api/objectPosition";
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
    expect(menuRows().map((r) => r.textContent)).toEqual(["Refresh", "Sort>", SIZE_AND_POSITION_LABEL]);
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

  it("with no dialog installed the row is there, greyed, and runs nothing", async () => {
    h.top = { ...BOX_REGION, floating: { x: 100, y: 80, width: 300, height: 200 } };
    rightClick(250, 110);
    const row = menuRows().find((r) => r.textContent === SIZE_AND_POSITION_LABEL);
    expect(row!.getAttribute("aria-disabled")).toBe("true");
    row!.click();
    await Promise.resolve();
    expect(document.querySelector("[data-pivot-box-menu]"), "a greyed row does not close the menu").not.toBeNull();
  });

  it("owns Escape while open (the canvas's Escape binding asks first), and Escape closes it", () => {
    expect(objectOwnsKey("Escape"), "no menu: Escape is the canvas's").toBe(false);
    rightClick(250, 110);
    expect(objectOwnsKey("Escape")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector("[data-pivot-box-menu]")).toBeNull();
    expect(objectOwnsKey("Escape")).toBe(false);
  });
});
