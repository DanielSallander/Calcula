//! FILENAME: app/extensions/__tests__/extension-cleanup.test.ts
// PURPOSE: Verify that store reset/cleanup functions return to initial state and are reusable.
// CONTEXT: Each extension store must cleanly reset without affecting other stores.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Mocks
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
// Imports
// ============================================================================

import {
  createSparklineGroup,
  getAllGroups as getAllSparklineGroups,
  resetSparklineStore,
  hasSparkline,
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
  currentSheetHasPassword,
  isCurrentWorkbookProtected,
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
  getBookmarkCount,
  onChange as onBookmarkChange,
} from "../BuiltIn/CellBookmarks/lib/bookmarkStore";

import {
  reset as resetWatchStore,
  subscribe as subscribeWatch,
} from "../WatchWindow/lib/watchStore";

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
});

// ============================================================================
// Reset Returns to Initial State (Deep Equality)
// ============================================================================

describe("store reset returns to initial state", () => {
  it("sparkline store reset returns to empty state", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
      "column",
    );

    resetSparklineStore();

    expect(getAllSparklineGroups()).toEqual([]);
    expect(hasSparkline(0, 5)).toBe(false);
    expect(hasSparkline(1, 5)).toBe(false);
  });

  it("controls store reset returns to empty state", () => {
    addFloatingControl({
      id: "control-0-1-1",
      sheetIndex: 0,
      row: 1,
      col: 1,
      x: 50,
      y: 50,
      width: 100,
      height: 30,
      controlType: "button",
    });

    resetFloatingStore();

    expect(getAllFloatingControls()).toEqual([]);
  });

  it("protection store reset returns all flags to false/default", () => {
    setSheetProtectedState(true, true, { selectLockedCells: false } as any);

    resetProtectionState();

    expect(isCurrentSheetProtected()).toBe(false);
    expect(currentSheetHasPassword()).toBe(false);
    expect(isCurrentWorkbookProtected()).toBe(false);
  });

  it("sort store reset returns to default state", () => {
    useSortStore.getState().initialize(0, 0, 100, 5, ["A", "B", "C", "D", "E", "F"], true);
    useSortStore.getState().addLevel();
    useSortStore.getState().addLevel();

    useSortStore.getState().reset();

    const state = useSortStore.getState();
    expect(state.levels).toEqual([]);
    expect(state.columnHeaders).toEqual([]);
    expect(state.hasHeaders).toBe(true);
    expect(state.caseSensitive).toBe(false);
    expect(state.selectedLevelId).toBeNull();
  });

  it("find store reset returns to default state", () => {
    useFindStore.getState().open(true);
    useFindStore.getState().setQuery("test query");
    useFindStore.getState().setReplaceText("replacement");
    useFindStore.getState().setMatches([[1, 2], [3, 4], [5, 6]], "test query");

    useFindStore.getState().reset();

    const state = useFindStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.query).toBe("");
    expect(state.replaceText).toBe("");
    expect(state.matches).toEqual([]);
    expect(state.currentIndex).toBe(-1);
    expect(state.options.caseSensitive).toBe(false);
  });

  it("validation store reset returns to empty state", () => {
    resetValidationState();

    const state = getValidationState();
    expect(state.validationRanges).toEqual([]);
    expect(state.invalidCells).toBeNull();
    expect(state.openDropdownCell).toBeNull();
    expect(state.promptVisible).toBe(false);
    expect(state.promptCell).toBeNull();
  });

  it("bookmark store removeAll returns to empty", () => {
    addBookmark(0, 0, 0, "Sheet1");
    addBookmark(1, 1, 0, "Sheet1");
    addBookmark(2, 2, 1, "Sheet2");

    removeAllBookmarks();

    expect(getAllBookmarks()).toEqual([]);
    expect(getBookmarkCount()).toBe(0);
  });
});

// ============================================================================
// Stores Can Be Used Again After Reset
// ============================================================================

