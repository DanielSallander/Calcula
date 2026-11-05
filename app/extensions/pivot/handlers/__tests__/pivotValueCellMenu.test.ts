//! FILENAME: app/extensions/Pivot/handlers/__tests__/pivotValueCellMenu.test.ts
// PURPOSE: The value-cell items of the pivot right-click menu (WP-A S10, owner
//          finding F4: "right-click on VALUE cells gets the full menu"), on the
//          REAL helpers and view store; the actions they call are doubled.
//          - visibility per cell type (value cell vs header), surface (Copy is
//            the canvas box's own) and pivot kind (Summarize Values By only on
//            a pivot KNOWN to be a range pivot);
//          - the model-pivot rule: Number Format / Show Values As / Value
//            Field Settings are DISABLED with a reason on a data-model pivot --
//            and on a pivot whose kind is not known (never guessed);
//          - a cell whose value field cannot be named greys every value item
//            with a reason; Sort by value sorts the clicked row's field by the
//            cell's value field along its column (BUG-0459), greyed on the
//            Grand Total row;
//          - each item calls the one action it names, with the cell's value
//            field; a failure toasts "<Label> failed: <reason>";
//          - the drill-through doors (model-drillthrough.md 2.9): the run row
//            reads "Drill through" when the pivot's cached REGION says its
//            behaviour has a design query, else "Show Details" -- also when it
//            is not known (the real region-first answer is pinned in
//            hasDesignQueryDrill.test.ts); the authoring row reads "View
//            drill-through behavior..." on a subscribed worksheet / a
//            non-editable canvas page and opens the dialog read-only.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GridMenuContext, GridContextMenuItem } from "@api";

