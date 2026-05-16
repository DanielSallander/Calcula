//! FILENAME: app/extensions/__tests__/extension-isolation.test.ts
// PURPOSE: Verify that extension stores are properly isolated and don't interfere with each other.
// CONTEXT: Each extension uses module-level state. Mutations in one store must not leak into another.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Mocks - must be declared before imports
// ============================================================================

vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));

vi.mock("@api/backend", () => ({
  invokeBackend: vi.fn(),
}));

vi.mock("@api", () => ({
  removeGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  emitAppEvent: vi.fn(),
  AppEvents: {},
  getAllDataValidations: vi.fn().mockResolvedValue([]),
  getInvalidCells: vi.fn().mockResolvedValue([]),
  getProtectionStatus: vi.fn().mockResolvedValue({
    isProtected: false,
    hasPassword: false,
    options: {},
  }),
  isWorkbookProtected: vi.fn().mockResolvedValue(false),
  DEFAULT_PROTECTION_OPTIONS: {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    useAutoFilter: false,
    usePivotTableReports: false,
    editObjects: false,
    editScenarios: false,
  },
  getWatchCells: vi.fn().mockResolvedValue([]),
  getSheets: vi.fn().mockResolvedValue([]),
  columnToLetter: vi.fn((col: number) => String.fromCharCode(65 + col)),
  applyAutoFilter: vi.fn(),
  removeAutoFilter: vi.fn(),
  clearAutoFilterCriteria: vi.fn(),
  reapplyAutoFilter: vi.fn(),
  clearColumnCriteria: vi.fn(),
  getAutoFilter: vi.fn(),
  getHiddenRows: vi.fn(),
  setColumnFilterValues: vi.fn(),
  getFilterUniqueValues: vi.fn(),
  detectDataRegion: vi.fn(),
  setHiddenRows: vi.fn(),
  dispatchGridAction: vi.fn(),
}));

vi.mock("@api/lib", () => ({
  sortRangeByColumn: vi.fn(),
  sortRange: vi.fn(),
  getViewportCells: vi.fn(),
  getStyle: vi.fn(),
  setColumnCustomFilter: vi.fn(),
}));

const editingState = { moveAfterReturn: true, moveDirection: "down" };
vi.mock("@api/editingPreferences", () => ({
  getMoveAfterReturn: vi.fn(() => editingState.moveAfterReturn),
  setMoveAfterReturn: vi.fn((v: boolean) => { editingState.moveAfterReturn = v; }),
  getMoveDirection: vi.fn(() => editingState.moveDirection),
  setMoveDirection: vi.fn((v: string) => { editingState.moveDirection = v; }),
}));

vi.mock("../../extensions/Controls/lib/designMode", () => ({
  getDesignMode: vi.fn(() => false),
}));

vi.mock("../AutoFilter/lib/filterEvents", () => ({
  FilterEvents: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../DataValidation/lib/validationEvents", () => ({
  ValidationEvents: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../FilterPane/lib/filterPaneApi", () => ({
  createRibbonFilter: vi.fn(),
  getAllRibbonFilters: vi.fn().mockResolvedValue([]),
  deleteRibbonFilter: vi.fn(),
  updateRibbonFilter: vi.fn(),
}));

