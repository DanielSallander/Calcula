//! FILENAME: app/extensions/TestRunner/lib/suites/aggregation.ts
// PURPOSE: Selection aggregation test suite.
// CONTEXT: Tests the status bar aggregation functions (sum, average, count, min, max).

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_AGGREGATION } from "../testArea";
import { getSelectionAggregations } from "@api";

const A = AREA_AGGREGATION;

export const aggregationSuite: TestSuite = {
  name: "Aggregation",
  description: "Tests selection aggregation (sum, average, count, min, max).",

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
      name: "Sum of numeric range",
      description: "getSelectionAggregations returns correct sum.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: "30" },
        ]);
        await ctx.settle();

        const result = await getSelectionAggregations(
          A.row, A.col, A.row + 2, A.col, "range"
        );
        assertEqual(result.sum, 60, "sum should be 60");
        assertEqual(result.count, 3, "count should be 3");
        assertEqual(result.numericalCount, 3, "numericalCount should be 3");
      },
    },
    {
      name: "Average of numeric range",
      description: "Average computed correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: "30" },
        ]);
        await ctx.settle();

        const result = await getSelectionAggregations(
          A.row, A.col, A.row + 2, A.col, "range"
        );
        assertEqual(result.average, 20, "average should be 20");
      },
    },
    {
      name: "Min and max",
      description: "Min and max computed correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "5" },
          { row: A.row + 1, col: A.col, value: "100" },
          { row: A.row + 2, col: A.col, value: "42" },
        ]);
        await ctx.settle();

        const result = await getSelectionAggregations(
          A.row, A.col, A.row + 2, A.col, "range"
        );
        assertEqual(result.min, 5, "min should be 5");
        assertEqual(result.max, 100, "max should be 100");
      },
    },
    {
      name: "Mixed text and numbers",
      description: "Text cells excluded from numerical aggregations.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "hello" },
          { row: A.row + 2, col: A.col, value: "30" },
        ]);
        await ctx.settle();

        const result = await getSelectionAggregations(
          A.row, A.col, A.row + 2, A.col, "range"
        );
        assertEqual(result.count, 3, "count includes text cells");
        assertEqual(result.numericalCount, 2, "numericalCount excludes text");
        assertEqual(result.sum, 40, "sum of numeric values only");
      },
    },
    {
      name: "Empty range",
      description: "Empty range returns null aggregations.",
      run: async (ctx) => {
        // Use a range that's already empty (afterEach clears it)
        const result = await getSelectionAggregations(
          A.row + 5, A.col, A.row + 7, A.col, "range"
        );
        assertEqual(result.count, 0, "count should be 0");
        assertEqual(result.numericalCount, 0, "numericalCount should be 0");
        assertTrue(result.sum === null || result.sum === 0, "sum should be null or 0 for empty");
      },
    },
  ],
};
