//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetDeletePolicy.test.ts
// PURPOSE: Delete Sheet asks first only when the sheet holds something --
//          Excel deletes a blank sheet without a word and asks ("Microsoft
//          Excel will permanently delete this sheet") about one with data.
// CONTEXT: Deleting a sheet ENDS the undo history (BUG-0005, Excel parity), so
//          a wrong "blank" answer is unrecoverable data loss while a wrong
//          "has data" answer costs one click. Every doubt therefore answers
//          "ask": a canvas (it IS objects), a read that failed, and a sheet
//          that is not the active one (its floating objects are not loaded, so
//          "no cells" does not mean "nothing").
//          "Blank" is the BACKEND's answer over every sheet-keyed store
//          (`sheet_is_blank`): the used range saw only cells, so a sheet that
//          held only a note, a comment, a whole-number validation rule, a
//          conditional format or a sheet-scoped name was deleted without a
//          question and without undo (review finding, 2026-10-04).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  isSheetBlank: vi.fn(),
  usedRange: vi.fn(),
  regions: vi.fn(),
}));

vi.mock("../../../api/lib", () => ({
  isSheetBlank: (...a: unknown[]) => h.isSheetBlank(...a),
}));
vi.mock("../../../core/lib/tauri-api", () => ({
  isSheetBlank: (...a: unknown[]) => h.isSheetBlank(...a),
  getUsedRange: (...a: unknown[]) => h.usedRange(...a),
}));
vi.mock("../../../api/gridOverlays", () => ({
  getGridRegions: () => h.regions(),
}));

import { deleteNeedsConfirmation, sheetDeleteNeedsConfirmation } from "../sheetDeletePolicy";

const EMPTY = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };

beforeEach(() => {
  h.isSheetBlank.mockReset();
  h.usedRange.mockReset();
  h.regions.mockReset();
  h.isSheetBlank.mockResolvedValue(true);
  // The used range would call a notes-only sheet EMPTY: it must not be what
  // decides (it sees cells only).
  h.usedRange.mockResolvedValue(EMPTY);
  h.regions.mockReturnValue([]);
});

describe("deleteNeedsConfirmation (the rule)", () => {
  it("a blank ACTIVE worksheet with no objects is deleted without asking (Excel)", () => {
    expect(deleteNeedsConfirmation({ kind: "worksheet", isActive: true, sheetBlank: true, objectCount: 0 })).toBe(false);
  });

  it("a sheet the backend calls not blank asks", () => {
    expect(deleteNeedsConfirmation({ kind: "worksheet", isActive: true, sheetBlank: false, objectCount: 0 })).toBe(true);
  });

  it("an object on the sheet (chart, shape, pivot overlay) asks", () => {
    expect(deleteNeedsConfirmation({ kind: "worksheet", isActive: true, sheetBlank: true, objectCount: 1 })).toBe(true);
  });

  it("a canvas always asks: a canvas is its objects", () => {
    expect(deleteNeedsConfirmation({ kind: "canvas", isActive: true, sheetBlank: true, objectCount: 0 })).toBe(true);
  });

  it("a sheet that is NOT active asks: its objects are not loaded, so no cells is not nothing", () => {
    expect(deleteNeedsConfirmation({ kind: "worksheet", isActive: false, sheetBlank: true, objectCount: 0 })).toBe(true);
  });

  it("an unknown answer asks", () => {
    expect(deleteNeedsConfirmation({ kind: "worksheet", isActive: true, sheetBlank: null, objectCount: 0 })).toBe(true);
    expect(deleteNeedsConfirmation({ kind: "worksheet", isActive: true, sheetBlank: true, objectCount: null })).toBe(true);
  });
});

describe("sheetDeletePolicy asks the backend whether the sheet is blank", () => {
  it("asks sheet_is_blank about THAT sheet; blank and no objects deletes without asking", async () => {
    expect(await sheetDeleteNeedsConfirmation({ index: 3 }, true)).toBe(false);
    expect(h.isSheetBlank).toHaveBeenCalledWith(3);
  });

  it("a sheet holding only a note (or a comment, a validation rule, a CF rule, a name) asks", async () => {
    // No cell, so the used range is empty -- the backend still says "not blank".
    h.isSheetBlank.mockResolvedValue(false);
    expect(await sheetDeleteNeedsConfirmation({ index: 0 }, true)).toBe(true);
  });

  it("the used range alone never answers blank", async () => {
    h.isSheetBlank.mockResolvedValue(false);
    h.usedRange.mockResolvedValue(EMPTY);
    expect(await sheetDeleteNeedsConfirmation({ index: 1 }, true)).toBe(true);
  });

  it("a registered grid region (an object of the active sheet) asks", async () => {
    h.regions.mockReturnValue([{ id: "chart-1", type: "chart", startRow: 0, startCol: 0, endRow: 1, endCol: 1 }]);
    expect(await sheetDeleteNeedsConfirmation({ index: 0 }, true)).toBe(true);
  });

  it("a failed read asks (fails toward the question, never toward silent loss)", async () => {
    h.isSheetBlank.mockRejectedValue(new Error("ipc down"));
    expect(await sheetDeleteNeedsConfirmation({ index: 0 }, true)).toBe(true);
  });

  it("an answer that is not a boolean asks", async () => {
    h.isSheetBlank.mockResolvedValue(undefined);
    expect(await sheetDeleteNeedsConfirmation({ index: 0 }, true)).toBe(true);
    h.isSheetBlank.mockResolvedValue("true");
    expect(await sheetDeleteNeedsConfirmation({ index: 0 }, true)).toBe(true);
  });

  it("a failed object read asks", async () => {
    h.regions.mockImplementation(() => {
      throw new Error("overlay registry gone");
    });
    expect(await sheetDeleteNeedsConfirmation({ index: 0 }, true)).toBe(true);
  });

  it("a canvas, or a sheet that is not active, asks without reading anything", async () => {
    expect(await sheetDeleteNeedsConfirmation({ index: 0, kind: "canvas" }, true)).toBe(true);
    expect(await sheetDeleteNeedsConfirmation({ index: 2 }, false)).toBe(true);
    expect(h.isSheetBlank).not.toHaveBeenCalled();
  });
});
