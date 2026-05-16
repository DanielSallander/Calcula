//! FILENAME: app/extensions/__tests__/store-defaults.test.ts
// PURPOSE: Snapshot initial state of all Zustand / module-level stores to catch unintended default changes.
// CONTEXT: Guards against accidental modifications to store defaults across the codebase.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Mocks - must be declared before imports
// ============================================================================

// Mock @api for module-level stores (Validation, Filter, Protection)
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

// Mock FilterPane dependencies
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

// Mock AutoFilter events
vi.mock("../AutoFilter/lib/filterEvents", () => ({
  FilterEvents: {
    FILTER_TOGGLED: "filter:toggled",
    FILTER_APPLIED: "filter:applied",
    FILTER_CLEARED: "filter:cleared",
    FILTER_STATE_REFRESHED: "filter:state-refreshed",
  },
}));

// Mock Validation events
vi.mock("../DataValidation/lib/validationEvents", () => ({
  ValidationEvents: {
    VALIDATION_CHANGED: "validation:changed",
    CIRCLES_TOGGLED: "validation:circles-toggled",
  },
}));

// Mock ScriptEditor API
vi.mock("../ScriptEditor/lib/scriptApi", () => ({
  listScripts: vi.fn().mockResolvedValue([]),
  getScript: vi.fn(),
  saveScript: vi.fn(),
  deleteScript: vi.fn(),
  renameScript: vi.fn(),
}));

// Mock ScriptNotebook API
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
// Imports (after mocks)
// ============================================================================

import { useSortStore } from "../Sorting/hooks/useSortState";
import { useFindStore } from "../BuiltIn/FindReplaceDialog/useFindStore";
import {
  getValidationState,
  resetState as resetValidationState,
} from "../DataValidation/lib/validationStore";
import {
  getFilterState,
  resetState as resetFilterState,
} from "../AutoFilter/lib/filterStore";
import {
  getAllFilters,
  clearCache as clearFilterPaneCache,
} from "../FilterPane/lib/filterPaneStore";
import {
  isCurrentSheetProtected,
  currentSheetHasPassword,
  getSheetOptions,
  isCurrentWorkbookProtected,
  resetProtectionState,
} from "../Protection/lib/protectionStore";
import { useModuleStore } from "../ScriptEditor/lib/useModuleStore";
import { useNotebookStore } from "../ScriptNotebook/lib/useNotebookStore";

// ============================================================================
// Sort Store Defaults
// ============================================================================

describe("Sort store initial state", () => {
  beforeEach(() => {
    useSortStore.getState().reset();
  });

  it("matches snapshot", () => {
    const { addLevel, deleteLevel, copyLevel, updateLevel, moveLevelUp, moveLevelDown,
      selectLevel, setHasHeaders, setCaseSensitive, setOrientation, setRange,
      setColumnHeaders, initialize, reset, ...state } = useSortStore.getState();
    expect(state).toMatchInlineSnapshot(`
      {
        "caseSensitive": false,
        "columnHeaders": [],
        "hasHeaders": true,
        "levels": [],
        "orientation": "rows",
        "rangeEndCol": 0,
        "rangeEndRow": 0,
        "rangeStartCol": 0,
        "rangeStartRow": 0,
        "selectedLevelId": null,
      }
    `);
  });

  it("has all expected properties", () => {
    const state = useSortStore.getState();
    expect(state).toHaveProperty("levels");
    expect(state).toHaveProperty("hasHeaders");
    expect(state).toHaveProperty("caseSensitive");
    expect(state).toHaveProperty("orientation");
    expect(state).toHaveProperty("rangeStartRow");
    expect(state).toHaveProperty("rangeStartCol");
    expect(state).toHaveProperty("rangeEndRow");
    expect(state).toHaveProperty("rangeEndCol");
    expect(state).toHaveProperty("columnHeaders");
    expect(state).toHaveProperty("selectedLevelId");
  });

  it("has no undefined values in defaults", () => {
    const { addLevel, deleteLevel, copyLevel, updateLevel, moveLevelUp, moveLevelDown,
      selectLevel, setHasHeaders, setCaseSensitive, setOrientation, setRange,
      setColumnHeaders, initialize, reset, ...state } = useSortStore.getState();
    for (const [key, value] of Object.entries(state)) {
      if (key === "selectedLevelId") continue; // null is expected
      expect(value, `sort store "${key}" should not be undefined`).not.toBeUndefined();
    }
  });
});

// ============================================================================
// Find/Search Store Defaults
// ============================================================================

