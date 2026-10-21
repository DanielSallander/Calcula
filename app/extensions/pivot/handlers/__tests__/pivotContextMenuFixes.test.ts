//! FILENAME: app/extensions/Pivot/handlers/__tests__/pivotContextMenuFixes.test.ts
// PURPOSE: The pivot right-click menu fixes of WP-A S9, on the REAL helpers,
//          the REAL view store (with its cell-window cache) and the REAL
//          chrome actions; only the backend calls are doubled.
//          - BUG-0455: windowed views -- a header past the view's first window
//            resolves (sync helpers AND the click handlers);
//          - BUG-0454: items name an item by its KEY (`pivotCellItemKey`),
//            falling back to the value (a numeric header "2013"); captions
//            show its LABEL (P2 S7: identity from the key, display from the label);
//          - Expand / Collapse on a VALUE cell act on the governing row item's
//            group path, only when its state differs, else disabled + reason;
//            Entire Field acts on that item's field;
//          - BUG-0456: every async failure reaches the user as a toast;
//          - the value-cell helpers S10 builds on (isValueCell,
//            valueFieldIndexFor, valueFieldNameFor, isCanvasPivotContext).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GridMenuContext, GridContextMenuItem } from "@api";

const h = vi.hoisted(() => ({
  items: [] as GridContextMenuItem[],
  regions: [] as Array<Record<string, unknown>>,
  surface: "grid" as string,
  fetchedView: null as unknown,
}));

vi.mock("@api", () => ({
  gridExtensions: {
    registerContextMenuItems: (items: GridContextMenuItem[]) => {
      h.items = items;
    },
    unregisterContextMenuItem: vi.fn(),
  },
  showDialog: vi.fn(),
  showToast: vi.fn(),
  closeTaskPane: vi.fn(),
  openTaskPane: vi.fn(),
  markTaskPaneManuallyClosed: vi.fn(),
  clearTaskPaneManuallyClosed: vi.fn(),
  getTaskPaneManuallyClosed: () => [],
}));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn() }));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(), promptAsync: vi.fn() }));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ surface: h.surface }),
}));
vi.mock("../../manifest", () => ({
  PIVOT_GROUP_DIALOG_ID: "g",
  PIVOT_FIELD_SETTINGS_DIALOG_ID: "fs",
  PIVOT_OPTIONS_DIALOG_ID: "o",
  PIVOT_DRILL_BEHAVIOR_DIALOG_ID: "d",
  PIVOT_PANE_ID: "p",
}));
vi.mock("../selectionHandler", () => ({
  findPivotRegionAtCell: (row: number, col: number) =>
    h.regions.find(
      (r) =>
        row >= (r.startRow as number) &&
        row <= (r.endRow as number) &&
        col >= (r.startCol as number) &&
        col <= (r.endCol as number),
    ) ?? null,
}));
vi.mock("../../lib/pivot-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/pivot-api")>();
  return {
    ...actual,
    getPivotAtCell: vi.fn(),
    getPivotView: vi.fn(() => Promise.resolve(h.fetchedView)),
    togglePivotGroup: vi.fn(() => Promise.resolve({})),
    applyPivotFilter: vi.fn(() => Promise.resolve({})),
    getPivotFieldUniqueValues: vi.fn(() => Promise.resolve({ members: [] })),
    expandCollapseLevel: vi.fn(() => Promise.resolve({})),
    expandCollapseAll: vi.fn(() => Promise.resolve({})),
    sortPivotField: vi.fn(() => Promise.resolve({})),
    deletePivotTable: vi.fn(() => Promise.resolve()),
    refreshPivotCache: vi.fn(() => Promise.resolve({})),
    updatePivotFields: vi.fn(() => Promise.resolve({})),
    updatePivotProperties: vi.fn(() => Promise.resolve({})),
    getPivotFieldInfo: vi.fn(),
    ungroupPivotField: vi.fn(),
    removePivotHierarchy: vi.fn(),
  };
});

