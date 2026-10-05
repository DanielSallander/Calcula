//! FILENAME: app/src/shell/FormulaBar/__tests__/referenceNavigator.test.ts
// PURPOSE: The navigator the shell registers with @api/referenceNavigation (for
//          Excel's Go To dialog) is the Name Box's own, driven OUTSIDE React --
//          the formula bar need not be mounted.
// CONTEXT: Home tab 2026-10-04. The Name Box's branches moved out of the
//          component (NameBox.navigate.ts); the Name Box tests pin each branch
//          through the box, this file pins the non-React door and its outcomes.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  dispatched: [] as Array<{ type: string; payload: unknown }>,
  sheets: [
    { index: 0, name: "Sheet1", kind: "grid" },
    { index: 1, name: "Data", kind: "grid" },
    { index: 2, name: "Report", kind: "canvas" },
  ],
  switchedTo: [] as number[],
}));

vi.mock("../../../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMergeInfo: async () => null,
  getNamedRange: async () => null,
  getSheets: async () => ({ sheets: h.sheets, activeIndex: 0 }),
  setActiveSheetApi: async (index: number) => {
    h.switchedTo.push(index);
    return { sheets: h.sheets, activeIndex: index };
  },
  primeSheetSwitch: async () => {},
  emitAppEvent: () => {},
}));
vi.mock("../../../api/backend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTableByName: async () => null,
}));
vi.mock("../../../api/gridDispatch", () => ({
  dispatchGridAction: (a: { type: string; payload: unknown }) => h.dispatched.push(a),
}));

import { installReferenceNavigator } from "../referenceNavigator";
import { navigateToReference, hasReferenceNavigator } from "../../../api/referenceNavigation";
import { setSelection } from "../../../api/grid";

const SET_SELECTION = setSelection(0, 0, 0, 0).type;
const selections = () => h.dispatched.filter((a) => a.type === SET_SELECTION).map((a) => a.payload);

beforeAll(() => installReferenceNavigator());
beforeEach(() => {
  h.dispatched = [];
  h.switchedTo = [];
});

describe("the Go To navigator", () => {
  it("is registered by the shell's install", () => {
    expect(hasReferenceNavigator()).toBe(true);
  });

  it("an address selects it", async () => {
    expect(await navigateToReference("B5")).toEqual({ kind: "done" });
    expect(selections()).toEqual([{ startRow: 4, startCol: 1, endRow: 4, endCol: 1, type: "cells" }]);
  });

  it("a range on another sheet switches there first", async () => {
    expect(await navigateToReference("Data!$A$1:$C$3")).toEqual({ kind: "done" });
    expect(h.switchedTo).toEqual([1]);
    expect(selections()).toEqual([{ startRow: 0, startCol: 0, endRow: 2, endCol: 2, type: "cells" }]);
  });

  it("a canvas sheet is a problem, said in words, and nothing moves", async () => {
    const out = await navigateToReference("Report!A1");
    expect(out.kind).toBe("problem");
    expect(selections()).toEqual([]);
  });

  it("text that names nothing is unclaimed (Go To says the reference is not valid)", async () => {
    expect(await navigateToReference("NoSuchName")).toEqual({ kind: "unclaimed" });
  });
});
