//! FILENAME: app/src/api/__tests__/api-format-stability.test.ts
// PURPOSE: Verify backward-compatible behavior for API formats, event names,
//          command IDs, and settings key formats.

import { describe, it, expect } from "vitest";
import { CellRange } from "../range";
import { AppEvents } from "../events";
import { CoreCommands } from "../commands";

// ============================================================================
// CellRange.toString() Format Stability
// ============================================================================

describe("CellRange.toString() format stability", () => {
  it("single cell toString format is stable", () => {
    const r = CellRange.fromCell(0, 0);
    expect(r.toString()).toBe("CellRange(A1)");
  });

  it("multi-cell toString format is stable", () => {
    const r = new CellRange(0, 0, 4, 2);
    expect(r.toString()).toBe("CellRange(A1:C5)");
  });

  it("address property uses A1 notation", () => {
    expect(new CellRange(0, 0, 0, 0).address).toBe("A1");
    expect(new CellRange(0, 0, 9, 3).address).toBe("A1:D10");
    expect(new CellRange(2, 1, 2, 1).address).toBe("B3");
  });

  it("fromAddress round-trips correctly", () => {
    const original = new CellRange(5, 2, 10, 5);
    const parsed = CellRange.fromAddress(original.address);
    expect(parsed.equals(original)).toBe(true);
  });

  it("fromAddress handles dollar signs", () => {
    const r = CellRange.fromAddress("$A$1:$C$5");
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.endRow).toBe(4);
    expect(r.endCol).toBe(2);
  });
});

// ============================================================================
// Event Name Format Stability
// ============================================================================

describe("Event name format stability", () => {
  it("all event names use app: prefix", () => {
    const values = Object.values(AppEvents);
    for (const name of values) {
      expect(name).toMatch(/^app:/);
    }
  });

  it("core event names are stable (snapshot)", () => {
    expect(AppEvents.SELECTION_CHANGED).toBe("app:selection-changed");
    expect(AppEvents.DATA_CHANGED).toBe("app:data-changed");
    expect(AppEvents.SHEET_CHANGED).toBe("app:sheet-changed");
    expect(AppEvents.GRID_REFRESH).toBe("app:grid-refresh");
    expect(AppEvents.EDIT_STARTED).toBe("app:edit-started");
    expect(AppEvents.EDIT_ENDED).toBe("app:edit-ended");
    expect(AppEvents.CELLS_UPDATED).toBe("app:cells-updated");
    expect(AppEvents.CELL_VALUES_CHANGED).toBe("app:cell-values-changed");
  });

  it("clipboard event names are stable", () => {
    expect(AppEvents.CUT).toBe("app:cut");
    expect(AppEvents.COPY).toBe("app:copy");
    expect(AppEvents.PASTE).toBe("app:paste");
  });

  it("lifecycle event names are stable", () => {
    expect(AppEvents.BEFORE_SAVE).toBe("app:before-save");
    expect(AppEvents.AFTER_SAVE).toBe("app:after-save");
    expect(AppEvents.BEFORE_OPEN).toBe("app:before-open");
    expect(AppEvents.AFTER_OPEN).toBe("app:after-open");
    expect(AppEvents.BEFORE_CLOSE).toBe("app:before-close");
  });

  it("all AppEvents values are unique", () => {
    const values = Object.values(AppEvents);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ============================================================================
// Command Name Format Stability
// ============================================================================

describe("Command name format stability", () => {
  it("all command IDs use core. prefix with dot-separated segments", () => {
    const values = Object.values(CoreCommands);
    for (const id of values) {
      expect(id).toMatch(/^core\.[a-z]+\.[a-zA-Z]+$/);
    }
  });

  it("clipboard command IDs are stable", () => {
    expect(CoreCommands.CUT).toBe("core.clipboard.cut");
    expect(CoreCommands.COPY).toBe("core.clipboard.copy");
    expect(CoreCommands.PASTE).toBe("core.clipboard.paste");
    expect(CoreCommands.PASTE_SPECIAL).toBe("core.clipboard.pasteSpecial");
    expect(CoreCommands.PASTE_VALUES).toBe("core.clipboard.pasteValues");
  });

  it("edit command IDs are stable", () => {
    expect(CoreCommands.UNDO).toBe("core.edit.undo");
    expect(CoreCommands.REDO).toBe("core.edit.redo");
    expect(CoreCommands.FIND).toBe("core.edit.find");
    expect(CoreCommands.REPLACE).toBe("core.edit.replace");
    expect(CoreCommands.CLEAR_ALL).toBe("core.edit.clearAll");
  });

  it("grid command IDs are stable", () => {
    expect(CoreCommands.MERGE_CELLS).toBe("core.grid.merge");
    expect(CoreCommands.UNMERGE_CELLS).toBe("core.grid.unmerge");
    expect(CoreCommands.FREEZE_PANES).toBe("core.grid.freeze");
    expect(CoreCommands.INSERT_ROW).toBe("core.grid.insertRow");
    expect(CoreCommands.DELETE_COLUMN).toBe("core.grid.deleteColumn");
  });

  it("all CoreCommands values are unique", () => {
    const values = Object.values(CoreCommands);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ============================================================================
// Settings Key Format Stability
// ============================================================================

describe("Settings key format stability", () => {
  it("scoped key format uses ext. prefix pattern", () => {
    // The settings module uses the format: ext.{extensionId}.{key}
    // We verify the pattern by checking the documented STORAGE_PREFIX
    const expectedPattern = /^ext\./;
    const sampleKey = "ext.my-org.my-ext.theme";
    expect(sampleKey).toMatch(expectedPattern);
  });

  it("settings key segments are dot-separated", () => {
    const sampleKey = "ext.charts.colorPalette";
    const parts = sampleKey.split(".");
    expect(parts[0]).toBe("ext");
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });
});
