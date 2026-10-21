//! FILENAME: app/extensions/AutoSum/__tests__/autoSumCellTarget.test.ts
// PURPOSE: AutoSum on a floating grid's cells (P3 S11, owner finding G3): the
//          door resolves the grid's cells ("content"), plans over the OBJECT's
//          cells (the typed read of @api/cellTarget, never the active sheet's
//          getRangeCellsTyped), writes the totals with the target in ONE undo
//          step and selects the result in the object; a single cell opens the
//          object's OWN editor with the guess. An owner that admits no
//          "content" refuses with nothing read or written (inert until S8).
// CONTEXT: The selection owner is REAL (@api/selectionOwner), shaped like the
//          floating grid's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  objectCells: [] as Array<{ row: number; col: number; value: number | string; display: string; formula: string | null; type: string }>,
  typedReads: [] as unknown[][],
  sheetReads: 0,
  writes: [] as unknown[][],
  undo: [] as string[],
  toasts: [] as string[],
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getRangeCellsTyped: async () => {
    h.sheetReads++;
    return [];
  },
  getUsedRange: async () => {
    h.sheetReads++;
    return { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };
  },
  updateCellsBatch: async (...a: unknown[]) => {
    h.writes.push(a);
    return [];
  },
  beginUndoTransaction: async (label: string) => {
    h.undo.push(`begin:${label}`);
    return 4;
  },
  commitUndoTransaction: async () => {
    h.undo.push("commit");
  },
  cancelUndoTransaction: async () => {
    h.undo.push("cancel");
  },
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: async (...a: unknown[]) => {
    h.typedReads.push(a);
    const rect = a[1] as { startRow: number; startCol: number; endRow: number; endCol: number };
    return h.objectCells.filter(
      (c) => c.row >= rect.startRow && c.row <= rect.endRow && c.col >= rect.startCol && c.col <= rect.endCol,
    );
  },
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (m: string) => {
    h.toasts.push(m);
  },
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    surface: "grid",
    selection: { startRow: 50, startCol: 50, endRow: 50, endCol: 50, type: "cells" },
  }),
  refreshGridData: () => {},
}));

import { runAutoSum } from "../lib/autoSumCommand";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };

let frSelection: Selection | null = null;
let actsOn: readonly CellTargetCapability[] = ["content"];
const selected: Selection[] = [];
const edited: string[] = [];
let release: () => void = () => {};

const num = (row: number, col: number, v: number) => ({ row, col, value: v, display: String(v), formula: null, type: "number" });

beforeEach(() => {
  h.objectCells = [num(0, 1, 1), num(1, 1, 2), num(2, 1, 3)];
  h.typedReads = [];
  h.sheetReads = 0;
  h.writes = [];
  h.undo = [];
  h.toasts = [];
  selected.length = 0;
  edited.length = 0;
  actsOn = ["content"];
  frSelection = { startRow: 0, startCol: 1, endRow: 2, endCol: 1, type: "cells", activeRow: 0, activeCol: 1 };
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
        : { ref: REF, selection: frSelection, bounds: { rows: 10, cols: 4 }, label: "Float1", wholeObject: false },
    selectCells: (sel) => {
      selected.push(sel);
    },
    editActiveCell: (text) => {
      edited.push(text);
      return true;
    },
  });
});
afterEach(() => release());

describe("AutoSum on a floating grid's cells", () => {
  it("totals the OBJECT's column: one targeted write in one undo step, the result selected in the object", async () => {
    await runAutoSum({ fn: "SUM" });
    expect(h.sheetReads, "the active sheet under the object was read").toBe(0);
    expect(h.typedReads.length).toBeGreaterThan(0);
    expect(h.typedReads.every((a) => a[0] === REF)).toBe(true);
    expect(h.writes).toEqual([[[{ row: 3, col: 1, value: "=SUM(B1:B3)", invariant: true }], { target: REF }]]);
    expect(h.undo).toEqual(["begin:AutoSum", "commit"]);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ startCol: 1, endCol: 1 });
    expect([selected[0].startRow, selected[0].endRow].sort()).toEqual([0, 3]);
  });

  it("one cell opens the OBJECT's own editor with the guess, and writes nothing", async () => {
    frSelection = { startRow: 3, startCol: 1, endRow: 3, endCol: 1, type: "cells", activeRow: 3, activeCol: 1 };
    await runAutoSum({ fn: "SUM" });
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatch(/^=SUM\(B1:B3\)$/);
    expect(h.writes).toEqual([]);
  });

  it("a total that would land past the object's extent is refused in words, nothing written", async () => {
    // Numbers fill rows 0..9 of a 10-row object: the total row would be 10.
    h.objectCells = Array.from({ length: 10 }, (_, r) => num(r, 1, r + 1));
    frSelection = { startRow: 0, startCol: 1, endRow: 9, endCol: 1, type: "cells", activeRow: 0, activeCol: 1 };
    await runAutoSum({ fn: "SUM" });
    expect(h.writes).toEqual([]);
    expect(h.toasts).toEqual(["AutoSum has no room inside floating grid 'Float1' for the totals. Nothing was changed."]);
  });

  it("inert until the owner admits \"content\": refused once, nothing read or written", async () => {
    actsOn = [];
    await runAutoSum({ fn: "SUM" });
    expect(h.writes).toEqual([]);
    expect(h.typedReads).toEqual([]);
    expect(h.sheetReads).toBe(0);
    expect(h.toasts).toEqual(["AutoSum is not available inside a floating grid yet. Nothing was changed."]);
  });
});
