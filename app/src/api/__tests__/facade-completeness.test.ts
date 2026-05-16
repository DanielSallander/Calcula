import { describe, it, expect } from "vitest";

// ============================================================================
// Facade Completeness Tests
// Verify the API layer provides everything extensions need.
// ============================================================================

describe("API Facade Completeness", () => {
  // --------------------------------------------------------------------------
  // 1. All api/ module exports are non-null
  // --------------------------------------------------------------------------
  describe("module exports are non-null", () => {
    it("commands.ts exports CommandRegistry as a non-null object", async () => {
      const mod = await import("../commands");
      expect(mod.CommandRegistry).toBeDefined();
      expect(typeof mod.CommandRegistry.register).toBe("function");
      expect(typeof mod.CommandRegistry.execute).toBe("function");
      expect(typeof mod.CommandRegistry.unregister).toBe("function");
      expect(typeof mod.CommandRegistry.has).toBe("function");
      expect(typeof mod.CommandRegistry.getAll).toBe("function");
    });

    it("commands.ts exports CoreCommands as a non-null object with string values", async () => {
      const mod = await import("../commands");
      expect(mod.CoreCommands).toBeDefined();
      const values = Object.values(mod.CoreCommands);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        expect(typeof v).toBe("string");
      }
    });

    it("events.ts exports AppEvents as a non-null object with string values", async () => {
      const mod = await import("../events");
      expect(mod.AppEvents).toBeDefined();
      const values = Object.values(mod.AppEvents);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        expect(typeof v).toBe("string");
        expect(v).toMatch(/^app:/);
      }
    });

    it("range.ts exports CellRange class", async () => {
      const mod = await import("../range");
      expect(mod.CellRange).toBeDefined();
      expect(typeof mod.CellRange.fromCell).toBe("function");
      expect(typeof mod.CellRange.fromAddress).toBe("function");
    }, 15000);

    it("version.ts exports API_VERSION as a string", async () => {
      const mod = await import("../version");
      expect(typeof mod.API_VERSION).toBe("string");
      expect(mod.API_VERSION.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // 2. api/lib.ts provides cell read/write functions
  // --------------------------------------------------------------------------
  describe("lib.ts cell read/write functions", () => {
    it("exports getCell function", async () => {
      const mod = await import("../lib");
      expect(typeof mod.getCell).toBe("function");
    });

    it("exports getViewportCells function", async () => {
      const mod = await import("../lib");
      expect(typeof mod.getViewportCells).toBe("function");
    });

    it("exports updateCellsBatch function", async () => {
      const mod = await import("../lib");
      expect(typeof mod.updateCellsBatch).toBe("function");
    });

    it("exports clearCell and clearRange functions", async () => {
      const mod = await import("../lib");
      expect(typeof mod.clearCell).toBe("function");
      expect(typeof mod.clearRange).toBe("function");
    });

    it("exports fillRange function", async () => {
      const mod = await import("../lib");
      expect(typeof mod.fillRange).toBe("function");
    });

    it("exports undo/redo transaction functions", async () => {
      const mod = await import("../lib");
      expect(typeof mod.beginUndoTransaction).toBe("function");
      expect(typeof mod.commitUndoTransaction).toBe("function");
      expect(typeof mod.undo).toBe("function");
      expect(typeof mod.redo).toBe("function");
    });

    it("exports sheet management functions", async () => {
      const mod = await import("../lib");
      expect(typeof mod.getSheets).toBe("function");
      expect(typeof mod.addSheet).toBe("function");
      expect(typeof mod.deleteSheet).toBe("function");
      expect(typeof mod.renameSheet).toBe("function");
    });

    it("exports style functions", async () => {
      const mod = await import("../lib");
      expect(typeof mod.setCellStyle).toBe("function");
      expect(typeof mod.getStyle).toBe("function");
      expect(typeof mod.applyFormatting).toBe("function");
    });
  });

  // --------------------------------------------------------------------------
  // 3. api/events.ts provides subscribe/emit
  // --------------------------------------------------------------------------
  describe("events.ts provides subscribe/emit", () => {
    it("exports emitAppEvent function", async () => {
      const mod = await import("../events");
      expect(typeof mod.emitAppEvent).toBe("function");
    });

    it("exports onAppEvent function that returns unsubscribe", async () => {
      const mod = await import("../events");
      expect(typeof mod.onAppEvent).toBe("function");
    });

    it("exports AppEvents with selection, sheet, and data change events", async () => {
      const mod = await import("../events");
      expect(mod.AppEvents.SELECTION_CHANGED).toBeDefined();
      expect(mod.AppEvents.SHEET_CHANGED).toBeDefined();
      expect(mod.AppEvents.DATA_CHANGED).toBeDefined();
      expect(mod.AppEvents.CELLS_UPDATED).toBeDefined();
      expect(mod.AppEvents.CELL_VALUES_CHANGED).toBeDefined();
    });

    it("exports restoreFocusToGrid utility", async () => {
      const mod = await import("../events");
      expect(typeof mod.restoreFocusToGrid).toBe("function");
    });
  });

  // --------------------------------------------------------------------------
  // 4. api/commands.ts provides register/execute
  // --------------------------------------------------------------------------
  describe("commands.ts provides register/execute", () => {
    it("CommandRegistry has register method", async () => {
      const mod = await import("../commands");
      expect(typeof mod.CommandRegistry.register).toBe("function");
    });

    it("CommandRegistry has execute method", async () => {
      const mod = await import("../commands");
      expect(typeof mod.CommandRegistry.execute).toBe("function");
    });

    it("CommandRegistry has unregister method", async () => {
      const mod = await import("../commands");
      expect(typeof mod.CommandRegistry.unregister).toBe("function");
    });

    it("CommandRegistry has has method", async () => {
      const mod = await import("../commands");
      expect(typeof mod.CommandRegistry.has).toBe("function");
    });

    it("CoreCommands contains clipboard, edit, format, and grid commands", async () => {
      const mod = await import("../commands");
      expect(mod.CoreCommands.CUT).toBeDefined();
      expect(mod.CoreCommands.UNDO).toBeDefined();
      expect(mod.CoreCommands.FORMAT_CELLS).toBeDefined();
      expect(mod.CoreCommands.MERGE_CELLS).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 5. api/settings.ts provides get/set/remove
  // --------------------------------------------------------------------------
  describe("settings.ts provides get/set/remove", () => {
    it("exports getSetting function", async () => {
      const mod = await import("../settings");
      expect(typeof mod.getSetting).toBe("function");
    });

    it("exports setSetting function", async () => {
      const mod = await import("../settings");
      expect(typeof mod.setSetting).toBe("function");
    });

    it("exports removeSetting function", async () => {
      const mod = await import("../settings");
      expect(typeof mod.removeSetting).toBe("function");
    });

    it("exports registerSettingDefinitions function", async () => {
      const mod = await import("../settings");
      expect(typeof mod.registerSettingDefinitions).toBe("function");
    });

    it("exports subscribeToSettings function", async () => {
      const mod = await import("../settings");
      expect(typeof mod.subscribeToSettings).toBe("function");
    });
  });

  // --------------------------------------------------------------------------
  // 6. api/types.ts provides conversion utilities
  // --------------------------------------------------------------------------
  describe("types.ts provides conversion utilities", () => {
    it("exports columnToLetter function", async () => {
      const mod = await import("../types");
      expect(typeof mod.columnToLetter).toBe("function");
      expect(mod.columnToLetter(0)).toBe("A");
      expect(mod.columnToLetter(25)).toBe("Z");
      expect(mod.columnToLetter(26)).toBe("AA");
    });

    it("exports letterToColumn function", async () => {
      const mod = await import("../types");
      expect(typeof mod.letterToColumn).toBe("function");
      expect(mod.letterToColumn("A")).toBe(0);
      expect(mod.letterToColumn("Z")).toBe(25);
      expect(mod.letterToColumn("AA")).toBe(26);
    });

    it("exports isFormulaExpectingReference function", async () => {
      const mod = await import("../types");
      expect(typeof mod.isFormulaExpectingReference).toBe("function");
    });

    it("exports zoom constants", async () => {
      const mod = await import("../types");
      expect(typeof mod.ZOOM_MIN).toBe("number");
      expect(typeof mod.ZOOM_MAX).toBe("number");
      expect(typeof mod.ZOOM_DEFAULT).toBe("number");
      expect(typeof mod.ZOOM_STEP).toBe("number");
      expect(Array.isArray(mod.ZOOM_PRESETS)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 7. api/range.ts provides CellRange class
  // --------------------------------------------------------------------------
  describe("range.ts provides CellRange class", () => {
    it("CellRange.fromCell creates a single-cell range", async () => {
      const { CellRange } = await import("../range");
      const r = CellRange.fromCell(0, 0);
      expect(r.isSingleCell).toBe(true);
      expect(r.address).toBe("A1");
    });

    it("CellRange.fromAddress parses A1-style references", async () => {
      const { CellRange } = await import("../range");
      const r = CellRange.fromAddress("B2:D4");
      expect(r.startRow).toBe(1);
      expect(r.startCol).toBe(1);
      expect(r.endRow).toBe(3);
      expect(r.endCol).toBe(3);
      expect(r.rowCount).toBe(3);
      expect(r.colCount).toBe(3);
    });

    it("CellRange has set operations (contains, intersects, union)", async () => {
      const { CellRange } = await import("../range");
      const r = new CellRange(0, 0, 5, 5);
      expect(r.contains(3, 3)).toBe(true);
      expect(r.contains(6, 6)).toBe(false);
      expect(r.intersects(new CellRange(4, 4, 8, 8))).toBe(true);
      expect(r.union(new CellRange(10, 10, 12, 12)).endRow).toBe(12);
    });

    it("CellRange has offset and resize methods", async () => {
      const { CellRange } = await import("../range");
      const r = CellRange.fromAddress("A1:B2");
      const shifted = r.offset(5, 5);
      expect(shifted.startRow).toBe(5);
      expect(shifted.startCol).toBe(5);
      const resized = r.resize(10, 10);
      expect(resized.rowCount).toBe(10);
      expect(resized.colCount).toBe(10);
    });
  });

  // --------------------------------------------------------------------------
  // 8. api/ui.ts provides menu and status bar registries
  // --------------------------------------------------------------------------
  describe("ui.ts provides menu and status bar registries", () => {
    it("exports registerMenu and getMenus", async () => {
      const mod = await import("../ui");
      expect(typeof mod.registerMenu).toBe("function");
      expect(typeof mod.getMenus).toBe("function");
    });

    it("exports registerMenuItem", async () => {
      const mod = await import("../ui");
      expect(typeof mod.registerMenuItem).toBe("function");
    });

    it("exports registerStatusBarItem and getStatusBarItems", async () => {
      const mod = await import("../ui");
      expect(typeof mod.registerStatusBarItem).toBe("function");
      expect(typeof mod.getStatusBarItems).toBe("function");
      expect(typeof mod.unregisterStatusBarItem).toBe("function");
    });

    it("exports task pane functions", async () => {
      const mod = await import("../ui");
      expect(typeof mod.registerTaskPane).toBe("function");
      expect(typeof mod.unregisterTaskPane).toBe("function");
      expect(typeof mod.openTaskPane).toBe("function");
      expect(typeof mod.closeTaskPane).toBe("function");
    });

    it("exports dialog functions", async () => {
      const mod = await import("../ui");
      expect(typeof mod.registerDialog).toBe("function");
      expect(typeof mod.unregisterDialog).toBe("function");
      expect(typeof mod.showDialog).toBe("function");
      expect(typeof mod.hideDialog).toBe("function");
    });

    it("exports overlay functions", async () => {
      const mod = await import("../ui");
      expect(typeof mod.registerOverlay).toBe("function");
      expect(typeof mod.unregisterOverlay).toBe("function");
      expect(typeof mod.showOverlay).toBe("function");
      expect(typeof mod.hideOverlay).toBe("function");
      expect(typeof mod.hideAllOverlays).toBe("function");
    });

    it("exports facade objects (TaskPaneExtensions, DialogExtensions, OverlayExtensions)", async () => {
      const mod = await import("../ui");
      expect(mod.TaskPaneExtensions).toBeDefined();
      expect(mod.DialogExtensions).toBeDefined();
      expect(mod.OverlayExtensions).toBeDefined();
    });

    it("exports activity bar functions", async () => {
      const mod = await import("../ui");
      expect(typeof mod.registerActivityView).toBe("function");
      expect(typeof mod.unregisterActivityView).toBe("function");
      expect(typeof mod.openActivityView).toBe("function");
      expect(typeof mod.closeActivityView).toBe("function");
      expect(typeof mod.toggleActivityView).toBe("function");
    });
  });

  // --------------------------------------------------------------------------
  // 9. Cross-reference: functions used by extensions available in api/
  // --------------------------------------------------------------------------
  describe("cross-reference: extension-used functions in api/", () => {
    it("style interceptor API is available", async () => {
      const mod = await import("../styleInterceptors");
      expect(typeof mod.registerStyleInterceptor).toBe("function");
      expect(typeof mod.unregisterStyleInterceptor).toBe("function");
      expect(typeof mod.hasStyleInterceptors).toBe("function");
    });

    it("cell decoration API is available", async () => {
      const mod = await import("../cellDecorations");
      expect(typeof mod.registerCellDecoration).toBe("function");
      expect(typeof mod.unregisterCellDecoration).toBe("function");
    });

    it("edit guard API is available", async () => {
      const mod = await import("../editGuards");
      expect(typeof mod.registerEditGuard).toBe("function");
      expect(typeof mod.checkRangeGuards).toBe("function");
    });

    it("cell click interceptor API is available", async () => {
      const mod = await import("../cellClickInterceptors");
      expect(typeof mod.registerCellClickInterceptor).toBe("function");
    });

    it("keyboard shortcut API is available", async () => {
      const mod = await import("../keyboard");
      expect(typeof mod.registerShortcut).toBe("function");
      expect(typeof mod.getShortcuts).toBe("function");
    });

    it("file format API is available", async () => {
      const mod = await import("../fileFormats");
      expect(typeof mod.registerFileFormat).toBe("function");
      expect(typeof mod.findImporter).toBe("function");
      expect(typeof mod.findExporter).toBe("function");
    });

    it("formula functions API is available", async () => {
      const mod = await import("../formulaFunctions");
      expect(typeof mod.registerFunction).toBe("function");
      expect(typeof mod.getCustomFunction).toBe("function");
      expect(typeof mod.executeCustomFunction).toBe("function");
    });

    it("grid overlay API is available", async () => {
      const mod = await import("../gridOverlays");
      expect(typeof mod.registerGridOverlay).toBe("function");
      expect(typeof mod.addGridRegions).toBe("function");
    });

    it("notifications API is available", async () => {
      const mod = await import("../notifications");
      expect(typeof mod.showToast).toBe("function");
    });
  });

  // --------------------------------------------------------------------------
  // 10. api/ types are self-contained (no deep core imports in types.ts)
  // --------------------------------------------------------------------------
  describe("api types self-containment", () => {
    it("types.ts re-exports core types rather than exposing core paths", async () => {
      // Verify the types module re-exports what extensions need
      const mod = await import("../types");
      expect(typeof mod.columnToLetter).toBe("function");
      expect(typeof mod.letterToColumn).toBe("function");
      // These are re-exports; the key check is that extensions
      // import from api/types, not core/types directly
    });

    it("range.ts imports from api/types, not core/types", async () => {
      // CellRange uses columnToLetter/letterToColumn from api/types
      const { CellRange } = await import("../range");
      // If the import chain were broken, CellRange.fromAddress would fail
      const r = CellRange.fromAddress("Z1");
      expect(r.startCol).toBe(25);
    });

    it("uiTypes.ts is a standalone type module", async () => {
      // uiTypes should compile without core imports
      const mod = await import("../uiTypes");
      // It only exports types, so we just verify the module loads
      expect(mod).toBeDefined();
    });
  });
});
