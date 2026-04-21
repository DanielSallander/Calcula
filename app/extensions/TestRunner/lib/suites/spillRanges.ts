//! FILENAME: app/extensions/TestRunner/lib/suites/spillRanges.ts
// PURPOSE: Tests for dynamic array formulas and spill range behavior.
// CONTEXT: Verifies SEQUENCE, SORT, UNIQUE produce correct spill output.

import type { TestSuite } from "../types";
import { expectCellValue } from "../assertions";
import { AREA_SPILL_RANGES } from "../testArea";

const A = AREA_SPILL_RANGES;

export const spillRangesSuite: TestSuite = {
  name: "Spill Ranges",
  description: "Tests dynamic array formulas and spill behavior.",

  afterEach: async (ctx) => {
    const updates = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 6; c++) {
        updates.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(updates);
    await ctx.settle();
  },

  tests: [
    {
      name: "SEQUENCE(5) spills vertically",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=SEQUENCE(5)" },
        ]);
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col, A.row + 4, A.col);
        expectCellValue(cells.get(A.ref(0, 0))!, "1", A.ref(0, 0));
        expectCellValue(cells.get(A.ref(1, 0))!, "2", A.ref(1, 0));
        expectCellValue(cells.get(A.ref(2, 0))!, "3", A.ref(2, 0));
        expectCellValue(cells.get(A.ref(3, 0))!, "4", A.ref(3, 0));
        expectCellValue(cells.get(A.ref(4, 0))!, "5", A.ref(4, 0));
      },
    },
    {
      name: "SEQUENCE(3,2) spills in a 3x2 grid",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=SEQUENCE(3,2)" },
        ]);
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col, A.row + 2, A.col + 1);
        expectCellValue(cells.get(A.ref(0, 0))!, "1", A.ref(0, 0));
        expectCellValue(cells.get(A.ref(0, 1))!, "2", A.ref(0, 1));
        expectCellValue(cells.get(A.ref(1, 0))!, "3", A.ref(1, 0));
        expectCellValue(cells.get(A.ref(1, 1))!, "4", A.ref(1, 1));
        expectCellValue(cells.get(A.ref(2, 0))!, "5", A.ref(2, 0));
        expectCellValue(cells.get(A.ref(2, 1))!, "6", A.ref(2, 1));
      },
    },
    {
      name: "SEQUENCE with start and step parameters",
      async run(ctx) {
        // SEQUENCE(4,1,10,5) = 10, 15, 20, 25
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=SEQUENCE(4,1,10,5)" },
        ]);
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col, A.row + 3, A.col);
        expectCellValue(cells.get(A.ref(0, 0))!, "10", A.ref(0, 0));
        expectCellValue(cells.get(A.ref(1, 0))!, "15", A.ref(1, 0));
        expectCellValue(cells.get(A.ref(2, 0))!, "20", A.ref(2, 0));
        expectCellValue(cells.get(A.ref(3, 0))!, "25", A.ref(3, 0));
      },
    },
    {
      name: "SORT spills sorted results",
      async run(ctx) {
        // Set up data to sort
        await ctx.setCells([
          { row: A.row, col: A.col, value: "30" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "20" },
        ]);
        await ctx.settle();

        // SORT the range in a separate column
        const rangeRef = `${A.ref(0, 0)}:${A.ref(2, 0)}`;
        await ctx.setCells([
          { row: A.row, col: A.col + 2, value: `=SORT(${rangeRef})` },
        ]);
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col + 2, A.row + 2, A.col + 2);
        expectCellValue(cells.get(A.ref(0, 2))!, "10", A.ref(0, 2));
        expectCellValue(cells.get(A.ref(1, 2))!, "20", A.ref(1, 2));
        expectCellValue(cells.get(A.ref(2, 2))!, "30", A.ref(2, 2));
      },
    },
    {
      name: "UNIQUE removes duplicate values",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Apple" },
          { row: A.row + 1, col: A.col, value: "Banana" },
          { row: A.row + 2, col: A.col, value: "Apple" },
          { row: A.row + 3, col: A.col, value: "Cherry" },
          { row: A.row + 4, col: A.col, value: "Banana" },
        ]);
        await ctx.settle();

        const rangeRef = `${A.ref(0, 0)}:${A.ref(4, 0)}`;
        await ctx.setCells([
          { row: A.row, col: A.col + 2, value: `=UNIQUE(${rangeRef})` },
        ]);
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col + 2, A.row + 2, A.col + 2);
        expectCellValue(cells.get(A.ref(0, 2))!, "Apple", A.ref(0, 2));
        expectCellValue(cells.get(A.ref(1, 2))!, "Banana", A.ref(1, 2));
        expectCellValue(cells.get(A.ref(2, 2))!, "Cherry", A.ref(2, 2));
      },
    },
    {
      name: "SEQUENCE(1,5) spills horizontally",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=SEQUENCE(1,5)" },
        ]);
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col, A.row, A.col + 4);
        expectCellValue(cells.get(A.ref(0, 0))!, "1", A.ref(0, 0));
        expectCellValue(cells.get(A.ref(0, 1))!, "2", A.ref(0, 1));
        expectCellValue(cells.get(A.ref(0, 2))!, "3", A.ref(0, 2));
        expectCellValue(cells.get(A.ref(0, 3))!, "4", A.ref(0, 3));
        expectCellValue(cells.get(A.ref(0, 4))!, "5", A.ref(0, 4));
      },
    },
    {
      name: "SORT descending order",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "30" },
          { row: A.row + 2, col: A.col, value: "20" },
        ]);
        await ctx.settle();

        const rangeRef = `${A.ref(0, 0)}:${A.ref(2, 0)}`;
        // SORT(array, sort_index, sort_order) where -1 = descending
        await ctx.setCells([
          { row: A.row, col: A.col + 2, value: `=SORT(${rangeRef},1,-1)` },
        ]);
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col + 2, A.row + 2, A.col + 2);
        expectCellValue(cells.get(A.ref(0, 2))!, "30", A.ref(0, 2));
        expectCellValue(cells.get(A.ref(1, 2))!, "20", A.ref(1, 2));
        expectCellValue(cells.get(A.ref(2, 2))!, "10", A.ref(2, 2));
      },
    },
  ],
};
