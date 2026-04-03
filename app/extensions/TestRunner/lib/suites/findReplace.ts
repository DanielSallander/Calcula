//! FILENAME: app/extensions/TestRunner/lib/suites/findReplace.ts
// PURPOSE: Find & Replace test suite.
// CONTEXT: Tests finding, replacing single/all, and case-sensitive search.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectCellValue } from "../assertions";
import { AREA_FIND_REPLACE } from "../testArea";
import { findAll, replaceAll, replaceSingle } from "@api";

const A = AREA_FIND_REPLACE;

export const findReplaceSuite: TestSuite = {
  name: "Find & Replace",
  description: "Tests find all, replace all, replace single, case-sensitive.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Find all matches",
      description: "Returns correct count and positions.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "hello" },
          { row: A.row + 1, col: A.col, value: "world" },
          { row: A.row + 2, col: A.col, value: "hello again" },
          { row: A.row + 3, col: A.col, value: "goodbye" },
        ]);
        await ctx.settle();

        const result = await findAll("hello");
        assertTrue(result.totalCount >= 2, `Should find at least 2 matches, got ${result.totalCount}`);
      },
    },
    {
      name: "Find case-sensitive",
      description: "Case-sensitive flag distinguishes case.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Hello" },
          { row: A.row + 1, col: A.col, value: "hello" },
          { row: A.row + 2, col: A.col, value: "HELLO" },
        ]);
        await ctx.settle();

        const caseSensitive = await findAll("Hello", { caseSensitive: true });
        const caseInsensitive = await findAll("Hello", { caseSensitive: false });

        assertTrue(
          caseSensitive.totalCount <= caseInsensitive.totalCount,
          "Case-sensitive should find <= case-insensitive matches"
        );
        assertTrue(caseSensitive.totalCount >= 1, "Should find at least 'Hello'");
      },
    },
    {
      name: "Replace all occurrences",
      description: "All matching cells updated.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "foo" },
          { row: A.row + 1, col: A.col, value: "bar" },
          { row: A.row + 2, col: A.col, value: "foo" },
        ]);
        await ctx.settle();

        const result = await replaceAll("foo", "baz");
        await ctx.settle();

        assertTrue(result.replacementCount >= 2, `Should replace at least 2, got ${result.replacementCount}`);

        const cell0 = await ctx.getCell(A.row, A.col);
        expectCellValue(cell0, "baz", "first replaced cell");
        const cell2 = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(cell2, "baz", "second replaced cell");
        // "bar" should be unchanged
        const cell1 = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(cell1, "bar", "non-matching cell unchanged");
      },
    },
    {
      name: "Replace single occurrence",
      description: "Only the specified cell is updated.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "apple" },
          { row: A.row + 1, col: A.col, value: "apple" },
        ]);
        await ctx.settle();

        await replaceSingle(A.row, A.col, "apple", "orange");
        await ctx.settle();

        expectCellValue(await ctx.getCell(A.row, A.col), "orange", "replaced cell");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "apple", "untouched cell");
      },
    },
    {
      name: "Find with no matches",
      description: "Returns zero results.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "hello" },
        ]);
        await ctx.settle();

        const result = await findAll("zzz_nonexistent_zzz");
        assertEqual(result.totalCount, 0, "no matches expected");
      },
    },
  ],
};
