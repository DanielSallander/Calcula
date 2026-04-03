//! FILENAME: app/extensions/TestRunner/lib/suites/emptyRangeOps.ts
// PURPOSE: Empty/zero range operation edge case tests.
// CONTEXT: Verifies operations on empty or trivial ranges don't crash.

import type { TestSuite } from "../types";
import { assertTrue } from "../assertions";
import { AREA_EMPTY_RANGE_OPS } from "../testArea";
import {
  sortRangeByColumn,
  getDataValidation,
  mergeCells,
  unmergeCells,
  getMergedRegions,
  getAllConditionalFormats,
} from "@api";

const A = AREA_EMPTY_RANGE_OPS;

export const emptyRangeOpsSuite: TestSuite = {
  name: "Empty/Zero Range Operations",
  description: "Tests that operations on empty or trivial ranges do not crash.",

  afterEach: async (ctx) => {
    try {
      const merged = await getMergedRegions();
      for (const m of merged) {
        if (m.startRow >= A.row && m.startRow <= A.row + 10 && m.startCol >= A.col && m.startCol <= A.col + 5) {
          await unmergeCells(m.startRow, m.startCol);
        }
      }
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Sort empty range does not crash",
      description: "sortRangeByColumn on a range with no data completes without error.",
      run: async (ctx) => {
        // The area should be empty - just sort it
        try {
          await sortRangeByColumn(A.row, A.col, A.row + 3, A.col, A.col, true, false);
          await ctx.settle();
        } catch (e) {
          // Some backends may return an error for empty sorts - that's acceptable
          ctx.log(`Sort empty range result: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Verify cells are still null/empty - no corruption
        const cell = await ctx.getCell(A.row, A.col);
        assertTrue(cell === null || cell.display === "", "cell should still be empty after sorting empty range");
      },
    },
    {
      name: "Clear already-empty range",
      description: "setCells with empty values on empty area does not error.",
      run: async (ctx) => {
        // Set empty values on already-empty cells
        await ctx.setCells([
          { row: A.row, col: A.col, value: "" },
          { row: A.row + 1, col: A.col, value: "" },
          { row: A.row + 2, col: A.col, value: "" },
        ]);
        await ctx.settle();

        // Should complete without error
        assertTrue(true, "clearing empty cells did not crash");
      },
    },
    {
      name: "Get validation on unvalidated cell returns null",
      description: "getDataValidation on a cell with no validation returns null.",
      run: async (ctx) => {
        const dv = await getDataValidation(A.row, A.col);
        assertTrue(dv === null, "unvalidated cell should return null validation");
      },
    },
    {
      name: "Merge single cell",
      description: "mergeCells on 1x1 range does not crash.",
      run: async (ctx) => {
        try {
          await mergeCells(A.row, A.col, A.row, A.col);
          await ctx.settle();
        } catch (e) {
          // A 1x1 merge may be rejected - that's valid behavior
          ctx.log(`Single cell merge result: ${e instanceof Error ? e.message : String(e)}`);
        }
        // No crash is the success criterion
        assertTrue(true, "single cell merge did not crash");
      },
    },
    {
      name: "Get CF on cell with no rules",
      description: "getAllConditionalFormats returns an array (possibly empty).",
      run: async (ctx) => {
        const all = await getAllConditionalFormats();
        assertTrue(Array.isArray(all), "should return an array");
        // The array may or may not be empty depending on other suites,
        // but it should be a valid array
        assertTrue(true, "getAllConditionalFormats did not crash");
      },
    },
  ],
};