import { showToast } from "@api";
import {
  getPivotAtCell,
  togglePivotGroup,
  applyPivotFilter,
  getPivotFieldUniqueValues,
  expandCollapseLevel,
  deletePivotTable,
  type PivotCellData,
  type PivotRowData,
  type PivotViewResponse,
} from "../../lib/pivot-api";
import { cachePivotView, deleteCachedPivotView, getCellWindowCache } from "../../lib/pivotViewStore";
import { registerPivotContextMenuItems } from "../pivotContextMenu";
import {
  getCachedCellData,
  getItemLabelForCell,
  isDimensionHeader,
  isValueCell,
  isCanvasPivotContext,
  valueFieldIndexFor,
  valueFieldNameFor,
  expandTargetFor,
  expandDisabledReason,
} from "../pivotContextMenuHelpers";
import { governingRowHeader, setPivotItemExpandedAt } from "../../lib/pivotChromeActions";

// ----------------------------------------------------------------------------
// Fixtures: a compact pivot anchored at (10, 2) -- one row-label column, two
// value columns.
// ----------------------------------------------------------------------------

const ANCHOR = { row: 10, col: 2 };

function header(label: string, extra: Partial<PivotCellData> = {}): PivotCellData {
  return { cellType: "RowHeader", value: label, formattedValue: label, backgroundStyle: "Normal", ...extra } as PivotCellData;
}

function data(value: number, extra: Partial<PivotCellData> = {}): PivotCellData {
  return { cellType: "Data", value, formattedValue: String(value), backgroundStyle: "Normal", ...extra } as PivotCellData;
}

function row(viewRow: number, cells: PivotCellData[], rowType: PivotRowData["rowType"] = "Data"): PivotRowData {
  return { viewRow, rowType, depth: 0, visible: true, cells };
}

const COLUMN_HEADER_ROW = (viewRow = 0) =>
  row(
    viewRow,
    [
      { cellType: "Corner", value: "Row Labels", formattedValue: "Row Labels", backgroundStyle: "Normal" } as PivotCellData,
      { cellType: "ColumnHeader", value: "Sum of Sales", formattedValue: "Sum of Sales", backgroundStyle: "Normal" } as PivotCellData,
      { cellType: "GrandTotalColumn", value: "Grand Total", formattedValue: "Grand Total", backgroundStyle: "Normal" } as PivotCellData,
    ],
    "ColumnHeader",
  );

function view(rows: PivotRowData[], extra: Partial<PivotViewResponse> = {}): PivotViewResponse {
  return {
    pivotId: "p1",
    version: 1,
    rowCount: rows.length,
    colCount: 3,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows,
    columns: [],
    valueFieldNames: ["Sum of Sales", "Count of Sales"],
    ...extra,
  } as unknown as PivotViewResponse;
}

/** The small fixture: East (expanded, with child Pens), West (collapsed), a 2013 header, Grand Total. */
function smallView(extra: Partial<PivotViewResponse> = {}): PivotViewResponse {
  return view(
    [
      COLUMN_HEADER_ROW(0),
      row(1, [
        header("East", { isExpandable: true, isCollapsed: false, groupPath: [[3, 5]] }),
        data(100, { valueFieldIndex: 0 }),
        data(7, { valueFieldIndex: 1 }),
      ]),
      row(2, [
        header("Pens", { indentLevel: 1, groupPath: [[3, 5], [4, 7]] }),
        data(40, { valueFieldIndex: 0 }),
        data(3, { valueFieldIndex: 1 }),
      ]),
      row(3, [
        header("West", { isExpandable: true, isCollapsed: true, groupPath: [[3, 6]] }),
        data(60, { valueFieldIndex: 0 }),
        data(4),
      ]),
      row(4, [
        // A numeric header the backend did not format: formattedValue is empty.
        header("", { value: 2013, formattedValue: "", groupPath: [[3, 9]] }),
        data(5, { valueFieldIndex: 0 }),
        data(1, { valueFieldIndex: 1 }),
      ]),
      row(
        5,
        [
          { cellType: "GrandTotalRow", value: "Grand Total", formattedValue: "Grand Total", backgroundStyle: "Normal" } as PivotCellData,
          { cellType: "GrandTotalRow", value: 165, formattedValue: "165", backgroundStyle: "Normal", valueFieldIndex: 0 } as PivotCellData,
          { cellType: "GrandTotalRow", value: 14, formattedValue: "14", backgroundStyle: "Normal", valueFieldIndex: 1 } as PivotCellData,
        ],
        "GrandTotal",
      ),
    ],
    extra,
  );
}