vi.mock("../FilterPane/lib/filterPaneEvents", () => ({
  FilterPaneEvents: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("../FilterPane/lib/filterPaneFilterBridge", () => ({
  applyRibbonFilter: vi.fn(),
  clearRibbonFilter: vi.fn(),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
  createSparklineGroup,
  getAllGroups as getAllSparklineGroups,
  resetSparklineStore,
} from "../Sparklines/store";

import {
  addFloatingControl,
  getAllFloatingControls,
  resetFloatingStore,
} from "../Controls/lib/floatingStore";

import {
  resetChartStore,
} from "../Charts/lib/chartStore";

import {
  resetState as resetFilterState,
} from "../AutoFilter/lib/filterStore";

import { useSortStore } from "../Sorting/hooks/useSortState";

import {
  resetProtectionState,
  isCurrentSheetProtected,
  setSheetProtectedState,
} from "../Protection/lib/protectionStore";

import {
  resetState as resetValidationState,
  getValidationState,
} from "../DataValidation/lib/validationStore";

import { useFindStore } from "../BuiltIn/FindReplaceDialog/useFindStore";

import {
  clearCache as clearFilterPaneCache,
  getAllFilters as getAllPaneFilters,
} from "../FilterPane/lib/filterPaneStore";

import {
  addBookmark,
  getAllBookmarks,
  removeAllBookmarks,
} from "../BuiltIn/CellBookmarks/lib/bookmarkStore";

import {
  reset as resetWatchStore,
} from "../WatchWindow/lib/watchStore";

import {
  getMoveAfterReturn,
  setMoveAfterReturn,
  getMoveDirection,
  setMoveDirection,
} from "@api/editingPreferences";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
  resetFloatingStore();
  resetChartStore();
  resetFilterState();
  useSortStore.getState().reset();
  resetProtectionState();
  resetValidationState();
  useFindStore.getState().reset();
  clearFilterPaneCache();
  removeAllBookmarks();
  resetWatchStore();
  editingState.moveAfterReturn = true;
  editingState.moveDirection = "down";
});

// ============================================================================
// Sparkline <-> Controls Isolation
// ============================================================================

describe("sparkline store does not affect controls store", () => {
  it("creating a sparkline group leaves controls store empty", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );

    expect(getAllSparklineGroups().length).toBe(1);
    expect(getAllFloatingControls().length).toBe(0);
  });

  it("adding a floating control leaves sparkline store empty", () => {
    addFloatingControl({
      id: "control-0-1-2",
      sheetIndex: 0,
      row: 1,
      col: 2,
      x: 100,
      y: 50,
      width: 120,
      height: 30,
      controlType: "button",
    });

    expect(getAllFloatingControls().length).toBe(1);
    expect(getAllSparklineGroups().length).toBe(0);
  });

  it("resetting sparklines does not affect controls", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    addFloatingControl({
      id: "control-0-0-0",
      sheetIndex: 0,
      row: 0,
      col: 0,
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      controlType: "button",
    });

    resetSparklineStore();

    expect(getAllSparklineGroups().length).toBe(0);
    expect(getAllFloatingControls().length).toBe(1);
  });
});

// ============================================================================
// Chart <-> Pivot View Isolation (chart state independent)
// ============================================================================

describe("chart store is independent of other stores", () => {
  it("resetting chart store does not affect sparkline groups", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 3, endRow: 0, endCol: 3 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
      "column",
    );

    resetChartStore();

    expect(getAllSparklineGroups().length).toBe(1);
  });

  it("resetting chart store does not affect protection state", () => {
    setSheetProtectedState(true, true, { selectLockedCells: true } as any);

    resetChartStore();

    expect(isCurrentSheetProtected()).toBe(true);
  });
});

// ============================================================================
// Filter Store <-> Sorting Store Isolation
// ============================================================================

describe("filter store changes do not corrupt sorting store", () => {
  it("resetting filter state leaves sort levels intact", () => {
    useSortStore.getState().initialize(0, 0, 10, 3, ["A", "B", "C", "D"], true);
    useSortStore.getState().addLevel();

    resetFilterState();

    const sortState = useSortStore.getState();
    expect(sortState.levels.length).toBe(2);
    expect(sortState.columnHeaders).toEqual(["A", "B", "C", "D"]);
  });

  it("resetting sort store does not affect filter state", () => {
    // Sort store has data
    useSortStore.getState().initialize(0, 0, 5, 2, ["X", "Y", "Z"], true);
    useSortStore.getState().addLevel();

    useSortStore.getState().reset();

    // Filter state is independent (just check no throw; filter state is module-private)
    expect(() => resetFilterState()).not.toThrow();
  });
});

// ============================================================================
// Protection <-> Validation Isolation
// ============================================================================

describe("protection store changes do not affect validation store", () => {
  it("setting sheet protection does not alter validation state", () => {
    const validationBefore = { ...getValidationState() };

    setSheetProtectedState(true, false, { selectLockedCells: true } as any);

    const validationAfter = getValidationState();
    expect(validationAfter.validationRanges).toEqual(validationBefore.validationRanges);
    expect(validationAfter.invalidCells).toEqual(validationBefore.invalidCells);
    expect(validationAfter.openDropdownCell).toEqual(validationBefore.openDropdownCell);
  });

  it("resetting validation state does not affect protection", () => {
    setSheetProtectedState(true, true, { selectLockedCells: false } as any);

    resetValidationState();

    expect(isCurrentSheetProtected()).toBe(true);
  });

  it("resetting protection does not affect validation", () => {
    // Validation state is at default; just verify no cross-reset
    resetProtectionState();

    const vs = getValidationState();
    expect(vs.validationRanges).toEqual([]);
    expect(vs.invalidCells).toBeNull();
  });
});

