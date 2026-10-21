//! FILENAME: app/extensions/Sorting/__tests__/sortCellTarget.test.ts
// PURPOSE: Sort A to Z / Z to A and Custom Sort on a floating grid's cells
//          (P3 S11, owner finding G3): the door resolves the grid's cells
//          ("sort"), decides the block over the OBJECT's cells (Excel's current
//          region and header guess over the typed read of @api/cellTarget --
//          never the active sheet's detectDataRegion / getRangeCellsTyped) and
//          sorts with the target. Custom Sort opens its dialog with the target.
//          An owner that admits no "sort" refuses (inert until S8).
// CONTEXT: The selection owner is REAL (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  /** The object's cells, row-major from its A1. */
  grid: [] as Array<Array<string | number | null>>,
  sheetReads: 0,
  sorts: [] as unknown[][],
  sheetSorts: 0,
  shown: [] as Array<{ id: string; data?: Record<string, unknown> }>,
  toasts: [] as string[],
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  detectDataRegion: async () => {
    h.sheetReads++;
    return null;
  },
  getRangeCellsTyped: async () => {
    h.sheetReads++;
    return [];
  },
  getUsedRange: async () => {
    h.sheetReads++;
    return { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };
  },
  sortRange: async (...args: unknown[]) => {
    h.sorts.push(args);
    return { success: true };
  },
  sortRangeByColumn: async () => {
    h.sheetSorts++;
    return { success: true };
  },
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: async (_ref: unknown, r: { startRow: number; startCol: number; endRow: number; endCol: number }) => {
    const out: unknown[] = [];
    for (let row = r.startRow; row <= r.endRow; row++) {
      for (let col = r.startCol; col <= r.endCol; col++) {
        const v = h.grid[row]?.[col] ?? null;
        if (v === null) continue;
        out.push({ row, col, value: v, display: String(v), formula: null, type: typeof v === "number" ? "number" : "text" });
      }
    }
    return out;
  },
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "grid", selection: { startRow: 40, startCol: 40, endRow: 40, endCol: 40, type: "cells" } }),
  refreshGridData: () => {},
}));
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getTableAtCell: async () => {
    h.sheetReads++;
    return null;
  },
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (id: string, data?: Record<string, unknown>) => h.shown.push({ id, data }),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (m: string) => {
    h.toasts.push(m);
  },
}));

import { runQuickSort, currentRegionIn } from "../lib/quickSort";
import { openCustomSort, SORT_DIALOG_ID } from "../lib/sortCommands";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };

let frSelection: Selection | null = null;
let actsOn: readonly CellTargetCapability[] = ["sort"];
let release: () => void = () => {};

beforeEach(() => {
  // Name / Score over three rows, in the object's A1:B4; D2 is a stray value.
  h.grid = [
    ["Name", "Score"],
    ["Cy", 3],
    ["Al", 1, null, "stray"],
    ["Bo", 2],
  ];
  h.sheetReads = 0;
  h.sorts = [];
  h.sheetSorts = 0;
  h.shown = [];
  h.toasts = [];
  actsOn = ["sort"];
  frSelection = { startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells", activeRow: 2, activeCol: 1 };
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    get actsOn() {
      return actsOn;
    },
    refusal: (action) => `${action} is not available inside a floating grid yet. Nothing was changed.`,
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 8, cols: 5 }, label: "Float1", wholeObject: false },
  });
});
afterEach(() => release());

describe("Excel's current region over an object's cells", () => {
  const filled = (keys: string[]) => new Set(keys);
  it("grows through diagonal neighbours and stops at blank rows and columns", () => {
    const f = filled(["0,0", "0,1", "1,0", "1,1", "2,2", "5,5"]);
    expect(currentRegionIn(f, 0, 0, { rows: 10, cols: 10 })).toEqual({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 });
    expect(currentRegionIn(f, 5, 5, { rows: 10, cols: 10 })).toEqual({ startRow: 5, startCol: 5, endRow: 5, endCol: 5 });
  });
  it("is null for an empty cell with no neighbour, and never grows past the bounds", () => {
    const f = filled(["0,0", "0,1"]);
    expect(currentRegionIn(f, 7, 7, { rows: 10, cols: 10 })).toBeNull();
    expect(currentRegionIn(filled(["0,0", "0,1", "0,2"]), 0, 0, { rows: 1, cols: 2 })).toEqual({
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 1,
    });
  });
});

describe("Sort on a floating grid's cells", () => {
  it("one cell sorts the OBJECT's block by the active column, header guessed, with the target", async () => {
    await runQuickSort(true);
    expect(h.sheetReads, "the active sheet under the object was read").toBe(0);
    expect(h.sheetSorts).toBe(0);
    expect(h.sorts).toEqual([[0, 0, 3, 1, [{ key: 1, ascending: true }], { hasHeaders: true }, { target: REF }]]);
  });

  it("several cells sort exactly the selection inside the object", async () => {
    frSelection = { startRow: 1, startCol: 0, endRow: 3, endCol: 0, type: "cells", activeRow: 1, activeCol: 0 };
    // A one-column selection inside wider data asks the Sort Warning; answer
    // "current" through the dialog's own answer function.
    const { answerSortWarning } = await import("../lib/sortWarning");
    const done = runQuickSort(false);
    await vi.waitFor(() => expect(h.shown.some((s) => s.id === "sort-warning")).toBe(true));
    answerSortWarning("current");
    await done;
    expect(h.sorts).toEqual([[1, 0, 3, 0, [{ key: 0, ascending: false }], { hasHeaders: false }, { target: REF }]]);
  });

  it("Custom Sort opens its dialog on the object's block, carrying the target", async () => {
    await openCustomSort();
    expect(h.shown).toEqual([
      {
        id: SORT_DIALOG_ID,
        data: { range: { startRow: 0, startCol: 0, endRow: 3, endCol: 1 }, hasHeaders: true, sortCol: 1, target: REF },
      },
    ]);
  });

  it("inert until the owner admits \"sort\": refused once, nothing read or sorted", async () => {
    actsOn = [];
    await runQuickSort(true);
    expect(h.sorts).toEqual([]);
    expect(h.sheetSorts).toBe(0);
    expect(h.toasts).toEqual(["Sort A to Z is not available inside a floating grid yet. Nothing was changed."]);
  });
});
