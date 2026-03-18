//! FILENAME: app/extensions/TestRunner/lib/suites/merge.ts
// PURPOSE: Merge cells test suite.
// CONTEXT: Tests merging, unmerging, and querying merged regions.

import type { TestSuite } from "../types";
import {
  assertTrue,
  assertEqual,
  expectCellValue,
  expectNotNull,
} from "../assertions";
import { AREA_MERGE } from "../testArea";
import {
  mergeCells,
  unmergeCells,
  getMergedRegions,
  getMergeInfo,
} from "../../../../src/api";

const A = AREA_MERGE;

export const mergeSuite: TestSuite = {
  name: "Merge Cells",
  description: "Tests merging, unmerging, and querying merged regions.",

  afterEach: async (ctx) => {
    // Unmerge anything in our test area
    try {
      const regions = await getMergedRegions();
      for (const region of regions) {
        if (
          region.startRow >= A.row && region.startRow < A.row + 10 &&
          region.startCol >= A.col && region.startCol < A.col + 10
        ) {
          await unmergeCells(region.startRow, region.startCol);
        }
      }
    } catch {
      // ignore
    }
    // Clear cells
    const clears = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Merge a 2x2 range",
      description: "getMergeInfo returns the merged region.",
      run: async (ctx) => {
        await mergeCells(A.row, A.col, A.row + 1, A.col + 1);
        await ctx.settle();

        const info = await getMergeInfo(A.row, A.col);
        expectNotNull(info, "Merge info should exist for anchor cell");
        assertEqual(info!.startRow, A.row, "merge startRow");
        assertEqual(info!.startCol, A.col, "merge startCol");
        assertEqual(info!.endRow, A.row + 1, "merge endRow");
        assertEqual(info!.endCol, A.col + 1, "merge endCol");

        // Non-anchor cell within merge should also report the merge
        const inner = await getMergeInfo(A.row + 1, A.col + 1);
        expectNotNull(inner, "Inner cell should report merge");
        assertEqual(inner!.startRow, A.row, "inner merge startRow");
      },
    },
    {
      name: "Merged cell value in top-left anchor",
      description: "Value set before merge is accessible at anchor.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Merged" }]);
        await ctx.settle();

        await mergeCells(A.row, A.col, A.row + 1, A.col + 1);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "Merged", "anchor cell");
      },
    },
    {
      name: "Unmerge restores individual cells",
      description: "After unmerge, getMergeInfo returns null.",
      run: async (ctx) => {
        await mergeCells(A.row, A.col, A.row + 1, A.col + 1);
        await ctx.settle();

        // Verify merged
        const before = await getMergeInfo(A.row, A.col);
        expectNotNull(before, "Should be merged");

        // Unmerge
        await unmergeCells(A.row, A.col);
        await ctx.settle();

        const after = await getMergeInfo(A.row, A.col);
        assertTrue(after === null, "Should be null after unmerge");
      },
    },
    {
      name: "Merged region appears in getMergedRegions",
      description: "Global list includes the new merge.",
      run: async (ctx) => {
        await mergeCells(A.row, A.col, A.row + 2, A.col + 2);
        await ctx.settle();

        const regions = await getMergedRegions();
        const found = regions.find(
          r => r.startRow === A.row && r.startCol === A.col
        );
        assertTrue(found !== undefined, "Merge should appear in getMergedRegions");
        assertEqual(found!.endRow, A.row + 2, "endRow in regions list");
        assertEqual(found!.endCol, A.col + 2, "endCol in regions list");
      },
    },
  ],
};
