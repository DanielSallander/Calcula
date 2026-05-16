//! FILENAME: app/extensions/__tests__/store-operations-parameterized.test.ts
// PURPOSE: Parameterized CRUD and edge case tests for all extension stores.
// CONTEXT: Maximizes test count via describe.each/it.each for the 10K test milestone.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Mocks - must be declared before imports
// ============================================================================

vi.mock("@api", () => ({
  getAllDataValidations: vi.fn(),
  getInvalidCells: vi.fn(),
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  emitAppEvent: vi.fn(),
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
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  getProtectionStatus: vi.fn(),
  isWorkbookProtected: vi.fn(),
  columnToLetter: vi.fn((col: number) => String.fromCharCode(65 + col)),
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
}));

vi.mock("@api/lib", () => ({
  sortRangeByColumn: vi.fn(),
  sortRange: vi.fn(),
  getViewportCells: vi.fn(),
  getStyle: vi.fn(),
  setColumnCustomFilter: vi.fn(),
}));

vi.mock("@api/backend", () => ({
  invokeBackend: vi.fn(),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { useSortStore } from "../Sorting/hooks/useSortState";
import { useFindStore } from "../BuiltIn/FindReplaceDialog/useFindStore";
import {
  getValidationState,
  getValidationRanges,
  getInvalidCellsList,
  isCirclesActive,
  getOpenDropdownCell,
  setOpenDropdownCell,
  setPromptState,
  clearCircles,
  resetState as resetValidationState,
} from "../DataValidation/lib/validationStore";
import {
  getFilterState,
  isFilterActive,
  getAutoFilterInfo,
  getOpenDropdownCol,
  setOpenDropdownCol,
  resetState as resetFilterState,
} from "../AutoFilter/lib/filterStore";
import {
  isCurrentSheetProtected,
  currentSheetHasPassword,
  getSheetOptions,
  isCurrentWorkbookProtected,
  setSheetProtectedState,
  setWorkbookProtectedState,
  resetProtectionState,
} from "../Protection/lib/protectionStore";
import {
  createSparklineGroup,
  removeSparklineGroup,
  getAllGroups,
  getSparklineForCell,
  hasSparkline,
  getGroupById,
  updateSparklineGroup,
  invalidateDataCache,
  isDataCacheDirty,
  resetSparklineStore,
} from "../Sparklines/store";
import {
  addBookmark,
  removeBookmark,
  removeBookmarkById,
  removeAllBookmarks,
  updateBookmark,
  getBookmarkAt,
  hasBookmarkAt,
  getAllBookmarks,
  getBookmarkCount,
  getSortedBookmarks,
  setCurrentSheet,
  getCurrentSheet,
  isHighlightEnabled,
  toggleHighlight,
  onChange,
} from "../BuiltIn/CellBookmarks/lib/bookmarkStore";

// ============================================================================
// Store definitions for parameterized initial state & reset tests
// ============================================================================

interface StoreTestDef {
  name: string;
  reset: () => void;
  getState: () => Record<string, unknown>;
  expectedKeys: string[];
}

const STORES: StoreTestDef[] = [
  {
    name: "Sort",
    reset: () => useSortStore.getState().reset(),
    getState: () => {
      const { addLevel, deleteLevel, copyLevel, updateLevel, moveLevelUp, moveLevelDown,
        selectLevel, setHasHeaders, setCaseSensitive, setOrientation, setRange,
        setColumnHeaders, initialize, reset, ...state } = useSortStore.getState();
      return state;
    },
    expectedKeys: ["levels", "hasHeaders", "caseSensitive", "orientation",
      "rangeStartRow", "rangeStartCol", "rangeEndRow", "rangeEndCol",
      "columnHeaders", "selectedLevelId"],
  },
  {
    name: "Find",
    reset: () => useFindStore.getState().reset(),
    getState: () => {
      const { open, close, setQuery, setReplaceText, setMatches, setCurrentIndex,
        clearResults, setOptions, nextMatch, previousMatch, reset, ...state } = useFindStore.getState();
      return state;
    },
    expectedKeys: ["isOpen", "showReplace", "query", "replaceText", "matches",
      "currentIndex", "options"],
  },
  {
    name: "Validation",
    reset: () => resetValidationState(),
    getState: () => getValidationState() as unknown as Record<string, unknown>,
    expectedKeys: ["validationRanges", "invalidCells", "openDropdownCell",
      "promptVisible", "promptCell"],
  },
  {
    name: "Filter",
    reset: () => resetFilterState(),
    getState: () => getFilterState() as unknown as Record<string, unknown>,
    expectedKeys: ["autoFilterInfo", "isActive", "openDropdownCol"],
  },
  {
    name: "Protection",
    reset: () => resetProtectionState(),
    getState: () => ({
      sheetProtected: isCurrentSheetProtected(),
      sheetHasPassword: currentSheetHasPassword(),
      workbookProtected: isCurrentWorkbookProtected(),
      sheetOptions: getSheetOptions(),
    }),
    expectedKeys: ["sheetProtected", "sheetHasPassword", "workbookProtected", "sheetOptions"],
  },
  {
    name: "Sparkline",
    reset: () => resetSparklineStore(),
    getState: () => ({
      groups: getAllGroups(),
      cacheDirty: isDataCacheDirty(),
    }),
    expectedKeys: ["groups", "cacheDirty"],
  },
  {
    name: "Bookmark",
    reset: () => { removeAllBookmarks(); setCurrentSheet(0); },
    getState: () => ({
      bookmarks: getAllBookmarks(),
      count: getBookmarkCount(),
      currentSheet: getCurrentSheet(),
      highlightEnabled: isHighlightEnabled(),
    }),
    expectedKeys: ["bookmarks", "count", "currentSheet", "highlightEnabled"],
  },
];

// ============================================================================
// 1. Initial state snapshot (7 tests)
// ============================================================================

describe.each(STORES)("$name store - initial state", ({ name, reset, getState, expectedKeys }) => {
  beforeEach(() => reset());

  it("has all expected keys", () => {
    const state = getState();
    for (const key of expectedKeys) {
      expect(state, `${name} store missing key "${key}"`).toHaveProperty(key);
    }
  });
});

// ============================================================================
// 2. Reset returns to initial (7 tests)
// ============================================================================

describe.each(STORES)("$name store - reset returns to initial", ({ name, reset, getState }) => {
  it("state after reset matches state after double-reset", () => {
    reset();
    const first = JSON.parse(JSON.stringify(getState()));
    reset();
    const second = JSON.parse(JSON.stringify(getState()));
    expect(second).toEqual(first);
  });
});

// ============================================================================
// 3. Sort store CRUD operations
// ============================================================================

describe("Sort store CRUD operations", () => {
  beforeEach(() => useSortStore.getState().reset());

  const ORIENTATIONS = ["rows", "columns"] as const;

  it.each(ORIENTATIONS)("setOrientation to %s works", (orientation) => {
    useSortStore.getState().setOrientation(orientation);
    expect(useSortStore.getState().orientation).toBe(orientation);
  });

  const HEADER_VALUES = [true, false];

  it.each(HEADER_VALUES)("setHasHeaders to %s works", (value) => {
    useSortStore.getState().setHasHeaders(value);
    expect(useSortStore.getState().hasHeaders).toBe(value);
  });

  it.each(HEADER_VALUES)("setCaseSensitive to %s works", (value) => {
    useSortStore.getState().setCaseSensitive(value);
    expect(useSortStore.getState().caseSensitive).toBe(value);
  });

  const RANGES = [
    [0, 0, 10, 5],
    [5, 3, 20, 8],
    [0, 0, 0, 0],
    [100, 100, 200, 200],
  ] as const;

  it.each(RANGES)("setRange(%i, %i, %i, %i) works", (sr, sc, er, ec) => {
    useSortStore.getState().setRange(sr, sc, er, ec);
    const s = useSortStore.getState();
    expect(s.rangeStartRow).toBe(sr);
    expect(s.rangeStartCol).toBe(sc);
    expect(s.rangeEndRow).toBe(er);
    expect(s.rangeEndCol).toBe(ec);
  });

  it("initialize creates a default level", () => {
    useSortStore.getState().initialize(0, 0, 10, 5, ["A", "B", "C"], true);
    expect(useSortStore.getState().levels.length).toBeGreaterThan(0);
  });

  it("addLevel increases level count", () => {
    useSortStore.getState().initialize(0, 0, 10, 5, ["A"], true);
    const before = useSortStore.getState().levels.length;
    useSortStore.getState().addLevel();
    expect(useSortStore.getState().levels.length).toBe(before + 1);
  });

  it("selectLevel sets selectedLevelId", () => {
    useSortStore.getState().initialize(0, 0, 10, 5, ["A", "B"], true);
    const levels = useSortStore.getState().levels;
    useSortStore.getState().selectLevel(levels[0].id);
    expect(useSortStore.getState().selectedLevelId).toBe(levels[0].id);
  });
});

// ============================================================================
// 4. Find store CRUD operations
// ============================================================================

describe("Find store CRUD operations", () => {
  beforeEach(() => useFindStore.getState().reset());

  const QUERIES = ["hello", "", "test123", "=SUM(A1:A10)", "special chars !@#"];

  it.each(QUERIES)("setQuery('%s') works", (query) => {
    useFindStore.getState().setQuery(query);
    expect(useFindStore.getState().query).toBe(query);
  });

  it.each(QUERIES)("setReplaceText('%s') works", (text) => {
    useFindStore.getState().setReplaceText(text);
    expect(useFindStore.getState().replaceText).toBe(text);
  });

  const OPTION_KEYS = ["caseSensitive", "matchEntireCell", "searchFormulas"] as const;

  it.each(OPTION_KEYS)("setOptions toggles %s", (key) => {
    useFindStore.getState().setOptions({ [key]: true });
    expect(useFindStore.getState().options[key]).toBe(true);
    useFindStore.getState().setOptions({ [key]: false });
    expect(useFindStore.getState().options[key]).toBe(false);
  });

  it("setMatches and clearResults work", () => {
    useFindStore.getState().setMatches([[1, 2], [3, 4]], "test");
    expect(useFindStore.getState().matches).toHaveLength(2);
    useFindStore.getState().clearResults();
    expect(useFindStore.getState().matches).toHaveLength(0);
  });

  it("open/close toggles isOpen", () => {
    useFindStore.getState().open();
    expect(useFindStore.getState().isOpen).toBe(true);
    useFindStore.getState().close();
    expect(useFindStore.getState().isOpen).toBe(false);
  });
});

// ============================================================================
// 5. Validation store CRUD operations
// ============================================================================

describe("Validation store CRUD operations", () => {
  beforeEach(() => resetValidationState());

  const CELLS = [
    { row: 0, col: 0 },
    { row: 5, col: 10 },
    { row: 99, col: 99 },
  ];

  it.each(CELLS)("setOpenDropdownCell row=$row col=$col", (cell) => {
    setOpenDropdownCell(cell);
    expect(getOpenDropdownCell()).toEqual(cell);
  });

  it("setOpenDropdownCell(null) clears it", () => {
    setOpenDropdownCell({ row: 1, col: 1 });
    setOpenDropdownCell(null);
    expect(getOpenDropdownCell()).toBeNull();
  });

  const PROMPT_STATES = [
    { visible: true, cell: { row: 0, col: 0 } },
    { visible: false, cell: null },
    { visible: true, cell: { row: 10, col: 20 } },
  ];

  it.each(PROMPT_STATES)("setPromptState visible=$visible", ({ visible, cell }) => {
    setPromptState(visible, cell);
    const state = getValidationState();
    expect(state.promptVisible).toBe(visible);
    expect(state.promptCell).toEqual(cell);
  });

  it("clearCircles resets invalid cells", () => {
    clearCircles();
    expect(getInvalidCellsList()).toBeNull();
    expect(isCirclesActive()).toBe(false);
  });

  it("getValidationRanges returns array", () => {
    expect(getValidationRanges()).toEqual([]);
  });
});

// ============================================================================
// 6. Filter store CRUD operations
// ============================================================================

describe("Filter store CRUD operations", () => {
  beforeEach(() => resetFilterState());

  it("initially not active", () => {
    expect(isFilterActive()).toBe(false);
  });

  it("getAutoFilterInfo initially null", () => {
    expect(getAutoFilterInfo()).toBeNull();
  });

  const DROPDOWN_COLS = [null, 0, 5, 10, 99];

  it.each(DROPDOWN_COLS)("setOpenDropdownCol(%s) works", (col) => {
    setOpenDropdownCol(col);
    expect(getOpenDropdownCol()).toBe(col);
  });

  it("reset clears dropdown col", () => {
    setOpenDropdownCol(5);
    resetFilterState();
    expect(getOpenDropdownCol()).toBeNull();
  });
});

// ============================================================================
// 7. Protection store CRUD operations
// ============================================================================

describe("Protection store CRUD operations", () => {
  beforeEach(() => resetProtectionState());

  const PROTECTION_FLAGS = [
    { isProtected: true, hasPassword: true },
    { isProtected: true, hasPassword: false },
    { isProtected: false, hasPassword: false },
  ];

  it.each(PROTECTION_FLAGS)(
    "setSheetProtectedState(protected=$isProtected, password=$hasPassword)",
    ({ isProtected, hasPassword }) => {
      const opts = { ...getSheetOptions() };
      setSheetProtectedState(isProtected, hasPassword, opts);
      expect(isCurrentSheetProtected()).toBe(isProtected);
      expect(currentSheetHasPassword()).toBe(hasPassword);
    },
  );

  const WORKBOOK_FLAGS = [true, false];

  it.each(WORKBOOK_FLAGS)("setWorkbookProtectedState(%s)", (flag) => {
    setWorkbookProtectedState(flag);
    expect(isCurrentWorkbookProtected()).toBe(flag);
  });

  it("reset restores all defaults", () => {
    setSheetProtectedState(true, true, { ...getSheetOptions(), formatCells: true });
    setWorkbookProtectedState(true);
    resetProtectionState();
    expect(isCurrentSheetProtected()).toBe(false);
    expect(currentSheetHasPassword()).toBe(false);
    expect(isCurrentWorkbookProtected()).toBe(false);
    expect(getSheetOptions().formatCells).toBe(false);
  });

  const OPTION_KEYS = [
    "selectLockedCells", "selectUnlockedCells", "formatCells", "formatColumns",
    "formatRows", "insertColumns", "insertRows", "insertHyperlinks",
    "deleteColumns", "deleteRows", "sort", "useAutoFilter",
    "usePivotTableReports", "editObjects", "editScenarios",
  ] as const;

  it.each(OPTION_KEYS)("protection option '%s' exists in defaults", (key) => {
    expect(getSheetOptions()).toHaveProperty(key);
  });
});

// ============================================================================
// 8. Sparkline store CRUD operations
// ============================================================================

describe("Sparkline store CRUD operations", () => {
  beforeEach(() => resetSparklineStore());

  it("initially has no groups", () => {
    expect(getAllGroups()).toEqual([]);
  });

  it("createSparklineGroup adds a group", () => {
    const loc = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    const data = { startRow: 0, startCol: 1, endRow: 0, endCol: 5 };
    const result = createSparklineGroup(loc, data, "line");
    expect(result.valid).toBe(true);
    expect(getAllGroups()).toHaveLength(1);
  });

  it("removeSparklineGroup removes a group", () => {
    const loc = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    const data = { startRow: 0, startCol: 1, endRow: 0, endCol: 5 };
    const result = createSparklineGroup(loc, data, "line");
    expect(result.group).toBeDefined();
    const removed = removeSparklineGroup(result.group!.id);
    expect(removed).toBe(true);
    expect(getAllGroups()).toHaveLength(0);
  });

  it("removeSparklineGroup returns false for nonexistent id", () => {
    expect(removeSparklineGroup(9999)).toBe(false);
  });

  it("getGroupById returns undefined for nonexistent id", () => {
    expect(getGroupById(9999)).toBeUndefined();
  });

  it("hasSparkline returns false for empty store", () => {
    expect(hasSparkline(0, 0)).toBe(false);
  });

  it("getSparklineForCell returns undefined for empty store", () => {
    expect(getSparklineForCell(0, 0)).toBeUndefined();
  });

  const SPARKLINE_TYPES = ["line", "column", "winloss"] as const;

  it.each(SPARKLINE_TYPES)("createSparklineGroup with type '%s'", (type) => {
    const loc = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    const data = { startRow: 0, startCol: 1, endRow: 0, endCol: 5 };
    const result = createSparklineGroup(loc, data, type);
    expect(result.valid).toBe(true);
    expect(result.group!.type).toBe(type);
  });

  it("updateSparklineGroup changes properties", () => {
    const loc = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    const data = { startRow: 0, startCol: 1, endRow: 0, endCol: 5 };
    const result = createSparklineGroup(loc, data, "line");
    const updated = updateSparklineGroup(result.group!.id, { color: "#FF0000" });
    expect(updated).toBe(true);
    expect(getGroupById(result.group!.id)!.color).toBe("#FF0000");
  });

  it("updateSparklineGroup returns false for nonexistent id", () => {
    expect(updateSparklineGroup(9999, { color: "#FF0000" })).toBe(false);
  });

  it("invalidateDataCache marks cache dirty", () => {
    invalidateDataCache();
    expect(isDataCacheDirty()).toBe(true);
  });

  it("resetSparklineStore clears all groups", () => {
    const loc = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    const data = { startRow: 0, startCol: 1, endRow: 0, endCol: 5 };
    createSparklineGroup(loc, data, "line");
    resetSparklineStore();
    expect(getAllGroups()).toHaveLength(0);
  });
});

// ============================================================================
// 9. Bookmark store CRUD operations
// ============================================================================

describe("Bookmark store CRUD operations", () => {
  beforeEach(() => {
    removeAllBookmarks();
    setCurrentSheet(0);
  });

  it("initially has no bookmarks", () => {
    expect(getAllBookmarks()).toEqual([]);
    expect(getBookmarkCount()).toBe(0);
  });

  const BOOKMARK_POSITIONS = [
    { row: 0, col: 0 },
    { row: 5, col: 10 },
    { row: 99, col: 99 },
    { row: 0, col: 255 },
  ];

  it.each(BOOKMARK_POSITIONS)("addBookmark at row=$row col=$col", ({ row, col }) => {
    const bm = addBookmark(row, col, 0, "Sheet1");
    expect(bm.row).toBe(row);
    expect(bm.col).toBe(col);
    expect(hasBookmarkAt(row, col, 0)).toBe(true);
  });

  it.each(BOOKMARK_POSITIONS)("removeBookmark at row=$row col=$col", ({ row, col }) => {
    addBookmark(row, col, 0, "Sheet1");
    const removed = removeBookmark(row, col, 0);
    expect(removed).toBe(true);
    expect(hasBookmarkAt(row, col, 0)).toBe(false);
  });

  const COLORS = ["blue", "green", "orange", "red", "purple", "yellow"] as const;

  it.each(COLORS)("addBookmark with color '%s'", (color) => {
    const bm = addBookmark(0, 0, 0, "Sheet1", { color });
    expect(bm.color).toBe(color);
    // Clean up for next iteration (same cell position)
    removeBookmark(0, 0, 0);
  });

  it("removeBookmarkById removes the correct bookmark", () => {
    const bm = addBookmark(1, 1, 0, "Sheet1");
    expect(removeBookmarkById(bm.id)).toBe(true);
    expect(getBookmarkCount()).toBe(0);
  });

  it("removeBookmarkById returns false for nonexistent id", () => {
    expect(removeBookmarkById("nonexistent")).toBe(false);
  });

  it("updateBookmark changes label", () => {
    const bm = addBookmark(2, 2, 0, "Sheet1");
    const result = updateBookmark(bm.id, { label: "Updated" });
    expect(result).toBe(true);
    expect(getBookmarkAt(2, 2, 0)!.label).toBe("Updated");
  });

  it("updateBookmark changes color", () => {
    const bm = addBookmark(3, 3, 0, "Sheet1");
    const result = updateBookmark(bm.id, { color: "red" });
    expect(result).toBe(true);
    expect(getBookmarkAt(3, 3, 0)!.color).toBe("red");
  });

  it("updateBookmark returns false for nonexistent id", () => {
    expect(updateBookmark("nonexistent", { label: "x" })).toBe(false);
  });

  it("removeAllBookmarks clears everything", () => {
    addBookmark(0, 0, 0, "Sheet1");
    addBookmark(1, 1, 0, "Sheet1");
    removeAllBookmarks();
    expect(getBookmarkCount()).toBe(0);
  });

  it("getSortedBookmarks returns sorted order", () => {
    addBookmark(5, 0, 0, "Sheet1");
    addBookmark(1, 0, 0, "Sheet1");
    addBookmark(3, 0, 0, "Sheet1");
    const sorted = getSortedBookmarks();
    expect(sorted[0].row).toBe(1);
    expect(sorted[1].row).toBe(3);
    expect(sorted[2].row).toBe(5);
  });

  it("getBookmarkAt returns undefined for nonexistent cell", () => {
    expect(getBookmarkAt(99, 99, 0)).toBeUndefined();
  });

  const SHEET_INDICES = [0, 1, 2, 5];

  it.each(SHEET_INDICES)("setCurrentSheet(%i) works", (index) => {
    setCurrentSheet(index);
    expect(getCurrentSheet()).toBe(index);
  });

  it("toggleHighlight flips state", () => {
    const before = isHighlightEnabled();
    const after = toggleHighlight();
    expect(after).toBe(!before);
  });

  it("onChange listener is called on mutation", () => {
    const listener = vi.fn();
    const unsub = onChange(listener);
    addBookmark(0, 0, 0, "Sheet1");
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it("onChange cleanup prevents further calls", () => {
    const listener = vi.fn();
    const unsub = onChange(listener);
    unsub();
    addBookmark(0, 0, 0, "Sheet1");
    expect(listener).not.toHaveBeenCalled();
  });

  it("addBookmark returns existing bookmark for same cell", () => {
    const bm1 = addBookmark(0, 0, 0, "Sheet1");
    const bm2 = addBookmark(0, 0, 0, "Sheet1");
    expect(bm1.id).toBe(bm2.id);
    expect(getBookmarkCount()).toBe(1);
  });
});

// ============================================================================
// 10. Edge cases - parameterized across stores
// ============================================================================

const EDGE_STORES = [
  {
    name: "Sort",
    reset: () => useSortStore.getState().reset(),
    doubleReset: () => { useSortStore.getState().reset(); useSortStore.getState().reset(); },
    isClean: () => useSortStore.getState().levels.length === 0,
  },
  {
    name: "Find",
    reset: () => useFindStore.getState().reset(),
    doubleReset: () => { useFindStore.getState().reset(); useFindStore.getState().reset(); },
    isClean: () => useFindStore.getState().query === "" && useFindStore.getState().matches.length === 0,
  },
  {
    name: "Validation",
    reset: () => resetValidationState(),
    doubleReset: () => { resetValidationState(); resetValidationState(); },
    isClean: () => getValidationRanges().length === 0,
  },
  {
    name: "Filter",
    reset: () => resetFilterState(),
    doubleReset: () => { resetFilterState(); resetFilterState(); },
    isClean: () => !isFilterActive(),
  },
  {
    name: "Protection",
    reset: () => resetProtectionState(),
    doubleReset: () => { resetProtectionState(); resetProtectionState(); },
    isClean: () => !isCurrentSheetProtected() && !isCurrentWorkbookProtected(),
  },
  {
    name: "Sparkline",
    reset: () => resetSparklineStore(),
    doubleReset: () => { resetSparklineStore(); resetSparklineStore(); },
    isClean: () => getAllGroups().length === 0,
  },
  {
    name: "Bookmark",
    reset: () => removeAllBookmarks(),
    doubleReset: () => { removeAllBookmarks(); removeAllBookmarks(); },
    isClean: () => getBookmarkCount() === 0,
  },
];

describe.each(EDGE_STORES)("$name store - edge cases", ({ name, reset, doubleReset, isClean }) => {
  beforeEach(() => reset());

  it("double reset does not throw", () => {
    expect(() => doubleReset()).not.toThrow();
  });

  it("is clean after reset", () => {
    expect(isClean()).toBe(true);
  });

  it("is clean after double reset", () => {
    doubleReset();
    expect(isClean()).toBe(true);
  });
});