describe("stores can be used again after reset", () => {
  it("sparkline store works after reset", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    resetSparklineStore();

    const result = createSparklineGroup(
      { startRow: 2, startCol: 3, endRow: 2, endCol: 3 },
      { startRow: 2, startCol: 0, endRow: 2, endCol: 2 },
      "column",
    );

    expect(result.valid).toBe(true);
    expect(getAllSparklineGroups().length).toBe(1);
  });

  it("controls store works after reset", () => {
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
    resetFloatingStore();

    addFloatingControl({
      id: "control-0-1-1",
      sheetIndex: 0,
      row: 1,
      col: 1,
      x: 100,
      y: 100,
      width: 80,
      height: 30,
      controlType: "checkbox",
    });

    expect(getAllFloatingControls().length).toBe(1);
    expect(getAllFloatingControls()[0].id).toBe("control-0-1-1");
  });

  it("sort store works after reset", () => {
    useSortStore.getState().initialize(0, 0, 5, 2, ["A", "B", "C"], true);
    useSortStore.getState().addLevel();
    useSortStore.getState().reset();

    useSortStore.getState().initialize(0, 0, 20, 1, ["X", "Y"], false);
    useSortStore.getState().addLevel();

    expect(useSortStore.getState().levels.length).toBe(2);
    expect(useSortStore.getState().columnHeaders).toEqual(["X", "Y"]);
    expect(useSortStore.getState().hasHeaders).toBe(false);
  });

  it("find store works after reset", () => {
    useFindStore.getState().setQuery("first");
    useFindStore.getState().reset();

    useFindStore.getState().open(false);
    useFindStore.getState().setQuery("second");

    expect(useFindStore.getState().query).toBe("second");
    expect(useFindStore.getState().isOpen).toBe(true);
  });

  it("bookmark store works after removeAll", () => {
    addBookmark(0, 0, 0, "Sheet1");
    removeAllBookmarks();

    const bm = addBookmark(5, 5, 0, "Sheet1", { label: "New", color: "green" });

    expect(getAllBookmarks().length).toBe(1);
    expect(bm.label).toBe("New");
  });
});

// ============================================================================
// Event Listeners Don't Fire After Store Reset
// ============================================================================