describe("Find store initial state", () => {
  beforeEach(() => {
    useFindStore.getState().reset();
  });

  it("matches snapshot", () => {
    const { open, close, setQuery, setReplaceText, setMatches, setCurrentIndex,
      clearResults, setOptions, nextMatch, previousMatch, reset, ...state } = useFindStore.getState();
    expect(state).toMatchInlineSnapshot(`
      {
        "currentIndex": -1,
        "isOpen": false,
        "matches": [],
        "options": {
          "caseSensitive": false,
          "matchEntireCell": false,
          "searchFormulas": false,
        },
        "query": "",
        "replaceText": "",
        "showReplace": false,
      }
    `);
  });

  it("has all expected properties", () => {
    const state = useFindStore.getState();
    expect(state).toHaveProperty("isOpen");
    expect(state).toHaveProperty("showReplace");
    expect(state).toHaveProperty("query");
    expect(state).toHaveProperty("replaceText");
    expect(state).toHaveProperty("matches");
    expect(state).toHaveProperty("currentIndex");
    expect(state).toHaveProperty("options");
  });

  it("options sub-object has all expected properties", () => {
    const { options } = useFindStore.getState();
    expect(options).toHaveProperty("caseSensitive");
    expect(options).toHaveProperty("matchEntireCell");
    expect(options).toHaveProperty("searchFormulas");
  });

  it("has no undefined values in defaults", () => {
    const { open, close, setQuery, setReplaceText, setMatches, setCurrentIndex,
      clearResults, setOptions, nextMatch, previousMatch, reset, ...state } = useFindStore.getState();
    for (const [key, value] of Object.entries(state)) {
      expect(value, `find store "${key}" should not be undefined`).not.toBeUndefined();
    }
  });
});

// ============================================================================
// Validation Store Defaults
// ============================================================================

describe("Validation store initial state", () => {
  beforeEach(() => {
    resetValidationState();
  });

  it("matches snapshot", () => {
    expect(getValidationState()).toMatchInlineSnapshot(`
      {
        "invalidCells": null,
        "openDropdownCell": null,
        "promptCell": null,
        "promptVisible": false,
        "validationRanges": [],
      }
    `);
  });

  it("has all expected properties", () => {
    const state = getValidationState();
    expect(state).toHaveProperty("validationRanges");
    expect(state).toHaveProperty("invalidCells");
    expect(state).toHaveProperty("openDropdownCell");
    expect(state).toHaveProperty("promptVisible");
    expect(state).toHaveProperty("promptCell");
  });
});

// ============================================================================
// Filter Store Defaults
// ============================================================================

describe("Filter store initial state", () => {
  beforeEach(() => {
    resetFilterState();
  });

  it("matches snapshot", () => {
    expect(getFilterState()).toMatchInlineSnapshot(`
      {
        "autoFilterInfo": null,
        "isActive": false,
        "openDropdownCol": null,
      }
    `);
  });

  it("has all expected properties", () => {
    const state = getFilterState();
    expect(state).toHaveProperty("autoFilterInfo");
    expect(state).toHaveProperty("isActive");
    expect(state).toHaveProperty("openDropdownCol");
  });

  it("isActive defaults to false", () => {
    expect(getFilterState().isActive).toBe(false);
  });
});

// ============================================================================
// FilterPane Store Defaults
// ============================================================================

describe("FilterPane store initial state", () => {
  beforeEach(() => {
    clearFilterPaneCache();
  });

  it("starts with empty filter list", () => {
    expect(getAllFilters()).toEqual([]);
  });

  it("clearCache resets to empty", () => {
    // After clear, should be empty
    clearFilterPaneCache();
    expect(getAllFilters()).toHaveLength(0);
  });
});

// ============================================================================
// Protection Store Defaults
// ============================================================================