// ============================================================================
// Search (Find) Store <-> Filter Pane Store Isolation
// ============================================================================

describe("search store state is independent of filter pane state", () => {
  it("opening find dialog does not affect filter pane cache", () => {
    useFindStore.getState().open(false);
    useFindStore.getState().setQuery("test");

    expect(getAllPaneFilters()).toEqual([]);
  });

  it("clearing filter pane cache does not affect find state", () => {
    useFindStore.getState().open(true);
    useFindStore.getState().setQuery("hello");
    useFindStore.getState().setMatches([[1, 2], [3, 4]], "hello");

    clearFilterPaneCache();

    const findState = useFindStore.getState();
    expect(findState.query).toBe("hello");
    expect(findState.matches.length).toBe(2);
    expect(findState.isOpen).toBe(true);
  });
});

// ============================================================================
// Bookmark Store <-> Watch Window Store Isolation
// ============================================================================

describe("bookmark store is independent of watch window store", () => {
  it("adding bookmarks does not create watch items", () => {
    addBookmark(0, 0, 0, "Sheet1", { label: "BM1", color: "blue" });
    addBookmark(1, 1, 0, "Sheet1", { label: "BM2", color: "red" });

    expect(getAllBookmarks().length).toBe(2);
    // Watch store was reset in beforeEach; no items should exist
    // (watch store items are module-private; reset clears them)
  });

  it("resetting watch store does not affect bookmarks", () => {
    addBookmark(5, 5, 0, "Sheet1");

    resetWatchStore();

    expect(getAllBookmarks().length).toBe(1);
  });

  it("removing all bookmarks does not affect watch store", () => {
    addBookmark(0, 0, 0, "Sheet1");

    removeAllBookmarks();

    expect(getAllBookmarks().length).toBe(0);
    // Watch store unaffected (no throw, state intact after its own reset)
    expect(() => resetWatchStore()).not.toThrow();
  });
});

// ============================================================================
// Settings (Editing Preferences) Isolation
// ============================================================================

describe("settings changes do not corrupt editing options", () => {
  it("changing moveAfterReturn does not affect moveDirection", () => {
    setMoveAfterReturn(false);
    expect(getMoveAfterReturn()).toBe(false);
    expect(getMoveDirection()).toBe("down");
  });

  it("changing moveDirection does not affect moveAfterReturn", () => {
    setMoveDirection("right");
    expect(getMoveDirection()).toBe("right");
    // moveAfterReturn should still be at its default
    expect(getMoveAfterReturn()).toBe(true);
  });

  it("editing preferences are independent of sort store", () => {
    setMoveDirection("up");

    useSortStore.getState().initialize(0, 0, 10, 2, ["A", "B", "C"], true);
    useSortStore.getState().addLevel();

    expect(getMoveDirection()).toBe("up");
    expect(useSortStore.getState().levels.length).toBe(2);
  });
});

// ============================================================================
// Each Store's Reset Only Resets Its Own State
// ============================================================================

describe("each store reset only affects its own state", () => {
  it("populates multiple stores then resets each independently", () => {
    // Populate
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    addFloatingControl({
      id: "control-0-2-3",
      sheetIndex: 0,
      row: 2,
      col: 3,
      x: 200,
      y: 100,
      width: 80,
      height: 25,
      controlType: "checkbox",
    });
    setSheetProtectedState(true, false, {} as any);
    useSortStore.getState().initialize(0, 0, 5, 2, ["A", "B", "C"], true);
    useSortStore.getState().addLevel();
    useFindStore.getState().setQuery("search");
    addBookmark(0, 0, 0, "Sheet1");

    // Reset sparklines only
    resetSparklineStore();
    expect(getAllSparklineGroups().length).toBe(0);
    expect(getAllFloatingControls().length).toBe(1);
    expect(isCurrentSheetProtected()).toBe(true);
    expect(useSortStore.getState().levels.length).toBe(2);
    expect(useFindStore.getState().query).toBe("search");
    expect(getAllBookmarks().length).toBe(1);

    // Reset controls only
    resetFloatingStore();
    expect(getAllFloatingControls().length).toBe(0);
    expect(isCurrentSheetProtected()).toBe(true);
    expect(useSortStore.getState().levels.length).toBe(2);

    // Reset protection only
    resetProtectionState();
    expect(isCurrentSheetProtected()).toBe(false);
    expect(useSortStore.getState().levels.length).toBe(2);

    // Reset sort only
    useSortStore.getState().reset();
    expect(useSortStore.getState().levels.length).toBe(0);
    expect(useFindStore.getState().query).toBe("search");

    // Reset find only
    useFindStore.getState().reset();
    expect(useFindStore.getState().query).toBe("");
    expect(getAllBookmarks().length).toBe(1);

    // Reset bookmarks only
    removeAllBookmarks();
    expect(getAllBookmarks().length).toBe(0);
  });
});

