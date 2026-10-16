//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotCellFormulaBar.test.ts
// PURPOSE: A canvas pivot box's selected cells in the formula bar, the Name
//          Box and the status bar (D-CELLS, WP-A S11b): the publisher drives
//          the REAL slots (@api/externalEdit's external cell, @api/statusBarRange),
//          the real cell-selection store, the real view cache and the real
//          window events. Only the grid snapshot, the published regions and
//          the pivot IPC are doubled.
//          Pinned: publish / withdraw, the address spelling (`Canvas1!B3`,
//          `'Sales Page'!B5`, a block-1 pivot's `AMK` columns), the
//          unformatted value of the ACTIVE cell, read-only, the grid rectangle
//          the status bar aggregates, the OWNER rule (a pivot's late clear
//          never withdraws what a floating grid published since), a new view,
//          a rename, a windowed row that is not cached yet (also when the
//          renderer's fetch of the same window is the one that lands).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface Region {
  id: string;
  type: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  data: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  snapshot: null as null | { sheetContext: { activeSheetIndex: number; activeSheetName: string } },
  regions: [] as Region[],
  regionHandlers: new Set<() => void>(),
  fetchWindow: vi.fn(),
}));

vi.mock("@api", () => ({
  // The real bijective base-26 spelling (a canvas block starts at column 1024 = AMK).
  columnToLetter: (col: number) => {
    let out = "";
    for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    return out;
  },
}));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => h.snapshot }));
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/gridOverlays")>()),
  getGridRegions: () => h.regions,
  onRegionChange: (fn: () => void) => {
    h.regionHandlers.add(fn);
    return () => h.regionHandlers.delete(fn);
  },
}));
vi.mock("../pivot-api", () => ({
  getCellDisplayValue: (value: unknown) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return value.toString();
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    return value as string;
  },
  getPivotCellWindow: (...args: unknown[]) => h.fetchWindow(...args),
  getPivotAtCell: vi.fn(),
  togglePivotGroup: vi.fn(),
  cancelPivotOperation: vi.fn(),
}));

import {
  getExternalCellTarget,
  getExternalNameBoxAddress,
  publishExternalCellTarget,
  type ExternalCellTarget,
} from "@api/externalEdit";
import { getStatusBarRange, publishStatusBarRange, __resetStatusBarRangeForTests } from "@api/statusBarRange";
import { AppEvents, emitAppEvent } from "@api/events";
import { PIVOT_CELLS_OWNER, installPivotCellFormulaBar, pivotCellA1 } from "../pivotCellFormulaBar";
import {
  clearPivotCellSelection,
  extendPivotCellSelection,
  resetPivotCellSelection,
  setPivotCellAnchor,
} from "../pivotVisualCellSelection";
import { deleteCachedPivotView, ensureCellWindow, setCachedPivotView } from "../pivotViewStore";
import type { PivotViewResponse } from "../pivot-api";

const FR_OWNER = "floatingRange";

function cell(value: unknown, formattedValue?: string) {
  return { cellType: "Data", value, formattedValue, backgroundStyle: "Normal" };
}

/** A small view: row r, col c holds the number r * 1000 + c + 0.5 (formatted "#"). */
function makeView(version: number, rows = 6, cols = 5, bump = 0): PivotViewResponse {
  return {
    pivotId: "p1",
    version,
    rowCount: rows,
    colCount: cols,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    isWindowed: false,
    rows: Array.from({ length: rows }, (_, r) => ({
      viewRow: r,
      rowType: "Data",
      depth: 0,
      visible: true,
      cells: Array.from({ length: cols }, (_, c) => cell(r * 1000 + c + 0.5 + bump, "formatted")),
    })),
    columns: [],
  } as unknown as PivotViewResponse;
}

function region(pivotId: string, startRow: number, startCol: number): Region {
  return {
    id: `pivot-visual-${pivotId}`,
    type: "pivot-visual",
    startRow,
    startCol,
    endRow: startRow + 5,
    endCol: startCol + 4,
    data: { pivotId },
  };
}

function onCanvas(name = "Canvas1", index = 1): void {
  h.snapshot = { sheetContext: { activeSheetIndex: index, activeSheetName: name } };
}

let cleanups: Array<() => void> = [];

beforeEach(() => {
  h.regions = [region("p1", 0, 0)];
  h.regionHandlers.clear();
  h.fetchWindow.mockReset();
  onCanvas();
  resetPivotCellSelection();
  __resetStatusBarRangeForTests();
  deleteCachedPivotView("p1");
  setCachedPivotView("p1", makeView(1));
  cleanups = installPivotCellFormulaBar();
});

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  resetPivotCellSelection();
  publishExternalCellTarget(FR_OWNER, null);
  publishExternalCellTarget(PIVOT_CELLS_OWNER, null);
  __resetStatusBarRangeForTests();
  deleteCachedPivotView("p1");
});

