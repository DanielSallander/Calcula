//! FILENAME: app/extensions/TestRunner/lib/suites/spillRanges.ts
// PURPOSE: Tests for dynamic array formulas and spill range behavior.
// CONTEXT: Verifies SEQUENCE, SORT, FILTER, UNIQUE produce correct spill output.

import type { TestSuite } from "../types";
import { expectCellValue, expectCellEmpty } from "../assertions";
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
      name: "Spill blocked by existing data shows error",
      async run(ctx) {
        // Put a blocker cell where the spill would go
        await ctx.setCells([
          { row: A.row + 2, col: A.col, value: "blocker" },
        ]);
        await ctx.settle();

        // SEQUENCE(5) needs rows 0-4, but row 2 is occupied
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=SEQUENCE(5)" },
        ]);
        await ctx.settle();

        // The host cell should show an error (spill blocked)
        const host = await ctx.getCell(A.row, A.col);
        if (!host || !host.display.includes("#")) {
          ctx.log(`Host display: ${host?.display}`);
          throw new Error(`Expected error for spill-blocked SEQUENCE, got: ${host?.display}`);
        }
      },
    },
    {
      name: "Clearing blocker allows spill to complete",
      async run(ctx) {
        // Set up blocker then formula
        await ctx.setCells([
          { row: A.row + 1, col: A.col, value: "blocker" },
        ]);
        await ctx.settle();
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=SEQUENCE(3)" },
        ]);
        await ctx.settle();

        // Verify blocked
        const hostBefore = await ctx.getCell(A.row, A.col);
        if (!hostBefore || !hostBefore.display.includes("#")) {
          ctx.log(`Skipping unblock test - formula not blocked: ${hostBefore?.display}`);
          return;
        }

        // Clear the blocker
        await ctx.setCells([
          { row: A.row + 1, col: A.col, value: "" },
        ]);
        await ctx.settle();

        // Now the spill should work
        const cells = await ctx.getCells(A.row, A.col, A.row + 2, A.col);
        expectCellValue(cells.get(A.ref(0, 0))!, "1", A.ref(0, 0));
        expectCellValue(cells.get(A.ref(1, 0))!, "2", A.ref(1, 0));
        expectCellValue(cells.get(A.ref(2, 0))!, "3", A.ref(2, 0));
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

        // SORT the range
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
      name: "FILTER returns matching rows",
      async run(ctx) {
        // Data: values in col 0, criteria in col 1
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row, col: A.col + 1, value: "Y" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 1, col: A.col + 1, value: "N" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 2, col: A.col + 1, value: "Y" },
        ]);
        await ctx.settle();

        const dataRef = `${A.ref(0, 0)}:${A.ref(2, 0)}`;
        const critRef = `${A.ref(0, 1)}:${A.ref(2, 1)}`;
        await ctx.setCells([
          { row: A.row, col: A.col + 3, value: `=FILTER(${dataRef},${critRef}="Y")` },
        ]);
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col + 3, A.row + 1, A.col + 3);
        expectCellValue(cells.get(A.ref(0, 3))!, "10", A.ref(0, 3));
        expectCellValue(cells.get(A.ref(1, 3))!, "30", A.ref(1, 3));
      },
    },
    {
      name: "Spill range updates when source data changes",
      async run(ctx) {
        // Set up source and SORT formula
        await ctx.setCells([
          { row: A.row, col: A.col, value: "3" },
          { row: A.row + 1, col: A.col, value: "1" },
          { row: A.row + 2, col: A.col, value: "2" },
        ]);
        await ctx.settle();

        const rangeRef = `${A.ref(0, 0)}:${A.ref(2, 0)}`;
        await ctx.setCells([
          { row: A.row, col: A.col + 2, value: `=SORT(${rangeRef})` },
        ]);
        await ctx.settle();

        // Verify initial sort
        let cells = await ctx.getCells(A.row, A.col + 2, A.row + 2, A.col + 2);
        expectCellValue(cells.get(A.ref(0, 2))!, "1", A.ref(0, 2));

        // Change source data
        await ctx.setCells([
          { row: A.row + 1, col: A.col, value: "5" },
        ]);
        await ctx.settle();

        // SORT should reflect new data: 2, 3, 5
        cells = await ctx.getCells(A.row, A.col + 2, A.row + 2, A.col + 2);
        expectCellValue(cells.get(A.ref(0, 2))!, "2", A.ref(0, 2));
        expectCellValue(cells.get(A.ref(1, 2))!, "3", A.ref(1, 2));
        expectCellValue(cells.get(A.ref(2, 2))!, "5", A.ref(2, 2));
      },
    },
  ],
};
