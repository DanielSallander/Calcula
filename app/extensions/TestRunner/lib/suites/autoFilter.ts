//! FILENAME: app/extensions/TestRunner/lib/suites/autoFilter.ts
// PURPOSE: AutoFilter test suite.
// CONTEXT: Tests applying, filtering, clearing, and removing autofilter.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_AUTOFILTER } from "../testArea";
import {
  applyAutoFilter,
  removeAutoFilter,
  getAutoFilter,
  setColumnFilterValues,
  getFilterUniqueValues,
  clearAutoFilterCriteria,
} from "../../../../src/api";

const A = AREA_AUTOFILTER;

export const autoFilterSuite: TestSuite = {
  name: "AutoFilter",
  description: "Tests autofilter apply, filter values, clear, and remove.",

  beforeEach: async (ctx) => {
    // Set up a small data table: Header + 4 data rows, 2 columns
    await ctx.setCells([
      { row: A.row, col: A.col, value: "Name" },
      { row: A.row, col: A.col + 1, value: "City" },
      { row: A.row + 1, col: A.col, value: "Alice" },
      { row: A.row + 1, col: A.col + 1, value: "Stockholm" },
      { row: A.row + 2, col: A.col, value: "Bob" },
      { row: A.row + 2, col: A.col + 1, value: "Oslo" },
      { row: A.row + 3, col: A.col, value: "Charlie" },
      { row: A.row + 3, col: A.col + 1, value: "Stockholm" },
      { row: A.row + 4, col: A.col, value: "Diana" },
      { row: A.row + 4, col: A.col + 1, value: "Helsinki" },
    ]);
    await ctx.settle();
  },

  afterEach: async (ctx) => {
    try { await removeAutoFilter(); } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Apply autofilter to range",
      description: "getAutoFilter returns non-null after apply.",
      run: async (ctx) => {
        await applyAutoFilter(A.row, A.col, A.row + 4, A.col + 1);
        await ctx.settle();

        const filter = await getAutoFilter();
        expectNotNull(filter, "AutoFilter should be active");
        assertEqual(filter!.startRow, A.row, "filter startRow");
        assertTrue(filter!.enabled, "filter should be enabled");
      },
    },
    {
      name: "Get unique values for column",
      description: "Returns distinct city values.",
      run: async (ctx) => {
        await applyAutoFilter(A.row, A.col, A.row + 4, A.col + 1);
        await ctx.settle();

        // columnIndex is relative to the autofilter range start column
        const result = await getFilterUniqueValues(1);
        assertTrue(result.success, "getFilterUniqueValues should succeed");
        const cityValues = result.values.map(v => v.value);
        assertTrue(cityValues.includes("Stockholm"), "Should include Stockholm");
        assertTrue(cityValues.includes("Oslo"), "Should include Oslo");
        assertTrue(cityValues.includes("Helsinki"), "Should include Helsinki");
      },
    },
    {
      name: "Filter by value selection",
      description: "setColumnFilterValues hides non-matching rows.",
      run: async (ctx) => {
        await applyAutoFilter(A.row, A.col, A.row + 4, A.col + 1);
        await ctx.settle();

        // Filter to show only "Stockholm" (column 1 = City, relative to filter range)
        const result = await setColumnFilterValues(1, ["Stockholm"], false);
        await ctx.settle();

        assertTrue(result.success, "Filter should succeed");
        // hiddenRows should include rows for Oslo and Helsinki
        assertTrue(result.hiddenRows.length > 0, "Some rows should be hidden");
        ctx.log(`Hidden rows: ${result.hiddenRows.join(", ")}`);
      },
    },
    {
      name: "Clear filter criteria restores all rows",
      description: "All rows visible after clearing criteria.",
      run: async (ctx) => {
        await applyAutoFilter(A.row, A.col, A.row + 4, A.col + 1);
        await ctx.settle();

        // Apply filter (column 1 = City, relative to filter range)
        await setColumnFilterValues(1, ["Stockholm"], false);
        await ctx.settle();

        // Clear
        const result = await clearAutoFilterCriteria();
        await ctx.settle();

        assertTrue(result.success, "Clear should succeed");
        assertEqual(result.hiddenRows.length, 0, "no rows hidden after clear");
      },
    },
    {
      name: "Remove autofilter entirely",
      description: "getAutoFilter returns null after removal.",
      run: async (ctx) => {
        await applyAutoFilter(A.row, A.col, A.row + 4, A.col + 1);
        await ctx.settle();

        await removeAutoFilter();
        await ctx.settle();

        const filter = await getAutoFilter();
        assertTrue(filter === null, "AutoFilter should be null after removal");
      },
    },
    {
      name: "Filter preserves data",
      description: "Filtered-out rows still have data when unfiltered.",
      run: async (ctx) => {
        await applyAutoFilter(A.row, A.col, A.row + 4, A.col + 1);
        await ctx.settle();

        // Filter to show only Stockholm (column 1 = City, relative to filter range)
        await setColumnFilterValues(1, ["Stockholm"], false);
        await ctx.settle();

        // Clear filter
        await clearAutoFilterCriteria();
        await ctx.settle();

        // Bob's row should still have data
        const bob = await ctx.getCell(A.row + 2, A.col);
        assertTrue(bob !== null && bob.display === "Bob", "Bob's data should be preserved");
      },
    },
  ],
};