describe("pivotCellA1", () => {
  it("one cell is `B5`, a rectangle `B5:D9` (no `$`, as a pick inserts it)", () => {
    expect(pivotCellA1({ startRow: 4, startCol: 1, endRow: 4, endCol: 1 })).toBe("B5");
    expect(pivotCellA1({ startRow: 4, startCol: 1, endRow: 8, endCol: 3 })).toBe("B5:D9");
  });
});

describe("the pivot's cells in the formula bar, Name Box and status bar", () => {
  it("nothing is published while no cell is selected", () => {
    expect(getExternalCellTarget()).toBeNull();
    expect(getStatusBarRange()).toBeNull();
  });

  it("one cell: the Name Box names it on the active canvas, the bar shows its UNFORMATTED value, read-only", () => {
    setPivotCellAnchor("p1", 2, 1);
    const target = getExternalCellTarget();
    expect(target).not.toBeNull();
    expect(target?.address).toBe("Canvas1!B3");
    expect(getExternalNameBoxAddress()).toBe("Canvas1!B3");
    // 2 * 1000 + 1 + 0.5 -- the raw number, never the "formatted" text.
    expect(target?.content).toBe("2001.5");
    expect(target?.readOnly).toBe(true);
    // The bar never opens an edit of a pivot's cell.
    expect(target?.beginEdit()).toBeNull();
    expect(target?.beginEdit("=")).toBeNull();
    // The status bar gets the one cell (and itself shows nothing for one cell).
    expect(getStatusBarRange()).toEqual({ startRow: 2, startCol: 1, endRow: 2, endCol: 1 });
  });

  it("a rectangle: the Name Box shows the range in the HIDDEN GRID (offset by the box's anchor); the bar keeps the ACTIVE cell", () => {
    h.regions = [region("p1", 4, 2)];
    setPivotCellAnchor("p1", 3, 3);
    extendPivotCellSelection(1, 1); // dragged up-left
    const target = getExternalCellTarget();
    // View rows 1..3, cols 1..3 -> grid rows 5..7, cols 3..5 -> D6:F8.
    expect(target?.address).toBe("Canvas1!D6:F8");
    expect(target?.content).toBe("3003.5");
    expect(getStatusBarRange()).toEqual({ startRow: 5, startCol: 3, endRow: 7, endCol: 5 });
  });

  it("a sheet name the parser reads only quoted is quoted: 'Sales Page'!B5", () => {
    onCanvas("Sales Page");
    setPivotCellAnchor("p1", 4, 1);
    expect(getExternalCellTarget()?.address).toBe("'Sales Page'!B5");
  });

  it("a block-1 pivot (anchored at column 1024) is named in its own block's columns", () => {
    h.regions = [region("p1", 0, 1024)];
    setPivotCellAnchor("p1", 0, 0);
    expect(getExternalCellTarget()?.address).toBe("Canvas1!AMK1");
    extendPivotCellSelection(2, 2);
    expect(getExternalCellTarget()?.address).toBe("Canvas1!AMK1:AMM3");
    expect(getStatusBarRange()).toEqual({ startRow: 0, startCol: 1024, endRow: 2, endCol: 1026 });
  });

  it("clearing the cells withdraws both publications", () => {
    setPivotCellAnchor("p1", 1, 1);
    extendPivotCellSelection(2, 2);
    expect(getExternalCellTarget()).not.toBeNull();
    expect(getStatusBarRange()).not.toBeNull();
    clearPivotCellSelection();
    expect(getExternalCellTarget()).toBeNull();
    expect(getStatusBarRange()).toBeNull();
  });

  it("OWNER RULE: a pivot clearing its cells late never withdraws what a floating grid published since", () => {
    setPivotCellAnchor("p1", 1, 1);
    extendPivotCellSelection(2, 2);
    const fr: ExternalCellTarget = {
      address: "Float1!A1",
      content: "=1+1",
      readOnly: false,
      beginEdit: () => null,
    };
    publishExternalCellTarget(FR_OWNER, fr);
    publishStatusBarRange("someone-else", { startRow: 9, startCol: 9, endRow: 10, endCol: 10 });
    clearPivotCellSelection();
    expect(getExternalCellTarget()?.address).toBe("Float1!A1");
    expect(getStatusBarRange()).toEqual({ startRow: 9, startCol: 9, endRow: 10, endCol: 10 });
    // Positive control: with the pivot holding the slots, the same clear withdraws.
    publishExternalCellTarget(FR_OWNER, null);
    __resetStatusBarRangeForTests();
    setPivotCellAnchor("p1", 1, 1);
    expect(getExternalCellTarget()?.address).toBe("Canvas1!B2");
    clearPivotCellSelection();
    expect(getExternalCellTarget()).toBeNull();
  });

  it("uninstall withdraws, and later selections publish nothing", () => {
    setPivotCellAnchor("p1", 1, 1);
    for (const c of cleanups) c();
    cleanups = [];
    expect(getExternalCellTarget()).toBeNull();
    expect(getStatusBarRange()).toBeNull();
    setPivotCellAnchor("p1", 2, 2);
    expect(getExternalCellTarget()).toBeNull();
  });

  it("a NEW VIEW of the pivot republishes the active cell's value (PIVOT_VIEW_UPDATED)", () => {
    setPivotCellAnchor("p1", 2, 1);
    expect(getExternalCellTarget()?.content).toBe("2001.5");
    setCachedPivotView("p1", makeView(2, 6, 5, 100)); // emits the event
    expect(getExternalCellTarget()?.content).toBe("2101.5");
  });

  it("a box not published on this sheet (yet) publishes nothing; its region arriving publishes", () => {
    h.regions = [];
    setPivotCellAnchor("p1", 1, 1);
    expect(getExternalCellTarget()).toBeNull();
    expect(getStatusBarRange()).toBeNull();
    h.regions = [region("p1", 0, 0)];
    for (const fn of [...h.regionHandlers]) fn();
    expect(getExternalCellTarget()?.address).toBe("Canvas1!B2");
  });

  it("a rename of the canvas renames the address at once (before the grid snapshot catches up)", () => {
    setPivotCellAnchor("p1", 1, 1);
    expect(getExternalCellTarget()?.address).toBe("Canvas1!B2");
    emitAppEvent(AppEvents.SHEET_RENAMED, { sheetIndex: 1, oldName: "Canvas1", newName: "Q1 Report" });
    expect(getExternalCellTarget()?.address).toBe("'Q1 Report'!B2");
    // A rename of ANOTHER sheet changes nothing here.
    emitAppEvent(AppEvents.SHEET_RENAMED, { sheetIndex: 0, oldName: "Sheet1", newName: "Data" });
    expect(getExternalCellTarget()?.address).toBe("Canvas1!B2");
  });

  it("a cell the row does not carry shows an empty bar, never another cell's text", () => {
    setPivotCellAnchor("p1", 1, 9); // past the row's five cells
    expect(getExternalCellTarget()?.content).toBe("");
  });
});