function setRegion(rowCount: number): void {
  h.regions = [
    {
      pivotId: "p1",
      startRow: ANCHOR.row,
      startCol: ANCHOR.col,
      endRow: ANCHOR.row + rowCount - 1,
      endCol: ANCHOR.col + 2,
      isEmpty: false,
      isModel: false,
    },
  ];
}

function install(v: PivotViewResponse, rowCount = v.rows.length): void {
  cachePivotView("p1", v);
  h.fetchedView = v;
  setRegion(rowCount);
  vi.mocked(getPivotAtCell).mockResolvedValue({ pivotId: "p1" } as never);
}

function ctxAt(viewRow: number, viewCol: number): GridMenuContext {
  const r = ANCHOR.row + viewRow;
  const c = ANCHOR.col + viewCol;
  return {
    selection: { startRow: r, startCol: c, endRow: r, endCol: c, type: "cells" },
    clickedCell: { row: r, col: c },
    isWithinSelection: true,
    sheetIndex: 0,
    sheetName: "Sheet1",
    dimensions: {} as GridMenuContext["dimensions"],
  } as GridMenuContext;
}

function findItem(id: string, list: GridContextMenuItem[] = h.items): GridContextMenuItem {
  for (const item of list) {
    if (item.id === id) return item;
    if (item.children) {
      const found = item.children.find((c) => c.id === id);
      if (found) return found;
    }
  }
  throw new Error(`no item ${id}`);
}

function resolveDisabled(item: GridContextMenuItem, ctx: GridMenuContext): boolean {
  return typeof item.disabled === "function" ? item.disabled(ctx) : !!item.disabled;
}

function resolveReason(item: GridContextMenuItem, ctx: GridMenuContext): string | null | undefined {
  return typeof item.disabledReason === "function" ? item.disabledReason(ctx) : item.disabledReason;
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteCachedPivotView("p1");
  h.items = [];
  h.regions = [];
  h.surface = "grid";
  h.fetchedView = null;
  registerPivotContextMenuItems();
});

// ----------------------------------------------------------------------------

describe("windowed views (BUG-0455)", () => {
  /** A 600-row windowed view: the response carries rows 0..199, the cache window 300..499 is loaded. */
  function installWindowed(): void {
    const first = [COLUMN_HEADER_ROW(0)];
    for (let i = 1; i < 200; i++) first.push(row(i, [header(`Item ${i}`, { groupPath: [[3, i]] }), data(i), data(1)]));
    const v = view(first, { isWindowed: true, totalRowCount: 600, windowStartRow: 0 } as Partial<PivotViewResponse>);
    install(v, 600);
    const later: PivotRowData[] = [];
    for (let i = 300; i < 500; i++) later.push(row(i, [header(`Item ${i}`, { groupPath: [[3, i]] }), data(i), data(1)]));
    getCellWindowCache("p1")!.setWindow(300, later);
  }

  it("a header at view row 350 (past the first window) resolves in the sync helpers", () => {
    installWindowed();
    const ctx = ctxAt(350, 0);
    expect(getCachedCellData(ctx)?.cell.formattedValue).toBe("Item 350");
    expect(isDimensionHeader(ctx)).toBe(true);
    expect(getItemLabelForCell(ctx)).toBe("Item 350");
    // A row whose window is not loaded is unknown, not a wrong cell.
    expect(getCachedCellData(ctxAt(250, 0))).toBeNull();
    // Out of the view's row COUNT, not of `rows.length`.
    expect(getCachedCellData(ctxAt(600, 0))).toBeNull();
  });

  it("Keep Only at view row 350 sends that item (the click handler reads the window too)", async () => {
    installWindowed();
    await findItem("pivot:filter:keepOnly").onClick(ctxAt(350, 0));
    expect(applyPivotFilter).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 3,
      filters: { manualFilter: { selectedItems: ["Item 350"] } },
    });
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("item labels fall back to the value (BUG-0454)", () => {
  it("Keep Only on a numeric header with an empty formattedValue sends \"2013\"", async () => {
    install(smallView());
    await findItem("pivot:filter:keepOnly").onClick(ctxAt(4, 0));
    expect(applyPivotFilter).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 3,
      filters: { manualFilter: { selectedItems: ["2013"] } },
    });
  });

  it("the Move label names the numeric header too", () => {
    install(smallView());
    const move = findItem("pivot:move");
    expect(typeof move.label === "function" ? move.label(ctxAt(4, 0)) : move.label).toBe('Move "2013"');
  });
});

