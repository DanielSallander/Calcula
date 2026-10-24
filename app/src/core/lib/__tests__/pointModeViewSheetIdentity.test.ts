//! FILENAME: app/src/core/lib/__tests__/pointModeViewSheetIdentity.test.ts
// PURPOSE: "Does the grid show a sheet the open edit does not belong to?"
//          (core/lib/pointModeView.ts) is decided by the sheet's IDENTITY.
// CONTEXT: Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT. When a temporary
//          sheet's discard (or a delete, a move, a copy) renumbers the edit's
//          sheet while it is open, an index comparison called the edit's OWN
//          sheet "foreign": `getLiveGridRegions()` went empty and every DOM
//          overlay hid, on the sheet the user was typing on. And a different
//          sheet that slid into the edit's old index read as "home". The
//          index-only snapshots of pointModeView.test.ts keep the old rule
//          covered for edits that carry no name.

import { describe, it, expect, afterEach, vi } from "vitest";

const grid = vi.hoisted(() => ({
  snapshot: null as null | {
    editing: { sourceSheetIndex?: number; sourceSheetName?: string; sourceSheetId?: string } | null;
    sheetContext: { activeSheetIndex: number; activeSheetName: string; activeSheetId?: string };
  },
}));

vi.mock("../../state/GridContext", () => ({
  getGridStateSnapshot: () => grid.snapshot,
}));

import { isPointModeOnForeignSheet, onPointModeViewChanged, notifyPointModeViewChanged } from "../pointModeView";
import { __resetExternalEditForTests } from "../formulaEditTarget";

function show(activeSheetIndex: number, activeSheetName: string): void {
  grid.snapshot = {
    editing: { sourceSheetIndex: 3, sourceSheetName: "Summary" },
    sheetContext: { activeSheetIndex, activeSheetName },
  };
}

afterEach(() => {
  __resetExternalEditForTests();
  grid.snapshot = null;
});

describe("isPointModeOnForeignSheet decides by the sheet's name", () => {
  it("the edit's sheet renumbered (3 -> 2): NOT foreign -- the overlays stay", () => {
    show(2, "Summary");
    expect(isPointModeOnForeignSheet(), "the edit's own sheet read as foreign").toBe(false);
  });

  it("another sheet at the edit's OLD index: foreign", () => {
    show(3, "Extra");
    expect(isPointModeOnForeignSheet(), "a different sheet at the old index read as the edit's").toBe(true);
  });

  it("control: point mode on another sheet is foreign, and the edit's own sheet is not", () => {
    show(1, "Costs");
    expect(isPointModeOnForeignSheet()).toBe(true);
    show(3, "Summary");
    expect(isPointModeOnForeignSheet()).toBe(false);
  });

  it("the signal does not flip when the edit's sheet is merely renumbered", () => {
    show(3, "Summary");
    const heard: boolean[] = [];
    const off = onPointModeViewChanged((foreign) => heard.push(foreign));
    show(2, "Summary");
    notifyPointModeViewChanged();
    expect(heard, "a renumbering flipped the point-mode signal").toEqual([]);
    show(1, "Costs");
    notifyPointModeViewChanged();
    expect(heard).toEqual([true]);
    off();
  });
});

// Review F1-rename-refuses-entry (round 5): by NAME, a rename of the edited
// sheet emptied `getLiveGridRegions()` and hid every DOM overlay on the very
// sheet the user was typing on. By the STABLE id it is still the edit's sheet.
describe("isPointModeOnForeignSheet decides by the stable id first", () => {
  function showWithId(index: number, name: string, id: string): void {
    grid.snapshot = {
      editing: { sourceSheetIndex: 3, sourceSheetName: "Summary", sourceSheetId: "S-summary" },
      sheetContext: { activeSheetIndex: index, activeSheetName: name, activeSheetId: id },
    };
  }

  it("the edit's sheet RENAMED (same id, new name): NOT foreign -- the overlays stay", () => {
    showWithId(3, "Totals", "S-summary");
    expect(isPointModeOnForeignSheet(), "the renamed edit sheet read as foreign").toBe(false);
  });

  it("a namesake with ANOTHER id: foreign", () => {
    showWithId(3, "Summary", "S-other");
    expect(isPointModeOnForeignSheet()).toBe(true);
  });
});