describe("a WINDOWED pivot whose active row is not cached yet", () => {
  function windowedView(version: number): PivotViewResponse {
    const v = makeView(version, 3, 5) as unknown as Record<string, unknown>;
    v.isWindowed = true;
    v.windowStartRow = 0;
    v.rowCount = 1000;
    return v as unknown as PivotViewResponse;
  }

  function windowAnswer(version: number, startRow: number, count: number) {
    return {
      version,
      startRow,
      rows: Array.from({ length: count }, (_, i) => ({
        viewRow: startRow + i,
        cells: Array.from({ length: 5 }, (_, c) => cell((startRow + i) * 1000 + c + 0.5)),
      })),
    };
  }

  it("shows nothing (null) until the row lands, fetches it ONCE, then shows the value", async () => {
    setCachedPivotView("p1", windowedView(7));
    let resolve!: (v: unknown) => void;
    h.fetchWindow.mockImplementation(() => new Promise((r) => (resolve = r)));
    setPivotCellAnchor("p1", 450, 2);
    expect(getExternalCellTarget()?.address).toBe("Canvas1!C451");
    expect(getExternalCellTarget()?.content).toBeNull();
    // Republishing (a region change) does not ask again.
    for (const fn of [...h.regionHandlers]) fn();
    expect(h.fetchWindow).toHaveBeenCalledTimes(1);
    expect(h.fetchWindow).toHaveBeenCalledWith("p1", 400, 200);
    resolve(windowAnswer(7, 400, 200));
    await vi.waitFor(() => expect(getExternalCellTarget()?.content).toBe("450002.5"));
  });

  it("also when the RENDERER's fetch of the same window is the one that lands", async () => {
    setCachedPivotView("p1", windowedView(8));
    let resolve!: (v: unknown) => void;
    h.fetchWindow.mockImplementation(() => new Promise((r) => (resolve = r)));
    const rendererRedraw = vi.fn();
    // The renderer asked first: the window is in flight when the cell is selected.
    ensureCellWindow("p1", 8, 420, 10, h.fetchWindow, rendererRedraw);
    setPivotCellAnchor("p1", 450, 1);
    expect(getExternalCellTarget()?.content).toBeNull();
    expect(h.fetchWindow).toHaveBeenCalledTimes(1);
    resolve(windowAnswer(8, 400, 200));
    await vi.waitFor(() => expect(getExternalCellTarget()?.content).toBe("450001.5"));
    expect(rendererRedraw).toHaveBeenCalledTimes(1);
  });

  it("a stale window (an older view's version) is dropped: the waiters are not called", async () => {
    setCachedPivotView("p1", windowedView(9));
    let resolve!: (v: unknown) => void;
    h.fetchWindow.mockImplementation(() => new Promise((r) => (resolve = r)));
    const first = vi.fn();
    const second = vi.fn();
    ensureCellWindow("p1", 9, 500, 1, h.fetchWindow, first);
    ensureCellWindow("p1", 9, 510, 1, h.fetchWindow, second);
    expect(h.fetchWindow).toHaveBeenCalledTimes(1);
    resolve(windowAnswer(4, 400, 200));
    await Promise.resolve();
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
