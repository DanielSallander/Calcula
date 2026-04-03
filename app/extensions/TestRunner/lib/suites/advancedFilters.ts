//! FILENAME: app/extensions/TestRunner/lib/suites/advancedFilters.ts
// PURPOSE: Advanced AutoFilter test suite.
// CONTEXT: Tests custom filters, top/bottom, dynamic, clearColumnCriteria,
//          isRowFiltered, getHiddenRows, getAutoFilterRange.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual } from "../assertions";
import { AREA_ADV_FILTERS } from "../testArea";
import {
  applyAutoFilter,
  removeAutoFilter,
  setColumnFilterValues,
  setColumnCustomFilter,
  setColumnTopBottomFilter,
  setColumnDynamicFilter,
  clearColumnCriteria,
  reapplyAutoFilter,
  isRowFiltered,
  getHiddenRows,
  getAutoFilterRange,
} from "@api";

const A = AREA_ADV_FILTERS;

export const advancedFiltersSuite: TestSuite = {
  name: "Advanced Filters",
  description: "Tests custom, top/bottom, dynamic filters, and filter query APIs.",

  afterEach: async (ctx) => {
    try { await removeAutoFilter(); } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 4; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Custom filter - greater than",
      description: "setColumnCustomFilter hides rows not matching criterion.",
      run: async (ctx) => {
        // Header + 5 data rows with numbers
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Amount" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "50" },
          { row: A.row + 3, col: A.col, value: "30" },
          { row: A.row + 4, col: A.col, value: "80" },
          { row: A.row + 5, col: A.col, value: "20" },
        ]);
        await ctx.settle();

        await applyAutoFilter(A.row, A.col, A.row + 5, A.col);
        // Filter: Amount > 25 (should keep 50, 30, 80)
        const result = await setColumnCustomFilter(0, ">=30");
        assertTrue(result.hiddenRows.length > 0, "should have hidden rows");

        // Rows with 10 and 20 should be hidden
        const is10Hidden = await isRowFiltered(A.row + 1);
        assertTrue(is10Hidden, "row with 10 should be hidden");
        const is50Hidden = await isRowFiltered(A.row + 2);
        assertTrue(!is50Hidden, "row with 50 should be visible");
      },
    },
    {
      name: "Custom filter - two criteria with AND",
      description: "Custom filter with two criteria combined with AND.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Val" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: "50" },
          { row: A.row + 4, col: A.col, value: "70" },
          { row: A.row + 5, col: A.col, value: "90" },
        ]);
        await ctx.settle();

        await applyAutoFilter(A.row, A.col, A.row + 5, A.col);
        // Between 20 and 60: >=20 AND <=60
        await setColumnCustomFilter(0, ">=20", "<=60", "and");

        const hidden = await getHiddenRows();
        // Rows with 10 and 70 and 90 should be hidden
        const row10Hidden = hidden.includes(A.row + 1);
        const row70Hidden = hidden.includes(A.row + 4);
        assertTrue(row10Hidden, "10 should be hidden");
        assertTrue(row70Hidden, "70 should be hidden");

        const row30Hidden = hidden.includes(A.row + 2);
        assertTrue(!row30Hidden, "30 should be visible");
      },
    },
    {
      name: "Top/bottom filter - top 2 items",
      description: "setColumnTopBottomFilter shows only top N values.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Score" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "40" },
          { row: A.row + 3, col: A.col, value: "20" },
          { row: A.row + 4, col: A.col, value: "50" },
          { row: A.row + 5, col: A.col, value: "30" },
        ]);
        await ctx.settle();

        await applyAutoFilter(A.row, A.col, A.row + 5, A.col);
        const result = await setColumnTopBottomFilter(0, "topItems", 2);
        assertTrue(result.hiddenRows.length > 0, "some rows hidden");

        // Top 2: 50 (row+4) and 40 (row+2) should be visible
        const is50Visible = !result.hiddenRows.includes(A.row + 4);
        const is40Visible = !result.hiddenRows.includes(A.row + 2);
        assertTrue(is50Visible, "50 should be visible (top 2)");
        assertTrue(is40Visible, "40 should be visible (top 2)");

        // 10 should be hidden
        const is10Hidden = result.hiddenRows.includes(A.row + 1);
        assertTrue(is10Hidden, "10 should be hidden");
      },
    },
    {
      name: "Dynamic filter - above average",
      description: "setColumnDynamicFilter hides below-average values.",
      run: async (ctx) => {
        // Values: 10, 20, 30, 40, 50 => average = 30
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Num" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "20" },
          { row: A.row + 3, col: A.col, value: "30" },
          { row: A.row + 4, col: A.col, value: "40" },
          { row: A.row + 5, col: A.col, value: "50" },
        ]);
        await ctx.settle();

        await applyAutoFilter(A.row, A.col, A.row + 5, A.col);
        const result = await setColumnDynamicFilter(0, "aboveAverage");
        assertTrue(result.hiddenRows.length > 0, "some rows hidden");

        // 10 and 20 should be hidden (below average of 30)
        assertTrue(result.hiddenRows.includes(A.row + 1), "10 hidden");
        assertTrue(result.hiddenRows.includes(A.row + 2), "20 hidden");
      },
    },
    {
      name: "Clear column criteria",
      description: "clearColumnCriteria removes filter for one column.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row, col: A.col + 1, value: "B" },
          { row: A.row + 1, col: A.col, value: "x" },
          { row: A.row + 1, col: A.col + 1, value: "1" },
          { row: A.row + 2, col: A.col, value: "y" },
          { row: A.row + 2, col: A.col + 1, value: "2" },
        ]);
        await ctx.settle();

        await applyAutoFilter(A.row, A.col, A.row + 2, A.col + 1);
        // Filter col 0 to only "x"
        await setColumnFilterValues(0, ["x"], false);

        let hidden = await getHiddenRows();
        assertTrue(hidden.includes(A.row + 2), "y row should be hidden");

        // Clear column 0 criteria
        await clearColumnCriteria(0);
        hidden = await getHiddenRows();
        const ourHidden = hidden.filter(r => r >= A.row && r <= A.row + 2);
        assertEqual(ourHidden.length, 0, "no rows hidden after clear");
      },
    },
    {
      name: "Get auto filter range",
      description: "getAutoFilterRange returns the correct range.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "H1" },
          { row: A.row, col: A.col + 1, value: "H2" },
          { row: A.row + 1, col: A.col, value: "d1" },
          { row: A.row + 1, col: A.col + 1, value: "d2" },
        ]);
        await ctx.settle();

        await applyAutoFilter(A.row, A.col, A.row + 1, A.col + 1);

        const range = await getAutoFilterRange();
        assertTrue(range !== null, "range should exist");
        assertEqual(range![0], A.row, "startRow");
        assertEqual(range![1], A.col, "startCol");
        assertEqual(range![2], A.row + 1, "endRow");
        assertEqual(range![3], A.col + 1, "endCol");
      },
    },
    {
      name: "Reapply auto filter",
      description: "reapplyAutoFilter refreshes filter with updated data.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Val" },
          { row: A.row + 1, col: A.col, value: "A" },
          { row: A.row + 2, col: A.col, value: "B" },
        ]);
        await ctx.settle();

        await applyAutoFilter(A.row, A.col, A.row + 2, A.col);
        await setColumnFilterValues(0, ["A"], false);

        // B row should be hidden
        let hidden = await getHiddenRows();
        assertTrue(hidden.includes(A.row + 2), "B should be hidden");

        // Change B to A and reapply
        await ctx.setCells([{ row: A.row + 2, col: A.col, value: "A" }]);
        await ctx.settle();

        const result = await reapplyAutoFilter();
        // After reapply, row+2 now has "A" which matches filter, so it should be visible
        const stillHidden = result.hiddenRows.includes(A.row + 2);
        assertTrue(!stillHidden, "row should be visible after reapply (now matches A)");
      },
    },
  ],
};