describe("identity from the KEY, display from the LABEL (P2 S7)", () => {
  /** The small fixture with row 4 a de-DE date header: key ISO, label localised. */
  function dateView(): PivotViewResponse {
    const v = smallView();
    v.rows[4].cells[0] = header("2024-01-15", {
      formattedValue: "",
      groupPath: [[3, 9]],
      member: { key: "2024-01-15", label: "15.01.2024" },
    });
    return v;
  }

  it("Keep Only sends the member KEY, never the label the cell shows", async () => {
    install(dateView());
    await findItem("pivot:filter:keepOnly").onClick(ctxAt(4, 0));
    expect(applyPivotFilter).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 3,
      filters: { manualFilter: { selectedItems: ["2024-01-15"] } },
    });
  });

  it("Hide sends every OTHER member's key (the field's members, by key)", async () => {
    install(dateView());
    vi.mocked(getPivotFieldUniqueValues).mockResolvedValueOnce({
      fieldIndex: 3,
      fieldName: "Date",
      members: [
        { key: "2024-01-15", label: "15.01.2024" },
        { key: "2024-02-01", label: "01.02.2024" },
        { key: "", label: "(Blank)" },
      ],
    });
    await findItem("pivot:filter:hide").onClick(ctxAt(4, 0));
    expect(applyPivotFilter).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 3,
      filters: { manualFilter: { selectedItems: ["2024-02-01", ""] } },
    });
  });

  it("a caption NAMES the item by its label", () => {
    install(dateView());
    const move = findItem("pivot:move");
    expect(typeof move.label === "function" ? move.label(ctxAt(4, 0)) : move.label).toBe('Move "15.01.2024"');
    expect(getItemLabelForCell(ctxAt(4, 0))).toBe("15.01.2024");
  });
});