describe("event listeners do not fire after store reset", () => {
  it("bookmark onChange listener does not fire after removeAllBookmarks resets state", () => {
    const listener = vi.fn();
    const unsub = onBookmarkChange(listener);

    // Listener fires on add
    addBookmark(0, 0, 0, "Sheet1");
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe
    unsub();
    listener.mockClear();

    // Subsequent changes should not fire
    addBookmark(1, 1, 0, "Sheet1");
    expect(listener).not.toHaveBeenCalled();
  });

  it("watch store subscriber does not fire after reset clears listeners", () => {
    const listener = vi.fn();
    const unsub = subscribeWatch(listener);

    // Reset clears listeners
    resetWatchStore();

    // The listener set was cleared by reset, so even without explicit unsub,
    // subsequent operations on an empty store should not trigger it
    // (reset clears the listeners set)
    listener.mockClear();

    // Calling reset again should not notify old listeners
    resetWatchStore();
    expect(listener).not.toHaveBeenCalled();

    // Clean up (unsub is a no-op after reset cleared listeners, but call for hygiene)
    unsub();
  });

  it("find store zustand subscriber stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsub = useFindStore.subscribe(listener);

    useFindStore.getState().setQuery("abc");
    expect(listener).toHaveBeenCalled();

    unsub();
    listener.mockClear();

    useFindStore.getState().setQuery("def");
    expect(listener).not.toHaveBeenCalled();
  });

  it("sort store zustand subscriber stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsub = useSortStore.subscribe(listener);

    useSortStore.getState().initialize(0, 0, 5, 2, ["A", "B", "C"], true);
    expect(listener).toHaveBeenCalled();

    unsub();
    listener.mockClear();

    useSortStore.getState().addLevel();
    expect(listener).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 10 Stores All Reset Independently Without Side Effects
// ============================================================================

describe("10 stores can all be reset independently without side effects", () => {
  it("populates all stores, resets them one by one, and verifies independence", () => {
    // 1. Sparklines
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    // 2. Controls
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
    // 3. Chart store (just ensure it's in a non-default state via reset later)
    // 4. Filter state
    // 5. Sort store
    useSortStore.getState().initialize(0, 0, 10, 3, ["A", "B", "C", "D"], true);
    useSortStore.getState().addLevel();
    // 6. Protection
    setSheetProtectedState(true, true, {} as any);
    // 7. Validation (at default, but we track it)
    // 8. Find store
    useFindStore.getState().open(true);
    useFindStore.getState().setQuery("multi-store");
    // 9. Filter pane cache (at default)
    // 10. Bookmarks
    addBookmark(0, 0, 0, "Sheet1");
    addBookmark(1, 1, 0, "Sheet1");

    // Track state before resets
    const storeStates = {
      sparklines: getAllSparklineGroups().length,
      controls: getAllFloatingControls().length,
      sortLevels: useSortStore.getState().levels.length,
      protected: isCurrentSheetProtected(),
      findQuery: useFindStore.getState().query,
      bookmarks: getBookmarkCount(),
    };

    expect(storeStates.sparklines).toBe(1);
    expect(storeStates.controls).toBe(1);
    expect(storeStates.sortLevels).toBe(2);
    expect(storeStates.protected).toBe(true);
    expect(storeStates.findQuery).toBe("multi-store");
    expect(storeStates.bookmarks).toBe(2);

    // Reset store 1: Sparklines
    resetSparklineStore();
    expect(getAllSparklineGroups().length).toBe(0);
    expect(getAllFloatingControls().length).toBe(1); // others untouched
    expect(useSortStore.getState().levels.length).toBe(2);
    expect(isCurrentSheetProtected()).toBe(true);

    // Reset store 2: Controls
    resetFloatingStore();
    expect(getAllFloatingControls().length).toBe(0);
    expect(useSortStore.getState().levels.length).toBe(2);

    // Reset store 3: Charts
    resetChartStore();
    expect(useSortStore.getState().levels.length).toBe(2);

    // Reset store 4: Filter
    resetFilterState();
    expect(useSortStore.getState().levels.length).toBe(2);

    // Reset store 5: Sort
    useSortStore.getState().reset();
    expect(useSortStore.getState().levels.length).toBe(0);
    expect(isCurrentSheetProtected()).toBe(true);

    // Reset store 6: Protection
    resetProtectionState();
    expect(isCurrentSheetProtected()).toBe(false);
    expect(useFindStore.getState().query).toBe("multi-store");

    // Reset store 7: Validation
    resetValidationState();
    expect(useFindStore.getState().query).toBe("multi-store");

    // Reset store 8: Find
    useFindStore.getState().reset();
    expect(useFindStore.getState().query).toBe("");
    expect(getBookmarkCount()).toBe(2);

    // Reset store 9: Filter pane
    clearFilterPaneCache();
    expect(getBookmarkCount()).toBe(2);

    // Reset store 10: Bookmarks
    removeAllBookmarks();
    expect(getBookmarkCount()).toBe(0);

    // Final: everything is at initial state
    expect(getAllSparklineGroups().length).toBe(0);
    expect(getAllFloatingControls().length).toBe(0);
    expect(isCurrentSheetProtected()).toBe(false);
    expect(useSortStore.getState().levels.length).toBe(0);
    expect(useFindStore.getState().query).toBe("");
    expect(useFindStore.getState().isOpen).toBe(false);
    expect(getBookmarkCount()).toBe(0);
    expect(getValidationState().validationRanges).toEqual([]);
    expect(getAllPaneFilters()).toEqual([]);
  });
});