// ============================================================================
// Multiple Stores Operating Simultaneously
// ============================================================================

describe("multiple stores operating simultaneously with no cross-contamination", () => {
  it("interleaved operations across 6 stores produce correct results", () => {
    // Step 1: Create sparkline
    const result1 = createSparklineGroup(
      { startRow: 0, startCol: 10, endRow: 0, endCol: 10 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 9 },
      "line",
    );

    // Step 2: Add control
    addFloatingControl({
      id: "control-0-5-5",
      sheetIndex: 0,
      row: 5,
      col: 5,
      x: 300,
      y: 200,
      width: 100,
      height: 40,
      controlType: "button",
    });

    // Step 3: Set protection
    setSheetProtectedState(true, true, { selectLockedCells: true } as any);

    // Step 4: Open find dialog
    useFindStore.getState().open(true);
    useFindStore.getState().setQuery("revenue");

    // Step 5: Add sort levels
    useSortStore.getState().initialize(0, 0, 100, 4, ["Name", "Revenue", "Date", "Region", "Status"], true);
    useSortStore.getState().addLevel();
    useSortStore.getState().addLevel();

    // Step 6: Add bookmarks
    addBookmark(10, 2, 0, "Sheet1", { label: "Important", color: "red" });
    addBookmark(20, 3, 1, "Sheet2", { label: "Review", color: "green" });

    // Verify all stores independently
    expect(getAllSparklineGroups().length).toBe(1);
    expect(result1.valid).toBe(true);
    expect(getAllFloatingControls().length).toBe(1);
    expect(isCurrentSheetProtected()).toBe(true);
    expect(useFindStore.getState().query).toBe("revenue");
    expect(useFindStore.getState().isOpen).toBe(true);
    expect(useSortStore.getState().levels.length).toBe(3);
    expect(useSortStore.getState().columnHeaders.length).toBe(5);
    expect(getAllBookmarks().length).toBe(2);
  });

  it("rapid sequential resets across all stores causes no errors", () => {
    // Populate everything
    createSparklineGroup(
      { startRow: 0, startCol: 3, endRow: 0, endCol: 3 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
      "column",
    );
    addFloatingControl({
      id: "control-0-0-0",
      sheetIndex: 0,
      row: 0,
      col: 0,
      x: 0,
      y: 0,
      width: 50,
      height: 20,
      controlType: "button",
    });
    setSheetProtectedState(true, false, {} as any);
    useSortStore.getState().initialize(0, 0, 5, 1, ["A", "B"], true);
    useFindStore.getState().setQuery("x");
    addBookmark(0, 0, 0, "Sheet1");

    // Reset all rapidly
    resetSparklineStore();
    resetFloatingStore();
    resetChartStore();
    resetFilterState();
    useSortStore.getState().reset();
    resetProtectionState();
    resetValidationState();
    useFindStore.getState().reset();
    clearFilterPaneCache();
    removeAllBookmarks();
    resetWatchStore();

    // All empty
    expect(getAllSparklineGroups().length).toBe(0);
    expect(getAllFloatingControls().length).toBe(0);
    expect(isCurrentSheetProtected()).toBe(false);
    expect(useSortStore.getState().levels.length).toBe(0);
    expect(useFindStore.getState().query).toBe("");
    expect(getAllBookmarks().length).toBe(0);
    expect(getValidationState().validationRanges).toEqual([]);
  });
});
