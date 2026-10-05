//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/editing/editingRules.test.ts
// PURPOSE: The pure rules behind the Editing menus' greyed rows, without React:
//          the blocks a selection is made of (what Remove Hyperlinks and Clear
//          Comments and Notes ask the backend about -- @api/selectionBlocks,
//          the one split, since 2026-10-04) and Excel's measured Fill edge rule (live Excel 16 build 20430, 2026-10-04,
//          scratchpad home-editing-probe/probe1.out).

import { describe, it, expect } from "vitest";
import type { Selection } from "@api/types";
import {
  fillHasSource,
  isDateFormatName,
  sortKindOf,
  SORT_LABELS,
  type FillDirection,
  type SortKeyCell,
} from "../../components/editing/editingRules";
import { selectionBlocks } from "@api/selectionBlocks";

const ROWS = 1048576;
const COLS = 16384;

function sel(startRow: number, startCol: number, endRow = startRow, endCol = startCol, extra?: Selection["additionalRanges"]): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges: extra };
}

/** [Down, Right, Up, Left] live, as Excel's GetEnabledMso reported them. */
function live(s: Selection | null): boolean[] {
  return (["down", "right", "up", "left"] as FillDirection[]).map((d) => fillHasSource(d, s, ROWS, COLS));
}

describe("fillHasSource: Excel's GetEnabledMso, row by row", () => {
  // Each row is one measured line of probe1.out (Y = enabled).
  const MEASURED: Array<[string, Selection, boolean[]]> = [
    ["A1", sel(0, 0), [false, false, true, true]],
    ["B2", sel(1, 1), [true, true, true, true]],
    ["A1:A3", sel(0, 0, 2, 0), [true, false, true, true]],
    ["A1:C1", sel(0, 0, 0, 2), [false, true, true, true]],
    ["A2:A3", sel(1, 0, 2, 0), [true, false, true, true]],
    ["A1048576", sel(ROWS - 1, 0), [true, false, false, true]],
    ["XFD5", sel(4, COLS - 1), [true, true, true, false]],
    ["A1048575:A1048576", sel(ROWS - 2, 0, ROWS - 1, 0), [true, false, true, true]],
    ["B:B", sel(0, 1, ROWS - 1, 1), [true, true, true, true]],
    ["1:1", sel(0, 0, 0, COLS - 1), [false, true, true, true]],
  ];
  for (const [address, selection, expected] of MEASURED) {
    it(address, () => {
      expect(live(selection)).toEqual(expected);
    });
  }

  it("the main range decides, as Core's fill acts on it alone (A1 main, D4 Ctrl+clicked)", () => {
    // Excel's A1;D4 greyed Down and Right too (probe3.out): its active area is A1.
    expect(live(sel(0, 0, 0, 0, [{ startRow: 3, startCol: 3, endRow: 3, endCol: 3 }]))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("no selection: nothing to fill in any direction", () => {
    expect(live(null)).toEqual([false, false, false, false]);
  });
});

describe("selectionBlocks (@api, what the Clear menu asks about)", () => {
  it("normalises a selection drawn up-left, and lists the main range FIRST, then the Ctrl+click ranges", () => {
    expect(selectionBlocks(sel(4, 3, 2, 1, [{ startRow: 10, startCol: 5, endRow: 9, endCol: 0 }]))).toEqual([
      { startRow: 2, startCol: 1, endRow: 4, endCol: 3 },
      { startRow: 9, startCol: 0, endRow: 10, endCol: 5 },
    ]);
  });

  it("drops an exact repeat (the same cell Ctrl+clicked twice)", () => {
    expect(selectionBlocks(sel(1, 1, 1, 1, [{ startRow: 1, startCol: 1, endRow: 1, endCol: 1 }]))).toHaveLength(1);
  });

  it("no selection, no blocks", () => {
    expect(selectionBlocks(null)).toEqual([]);
    expect(selectionBlocks(undefined)).toEqual([]);
  });
});

// ============================================================================
// Sort & Filter's row labels (live Excel 16 build 20430, 2026-10-04, UI
// Automation on Home > Sort & Filter in a fresh off-screen instance;
// scratchpad fix-home-probe/sortlabels.out and sortlabels2.out)
// ============================================================================

describe("Sort & Filter's labels follow the sort key's values, as Excel's do", () => {
  const n = (row: number): SortKeyCell => ({ row, kind: "number" });
  const d = (row: number): SortKeyCell => ({ row, kind: "date" });
  const t = (row: number): SortKeyCell => ({ row, kind: "text" });

  it("the three pairs are Excel's words", () => {
    expect(SORT_LABELS).toEqual({
      text: { ascending: "Sort A to Z", descending: "Sort Z to A" },
      number: { ascending: "Sort Smallest to Largest", descending: "Sort Largest to Smallest" },
      date: { ascending: "Sort Oldest to Newest", descending: "Sort Newest to Oldest" },
    });
  });

  // [what, cells of the key column (data order), top row of the block, single?, expected]
  const cases: Array<[string, SortKeyCell[], number, boolean, "text" | "number" | "date"]> = [
    // One cell: the active cell's own value.
    ["A1 number 42 (and a number formula, a time, TRUE, a percent, a currency)", [n(0)], 0, true, "number"],
    ["A2 a date (=DATE, or yyyy-mm-dd typed)", [d(1)], 1, true, "date"],
    ["A3 text (and a formula giving text)", [t(2)], 2, true, "text"],
    ["A4 empty", [], 3, true, "text"],
    // A range: the active cell's column, over the range.
    ["D1:D3 three numbers", [n(0), n(1), n(2)], 0, false, "number"],
    ["E1:E3 three dates", [d(0), d(1), d(2)], 0, false, "date"],
    ["F1:F4 a text header over numbers -- even with the header active", [t(0), n(1), n(2), n(3)], 0, false, "number"],
    ["G1:G4 numbers and an empty cell", [n(0), n(1), n(2)], 0, false, "number"],
    ["H1:H3 number, date, number", [n(0), d(1), n(2)], 0, false, "number"],
    ["I1:I3 date, number, number (the date active)", [d(0), n(1), n(2)], 0, false, "number"],
    ["A1:A3 number, date, text (the number active)", [n(0), d(1), t(2)], 0, false, "text"],
  ];
  for (const [what, cells, top, single, expected] of cases) {
    it(`${what}: ${expected}`, () => {
      expect(sortKindOf(cells, top, single)).toBe(expected);
    });
  }

  it("a text first row is a header only when something after it is not text", () => {
    expect(sortKindOf([t(0), t(1)], 0, false)).toBe("text");
    // Text that is not on the block's top row is data, not a header.
    expect(sortKindOf([t(1), n(2)], 0, false)).toBe("text");
  });

  it("date formats: the backend's Date display names and custom date codes; times and numbers are not dates", () => {
    for (const fmt of ["Date (YYYY-MM-DD)", "Date (dd/mm/yyyy)", "yyyy-mm-dd", "d-mmm", "[$-x-sysdate]dddd, mmmm dd, yyyy", "yyyy-mm-dd hh:mm"]) {
      expect(isDateFormatName(fmt), fmt).toBe(true);
    }
    for (const fmt of ["General", "Time (hh:mm)", "hh:mm:ss", "Number (2 decimals)", "Currency ($, 2 decimals)", "Percentage (0 decimals)",
      "Accounting ($, 2 decimals)", "Scientific (2 decimals)", "Fraction (up to 1 digits)", "@", '0 "days"', "#,##0.00", "[Red]0"]) {
      expect(isDateFormatName(fmt), fmt).toBe(false);
    }
  });
});
