//! FILENAME: app/src/api/__tests__/api-surface-stability.test.ts
// PURPOSE: Verify public API surface stability — catch accidental breaking changes.

import { describe, it, expect } from "vitest";

// ============================================================================
// events.ts exports
// ============================================================================

describe("api/events.ts surface stability", () => {
  it("exports emitAppEvent as a function", async () => {
    const mod = await import("../events");
    expect(typeof mod.emitAppEvent).toBe("function");
  });

  it("exports onAppEvent as a function", async () => {
    const mod = await import("../events");
    expect(typeof mod.onAppEvent).toBe("function");
  });

  it("exports restoreFocusToGrid as a function", async () => {
    const mod = await import("../events");
    expect(typeof mod.restoreFocusToGrid).toBe("function");
  });

  it("exports AppEvents as an object with expected event keys", async () => {
    const mod = await import("../events");
    expect(mod.AppEvents).toBeDefined();
    expect(typeof mod.AppEvents).toBe("object");

    const expectedKeys = [
      "CUT", "COPY", "PASTE",
      "FIND", "REPLACE",
      "FREEZE_CHANGED", "SPLIT_CHANGED",
      "VIEW_MODE_CHANGED", "SHOW_FORMULAS_TOGGLED",
      "SELECTION_CHANGED", "SHEET_CHANGED",
      "DATA_CHANGED", "CELLS_UPDATED", "CELL_VALUES_CHANGED",
      "EDIT_STARTED", "EDIT_ENDED",
      "GRID_REFRESH",
      "CONTEXT_MENU_REQUEST", "CONTEXT_MENU_CLOSE",
      "ROWS_INSERTED", "COLUMNS_INSERTED", "ROWS_DELETED", "COLUMNS_DELETED",
      "NAVIGATE_TO_CELL",
      "NAMED_RANGES_CHANGED",
      "FILL_COMPLETED",
      "ANNOTATIONS_CHANGED",
      "ZOOM_CHANGED", "THEME_CHANGED",
      "BEFORE_SAVE", "AFTER_SAVE", "BEFORE_OPEN", "AFTER_OPEN",
      "DIRTY_STATE_CHANGED",
      "CHART_SELECTION_CHANGED",
    ];

    for (const key of expectedKeys) {
      expect(mod.AppEvents).toHaveProperty(key);
    }
  });

  it("AppEvents values are prefixed with 'app:'", async () => {
    const mod = await import("../events");
    for (const value of Object.values(mod.AppEvents)) {
      expect(value).toMatch(/^app:/);
    }
  });
});

// ============================================================================
// commands.ts exports
// ============================================================================

describe("api/commands.ts surface stability", () => {
  it("exports CoreCommands as an object", async () => {
    const mod = await import("../commands");
    expect(mod.CoreCommands).toBeDefined();
    expect(typeof mod.CoreCommands).toBe("object");
  });

  it("CoreCommands contains expected command IDs", async () => {
    const mod = await import("../commands");
    const expected = [
      "CUT", "COPY", "PASTE", "PASTE_SPECIAL",
      "UNDO", "REDO", "FIND", "REPLACE",
      "CLEAR_CONTENTS", "CLEAR_FORMATTING", "CLEAR_ALL",
      "FORMAT_CELLS", "FORMAT_PAINTER",
      "MERGE_CELLS", "UNMERGE_CELLS", "FREEZE_PANES",
      "INSERT_ROW", "INSERT_COLUMN", "DELETE_ROW", "DELETE_COLUMN",
      "FILL_DOWN", "FILL_RIGHT", "FILL_UP", "FILL_LEFT",
    ];
    for (const key of expected) {
      expect(mod.CoreCommands).toHaveProperty(key);
    }
  });

  it("CoreCommands values are prefixed with 'core.'", async () => {
    const mod = await import("../commands");
    for (const value of Object.values(mod.CoreCommands)) {
      expect(value).toMatch(/^core\./);
    }
  });

  it("exports CommandRegistry singleton with ICommandRegistry methods", async () => {
    const mod = await import("../commands");
    expect(mod.CommandRegistry).toBeDefined();
    expect(typeof mod.CommandRegistry.execute).toBe("function");
    expect(typeof mod.CommandRegistry.register).toBe("function");
    expect(typeof mod.CommandRegistry.unregister).toBe("function");
    expect(typeof mod.CommandRegistry.has).toBe("function");
    expect(typeof mod.CommandRegistry.getAll).toBe("function");
  });
});

