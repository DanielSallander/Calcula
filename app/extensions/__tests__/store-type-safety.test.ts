//! FILENAME: app/extensions/__tests__/store-type-safety.test.ts
// PURPOSE: Verify store getters return expected types, setters accept correct types, actions return expected types.
// CONTEXT: Runtime type-safety checks complementing TypeScript's static analysis.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Mocks
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

vi.mock("../AutoFilter/lib/filterEvents", () => ({
  FilterEvents: {
    FILTER_TOGGLED: "filter:toggled",
    FILTER_APPLIED: "filter:applied",
    FILTER_CLEARED: "filter:cleared",
    FILTER_STATE_REFRESHED: "filter:state-refreshed",
  },
}));

vi.mock("../DataValidation/lib/validationEvents", () => ({
  ValidationEvents: {
    VALIDATION_CHANGED: "validation:changed",
    CIRCLES_TOGGLED: "validation:circles-toggled",
  },
}));

vi.mock("../FilterPane/lib/filterPaneApi", () => ({
  createRibbonFilter: vi.fn(),
  deleteRibbonFilter: vi.fn(),
  updateRibbonFilter: vi.fn(),
  updateRibbonFilterSelection: vi.fn(),
  getAllRibbonFilters: vi.fn().mockResolvedValue([]),
  getRibbonFilterItems: vi.fn(),
  getBiColumnValues: vi.fn(),
  getBiColumnAvailableValues: vi.fn(),
}));

vi.mock("../FilterPane/lib/filterPaneEvents", () => ({
  FilterPaneEvents: {
    FILTER_CREATED: "filterpane:filter-created",
    FILTER_DELETED: "filterpane:filter-deleted",
    FILTER_UPDATED: "filterpane:filter-updated",
    FILTER_SELECTION_CHANGED: "filterpane:filter-selection-changed",
    FILTERS_REFRESHED: "filterpane:filters-refreshed",
  },
}));

vi.mock("../FilterPane/lib/filterPaneFilterBridge", () => ({
  applyRibbonFilter: vi.fn(),
  clearRibbonFilter: vi.fn(),
}));

vi.mock("../ScriptEditor/lib/scriptApi", () => ({
  listScripts: vi.fn().mockResolvedValue([]),
  getScript: vi.fn(),
  saveScript: vi.fn(),
  deleteScript: vi.fn(),
  renameScript: vi.fn(),
}));

vi.mock("../ScriptNotebook/lib/notebookApi", () => ({
  listNotebooks: vi.fn().mockResolvedValue([]),
  createNotebook: vi.fn(),
  saveNotebook: vi.fn(),
  loadNotebook: vi.fn(),
  deleteNotebook: vi.fn(),
  runNotebookCell: vi.fn(),
  runAllCells: vi.fn(),
  rewindNotebook: vi.fn(),
  runFromCell: vi.fn(),
  resetNotebookRuntime: vi.fn(),
}));

vi.mock("@api/backend", () => ({
  invokeBackend: vi.fn(),
}));

// ============================================================================
// Imports
// ============================================================================

