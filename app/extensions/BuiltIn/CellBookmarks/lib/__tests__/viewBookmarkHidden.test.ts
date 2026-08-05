//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/__tests__/viewBookmarkHidden.test.ts
// PURPOSE: A view bookmark owns the USER's by-hand hides and nothing else.
// CONTEXT: The store used to snapshot `dimensions.hiddenRows` -- the EFFECTIVE
//          union of user + filter + outline hides -- and restore it by
//          dispatching setHiddenRows, which lands in the FILTER source. That
//          produced a row that was hidden, that the row-header "Unhide" would
//          not clear (its predicate reads the user set), and that disappeared
//          on reload (the backend user set never learned about it). Two
//          disagreeing notions of "hidden" is exactly what the composition rule
//          exists to prevent, so these tests pin the decomposition:
//          capture reads the user source, restore writes the user authority.

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above ordinary consts, so the spies have to be
// created inside vi.hoisted() to exist by the time the factory runs.
const { hideRows, hideColumns, dispatchGridAction, setHiddenRows, setHiddenCols } = vi.hoisted(
  () => ({
    hideRows: vi.fn(async () => true),
    hideColumns: vi.fn(async () => true),
    dispatchGridAction: vi.fn(),
    setHiddenRows: vi.fn(),
    setHiddenCols: vi.fn(),
  })
);

vi.mock("@api", () => ({
  dispatchGridAction,
  hideRows,
  hideColumns,
  // Present so an accidental re-introduction of the filter-source write is
  // observable rather than a module-resolution error.
  setHiddenRows,
  setHiddenCols,
  setSelection: vi.fn(),
  setViewport: vi.fn(),
  setZoom: vi.fn(),
  setViewMode: vi.fn(),
  setShowFormulas: vi.fn(),
  setFreezeConfig: vi.fn(),
  setSplitConfig: vi.fn(),
  setColumnWidth: vi.fn(),
  setRowHeight: vi.fn(),
  setActiveSheet: vi.fn(),
  setActiveSheetApi: vi.fn(),
  scrollToPosition: vi.fn(),
  emitAppEvent: vi.fn(),
  AppEvents: { SHEET_CHANGED: "app:sheet-changed" },
  getAutoFilter: vi.fn(async () => null),
  applyAutoFilter: vi.fn(async () => undefined),
  setColumnFilterValues: vi.fn(async () => undefined),
  removeAutoFilter: vi.fn(async () => undefined),
  clearAutoFilterCriteria: vi.fn(async () => undefined),
}));

const gridState = {
  dimensions: {
    // 7 is hidden by hand; 3 is hidden by a filter. The union the renderer
    // consumes therefore holds both -- and a bookmark may only claim the 7.
    manuallyHiddenRows: new Set<number>([7]),
    manuallyHiddenCols: new Set<number>([2]),
    filterHiddenRows: new Set<number>([3]),
    hiddenRows: new Set<number>([3, 7]),
    hiddenCols: new Set<number>([2]),
    columnWidths: new Map<number, number>(),
    rowHeights: new Map<number, number>(),
  },
  selection: null,
  viewport: { scrollX: 0, scrollY: 0 },
  zoom: 1,
  sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  freezeConfig: { freezeRow: null, freezeCol: null },
  splitConfig: { splitRow: null, splitCol: null },
  viewMode: "normal",
  showFormulas: false,
};

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => gridState,
}));

import { captureCurrentState, restoreState } from "../viewBookmarkStore";

beforeEach(() => {
  vi.clearAllMocks();
  gridState.dimensions.manuallyHiddenRows = new Set([7]);
  gridState.dimensions.manuallyHiddenCols = new Set([2]);
});

describe("view bookmark: hidden rows/columns", () => {
  it("captures the user's hides, not the effective union", async () => {
    const snapshot = await captureCurrentState({ hiddenRows: true, hiddenCols: true });

    // Row 3 is filter-hidden. Capturing it here would make a later restore
    // re-assert it as a hand hide that outlives the filter that caused it.
    expect(snapshot.hiddenRows).toEqual([7]);
    expect(snapshot.hiddenCols).toEqual([2]);
  });

  it("restores through the backend authority, never the filter source", async () => {
    await restoreState({ hiddenRows: [4], hiddenCols: [] }, { hiddenRows: true });

    expect(hideRows).toHaveBeenCalled();
    expect(setHiddenRows).not.toHaveBeenCalled();
    expect(setHiddenCols).not.toHaveBeenCalled();
  });

  it("hides what the snapshot captured and reveals what it did not", async () => {
    // Now hidden: {7}. Snapshot says: {4}. So 7 must be revealed and 4 hidden.
    await restoreState({ hiddenRows: [4] }, { hiddenRows: true });

    expect(hideRows).toHaveBeenCalledWith([7], false);
    expect(hideRows).toHaveBeenCalledWith([4], true);
  });

  it("does not call the backend when the snapshot already matches", async () => {
    await restoreState({ hiddenRows: [7] }, { hiddenRows: true });

    expect(hideRows).not.toHaveBeenCalled();
  });

  it("reveals every hand-hidden row when the snapshot captured none", async () => {
    await restoreState({ hiddenRows: [] }, { hiddenRows: true });

    expect(hideRows).toHaveBeenCalledTimes(1);
    expect(hideRows).toHaveBeenCalledWith([7], false);
  });

  it("routes columns to the column axis", async () => {
    await restoreState({ hiddenCols: [5] }, { hiddenCols: true });

    expect(hideColumns).toHaveBeenCalledWith([2], false);
    expect(hideColumns).toHaveBeenCalledWith([5], true);
    expect(hideRows).not.toHaveBeenCalled();
  });

  it("leaves hides alone when the dimension is not part of the bookmark", async () => {
    await restoreState({ hiddenRows: [4], hiddenCols: [5] }, { zoom: true });

    expect(hideRows).not.toHaveBeenCalled();
    expect(hideColumns).not.toHaveBeenCalled();
  });
});
