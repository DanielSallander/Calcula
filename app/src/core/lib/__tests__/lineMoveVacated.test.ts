//! FILENAME: app/src/core/lib/__tests__/lineMoveVacated.test.ts
// PURPOSE: BUG-0756 -- a row / column drag that lands on part of itself clears
//          only the target lines outside the source, and empties in its batch
//          the cells it leaves behind there and any data-table body cell left
//          in the source.
// SABOTAGE: make `targetLinesOutsideSource` answer the whole target -- fails at
//           "CLEARS ITS OWN LINES".

import { describe, expect, it } from "vitest";
import { lineRuns, lineSizeWrites, movedLineSizes, targetLinesOutsideSource, vacatedMoveCells } from "../lineMoveVacated";

describe("targetLinesOutsideSource", () => {
  it("clears only the target lines that are not the block's own", () => {
    // Rows 6..8 moved up one (target 5..7): only row 5 is cleared first.
    expect(targetLinesOutsideSource(6, 8, 5, 3), "CLEARS ITS OWN LINES").toEqual([[5, 5]]);
    // Rows 6..8 moved up two (target 4..6).
    expect(targetLinesOutsideSource(6, 8, 4, 3)).toEqual([[4, 5]]);
    // No overlap: the whole target.
    expect(targetLinesOutsideSource(6, 8, 0, 3)).toEqual([[0, 2]]);
    expect(targetLinesOutsideSource(6, 8, 20, 3)).toEqual([[20, 22]]);
  });
});

describe("vacatedMoveCells", () => {
  it("empties what the move leaves in the target and every data-table body cell", () => {
    // Table K6:L8 (formula row L6, inputs K7:K8, body L7:L8) moved up one row.
    const cells = [
      { row: 5, col: 11, formula: "=B1" },
      { row: 6, col: 10, formula: null },
      { row: 6, col: 11, formula: "=TABLE(,A1)" },
      { row: 7, col: 10, formula: null },
      { row: 7, col: 11, formula: "=TABLE(,A1)" },
    ];
    // The writes land one row up: rows 4..6.
    const written = new Set(cells.map((c) => `${c.row - 1},${c.col}`));
    const vacated = vacatedMoveCells(cells, written, (row) => row >= 4 && row <= 6);
    // Row 7 is source-only: its plain input K8 is cleared after the batch by
    // the source clear, but its body cell L8 must go IN the batch.
    expect(vacated.map((c) => `${c.row},${c.col}`)).toEqual(["7,11"]);
  });
});

// Ledger programme 2 wave 4 (dtcf4), Excel [LIVE, dtcf4/probe1.ps1]: a line
// move carries each line's size AND its hand-hidden state; the lines it leaves
// go back to the standard size, shown; a hidden target line takes its source's
// (visible) state. SABOTAGE: make `movedLineSizes` ignore `hidden` (pass an
// empty set inside) -- fails at "HIDDEN STATE STAYED BEHIND".
describe("movedLineSizes", () => {
  const std = 20;
  it("R1/R2: sizes follow the lines; the lines left behind take the standard size", () => {
    // Row 2 (index 1) at 40, row 5 (index 4) at 53: rows 1..1 to 4.
    let plan = movedLineSizes(1, 1, 4, new Map([[1, 40], [4, 53]]), std, new Set());
    expect([...plan.sizes]).toEqual([[20, [1]], [40, [4]]]);
    expect(plan.hide).toEqual([]);
    // Rows 1..2 at 40 / 27 moved down one: 2 / 3 take 40 / 27, row 1 standard.
    plan = movedLineSizes(1, 2, 2, new Map([[1, 40], [2, 27]]), std, new Set());
    expect([...plan.sizes].sort((a, b) => a[0] - b[0])).toEqual([[20, [1]], [27, [3]], [40, [2]]]);
  });
  it("R3/R4: the hidden state moves; a hidden target line is shown", () => {
    // Rows 1..3, row 2 hidden at 33, moved to 9..11: row 10 hidden, row 2 shown.
    let plan = movedLineSizes(1, 3, 9, new Map([[2, 33]]), std, new Set([2]));
    expect(plan.hide, "HIDDEN STATE STAYED BEHIND").toEqual([10]);
    expect(plan.sizes.get(33)).toEqual([10]);
    expect(plan.sizes.get(std), "the hidden source line is shown at the standard size").toEqual([2]);
    expect(plan.showsHidden).toBe(true);
    // Row 2 at 40 onto the hidden row 12: row 12 shown at 40.
    plan = movedLineSizes(1, 1, 11, new Map([[1, 40]]), std, new Set([11]));
    expect(plan.sizes.get(40)).toEqual([11]);
    expect(plan.hide).toEqual([]);
    expect(plan.showsHidden).toBe(true);
  });
  it("positive control: standard lines onto standard lines write nothing", () => {
    const plan = movedLineSizes(1, 3, 9, new Map([[50, 40]]), std, new Set([60]));
    expect(plan.sizes.size + plan.hide.length).toBe(0);
    expect(lineRuns([1, 2, 3, 7, 9, 10])).toEqual([[1, 3], [7, 7], [9, 10]]);
  });
});

// Ledger programme 2 wave 5 (misc5), Excel [LIVE, misc5/probe1.ps1]: a line a
// filter or a collapsed group hides moves hidden like one hidden by hand, and
// the writes that SHOW hidden lines go apart from the visible lines' (under an
// AutoFilter's filter mode a mixed batch resize passes hidden rows over).
// SABOTAGE: make `lineSizeWrites` write each size's lines in one batch --
// fails at "SHOWN LINES MIXED WITH VISIBLE ONES".
describe("lineSizeWrites", () => {
  it("writes the lines a move shows apart from the visible ones", () => {
    // Rows 2..4 (row 2 at 40; rows 3, 4 hidden) moved to 19..21.
    const plan = movedLineSizes(2, 4, 19, new Map([[2, 40]]), 20, new Set([3, 4]));
    expect(plan.hide).toEqual([20, 21]);
    expect(plan.shows).toEqual([3, 4]);
    expect(lineSizeWrites(plan), "SHOWN LINES MIXED WITH VISIBLE ONES").toEqual([
      [20, [[2, 2]]],
      [20, [[3, 4]]],
      [40, [[19, 19]]],
    ]);
  });
  it("positive control: a plan that shows nothing writes each size once", () => {
    const plan = movedLineSizes(1, 2, 2, new Map([[1, 40], [2, 27]]), 20, new Set());
    expect(plan.shows).toEqual([]);
    expect(lineSizeWrites(plan).length).toBe(plan.sizes.size);
  });
});