import { useSortStore } from "../Sorting/hooks/useSortState";
import { useFindStore } from "../BuiltIn/FindReplaceDialog/useFindStore";
import {
  getValidationState,
  getValidationRanges,
  getInvalidCellsList,
  isCirclesActive,
  getOpenDropdownCell,
  getCurrentSelection,
  setCurrentSelection,
  setOpenDropdownCell,
  setPromptState,
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
import { useModuleStore } from "../ScriptEditor/lib/useModuleStore";
import { useNotebookStore } from "../ScriptNotebook/lib/useNotebookStore";

// ============================================================================
// Sort Store - Type Safety
// ============================================================================

describe("Sort store type safety", () => {
  beforeEach(() => {
    useSortStore.getState().reset();
  });

  it("getters return correct types", () => {
    const s = useSortStore.getState();
    expect(typeof s.hasHeaders).toBe("boolean");
    expect(typeof s.caseSensitive).toBe("boolean");
    expect(typeof s.orientation).toBe("string");
    expect(typeof s.rangeStartRow).toBe("number");
    expect(Array.isArray(s.levels)).toBe(true);
    expect(Array.isArray(s.columnHeaders)).toBe(true);
  });

  it("actions are functions", () => {
    const s = useSortStore.getState();
    expect(typeof s.addLevel).toBe("function");
    expect(typeof s.deleteLevel).toBe("function");
    expect(typeof s.reset).toBe("function");
    expect(typeof s.initialize).toBe("function");
  });

  it("setHasHeaders accepts boolean and updates state", () => {
    useSortStore.getState().setHasHeaders(false);
    expect(useSortStore.getState().hasHeaders).toBe(false);
  });

  it("setOrientation accepts string and updates state", () => {
    useSortStore.getState().setOrientation("columns");
    expect(useSortStore.getState().orientation).toBe("columns");
  });
});

// ============================================================================
// Find Store - Type Safety
// ============================================================================

describe("Find store type safety", () => {
  beforeEach(() => {
    useFindStore.getState().reset();
  });

  it("getters return correct types", () => {
    const s = useFindStore.getState();
    expect(typeof s.isOpen).toBe("boolean");
    expect(typeof s.showReplace).toBe("boolean");
    expect(typeof s.query).toBe("string");
    expect(typeof s.replaceText).toBe("string");
    expect(typeof s.currentIndex).toBe("number");
    expect(Array.isArray(s.matches)).toBe(true);
    expect(typeof s.options).toBe("object");
    expect(s.options).not.toBeNull();
  });

  it("setQuery accepts string", () => {
    useFindStore.getState().setQuery("hello");
    expect(useFindStore.getState().query).toBe("hello");
  });

  it("setOptions merges partial options", () => {
    useFindStore.getState().setOptions({ caseSensitive: true });
    const opts = useFindStore.getState().options;
    expect(opts.caseSensitive).toBe(true);
    expect(opts.matchEntireCell).toBe(false); // unchanged
  });

  it("open returns void (not undefined state)", () => {
    const result = useFindStore.getState().open(true);
    expect(result).toBeUndefined(); // void action
    expect(useFindStore.getState().isOpen).toBe(true);
  });
});

// ============================================================================
// Validation Store - Type Safety
// ============================================================================

describe("Validation store type safety", () => {
  beforeEach(() => {
    resetValidationState();
  });

  it("getters return correct types", () => {
    expect(typeof isCirclesActive()).toBe("boolean");
    expect(Array.isArray(getValidationRanges())).toBe(true);
    expect(getInvalidCellsList()).toBeNull();
    expect(getOpenDropdownCell()).toBeNull();
    expect(getCurrentSelection()).toBeNull();
  });

  it("setCurrentSelection accepts object and updates getter", () => {
    const sel = { startRow: 0, startCol: 0, endRow: 5, endCol: 5, activeRow: 0, activeCol: 0 };
    setCurrentSelection(sel);
    expect(getCurrentSelection()).toEqual(sel);
  });

  it("setOpenDropdownCell accepts object", () => {
    setOpenDropdownCell({ row: 1, col: 2 });
    expect(getOpenDropdownCell()).toEqual({ row: 1, col: 2 });
  });

  it("setPromptState updates validation state", () => {
    setPromptState(true, { row: 3, col: 4 });
    const state = getValidationState();
    expect(state.promptVisible).toBe(true);
    expect(state.promptCell).toEqual({ row: 3, col: 4 });
  });
});

// ============================================================================
// Filter Store - Type Safety
// ============================================================================

describe("Filter store type safety", () => {
  beforeEach(() => {
    resetFilterState();
  });

  it("getters return correct types", () => {
    expect(typeof isFilterActive()).toBe("boolean");
    expect(getAutoFilterInfo()).toBeNull();
    expect(getOpenDropdownCol()).toBeNull();
    expect(typeof getFilterState()).toBe("object");
  });

  it("setOpenDropdownCol accepts number", () => {
    setOpenDropdownCol(3);
    expect(getOpenDropdownCol()).toBe(3);
  });

  it("setOpenDropdownCol accepts null", () => {
    setOpenDropdownCol(3);
    setOpenDropdownCol(null);
    expect(getOpenDropdownCol()).toBeNull();
  });
});

// ============================================================================
// Protection Store - Type Safety
// ============================================================================

describe("Protection store type safety", () => {
  beforeEach(() => {
    resetProtectionState();
  });

  it("getters return correct types", () => {
    expect(typeof isCurrentSheetProtected()).toBe("boolean");
    expect(typeof currentSheetHasPassword()).toBe("boolean");
    expect(typeof isCurrentWorkbookProtected()).toBe("boolean");
    expect(typeof getSheetOptions()).toBe("object");
  });

  it("setSheetProtectedState updates all related getters", () => {
    const opts = { ...getSheetOptions(), formatCells: true };
    setSheetProtectedState(true, true, opts);
    expect(isCurrentSheetProtected()).toBe(true);
    expect(currentSheetHasPassword()).toBe(true);
    expect(getSheetOptions().formatCells).toBe(true);
  });

  it("setWorkbookProtectedState accepts boolean", () => {
    setWorkbookProtectedState(true);
    expect(isCurrentWorkbookProtected()).toBe(true);
  });

  it("all protection option values are booleans", () => {
    const opts = getSheetOptions();
    for (const [key, value] of Object.entries(opts)) {
      expect(typeof value, `protection option "${key}" should be boolean`).toBe("boolean");
    }
  });
});

// ============================================================================
// Module Store - Type Safety
// ============================================================================

describe("ScriptEditor module store type safety", () => {
  beforeEach(() => {
    useModuleStore.setState({
      modules: [],
      activeModuleId: null,
      dirtyModuleIds: [],
      loaded: false,
      navPaneVisible: true,
    });
  });

  it("getters return correct types", () => {
    const s = useModuleStore.getState();
    expect(Array.isArray(s.modules)).toBe(true);
    expect(s.activeModuleId).toBeNull();
    expect(Array.isArray(s.dirtyModuleIds)).toBe(true);
    expect(typeof s.loaded).toBe("boolean");
    expect(typeof s.navPaneVisible).toBe("boolean");
  });

  it("selectModule updates activeModuleId to string", () => {
    useModuleStore.getState().selectModule("test-id");
    expect(useModuleStore.getState().activeModuleId).toBe("test-id");
  });

  it("toggleNavPane toggles boolean", () => {
    expect(useModuleStore.getState().navPaneVisible).toBe(true);
    useModuleStore.getState().toggleNavPane();
    expect(useModuleStore.getState().navPaneVisible).toBe(false);
  });
});

// ============================================================================
// Notebook Store - Type Safety
// ============================================================================

describe("ScriptNotebook store type safety", () => {
  beforeEach(() => {
    useNotebookStore.setState({
      notebooks: [],
      activeNotebook: null,
      isExecuting: false,
      executingCellId: null,
    });
  });

  it("getters return correct types", () => {
    const s = useNotebookStore.getState();
    expect(Array.isArray(s.notebooks)).toBe(true);
    expect(s.activeNotebook).toBeNull();
    expect(typeof s.isExecuting).toBe("boolean");
    expect(s.executingCellId).toBeNull();
  });

  it("actions are functions", () => {
    const s = useNotebookStore.getState();
    expect(typeof s.refreshNotebookList).toBe("function");
    expect(typeof s.addCell).toBe("function");
    expect(typeof s.removeCell).toBe("function");
    expect(typeof s.runCell).toBe("function");
    expect(typeof s.runAll).toBe("function");
  });
});