describe("Expand / Collapse on a value cell act on the governing row item", () => {
  it("the governing header of a value row is its right-most item-naming RowHeader", () => {
    install(smallView());
    expect(governingRowHeader("p1", 1)?.cell.formattedValue).toBe("East");
    expect(governingRowHeader("p1", 5), "a grand-total row has no governing item").toBeNull();
    expect(governingRowHeader("p1", 0), "a column-header row has none").toBeNull();
  });

  it("Collapse on East's value collapses East by its group path; Expand is disabled 'Already expanded.'", async () => {
    install(smallView());
    const ctx = ctxAt(1, 1);
    expect(expandTargetFor(ctx)?.header.formattedValue).toBe("East");

    const expand = findItem("pivot:ec:expand");
    const collapse = findItem("pivot:ec:collapse");
    expect(resolveDisabled(expand, ctx)).toBe(true);
    expect(resolveReason(expand, ctx)).toBe("Already expanded.");
    expect(resolveDisabled(collapse, ctx)).toBe(false);
    expect(resolveReason(collapse, ctx)).toBeNull();

    await collapse.onClick(ctx);
    expect(togglePivotGroup).toHaveBeenCalledTimes(1);
    expect(togglePivotGroup).toHaveBeenCalledWith({
      pivotId: "p1",
      isRow: true,
      fieldIndex: 0,
      value: "East",
      groupPath: [[3, 5]],
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it("Expand on a collapsed item's value cell expands it; Collapse is disabled 'Already collapsed.'", async () => {
    install(smallView());
    const ctx = ctxAt(3, 2);
    expect(resolveReason(findItem("pivot:ec:collapse"), ctx)).toBe("Already collapsed.");
    await findItem("pivot:ec:expand").onClick(ctx);
    expect(togglePivotGroup).toHaveBeenCalledWith(expect.objectContaining({ value: "West", groupPath: [[3, 6]] }));
  });

  it("a value cell under a non-expandable item: both disabled with a reason, and a click sends nothing", async () => {
    install(smallView());
    const ctx = ctxAt(2, 1);
    expect(resolveDisabled(findItem("pivot:ec:expand"), ctx)).toBe(true);
    expect(resolveReason(findItem("pivot:ec:expand"), ctx)).toBe('"Pens" has nothing to expand.');
    expect(resolveReason(findItem("pivot:ec:collapse"), ctx)).toBe('"Pens" has nothing to collapse.');
    // A click that raced past the disabled state is told why, never silent.
    await findItem("pivot:ec:expand").onClick(ctx);
    expect(togglePivotGroup).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('"Pens" has nothing to expand.', { variant: "info" });
  });

  it("where nothing governs (a grand-total row, the corner) the leaves are disabled 'Nothing to ... here.'", () => {
    install(smallView());
    expect(resolveReason(findItem("pivot:ec:expand"), ctxAt(5, 1))).toBe("Nothing to expand here.");
    expect(resolveReason(findItem("pivot:ec:collapse"), ctxAt(0, 0))).toBe("Nothing to collapse here.");
    expect(resolveReason(findItem("pivot:ec:expandField"), ctxAt(5, 1))).toBe("No field to expand here.");
  });

  it("on a HEADER the leaves act on that header (column headers keep isRow false)", async () => {
    install(smallView());
    await findItem("pivot:ec:collapse").onClick(ctxAt(1, 0));
    expect(togglePivotGroup).toHaveBeenCalledWith(expect.objectContaining({ isRow: true, value: "East" }));
  });

  it("Entire Field on a value cell acts on the governing item's field (its source index)", async () => {
    install(smallView());
    const ctx = ctxAt(1, 2);
    expect(resolveDisabled(findItem("pivot:ec:collapseField"), ctx)).toBe(false);
    await findItem("pivot:ec:collapseField").onClick(ctx);
    expect(expandCollapseLevel).toHaveBeenCalledWith({ pivotId: "p1", isRow: true, fieldIndex: 3, expand: false });
  });

  it("setPivotItemExpandedAt: a tabular header (no indent) toggles at its group-path depth; same state sends nothing", async () => {
    const tabular = header("Pens", { indentLevel: 0, isExpandable: true, isCollapsed: false, groupPath: [[3, 5], [4, 7]] });
    expect(await setPivotItemExpandedAt("p1", tabular, true, true)).toBe(false);
    expect(togglePivotGroup).not.toHaveBeenCalled();
    expect(await setPivotItemExpandedAt("p1", tabular, true, false)).toBe(true);
    expect(togglePivotGroup).toHaveBeenCalledWith({
      pivotId: "p1",
      isRow: true,
      fieldIndex: 1,
      value: "Pens",
      groupPath: [[3, 5], [4, 7]],
    });
  });
});

describe("failures reach the user (BUG-0456)", () => {
  it("a rejected toggle toasts '<label> failed: <message>'", async () => {
    install(smallView());
    vi.mocked(togglePivotGroup).mockRejectedValueOnce(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await findItem("pivot:ec:collapse").onClick(ctxAt(1, 1));
    expect(showToast).toHaveBeenCalledWith("Collapse failed: boom", { variant: "error" });
    error.mockRestore();
  });

  it("a rejected Delete PivotTable toasts (it used to have no catch at all)", async () => {
    install(smallView());
    vi.mocked(deletePivotTable).mockRejectedValueOnce("locked");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await findItem("pivot:delete").onClick(ctxAt(1, 1));
    expect(showToast).toHaveBeenCalledWith("Delete PivotTable failed: locked", { variant: "error" });
    error.mockRestore();
  });

  it("a header item whose cell can no longer be read says so instead of returning silently", async () => {
    install(smallView());
    vi.mocked(getPivotAtCell).mockResolvedValueOnce(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await findItem("pivot:sort:aToZ").onClick(ctxAt(1, 0));
    expect(showToast).toHaveBeenCalledWith(
      "Sort A to Z failed: the PivotTable cell under the pointer could not be read",
      { variant: "error" },
    );
    error.mockRestore();
  });

  it("every async item's failure is caught: no item rejects into the menu host", async () => {
    install(smallView());
    vi.mocked(getPivotAtCell).mockRejectedValue(new Error("down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const leaves = h.items.flatMap((i) => (i.children ? i.children : [i]));
    for (const item of leaves) {
      if (resolveDisabled(item, ctxAt(1, 0))) continue;
      if (item.id === "pivot:hideFieldList" || item.id === "pivot:editScript") continue;
      await expect(Promise.resolve(item.onClick(ctxAt(1, 0))), item.id).resolves.toBeUndefined();
    }
    error.mockRestore();
    vi.mocked(getPivotAtCell).mockReset();
  });
});

describe("value-cell helpers", () => {
  it("isValueCell: data and value-area totals, never labels or the total caption", () => {
    install(smallView());
    expect(isValueCell(ctxAt(1, 1))).toBe(true);
    expect(isValueCell(ctxAt(5, 1)), "grand total value").toBe(true);
    expect(isValueCell(ctxAt(5, 0)), "the Grand Total LABEL").toBe(false);
    expect(isValueCell(ctxAt(0, 2)), "the Grand Total column caption").toBe(false);
    expect(isValueCell(ctxAt(1, 0)), "a header").toBe(false);
  });

  it("valueFieldIndexFor / valueFieldNameFor read the cell's index; one value field answers 0", () => {
    install(smallView());
    expect(valueFieldIndexFor(ctxAt(1, 2))).toBe(1);
    expect(valueFieldNameFor(ctxAt(1, 2))).toBe("Count of Sales");
    expect(valueFieldIndexFor(ctxAt(3, 2)), "two fields and no index: unknown").toBeNull();
    expect(valueFieldIndexFor(ctxAt(1, 0)), "not a value cell").toBeNull();

    install(smallView({ valueFieldNames: ["[Revenue]"] }));
    expect(valueFieldIndexFor(ctxAt(3, 2))).toBe(0);
    expect(valueFieldNameFor(ctxAt(3, 2)), "a model measure's brackets are stripped").toBe("Revenue");
  });

  it("isCanvasPivotContext: only on a canvas, only inside a pivot", () => {
    install(smallView());
    expect(isCanvasPivotContext(ctxAt(1, 1))).toBe(false);
    h.surface = "canvas";
    expect(isCanvasPivotContext(ctxAt(1, 1))).toBe(true);
    expect(isCanvasPivotContext(ctxAt(40, 1)), "outside the pivot").toBe(false);
  });

  it("expandDisabledReason is null exactly when the leaf can act", () => {
    install(smallView());
    expect(expandDisabledReason(ctxAt(3, 1), true)).toBeNull();
    expect(expandDisabledReason(ctxAt(1, 1), false)).toBeNull();
  });
});