const h = vi.hoisted(() => ({
  items: [] as GridContextMenuItem[],
  regions: [] as Array<Record<string, unknown>>,
  surface: "grid" as string,
  commands: new Set<string>(),
  /** pivotId -> the region's "has a design-query drill" answer (undefined = not known). */
  drill: new Map<string, boolean | undefined>(),
  /** sheet index -> sheet id (the report-pages snapshot). */
  sheetIds: {} as Record<number, string>,
  /** The subscribed sheet ids (@api/collaboration). */
  subscribed: new Set<string>(),
  /** The canvas layout surface's `editable`; null = no surface. */
  surfaceEditable: null as boolean | null,
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
  getReportPagesSnapshot: () => ({}),
  sheetIdAt: (_snapshot: unknown, index: number) => h.sheetIds[index] ?? null,
  isSheetSubscribed: (sheetId: string) => h.subscribed.has(sheetId),
}));
vi.mock("@api/layoutSurface", () => ({
  getLayoutSurface: () => (h.surfaceEditable === null ? null : { editable: h.surfaceEditable }),
}));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn() }));
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(), promptAsync: vi.fn() }));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => ({ surface: h.surface }) }));
vi.mock("@api/commands", () => ({
  CommandRegistry: {
    has: (id: string) => h.commands.has(id),
    execute: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("../../manifest", () => ({
  PIVOT_GROUP_DIALOG_ID: "g",
  PIVOT_FIELD_SETTINGS_DIALOG_ID: "fs",
  PIVOT_OPTIONS_DIALOG_ID: "o",
  PIVOT_DRILL_BEHAVIOR_DIALOG_ID: "d",
  PIVOT_PANE_ID: "p",
}));
vi.mock("../selectionHandler", () => {
  const find = (row: number, col: number) =>
    h.regions.find(
      (r) =>
        row >= (r.startRow as number) &&
        row <= (r.endRow as number) &&
        col >= (r.startCol as number) &&
        col <= (r.endCol as number),
    ) ?? null;
  return {
    findPivotRegionAtCell: find,
    isModelPivot: (pivotId: string) =>
      h.regions.find((r) => r.pivotId === pivotId)?.isModel as boolean | undefined,
    hasDesignQueryDrill: (pivotId: string) => h.drill.get(pivotId),
  };
});
vi.mock("../../lib/pivotCellDoubleClick", () => ({ runPivotDrillThrough: vi.fn() }));
vi.mock("../../lib/valueFieldEdits", () => ({ editPivotValueField: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/valueFieldDialogRequest", () => ({ requestValueFieldDialog: vi.fn(() => Promise.resolve()) }));
vi.mock("../../lib/pivot-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/pivot-api")>();
  return { ...actual, sortPivotField: vi.fn(() => Promise.resolve({})) };
});

import { showDialog, showToast } from "@api";
import { CommandRegistry } from "@api/commands";
import type { PivotCellData, PivotRowData, PivotViewResponse } from "../../lib/pivot-api";
import { sortPivotField } from "../../lib/pivot-api";
import { cachePivotView, deleteCachedPivotView } from "../../lib/pivotViewStore";
import {
  registerPivotContextMenuItems,
  MODEL_PIVOT_REASON,
  VALUE_FIELD_UNKNOWN_REASON,
  SORT_GRAND_TOTAL_ROW_REASON,
  COPY_UNAVAILABLE_REASON,
} from "../pivotContextMenu";
import { runPivotDrillThrough } from "../../lib/pivotCellDoubleClick";
import { editPivotValueField } from "../../lib/valueFieldEdits";
import { requestValueFieldDialog } from "../../lib/valueFieldDialogRequest";
import { PIVOT_CANVAS_COPY_CELLS_COMMAND } from "../../lib/pivotCanvasCellCommands";
import { SHOW_VALUES_AS_OPTIONS } from "../../lib/showValuesAsOptions";

// ----------------------------------------------------------------------------
// Fixture: a compact pivot anchored at (10, 2): row labels, Sum of Sales, Count of Sales.
// ----------------------------------------------------------------------------

const ANCHOR = { row: 10, col: 2 };

const cell = (cellType: string, value: unknown, extra: Partial<PivotCellData> = {}): PivotCellData =>
  ({ cellType, value, formattedValue: String(value), backgroundStyle: "Normal", ...extra }) as PivotCellData;
const row = (viewRow: number, cells: PivotCellData[], rowType: PivotRowData["rowType"] = "Data"): PivotRowData =>
  ({ viewRow, rowType, depth: 0, visible: true, cells }) as PivotRowData;

function view(): PivotViewResponse {
  return {
    pivotId: "p1",
    version: 1,
    rowCount: 4,
    colCount: 3,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    columns: [],
    valueFieldNames: ["Sum of Sales", "Count of Sales"],
    rows: [
      row(0, [cell("Corner", "Row Labels"), cell("ColumnHeader", "Sum of Sales"), cell("ColumnHeader", "Count of Sales")], "ColumnHeader"),
      row(1, [
        cell("RowHeader", "East", { groupPath: [[3, 5]] }),
        // Its path: the row's item, then the column's (a Year item).
        cell("Data", 100, { valueFieldIndex: 0, groupPath: [[3, 5], [7, 2]] }),
        cell("Data", 7, { valueFieldIndex: 1 }),
      ]),
      // A value cell that names no value field (two fields, no index).
      row(2, [cell("RowHeader", "West", { groupPath: [[3, 6]] }), cell("Data", 60, { valueFieldIndex: 0 }), cell("Data", 4)]),
      // The Grand Total row: its label names no item.
      row(3, [cell("GrandTotal", "Grand Total"), cell("GrandTotal", 160, { valueFieldIndex: 0 }), cell("GrandTotal", 11, { valueFieldIndex: 1 })], "GrandTotal"),
    ],
  } as unknown as PivotViewResponse;
}

function install(isModel: boolean | undefined): void {
  cachePivotView("p1", view());
  h.regions = [
    {
      pivotId: "p1",
      name: "PivotTable1",
      startRow: ANCHOR.row,
      startCol: ANCHOR.col,
      endRow: ANCHOR.row + 3,
      endCol: ANCHOR.col + 2,
      isEmpty: false,
      ...(isModel === undefined ? {} : { isModel }),
    },
  ];
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

function findItem(id: string): GridContextMenuItem {
  for (const item of h.items) {
    if (item.id === id) return item;
    const child = item.children?.find((c) => c.id === id);
    if (child) return child;
  }
  throw new Error(`no item ${id}`);
}
const visible = (item: GridContextMenuItem, ctx: GridMenuContext) =>
  item.visible === undefined ? true : typeof item.visible === "function" ? item.visible(ctx) : item.visible;
const disabled = (item: GridContextMenuItem, ctx: GridMenuContext) =>
  typeof item.disabled === "function" ? item.disabled(ctx) : !!item.disabled;
const reason = (item: GridContextMenuItem, ctx: GridMenuContext) =>
  typeof item.disabledReason === "function" ? item.disabledReason(ctx) : item.disabledReason;
const label = (item: GridContextMenuItem, ctx: GridMenuContext) =>
  typeof item.label === "function" ? item.label(ctx) : item.label;

const VALUE_ITEMS = [
  "pivot:numberFormat",
  "pivot:sortByValue",
  "pivot:removeValueField",
  "pivot:showValuesAs",
  "pivot:showDetails",
  "pivot:valueFieldSettings",
];
const MODEL_GATED = ["pivot:numberFormat", "pivot:showValuesAs", "pivot:valueFieldSettings"];

beforeEach(() => {
  vi.clearAllMocks();
  deleteCachedPivotView("p1");
  h.items = [];
  h.regions = [];
  h.surface = "grid";
  h.commands = new Set();
  h.drill = new Map();
  h.sheetIds = {};
  h.subscribed = new Set();
  h.surfaceEditable = null;
  registerPivotContextMenuItems();
});

describe("visibility", () => {
  it("the value items show on a value cell, lead the pivot group, and never on a header", () => {
    install(false);
    for (const id of [...VALUE_ITEMS, "pivot:summarizeBy"]) {
      expect(visible(findItem(id), ctxAt(1, 2)), id).toBe(true);
      expect(visible(findItem(id), ctxAt(1, 0)), `${id} on a header`).toBe(false);
      expect(findItem(id).order, `${id} leads (order < 20)`).toBeLessThan(20);
    }
  });

  it("Copy is the canvas box's own: shown on a canvas pivot (any cell), never on the worksheet", () => {
    install(false);
    expect(visible(findItem("pivot:copy"), ctxAt(1, 2))).toBe(false);
    h.surface = "canvas";
    expect(visible(findItem("pivot:copy"), ctxAt(1, 2))).toBe(true);
    expect(visible(findItem("pivot:copy"), ctxAt(1, 0))).toBe(true);
    expect(findItem("pivot:copy").shortcut).toBe("Ctrl+C");
  });

  it("range pivot: Summarize Values By shows and every value item is enabled", () => {
    install(false);
    const ctx = ctxAt(1, 2);
    expect(visible(findItem("pivot:summarizeBy"), ctx)).toBe(true);
    for (const id of [...VALUE_ITEMS, "pivot:summarizeBy"]) {
      expect(disabled(findItem(id), ctx), id).toBe(false);
    }
    expect(label(findItem("pivot:removeValueField"), ctx)).toBe('Remove "Count of Sales"');
  });

  it("model pivot: Summarize absent; Number Format / Show Values As / Value Field Settings greyed with the model reason", () => {
    install(true);
    const ctx = ctxAt(1, 1);
    expect(visible(findItem("pivot:summarizeBy"), ctx)).toBe(false);
    for (const id of MODEL_GATED) {
      expect(visible(findItem(id), ctx), id).toBe(true);
      expect(disabled(findItem(id), ctx), id).toBe(true);
      expect(reason(findItem(id), ctx), id).toBe(MODEL_PIVOT_REASON);
    }
    // Remove and Show Details act as on a range pivot.
    expect(disabled(findItem("pivot:removeValueField"), ctx)).toBe(false);
    expect(disabled(findItem("pivot:showDetails"), ctx)).toBe(false);
    // The Show Values As choices are greyed too (a sub-menu never acts).
    expect(disabled(findItem("pivot:showValuesAs:percent_of_total"), ctx)).toBe(true);
  });

  it("a pivot whose kind is not known yet is treated as a model pivot (never guessed)", () => {
    install(undefined);
    const ctx = ctxAt(1, 1);
    expect(visible(findItem("pivot:summarizeBy"), ctx)).toBe(false);
    for (const id of MODEL_GATED) expect(reason(findItem(id), ctx), id).toBe(MODEL_PIVOT_REASON);
  });

  it("a value cell that names no value field greys every value item with a reason", () => {
    install(false);
    const ctx = ctxAt(2, 2);
    for (const id of [
      "pivot:numberFormat",
      "pivot:removeValueField",
      "pivot:summarizeBy",
      "pivot:showValuesAs",
      "pivot:showDetails",
      "pivot:valueFieldSettings",
    ]) {
      expect(disabled(findItem(id), ctx), id).toBe(true);
      expect(reason(findItem(id), ctx), id).toBe(VALUE_FIELD_UNKNOWN_REASON);
    }
    expect(label(findItem("pivot:removeValueField"), ctx)).toBe("Remove Value Field");
  });

  it("Sort by value is enabled on a value cell and greyed on the Grand Total row (BUG-0459)", () => {
    install(false);
    const ctx = ctxAt(1, 1);
    const sort = findItem("pivot:sortByValue");
    expect(label(sort, ctx)).toBe("Sort");
    expect(disabled(sort, ctx)).toBe(false);
    expect(sort.children?.map((c) => [c.label, disabled(c, ctx)])).toEqual([
      ["Sort Smallest to Largest", false],
      ["Sort Largest to Smallest", false],
    ]);
    // A model pivot sorts by value too.
    install(true);
    expect(disabled(sort, ctxAt(1, 1))).toBe(false);
    const total = ctxAt(3, 1);
    expect(disabled(sort, total)).toBe(true);
    expect(reason(sort, total)).toBe(SORT_GRAND_TOTAL_ROW_REASON);
    for (const child of sort.children ?? []) expect(reason(child, total)).toBe(SORT_GRAND_TOTAL_ROW_REASON);
  });

  it("the Show Values As choices are the dialog's list; a based one says it opens a dialog", () => {
    install(false);
    const children = findItem("pivot:showValuesAs").children ?? [];
    expect(children.map((c) => c.id)).toEqual(SHOW_VALUES_AS_OPTIONS.map((o) => `pivot:showValuesAs:${o.value}`));
    expect(findItem("pivot:showValuesAs:percent_of_total").label).toBe("% of Grand Total");
    expect(findItem("pivot:showValuesAs:running_total").label).toBe("Running Total In...");
    expect(findItem("pivot:summarizeBy").children?.map((c) => c.label)).toEqual([
      "Sum",
      "Count",
      "Average",
      "Max",
      "Min",
      "Product",
      "More Options...",
    ]);
  });
});

describe("actions", () => {
  it("Sort Largest to Smallest sorts the row's field by the cell's value field along its column (BUG-0459)", async () => {
    install(false);
    await findItem("pivot:sortByValue:descending").onClick(ctxAt(1, 1));
    expect(sortPivotField).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 3,
      valuesHierarchy: "Sum of Sales",
      scopeGroupPath: [[7, 2]],
      sortBy: "descending",
    });
  });

  it("Sort Smallest to Largest in a column with no column items reads the grand total line", async () => {
    install(false);
    await findItem("pivot:sortByValue:ascending").onClick(ctxAt(1, 2));
    expect(sortPivotField).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 3,
      valuesHierarchy: "Count of Sales",
      scopeGroupPath: [],
      sortBy: "ascending",
    });
  });

  it("Summarize Values By > Count summarizes the cell's value field", async () => {
    install(false);
    await findItem("pivot:summarizeBy:count").onClick(ctxAt(1, 2));
    expect(editPivotValueField).toHaveBeenCalledWith("p1", 1, { kind: "summarize", aggregation: "count" });
  });

  it("Show Values As: a plain choice applies at once, a based one opens the settings dialog", async () => {
    install(false);
    await findItem("pivot:showValuesAs:percent_of_total").onClick(ctxAt(1, 1));
    expect(editPivotValueField).toHaveBeenCalledWith("p1", 0, { kind: "showValuesAs", showValuesAs: "percent_of_total" });
    await findItem("pivot:showValuesAs:difference").onClick(ctxAt(1, 2));
    expect(requestValueFieldDialog).toHaveBeenCalledWith({ pivotId: "p1", valueFieldIndex: 1, dialog: "settings" });
    expect(editPivotValueField).toHaveBeenCalledTimes(1);
  });

  it("Number Format... / Value Field Settings... / More Options... open the pane's modal on the field", async () => {
    install(false);
    await findItem("pivot:numberFormat").onClick(ctxAt(1, 2));
    await findItem("pivot:valueFieldSettings").onClick(ctxAt(1, 1));
    await findItem("pivot:summarizeBy:more").onClick(ctxAt(1, 2));
    expect(vi.mocked(requestValueFieldDialog).mock.calls.map((c) => c[0])).toEqual([
      { pivotId: "p1", valueFieldIndex: 1, dialog: "numberFormat" },
      { pivotId: "p1", valueFieldIndex: 0, dialog: "settings" },
      { pivotId: "p1", valueFieldIndex: 1, dialog: "settings" },
    ]);
  });

  it("Remove \"<field>\" removes the cell's value field", async () => {
    install(true);
    await findItem("pivot:removeValueField").onClick(ctxAt(1, 1));
    expect(editPivotValueField).toHaveBeenCalledWith("p1", 0, { kind: "remove" });
  });

  it("Show Details drills the clicked cell (the one drill the double-click uses)", async () => {
    install(false);
    await findItem("pivot:showDetails").onClick(ctxAt(1, 2));
    expect(runPivotDrillThrough).toHaveBeenCalledTimes(1);
    const [pivotId, drilled, gridRow, gridCol, options] = vi.mocked(runPivotDrillThrough).mock.calls[0];
    expect([pivotId, drilled.value, gridRow, gridCol]).toEqual(["p1", 7, ANCHOR.row + 1, ANCHOR.col + 2]);
    // The pivot's sheet and name ride along: the drill's source for the page
    // filters and the sheet-name fallback (model-drillthrough.md 2.4 / 2.5).
    expect(options).toEqual({ sheetIndex: 0, name: "PivotTable1" });
  });

  it("Copy runs the canvas cell copy command; without it the row is greyed and a click says why", async () => {
    install(false);
    h.surface = "canvas";
    const copy = findItem("pivot:copy");
    expect(disabled(copy, ctxAt(1, 1))).toBe(true);
    expect(reason(copy, ctxAt(1, 1))).toBe(COPY_UNAVAILABLE_REASON);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await copy.onClick(ctxAt(1, 1));
    expect(CommandRegistry.execute).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(`Copy failed: ${COPY_UNAVAILABLE_REASON}`, { variant: "error" });
    error.mockRestore();

    h.commands.add(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    expect(disabled(copy, ctxAt(1, 1))).toBe(false);
    await copy.onClick(ctxAt(1, 1));
    expect(CommandRegistry.execute).toHaveBeenCalledWith(PIVOT_CANVAS_COPY_CELLS_COMMAND);
  });

  it("a failed action toasts '<Label> failed: <reason>'", async () => {
    install(false);
    vi.mocked(editPivotValueField).mockRejectedValueOnce(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await findItem("pivot:summarizeBy:average").onClick(ctxAt(1, 1));
    expect(showToast).toHaveBeenCalledWith("Summarize Values By Average failed: boom", { variant: "error" });
    error.mockRestore();
  });

  it("a click that raced past a greyed row (no value field) is told why, not silent", async () => {
    install(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await findItem("pivot:removeValueField").onClick(ctxAt(2, 2));
    expect(editPivotValueField).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(`Remove value field failed: ${VALUE_FIELD_UNKNOWN_REASON}`, { variant: "error" });
    error.mockRestore();
  });
});

describe("drill-through doors (model-drillthrough.md 2.9)", () => {
  it("the run row reads 'Drill through' when the pivot's region says it has a design query, else 'Show Details'", () => {
    install(true);
    const ctx = ctxAt(1, 1);
    const item = findItem("pivot:showDetails");
    h.drill.set("p1", true);
    expect(label(item, ctx)).toBe("Drill through");
    h.drill.set("p1", false);
    expect(label(item, ctx)).toBe("Show Details");
  });

  it("an UNKNOWN answer reads 'Show Details' (stale mislabels, never misroutes); off every pivot it does too", () => {
    // SABOTAGE: return "Drill through" for an unknown behaviour -- a range
    // pivot's value cell would promise a drill it does not have.
    install(true);
    expect(label(findItem("pivot:showDetails"), ctxAt(1, 1))).toBe("Show Details");
    expect(label(findItem("pivot:showDetails"), ctxAt(-5, -5))).toBe("Show Details");
  });

  it("whatever the label, the row runs the ONE drill with the clicked cell, the pivot's sheet and its name", async () => {
    install(true);
    h.drill.set("p1", true);
    await findItem("pivot:showDetails").onClick(ctxAt(1, 1));
    expect(runPivotDrillThrough).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ value: 100 }),
      ANCHOR.row + 1,
      ANCHOR.col + 1,
      { sheetIndex: 0, name: "PivotTable1" },
    );
  });

  it("the authoring row reads 'Drill-through behavior...' on the user's own worksheet and opens the dialog editable", async () => {
    install(true);
    h.sheetIds[0] = "S-own";
    const item = findItem("pivot:drillBehavior");
    expect(label(item, ctxAt(1, 1))).toBe("Drill-through behavior...");
    await item.onClick(ctxAt(1, 1));
    expect(showDialog).toHaveBeenCalledWith("d", { pivotId: "p1", readOnly: false });
  });

  it("on a SUBSCRIBED worksheet it reads 'View drill-through behavior...' and opens the same dialog read-only", async () => {
    // SABOTAGE: drop the isSheetSubscribed branch -- a subscriber gets an
    // editable dialog on a publisher's definition.
    install(true);
    h.sheetIds[0] = "S-sub";
    h.subscribed.add("S-sub");
    const item = findItem("pivot:drillBehavior");
    expect(label(item, ctxAt(1, 1))).toBe("View drill-through behavior...");
    await item.onClick(ctxAt(1, 1));
    expect(showDialog).toHaveBeenCalledWith("d", { pivotId: "p1", readOnly: true });
  });

  it("on a canvas the layout surface decides: a non-editable page is view-only, an editable page (or none known) is not", () => {
    install(true);
    h.surface = "canvas";
    const item = findItem("pivot:drillBehavior");
    h.surfaceEditable = false;
    expect(label(item, ctxAt(1, 1))).toBe("View drill-through behavior...");
    h.surfaceEditable = true;
    expect(label(item, ctxAt(1, 1))).toBe("Drill-through behavior...");
    h.surfaceEditable = null;
    expect(label(item, ctxAt(1, 1))).toBe("Drill-through behavior...");
  });
});
