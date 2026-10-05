//! FILENAME: app/extensions/GoToSpecial/__tests__/goToSpecialCriteria.test.ts
// PURPOSE: The selection Go To Special builds from what it FOUND holds exactly
//          the found cells -- never the rectangle around them.
// CONTEXT: This file used to pin the defect as the intended behaviour. It
//          carried its own copy of the dialog's handler ("computeSelectionFrom
//          Cells") and asserted that scattered matches at B1, A10 and I5 made
//          Core's MAIN range A1:I10 -- the bounding box. The main range is a
//          real selected range (Clear Contents, Delete and Fill act on it), so
//          "Constants, then Delete" also cleared every formula inside the box.
//          It now drives the REAL module the dialog and the quick-item command
//          share, and asserts the property that matters: every cell of every
//          selected area is a match, and every match is selected.

import { describe, it, expect } from "vitest";
import {
  groupMatchedCells,
  selectionForMatches,
  MAX_MATCH_AREAS,
  type MatchedCell,
  type MatchArea,
} from "../lib/matchAreas";
import { searchAreasFor, clipToUsedExtent } from "../lib/selectSpecialCells";

const key = (r: number, c: number): string => `${r},${c}`;

/** Every cell the areas cover, as keys (a cell covered twice counts twice). */
function covered(areas: MatchArea[]): string[] {
  const out: string[] = [];
  for (const a of areas) {
    for (let r = Math.min(a.startRow, a.endRow); r <= Math.max(a.startRow, a.endRow); r++) {
      for (let c = Math.min(a.startCol, a.endCol); c <= Math.max(a.startCol, a.endCol); c++) out.push(key(r, c));
    }
  }
  return out;
}

/** The areas a selection payload selects: the main range and every extra one. */
function selectedAreas(payload: NonNullable<ReturnType<typeof selectionForMatches>>): MatchArea[] {
  return [
    { startRow: payload.startRow, startCol: payload.startCol, endRow: payload.endRow, endCol: payload.endCol },
    ...(payload.additionalRanges ?? []),
  ];
}

function expectExactly(cells: MatchedCell[]): void {
  const payload = selectionForMatches(cells)!;
  const sel = covered(selectedAreas(payload));
  const want = [...new Set(cells.map((c) => key(c.row, c.col)))];
  expect(new Set(sel).size, "a cell is selected twice (two areas overlap)").toBe(sel.length);
  expect([...sel].sort()).toEqual([...want].sort());
}

describe("Go To Special selects exactly the matching cells", () => {
  it("Constants scattered around a formula: the formula cell is NOT selected (the Delete defect)", () => {
    // A1:B2 and A3 are constants, B3 holds a formula, C5 a constant. The old
    // main range was A1:C5 -- which holds B3.
    const constants = [
      { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 },
      { row: 2, col: 0 }, { row: 4, col: 2 },
    ];
    const payload = selectionForMatches(constants)!;
    const sel = covered(selectedAreas(payload));
    expect(sel, "the formula at B3 is inside the selection").not.toContain(key(2, 1));
    expect(sel).not.toContain(key(4, 0));
    expectExactly(constants);
  });

  it("the MAIN range alone (what Clear Contents acts on) holds only matches", () => {
    const scattered = [{ row: 1, col: 5 }, { row: 10, col: 0 }, { row: 5, col: 8 }];
    const payload = selectionForMatches(scattered)!;
    const main = covered([selectedAreas(payload)[0]]);
    for (const cell of main) {
      expect(scattered.map((c) => key(c.row, c.col)), `main range holds ${cell}`).toContain(cell);
    }
  });

  it("the first match (reading order) is the ACTIVE cell -- Core's endRow/endCol -- as in Excel", () => {
    const payload = selectionForMatches([{ row: 4, col: 2 }, { row: 0, col: 3 }, { row: 0, col: 1 }])!;
    expect({ row: payload.endRow, col: payload.endCol }).toEqual({ row: 0, col: 1 });
  });

  it("a block of matches is ONE area (not one area per cell)", () => {
    const block: MatchedCell[] = [];
    for (let r = 0; r < 30; r++) for (let c = 0; c < 4; c++) block.push({ row: r, col: c });
    expect(groupMatchedCells(block)).toEqual([{ startRow: 0, startCol: 0, endRow: 29, endCol: 3 }]);
    const payload = selectionForMatches(block)!;
    expect(payload.additionalRanges).toBeUndefined();
  });

  it("Excel's measured shapes: A1:A3 + B2:B3 is A1 ; A2:B3", () => {
    const cells = [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 1 }];
    expect(groupMatchedCells(cells)).toEqual([
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
    ]);
    expectExactly(cells);
  });

  it("an L-shape is two areas covering exactly the L", () => {
    const cells = [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 0 }, { row: 2, col: 0 }];
    expect(groupMatchedCells(cells)).toHaveLength(2);
    expectExactly(cells);
  });

  it("a checkerboard is one area per cell, and a cell found twice is selected once", () => {
    const cells = [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 2, col: 0 }, { row: 0, col: 2 }, { row: 1, col: 1 }];
    expect(groupMatchedCells(cells)).toHaveLength(4);
    expectExactly(cells);
  });

  it("more than 1000 matches are still selected exactly (the old code dropped them and kept the box)", () => {
    const cells = Array.from({ length: 1500 }, (_, i) => ({ row: i * 2, col: 0 }));
    const payload = selectionForMatches(cells)!;
    expect(payload.additionalRanges).toHaveLength(1499);
    expectExactly(cells);
  });

  it("no matches selects nothing", () => {
    expect(selectionForMatches([])).toBeNull();
  });

  it("refuses rather than selecting a box when the areas exceed the limit", () => {
    const cells = Array.from({ length: MAX_MATCH_AREAS + 1 }, (_, i) => ({ row: i * 2, col: 0 }));
    expect(() => selectionForMatches(cells)).toThrow(/separate areas/);
  });
});

describe("where Go To Special searches", () => {
  it("one selected cell searches the whole sheet", () => {
    expect(searchAreasFor({ startRow: 3, startCol: 5, endRow: 3, endCol: 5 })).toBeNull();
  });

  it("a range searches inside it (normalised when selected upwards)", () => {
    expect(searchAreasFor({ startRow: 10, startCol: 8, endRow: 2, endCol: 1 })).toEqual([
      { startRow: 2, startCol: 1, endRow: 10, endCol: 8 },
    ]);
  });

  it("a multi-area selection searches EVERY area, not just the main range", () => {
    expect(
      searchAreasFor({
        startRow: 0, startCol: 0, endRow: 0, endCol: 0,
        additionalRanges: [{ startRow: 5, startCol: 5, endRow: 6, endCol: 6 }],
      }),
    ).toEqual([
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 5, startCol: 5, endRow: 6, endCol: 6 },
    ]);
  });

  it("a scanned search is clipped to the used extent (a whole column is a million rows)", () => {
    const used = { endRow: 99, endCol: 4, empty: false };
    expect(clipToUsedExtent({ startRow: 0, startCol: 2, endRow: 1_048_575, endCol: 2 }, used)).toEqual({
      startRow: 0, startCol: 2, endRow: 99, endCol: 2,
    });
    expect(clipToUsedExtent({ startRow: 200, startCol: 0, endRow: 300, endCol: 0 }, used)).toBeNull();
    expect(clipToUsedExtent({ startRow: 0, startCol: 0, endRow: 5, endCol: 5 }, { ...used, empty: true })).toBeNull();
  });
});

// Criteria completeness is criteriaOptions.test.ts's job: it reads the
// dialog's own list and is exhaustive over GoToSpecialCriteria by type.
