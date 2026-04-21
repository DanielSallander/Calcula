//! FILENAME: app/extensions/TestRunner/lib/suites/subtotals.ts
// PURPOSE: Tests for SUBTOTAL function behavior and subtotal-related operations.
// CONTEXT: Verifies SUBTOTAL formula evaluates correctly with various function codes.

import type { TestSuite } from "../types";
import { expectCellValue } from "../assertions";
import { AREA_SUBTOTALS } from "../testArea";

const A = AREA_SUBTOTALS;

export const subtotalsSuite: TestSuite = {
  name: "Subtotals",
  description: "Tests SUBTOTAL function with various function codes.",

  afterEach: async (ctx) => {
    const updates = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 4; c++) {
        updates.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(updates);
    await ctx.settle();
  },

  tests: [
    {
      name: "SUBTOTAL(9,...) calculates SUM",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: `=SUBTOTAL(9,${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(cell, "60", A.ref(3, 0));
      },
    },
    {
      name: "SUBTOTAL(1,...) calculates AVERAGE",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: `=SUBTOTAL(1,${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(cell, "20", A.ref(3, 0));
      },
    },
    {
      name: "SUBTOTAL(2,...) calculates COUNT",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "hello" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: `=SUBTOTAL(2,${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 3, A.col);
        // COUNT counts numeric cells only: 10 and 30 = 2
        expectCellValue(cell, "2", A.ref(3, 0));
      },
    },
    {
      name: "SUBTOTAL(3,...) calculates COUNTA",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "hello" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: `=SUBTOTAL(3,${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 3, A.col);
        // COUNTA counts all non-empty: 3
        expectCellValue(cell, "3", A.ref(3, 0));
      },
    },
    {
      name: "SUBTOTAL(4,...) calculates MAX",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "50" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: `=SUBTOTAL(4,${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(cell, "50", A.ref(3, 0));
      },
    },
    {
      name: "SUBTOTAL(5,...) calculates MIN",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "50" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: `=SUBTOTAL(5,${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(cell, "10", A.ref(3, 0));
      },
    },
    {
      name: "Nested SUBTOTAL excludes inner SUBTOTAL results",
      async run(ctx) {
        // Group 1: values + subtotal
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: `=SUBTOTAL(9,${A.ref(0, 0)}:${A.ref(1, 0)})` },
          // Group 2: values + subtotal
          { row: A.row + 3, col: A.col, value: "30" },
          { row: A.row + 4, col: A.col, value: "40" },
          { row: A.row + 5, col: A.col, value: `=SUBTOTAL(9,${A.ref(3, 0)}:${A.ref(4, 0)})` },
          // Grand total: should ignore the two inner SUBTOTAL cells
          { row: A.row + 6, col: A.col, value: `=SUBTOTAL(9,${A.ref(0, 0)}:${A.ref(5, 0)})` },
        ]);
        await ctx.settle();

        // Inner subtotals
        const sub1 = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(sub1, "30", A.ref(2, 0));

        const sub2 = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(sub2, "70", A.ref(5, 0));

        // Grand total should be 10+20+30+40 = 100, NOT 10+20+30+30+40+70 = 200
        const grand = await ctx.getCell(A.row + 6, A.col);
        expectCellValue(grand, "100", A.ref(6, 0));
      },
    },
    {
      name: "SUBTOTAL with multiple ranges",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "5" },
          { row: A.row + 1, col: A.col, value: "15" },
          { row: A.row + 3, col: A.col, value: "25" },
          { row: A.row + 4, col: A.col, value: "35" },
          // SUM of both ranges
          { row: A.row + 6, col: A.col, value: `=SUBTOTAL(9,${A.ref(0, 0)}:${A.ref(1, 0)},${A.ref(3, 0)}:${A.ref(4, 0)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 6, A.col);
        expectCellValue(cell, "80", A.ref(6, 0));
      },
    },
    {
      name: "SUBTOTAL updates when source data changes",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: `=SUBTOTAL(9,${A.ref(0, 0)}:${A.ref(1, 0)})` },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(cell, "30", A.ref(2, 0));

        // Change a source value
        await ctx.setCells([
          { row: A.row, col: A.col, value: "100" },
        ]);
        await ctx.settle();

        cell = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(cell, "120", A.ref(2, 0));
      },
    },
  ],
};