// ============================================================================
// lib.ts exports (spot-check key functions)
// ============================================================================

describe("api/lib.ts surface stability", () => {
  it("exports core cell operations", async () => {
    const mod = await import("../lib");
    const cellOps = [
      "getCell", "updateCell", "updateCellsBatch", "clearCell",
      "clearRange", "fillRange", "getGridBounds", "getCellCount",
    ];
    for (const fn of cellOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports sheet management functions", async () => {
    const mod = await import("../lib");
    const sheetOps = [
      "getSheets", "getActiveSheet", "setActiveSheet",
      "addSheet", "deleteSheet", "renameSheet", "moveSheet", "copySheet",
    ];
    for (const fn of sheetOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports undo/redo functions", async () => {
    const mod = await import("../lib");
    const undoOps = ["getUndoState", "undo", "redo", "beginUndoTransaction", "commitUndoTransaction"];
    for (const fn of undoOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports dimension functions", async () => {
    const mod = await import("../lib");
    const dimOps = ["setColumnWidth", "getColumnWidth", "setRowHeight", "getRowHeight"];
    for (const fn of dimOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports style functions", async () => {
    const mod = await import("../lib");
    const styleOps = ["getStyle", "getAllStyles", "setCellStyle", "applyFormatting"];
    for (const fn of styleOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports find/replace functions", async () => {
    const mod = await import("../lib");
    const findOps = ["findAll", "countMatches", "replaceAll", "replaceSingle"];
    for (const fn of findOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports merge cell functions", async () => {
    const mod = await import("../lib");
    const mergeOps = ["mergeCells", "unmergeCells", "getMergedRegions", "getMergeInfo"];
    for (const fn of mergeOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports named range functions", async () => {
    const mod = await import("../lib");
    const namedOps = [
      "createNamedRange", "updateNamedRange", "deleteNamedRange",
      "getNamedRange", "getAllNamedRanges",
    ];
    for (const fn of namedOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports data validation functions", async () => {
    const mod = await import("../lib");
    const valOps = [
      "setDataValidation", "clearDataValidation", "getDataValidation",
      "getAllDataValidations", "validateCell",
    ];
    for (const fn of valOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports comment functions", async () => {
    const mod = await import("../lib");
    const commentOps = ["addComment", "updateComment", "deleteComment", "getComment", "getAllComments"];
    for (const fn of commentOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports grouping/outline functions", async () => {
    const mod = await import("../lib");
    const groupOps = [
      "groupRows", "ungroupRows", "groupColumns", "ungroupColumns",
      "collapseRowGroup", "expandRowGroup", "getOutlineInfo",
    ];
    for (const fn of groupOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports autofilter functions", async () => {
    const mod = await import("../lib");
    const filterOps = [
      "applyAutoFilter", "clearColumnCriteria", "removeAutoFilter",
      "getAutoFilter", "getHiddenRows", "getFilterUniqueValues",
    ];
    for (const fn of filterOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports pivot API functions", async () => {
    const mod = await import("../lib");
    const pivotOps = [
      "createPivotTable", "updatePivotFields", "togglePivotGroup",
      "getPivotView", "deletePivotTable", "refreshPivotCache",
    ];
    for (const fn of pivotOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports conditional formatting functions", async () => {
    const mod = await import("../lib");
    const cfOps = [
      "addConditionalFormat", "updateConditionalFormat",
      "deleteConditionalFormat", "getAllConditionalFormats",
    ];
    for (const fn of cfOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports protection functions", async () => {
    const mod = await import("../lib");
    const protOps = [
      "protectSheet", "unprotectSheet", "isSheetProtected",
      "canEditCell", "protectWorkbook", "unprotectWorkbook",
    ];
    for (const fn of protOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports data validation helper creators", async () => {
    const mod = await import("../lib");
    const helpers = [
      "createWholeNumberRule", "createDecimalRule", "createListRule",
      "createTextLengthRule", "createCustomRule",
    ];
    for (const fn of helpers) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });
});

// ============================================================================
// types.ts exports
// ============================================================================

describe("api/types.ts surface stability", () => {
  it("exports columnToLetter as a function", async () => {
    const mod = await import("../types");
    expect(typeof mod.columnToLetter).toBe("function");
  });

  it("exports letterToColumn as a function", async () => {
    const mod = await import("../types");
    expect(typeof mod.letterToColumn).toBe("function");
  });

  it("columnToLetter produces expected values", async () => {
    const { columnToLetter } = await import("../types");
    expect(columnToLetter(0)).toBe("A");
    expect(columnToLetter(25)).toBe("Z");
    expect(columnToLetter(26)).toBe("AA");
  });

  it("letterToColumn produces expected values", async () => {
    const { letterToColumn } = await import("../types");
    expect(letterToColumn("A")).toBe(0);
    expect(letterToColumn("Z")).toBe(25);
    expect(letterToColumn("AA")).toBe(26);
  });

  it("exports zoom constants", async () => {
    const mod = await import("../types");
    expect(typeof mod.ZOOM_MIN).toBe("number");
    expect(typeof mod.ZOOM_MAX).toBe("number");
    expect(typeof mod.ZOOM_DEFAULT).toBe("number");
    expect(typeof mod.ZOOM_STEP).toBe("number");
    expect(Array.isArray(mod.ZOOM_PRESETS)).toBe(true);
  });

  it("exports DEFAULT_GRID_CONFIG and DEFAULT_FREEZE_CONFIG", async () => {
    const mod = await import("../types");
    expect(mod.DEFAULT_GRID_CONFIG).toBeDefined();
    expect(mod.DEFAULT_FREEZE_CONFIG).toBeDefined();
  });

  it("exports isFormulaExpectingReference as a function", async () => {
    const mod = await import("../types");
    expect(typeof mod.isFormulaExpectingReference).toBe("function");
  });
});

// ============================================================================
// settings.ts exports
// ============================================================================

describe("api/settings.ts surface stability", () => {
  it("exports getSetting as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.getSetting).toBe("function");
  });

  it("exports setSetting as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.setSetting).toBe("function");
  });

  it("exports removeSetting as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.removeSetting).toBe("function");
  });

  it("exports registerSettingDefinitions as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.registerSettingDefinitions).toBe("function");
  });

  it("exports getAllSettingDefinitions as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.getAllSettingDefinitions).toBe("function");
  });

  it("exports subscribeToSettings as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.subscribeToSettings).toBe("function");
  });
});

// ============================================================================
// range.ts — CellRange class methods
// ============================================================================

describe("api/range.ts CellRange surface stability", () => {
  it("CellRange class is exported", async () => {
    const mod = await import("../range");
    expect(mod.CellRange).toBeDefined();
    expect(typeof mod.CellRange).toBe("function");
  });

  it("CellRange has static fromAddress method", async () => {
    const { CellRange } = await import("../range");
    expect(typeof CellRange.fromAddress).toBe("function");
  });

  it("CellRange has static fromCell method", async () => {
    const { CellRange } = await import("../range");
    expect(typeof CellRange.fromCell).toBe("function");
  });

  it("CellRange instance has all expected methods", async () => {
    const { CellRange } = await import("../range");
    const range = new CellRange(0, 0, 5, 5);

    const expectedMethods = [
      "contains", "intersects", "intersection", "union",
      "offset", "resize", "cells", "forEachCell",
      "getCell", "getRow", "getColumn",
      "equals", "toString",
    ];

    for (const method of expectedMethods) {
      expect(typeof (range as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("CellRange constructor sets row/col properties", async () => {
    const { CellRange } = await import("../range");
    const range = new CellRange(1, 2, 10, 20);
    expect(range.startRow).toBe(1);
    expect(range.startCol).toBe(2);
    expect(range.endRow).toBe(10);
    expect(range.endCol).toBe(20);
  });
});
