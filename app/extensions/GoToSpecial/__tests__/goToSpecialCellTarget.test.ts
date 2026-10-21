//! FILENAME: app/extensions/GoToSpecial/__tests__/goToSpecialCellTarget.test.ts
// PURPOSE: Go To Special on a floating grid's cells (P3 S11, owner finding
//          G3): the door resolves the grid's cells ("read"), searches the
//          OBJECT's cells (goToSpecial with its target -- one cell searches the
//          whole object; a range is clipped to the object's extent, never the
//          active sheet's used range) and selects the matches in the object,
//          several areas riding additionalRanges. An owner that admits no "read" refuses (inert
//          until S8).
// CONTEXT: The selection owner is REAL (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  searches: [] as unknown[][],
  answer: [] as Array<{ row: number; col: number }>,
  sheetReads: 0,
  coreSelections: 0,
  shown: [] as string[],
  toasts: [] as string[],
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  goToSpecial: async (...a: unknown[]) => {
    h.searches.push(a);
    return { cells: h.answer };
  },
  getGridStateSnapshot: () => ({ surface: "grid", selection: { startRow: 40, startCol: 40, endRow: 40, endCol: 40, type: "cells" } }),
}));
vi.mock("@api/gridDispatch", () => ({
  dispatchGridAction: () => {
    h.coreSelections++;
  },
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getUsedRange: async () => {
    h.sheetReads++;
    return { startRow: 0, startCol: 0, endRow: 2, endCol: 2, empty: false };
  },
}));
vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (id: string) => h.shown.push(id),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (m: string) => {
    h.toasts.push(m);
  },
}));

import { selectSpecialCells } from "../lib/selectSpecialCells";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };

let frSelection: Selection | null = null;
let actsOn: readonly CellTargetCapability[] = ["read"];
const selected: Selection[] = [];
let release: () => void = () => {};

beforeEach(() => {
  h.searches = [];
  h.answer = [
    { row: 1, col: 1 },
    { row: 4, col: 3 },
  ];
  h.sheetReads = 0;
  h.coreSelections = 0;
  h.shown = [];
  h.toasts = [];
  selected.length = 0;
  actsOn = ["read"];
  frSelection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells", activeRow: 0, activeCol: 0 };
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
        : { ref: REF, selection: frSelection, bounds: { rows: 6, cols: 4 }, label: "Float1", wholeObject: false },
    selectCells: (sel) => {
      selected.push(sel);
    },
  });
});
afterEach(() => release());

describe("Go To Special on a floating grid's cells", () => {
  it("one cell searches the WHOLE object with its target and selects every match in the object", async () => {
    const outcome = await selectSpecialCells("constants", { announce: false });
    expect(outcome).toEqual({ kind: "selected", cells: 2, areas: 2 });
    expect(h.searches).toEqual([["constants", undefined, { target: REF }]]);
    expect(h.coreSelections, "Core's hidden selection was replaced").toBe(0);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" });
    expect(selected[0].additionalRanges).toEqual([{ startRow: 4, startCol: 3, endRow: 4, endCol: 3 }]);
  });

  it("a range is clipped to the object's extent (not the sheet's used range) and searched with the target", async () => {
    frSelection = { startRow: 0, startCol: 0, endRow: 999, endCol: 1, type: "cells", activeRow: 0, activeCol: 0 };
    await selectSpecialCells("blanks", { announce: false });
    expect(h.sheetReads).toBe(0);
    expect(h.searches).toEqual([["blanks", { startRow: 0, startCol: 0, endRow: 5, endCol: 1 }, { target: REF }]]);
  });

  it("inert until the owner admits \"read\": refused once, nothing searched", async () => {
    actsOn = [];
    const outcome = await selectSpecialCells("constants");
    expect(outcome.kind).toBe("refused");
    expect(h.shown).toEqual([]);
    expect(h.searches).toEqual([]);
    expect(h.toasts).toEqual(["Go To Special is not available inside a floating grid yet. Nothing was changed."]);
  });
});
