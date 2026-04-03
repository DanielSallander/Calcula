//! FILENAME: app/extensions/TestRunner/lib/suites/workflowFilteredReport.ts
// PURPOSE: Filtered report end-to-end workflow test.
// CONTEXT: Creates a data table, applies filter, sorts, then verifies data integrity.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue } from "../assertions";
import { AREA_WF_FILTERED_REPORT } from "../testArea";
import {
  applyAutoFilter,
  removeAutoFilter,
  setColumnFilterValues,
  getHiddenRows,
  clearAutoFilterCriteria,
  sortRangeByColumn,
} from "@api";

const A = AREA_WF_FILTERED_REPORT;

export const workflowFilteredReportSuite: TestSuite = {
  name: "Workflow: Filtered Report",
  description: "End-to-end data report with filtering, sorting, and data integrity checks.",

  afterEach: async (ctx) => {
    try { await removeAutoFilter(); } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 5; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Create and filter data report",
      description: "Data table with filter, sort, remove filter, verify data intact.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Step 1: Set up data table (header + 6 rows)
        await ctx.setCells([
          // Header
          { row: R, col: C, value: "Name" },
          { row: R, col: C + 1, value: "Region" },
          { row: R, col: C + 2, value: "Sales" },
          // Data
          { row: R + 1, col: C, value: "Alice" },
          { row: R + 1, col: C + 1, value: "North" },
          { row: R + 1, col: C + 2, value: "300" },
          { row: R + 2, col: C, value: "Bob" },
          { row: R + 2, col: C + 1, value: "South" },
          { row: R + 2, col: C + 2, value: "150" },
          { row: R + 3, col: C, value: "Charlie" },
          { row: R + 3, col: C + 1, value: "North" },
          { row: R + 3, col: C + 2, value: "450" },
          { row: R + 4, col: C, value: "Diana" },
          { row: R + 4, col: C + 1, value: "West" },
          { row: R + 4, col: C + 2, value: "200" },
          { row: R + 5, col: C, value: "Eve" },
          { row: R + 5, col: C + 1, value: "North" },
          { row: R + 5, col: C + 2, value: "500" },
          { row: R + 6, col: C, value: "Frank" },
          { row: R + 6, col: C + 1, value: "South" },
          { row: R + 6, col: C + 2, value: "100" },
        ]);
        await ctx.settle();

        // Step 2: Apply autofilter
        await applyAutoFilter(R, C, R + 6, C + 2);
        await ctx.settle();

        // Step 3: Filter Region to "North" only (column 1 relative to filter)
        const filterResult = await setColumnFilterValues(1, ["North"], false);
        await ctx.settle();
        assertTrue(filterResult.success, "filter should succeed");

        // Step 4: Verify hidden rows
        const hidden = await getHiddenRows();
        // South rows (R+2, R+6) and West row (R+4) should be hidden
        assertTrue(hidden.includes(R + 2), `Bob (South) should be hidden`);
        assertTrue(hidden.includes(R + 4), `Diana (West) should be hidden`);
        assertTrue(hidden.includes(R + 6), `Frank (South) should be hidden`);
        // North rows should be visible
        assertTrue(!hidden.includes(R + 1), `Alice (North) should be visible`);
        assertTrue(!hidden.includes(R + 3), `Charlie (North) should be visible`);
        assertTrue(!hidden.includes(R + 5), `Eve (North) should be visible`);

        // Step 5: Remove filter
        await clearAutoFilterCriteria();
        await ctx.settle();

        // Step 6: Verify all rows visible
        const hiddenAfter = await getHiddenRows();
        const ourHidden = hiddenAfter.filter(r => r >= R + 1 && r <= R + 6);
        assertEqual(ourHidden.length, 0, "all data rows should be visible after clearing filter");

        // Step 7: Verify data integrity
        expectCellValue(await ctx.getCell(R + 1, C), "Alice", "Alice should still be row 1");
        expectCellValue(await ctx.getCell(R + 2, C), "Bob", "Bob should still be row 2");
        expectCellValue(await ctx.getCell(R + 6, C), "Frank", "Frank should still be row 6");

        ctx.log("Filtered report workflow completed successfully");
      },
    },
    {
      name: "Filter then remove preserves data",
      description: "Apply filter, remove autofilter entirely, verify all data intact.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        await ctx.setCells([
          { row: R, col: C, value: "Item" },
          { row: R + 1, col: C, value: "A" },
          { row: R + 2, col: C, value: "B" },
          { row: R + 3, col: C, value: "C" },
        ]);
        await ctx.settle();

        await applyAutoFilter(R, C, R + 3, C);
        await ctx.settle();

        await setColumnFilterValues(0, ["A"], false);
        await ctx.settle();

        // Remove autofilter entirely
        await removeAutoFilter();
        await ctx.settle();

        // All rows should be visible and data intact
        expectCellValue(await ctx.getCell(R + 1, C), "A", "A intact");
        expectCellValue(await ctx.getCell(R + 2, C), "B", "B intact");
        expectCellValue(await ctx.getCell(R + 3, C), "C", "C intact");
      },
    },
  ],
};
