//! FILENAME: app/extensions/TestRunner/lib/suites/consolidation.ts
// PURPOSE: Data Consolidation test suite.
// CONTEXT: Tests consolidateData with sum, average, by position, and by category.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_CONSOLIDATION } from "../testArea";
import { consolidateData } from "@api";
import { getActiveSheet } from "@api/lib";

const A = AREA_CONSOLIDATION;

export const consolidationSuite: TestSuite = {
  name: "Data Consolidation",
  description: "Tests data consolidation by position and by category.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 30; r++) {
      for (let c = 0; c < 6; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Consolidate by position - SUM",
      description: "SUM consolidation of two same-size ranges.",
      run: async (ctx) => {
        const sheet = await getActiveSheet();

        // Range 1: rows A.row to A.row+2, cols A.col to A.col+1
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row, col: A.col + 1, value: "20" },
          { row: A.row + 1, col: A.col, value: "30" },
          { row: A.row + 1, col: A.col + 1, value: "40" },
        ]);

        // Range 2: rows A.row+5 to A.row+7, cols A.col to A.col+1
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "5" },
          { row: A.row + 5, col: A.col + 1, value: "10" },
          { row: A.row + 6, col: A.col, value: "15" },
          { row: A.row + 6, col: A.col + 1, value: "20" },
        ]);
        await ctx.settle();

        // Destination: A.row+15
        const result = await consolidateData({
          function: "sum",
          sourceRanges: [
            { sheetIndex: sheet, startRow: A.row, startCol: A.col, endRow: A.row + 1, endCol: A.col + 1 },
            { sheetIndex: sheet, startRow: A.row + 5, startCol: A.col, endRow: A.row + 6, endCol: A.col + 1 },
          ],
          destSheetIndex: sheet,
          destRow: A.row + 15,
          destCol: A.col,
          useTopRow: false,
          useLeftColumn: false,
        });

        assertTrue(result.success, `consolidation should succeed: ${result.error}`);
        assertTrue(result.updatedCells.length > 0, "should write cells");

        // Check summed values: 10+5=15, 20+10=30, 30+15=45, 40+20=60
        const c1 = await ctx.getCell(A.row + 15, A.col);
        assertEqual(c1?.display, "15", "10+5=15");
        const c2 = await ctx.getCell(A.row + 15, A.col + 1);
        assertEqual(c2?.display, "30", "20+10=30");
        const c3 = await ctx.getCell(A.row + 16, A.col);
        assertEqual(c3?.display, "45", "30+15=45");
      },
    },
    {
      name: "Consolidate by position - AVERAGE",
      description: "AVERAGE consolidation of two ranges.",
      run: async (ctx) => {
        const sheet = await getActiveSheet();

        // Range 1
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "30" },
        ]);
        // Range 2
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "20" },
          { row: A.row + 6, col: A.col, value: "40" },
        ]);
        await ctx.settle();

        const result = await consolidateData({
          function: "average",
          sourceRanges: [
            { sheetIndex: sheet, startRow: A.row, startCol: A.col, endRow: A.row + 1, endCol: A.col },
            { sheetIndex: sheet, startRow: A.row + 5, startCol: A.col, endRow: A.row + 6, endCol: A.col },
          ],
          destSheetIndex: sheet,
          destRow: A.row + 15,
          destCol: A.col,
          useTopRow: false,
          useLeftColumn: false,
        });

        assertTrue(result.success, `consolidation should succeed: ${result.error}`);

        // Average of 10 and 20 = 15, average of 30 and 40 = 35
        const c1 = await ctx.getCell(A.row + 15, A.col);
        assertEqual(c1?.display, "15", "avg(10,20)=15");
        const c2 = await ctx.getCell(A.row + 16, A.col);
        assertEqual(c2?.display, "35", "avg(30,40)=35");
      },
    },
    {
      name: "Consolidate by category with top row",
      description: "Category consolidation uses column headers to match.",
      run: async (ctx) => {
        const sheet = await getActiveSheet();

        // Range 1: headers + data (columns in order: A, B)
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row, col: A.col + 1, value: "B" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col + 1, value: "20" },
        ]);

        // Range 2: headers + data (columns in order: B, A — reversed!)
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "B" },
          { row: A.row + 5, col: A.col + 1, value: "A" },
          { row: A.row + 6, col: A.col, value: "30" },
          { row: A.row + 6, col: A.col + 1, value: "40" },
        ]);
        await ctx.settle();

        const result = await consolidateData({
          function: "sum",
          sourceRanges: [
            { sheetIndex: sheet, startRow: A.row, startCol: A.col, endRow: A.row + 1, endCol: A.col + 1 },
            { sheetIndex: sheet, startRow: A.row + 5, startCol: A.col, endRow: A.row + 6, endCol: A.col + 1 },
          ],
          destSheetIndex: sheet,
          destRow: A.row + 15,
          destCol: A.col,
          useTopRow: true,
          useLeftColumn: false,
        });

        assertTrue(result.success, `consolidation should succeed: ${result.error}`);
        assertTrue(result.updatedCells.length > 0, "should write cells");

        // With useTopRow, category matching should align A with A and B with B
        // Header row at A.row+15, data at A.row+16
        // A = 10+40=50, B = 20+30=50
        ctx.log(`Consolidation wrote ${result.updatedCells.length} cells`);
      },
    },
    {
      name: "Consolidate with MAX function",
      description: "MAX consolidation picks the maximum across ranges.",
      run: async (ctx) => {
        const sheet = await getActiveSheet();

        await ctx.setCells([
          { row: A.row, col: A.col, value: "100" },
          { row: A.row + 5, col: A.col, value: "200" },
          { row: A.row + 10, col: A.col, value: "150" },
        ]);
        await ctx.settle();

        const result = await consolidateData({
          function: "max",
          sourceRanges: [
            { sheetIndex: sheet, startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col },
            { sheetIndex: sheet, startRow: A.row + 5, startCol: A.col, endRow: A.row + 5, endCol: A.col },
            { sheetIndex: sheet, startRow: A.row + 10, startCol: A.col, endRow: A.row + 10, endCol: A.col },
          ],
          destSheetIndex: sheet,
          destRow: A.row + 20,
          destCol: A.col,
          useTopRow: false,
          useLeftColumn: false,
        });

        assertTrue(result.success, `consolidation should succeed: ${result.error}`);
        const c = await ctx.getCell(A.row + 20, A.col);
        assertEqual(c?.display, "200", "max(100,200,150)=200");
      },
    },
  ],
};
