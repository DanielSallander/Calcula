//! FILENAME: app/extensions/TestRunner/lib/suites/removeDuplicates.ts
// PURPOSE: Remove duplicates test suite.
// CONTEXT: Tests removing duplicate rows from a data range.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectCellValue } from "../assertions";
import { AREA_REMOVE_DUPLICATES } from "../testArea";
import { removeDuplicates } from "@api";

const A = AREA_REMOVE_DUPLICATES;

export const removeDuplicatesSuite: TestSuite = {
  name: "Remove Duplicates",
  description: "Tests removing duplicate rows from data ranges.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Remove duplicates from single column",
      description: "Duplicate rows removed, unique remain.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Apple" },
          { row: A.row + 1, col: A.col, value: "Banana" },
          { row: A.row + 2, col: A.col, value: "Apple" },
          { row: A.row + 3, col: A.col, value: "Cherry" },
          { row: A.row + 4, col: A.col, value: "Banana" },
        ]);
        await ctx.settle();

        const result = await removeDuplicates(
          A.row, A.col, A.row + 4, A.col, [A.col], false
        );
        await ctx.settle();

        assertTrue(result.success, "Remove duplicates should succeed");
        assertEqual(result.duplicatesRemoved, 2, "should remove 2 duplicates");
        assertEqual(result.uniqueRemaining, 3, "should have 3 unique values");
      },
    },
    {
      name: "Remove duplicates with header row",
      description: "Header is preserved, not treated as data.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Fruit" },  // header
          { row: A.row + 1, col: A.col, value: "Apple" },
          { row: A.row + 2, col: A.col, value: "Apple" },
          { row: A.row + 3, col: A.col, value: "Banana" },
        ]);
        await ctx.settle();

        const result = await removeDuplicates(
          A.row, A.col, A.row + 3, A.col, [A.col], true
        );
        await ctx.settle();

        assertTrue(result.success, "Should succeed with header");
        assertEqual(result.duplicatesRemoved, 1, "1 duplicate Apple removed");

        // Header should still be there
        const header = await ctx.getCell(A.row, A.col);
        expectCellValue(header, "Fruit", "header preserved");
      },
    },
    {
      name: "Remove duplicates across multiple columns",
      description: "Only full-row duplicates removed.",
      run: async (ctx) => {
        // Two columns: name + city
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Alice" },
          { row: A.row, col: A.col + 1, value: "Stockholm" },
          { row: A.row + 1, col: A.col, value: "Bob" },
          { row: A.row + 1, col: A.col + 1, value: "Oslo" },
          { row: A.row + 2, col: A.col, value: "Alice" },
          { row: A.row + 2, col: A.col + 1, value: "Stockholm" }, // full duplicate
          { row: A.row + 3, col: A.col, value: "Alice" },
          { row: A.row + 3, col: A.col + 1, value: "Oslo" }, // different city, not a dup
        ]);
        await ctx.settle();

        const result = await removeDuplicates(
          A.row, A.col, A.row + 3, A.col + 1, [A.col, A.col + 1], false
        );
        await ctx.settle();

        assertTrue(result.success, "Should succeed");
        assertEqual(result.duplicatesRemoved, 1, "only 1 full-row duplicate");
        assertEqual(result.uniqueRemaining, 3, "3 unique rows");
      },
    },
    {
      name: "All unique data unchanged",
      description: "No rows removed when all data is unique.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row + 1, col: A.col, value: "B" },
          { row: A.row + 2, col: A.col, value: "C" },
        ]);
        await ctx.settle();

        const result = await removeDuplicates(
          A.row, A.col, A.row + 2, A.col, [A.col], false
        );
        await ctx.settle();

        assertEqual(result.duplicatesRemoved, 0, "no duplicates to remove");
        assertEqual(result.uniqueRemaining, 3, "all 3 rows remain");
      },
    },
  ],
};