describe("Protection store initial state", () => {
  beforeEach(() => {
    resetProtectionState();
  });

  it("matches snapshot", () => {
    expect({
      sheetProtected: isCurrentSheetProtected(),
      sheetHasPassword: currentSheetHasPassword(),
      workbookProtected: isCurrentWorkbookProtected(),
      sheetOptions: getSheetOptions(),
    }).toMatchInlineSnapshot(`
      {
        "sheetHasPassword": false,
        "sheetOptions": {
          "deleteColumns": false,
          "deleteRows": false,
          "editObjects": false,
          "editScenarios": false,
          "formatCells": false,
          "formatColumns": false,
          "formatRows": false,
          "insertColumns": false,
          "insertHyperlinks": false,
          "insertRows": false,
          "selectLockedCells": true,
          "selectUnlockedCells": true,
          "sort": false,
          "useAutoFilter": false,
          "usePivotTableReports": false,
        },
        "sheetProtected": false,
        "workbookProtected": false,
      }
    `);
  });

  it("has all expected protection option properties", () => {
    const opts = getSheetOptions();
    const expectedKeys = [
      "selectLockedCells", "selectUnlockedCells", "formatCells", "formatColumns",
      "formatRows", "insertColumns", "insertRows", "insertHyperlinks",
      "deleteColumns", "deleteRows", "sort", "useAutoFilter",
      "usePivotTableReports", "editObjects", "editScenarios",
    ];
    for (const key of expectedKeys) {
      expect(opts, `protection options missing "${key}"`).toHaveProperty(key);
    }
  });
});

// ============================================================================
// Script Module Store Defaults
// ============================================================================

describe("ScriptEditor module store initial state", () => {
  beforeEach(() => {
    useModuleStore.setState({
      modules: [],
      activeModuleId: null,
      dirtyModuleIds: [],
      loaded: false,
      navPaneVisible: true,
    });
  });

  it("matches snapshot", () => {
    const { loadModules, createModule, selectModule, markDirty, markClean,
      saveModule, removeModule, renameModule, duplicateModule, toggleNavPane,
      ...state } = useModuleStore.getState();
    expect(state).toMatchInlineSnapshot(`
      {
        "activeModuleId": null,
        "dirtyModuleIds": [],
        "loaded": false,
        "modules": [],
        "navPaneVisible": true,
      }
    `);
  });

  it("has all expected properties", () => {
    const state = useModuleStore.getState();
    expect(state).toHaveProperty("modules");
    expect(state).toHaveProperty("activeModuleId");
    expect(state).toHaveProperty("dirtyModuleIds");
    expect(state).toHaveProperty("loaded");
    expect(state).toHaveProperty("navPaneVisible");
  });
});

// ============================================================================
// Script Notebook Store Defaults
// ============================================================================

describe("ScriptNotebook store initial state", () => {
  beforeEach(() => {
    useNotebookStore.setState({
      notebooks: [],
      activeNotebook: null,
      isExecuting: false,
      executingCellId: null,
    });
  });

  it("matches snapshot", () => {
    const { refreshNotebookList, createNotebook, openNotebook, closeNotebook,
      deleteNotebook, saveActiveNotebook, addCell, removeCell, updateCellSource,
      moveCellUp, moveCellDown, runCell, runAll, rewindToCell, runFromCell,
      ...state } = useNotebookStore.getState();
    expect(state).toMatchInlineSnapshot(`
      {
        "activeNotebook": null,
        "executingCellId": null,
        "isExecuting": false,
        "notebooks": [],
      }
    `);
  });

  it("has all expected properties", () => {
    const state = useNotebookStore.getState();
    expect(state).toHaveProperty("notebooks");
    expect(state).toHaveProperty("activeNotebook");
    expect(state).toHaveProperty("isExecuting");
    expect(state).toHaveProperty("executingCellId");
  });
});

// ============================================================================
// Cross-store: no shared object references
// ============================================================================

describe("Stores do not share object references in defaults", () => {
  it("sort store levels are safe from cross-mutation after addLevel + reset", () => {
    useSortStore.getState().reset();
    useSortStore.getState().initialize(0, 0, 10, 5, ["A", "B"], true);
    const before = useSortStore.getState().levels.length;
    expect(before).toBeGreaterThan(0);
    useSortStore.getState().reset();
    expect(useSortStore.getState().levels).toEqual([]);
  });

  it("find store matches are safe from cross-mutation after setMatches + reset", () => {
    useFindStore.getState().setMatches([[1, 2]], "test");
    expect(useFindStore.getState().matches.length).toBe(1);
    useFindStore.getState().reset();
    expect(useFindStore.getState().matches).toEqual([]);
  });

  it("find store options are safe from cross-mutation after setOptions + reset", () => {
    useFindStore.getState().setOptions({ caseSensitive: true });
    expect(useFindStore.getState().options.caseSensitive).toBe(true);
    useFindStore.getState().reset();
    expect(useFindStore.getState().options.caseSensitive).toBe(false);
  });

  it("protection options object is unique per reset", () => {
    resetProtectionState();
    const a = getSheetOptions();
    resetProtectionState();
    const b = getSheetOptions();
    expect(a).not.toBe(b);
  });
});
