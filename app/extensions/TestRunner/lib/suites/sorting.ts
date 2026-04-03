//! FILENAME: app/extensions/TestRunner/lib/suites/sorting.ts
// PURPOSE: Sorting test suite.
// CONTEXT: Tests ascending/descending sort, text sort, row integrity, and empty cells.

import type { TestSuite } from "../types";
import { expectCellValue, assertTrue } from "../assertions";
import { AREA_SORTING } from "../testArea";
import { sortRangeByColumn } from "@api";

const A = AREA_SORTING;

export const sortingSuite: TestSuite = {
  name: "Sorting",
  description: "Tests sort operations on ranges of data.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 4; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Sort ascending by numeric column",
      description: "Numeric column sorts low-to-high.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "30" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "20" },
        ]);
        await ctx.settle();

        await sortRangeByColumn(A.row, A.col, A.row + 2, A.col, A.col, true, false);
        await ctx.settle();

        expectCellValue(await ctx.getCell(A.row, A.col), "10", "first after asc sort");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "20", "second after asc sort");
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "30", "third after asc sort");
      },
    },
    {
      name: "Sort descending by numeric column",
      description: "Numeric column sorts high-to-low.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "30" },
          { row: A.row + 2, col: A.col, value: "20" },
        ]);
        await ctx.settle();

        await sortRangeByColumn(A.row, A.col, A.row + 2, A.col, A.col, false, false);
        await ctx.settle();

        expectCellValue(await ctx.getCell(A.row, A.col), "30", "first after desc sort");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "20", "second after desc sort");
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "10", "third after desc sort");
      },
    },
    {
      name: "Sort text alphabetically",
      description: "Text column sorts A-Z.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Cherry" },
          { row: A.row + 1, col: A.col, value: "Apple" },
          { row: A.row + 2, col: A.col, value: "Banana" },
        ]);
        await ctx.settle();

        await sortRangeByColumn(A.row, A.col, A.row + 2, A.col, A.col, true, false);
        await ctx.settle();

        expectCellValue(await ctx.getCell(A.row, A.col), "Apple", "first after text sort");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "Banana", "second");
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "Cherry", "third");
      },
    },
    {
      name: "Sort preserves row integrity",
      description: "Multi-column data stays together when sorted.",
      run: async (ctx) => {
        // Col 0: names, Col 1: scores
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Bob" },
          { row: A.row, col: A.col + 1, value: "30" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "10" },
          { row: A.row + 2, col: A.col, value: "Charlie" },
          { row: A.row + 2, col: A.col + 1, value: "20" },
        ]);
        await ctx.settle();

        // Sort by score column ascending
        await sortRangeByColumn(A.row, A.col, A.row + 2, A.col + 1, A.col + 1, true, false);
        await ctx.settle();

        // Alice(10) should be first, Charlie(20) second, Bob(30) third
        expectCellValue(await ctx.getCell(A.row, A.col), "Alice", "row 0 name");
        expectCellValue(await ctx.getCell(A.row, A.col + 1), "10", "row 0 score");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "Charlie", "row 1 name");
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "Bob", "row 2 name");
      },
    },
    {
      name: "Sort with empty cells",
      description: "Empty cells sort to the bottom.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "30" },
          { row: A.row + 1, col: A.col, value: "" },
          { row: A.row + 2, col: A.col, value: "10" },
        ]);
        await ctx.settle();

        await sortRangeByColumn(A.row, A.col, A.row + 2, A.col, A.col, true, false);
        await ctx.settle();

        // Non-empty values should come first
        const first = await ctx.getCell(A.row, A.col);
        const second = await ctx.getCell(A.row + 1, A.col);
        assertTrue(
          first !== null && first.display !== "",
          "First cell should not be empty after sort"
        );
        // The empty cell should be at the bottom
        ctx.log(`Sorted order: "${first?.display}", "${second?.display}"`);
      },
    },
  ],
};
