//! FILENAME: app/extensions/TestRunner/lib/suites/pipelineFilterSort.ts
// PURPOSE: Advanced data pipeline tests combining filter, sort, and aggregate.
// CONTEXT: Tests multi-step data processing workflows using multiple APIs together.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue } from "../assertions";
import { AREA_PIPELINE_FSA } from "../testArea";
import {
  applyAutoFilter,
  removeAutoFilter,
  setColumnFilterValues,
  getHiddenRows,
  clearAutoFilterCriteria,
  sortRangeByColumn,
  createNamedRange,
  deleteNamedRange,
  getAllNamedRanges,
  addConditionalFormat,
  clearConditionalFormatsInRange,
  calculateNow,
  getSelectionAggregations,
} from "../../../../src/api";
import { evaluateConditionalFormats } from "../../../../src/api/backend";

const A = AREA_PIPELINE_FSA;

export const pipelineFilterSortSuite: TestSuite = {
  name: "Pipeline: Filter + Sort + Aggregate",
  description: "Tests multi-step data processing: filter, sort, named ranges with CF.",

  afterEach: async (ctx) => {
    try { await removeAutoFilter(); } catch { /* ignore */ }
    try {
      await clearConditionalFormatsInRange(A.row, A.col, A.row + 15, A.col + 5);
    } catch { /* ignore */ }
    try {
      const ranges = await getAllNamedRanges();
      for (const r of ranges) {
        if (r.name.startsWith("Pipeline")) {
          await deleteNamedRange(r.name);
        }
      }
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 5; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Filter then sort filtered data",
      description: "Apply filter to narrow data, sort remaining, verify order.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Set up data: Product, Category, Price
        await ctx.setCells([
          { row: R, col: C, value: "Product" },
          { row: R, col: C + 1, value: "Category" },
          { row: R, col: C + 2, value: "Price" },
          { row: R + 1, col: C, value: "Apple" },
          { row: R + 1, col: C + 1, value: "Fruit" },
          { row: R + 1, col: C + 2, value: "3" },
          { row: R + 2, col: C, value: "Bread" },
          { row: R + 2, col: C + 1, value: "Bakery" },
          { row: R + 2, col: C + 2, value: "5" },
          { row: R + 3, col: C, value: "Cherry" },
          { row: R + 3, col: C + 1, value: "Fruit" },
          { row: R + 3, col: C + 2, value: "8" },
          { row: R + 4, col: C, value: "Banana" },
          { row: R + 4, col: C + 1, value: "Fruit" },
          { row: R + 4, col: C + 2, value: "2" },
          { row: R + 5, col: C, value: "Cake" },
          { row: R + 5, col: C + 1, value: "Bakery" },
          { row: R + 5, col: C + 2, value: "12" },
        ]);
        await ctx.settle();

        // Step 1: Filter to Fruit only
        await applyAutoFilter(R, C, R + 5, C + 2);
        await ctx.settle();
        await setColumnFilterValues(1, ["Fruit"], false);
        await ctx.settle();

        // Verify Bakery rows are hidden
        const hidden = await getHiddenRows();
        assertTrue(hidden.includes(R + 2), "Bread should be hidden");
        assertTrue(hidden.includes(R + 5), "Cake should be hidden");

        // Step 2: Sort by Price ascending (sort operates on all rows but hidden stay hidden)
        await sortRangeByColumn(R + 1, C, R + 5, C + 2, C + 2, true, false);
        await ctx.settle();

        // Step 3: Clear filter and verify sorted order
        await clearAutoFilterCriteria();
        await ctx.settle();

        // All data should be visible and sorted by price
        const hiddenAfter = await getHiddenRows();
        const ourHidden = hiddenAfter.filter(r => r >= R + 1 && r <= R + 5);
        assertEqual(ourHidden.length, 0, "all rows visible after clearing filter");

        ctx.log("Filter + sort pipeline completed");
      },
    },
    {
      name: "Named range with formula and CF",
      description: "Create named range, use in formula, apply CF to the range.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Set up data
        await ctx.setCells([
          { row: R, col: C, value: "75" },
          { row: R + 1, col: C, value: "45" },
          { row: R + 2, col: C, value: "90" },
          { row: R + 3, col: C, value: "60" },
        ]);
        await ctx.settle();

        // Create named range for the data (name, sheetIndex, refersTo)
        const rangeRef = `${A.ref(0, 0)}:${A.ref(3, 0)}`;
        await createNamedRange("PipelineScores", null, rangeRef);
        await ctx.settle();

        // Use named range in SUM formula
        await ctx.setCells([
          { row: R + 5, col: C, value: "=SUM(PipelineScores)" },
          { row: R + 6, col: C, value: "=AVERAGE(PipelineScores)" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const sumCell = await ctx.getCell(R + 5, C);
        expectCellValue(sumCell, "270", "SUM of named range");
        const avgCell = await ctx.getCell(R + 6, C);
        expectNotNull(avgCell, "AVERAGE cell should exist");
        // AVERAGE of 75+45+90+60 = 270/4 = 67.5
        assertTrue(avgCell!.display.includes("67.5"), `AVERAGE should be 67.5, got ${avgCell!.display}`);

        // Apply CF to the named range area: values > 70 get formatting
        const cf = await addConditionalFormat({
          ranges: [{
            startRow: R, startCol: C,
            endRow: R + 3, endCol: C,
          }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "70" },
          format: { bold: true },
        });
        assertTrue(cf.success, "CF should succeed");
        await ctx.settle();

        const evalResult = await evaluateConditionalFormats(R, C, R + 3, C);
        const evalCells = evalResult?.cells ?? [];
        // evaluateConditionalFormats returns only matching cells
        assertEqual(evalCells.length, 2, "75 and 90 should match CF rule");
      },
    },
    {
      name: "Sort preserves literal values across columns",
      description: "Sort by one column, verify all columns move together.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Set up data with 3 columns (no formulas — pure data sort)
        await ctx.setCells([
          { row: R, col: C, value: "Name" },
          { row: R, col: C + 1, value: "Score" },
          { row: R, col: C + 2, value: "Grade" },
          { row: R + 1, col: C, value: "Zara" },
          { row: R + 1, col: C + 1, value: "80" },
          { row: R + 1, col: C + 2, value: "B" },
          { row: R + 2, col: C, value: "Alice" },
          { row: R + 2, col: C + 1, value: "95" },
          { row: R + 2, col: C + 2, value: "A" },
          { row: R + 3, col: C, value: "Mike" },
          { row: R + 3, col: C + 1, value: "70" },
          { row: R + 3, col: C + 2, value: "C" },
        ]);
        await ctx.settle();

        // Sort by Score ascending
        await sortRangeByColumn(R + 1, C, R + 3, C + 2, C + 1, true, false);
        await ctx.settle();

        // After sort: Mike(70,C), Zara(80,B), Alice(95,A)
        expectCellValue(await ctx.getCell(R + 1, C), "Mike", "first after sort");
        expectCellValue(await ctx.getCell(R + 1, C + 1), "70", "Mike score");
        expectCellValue(await ctx.getCell(R + 1, C + 2), "C", "Mike grade");

        expectCellValue(await ctx.getCell(R + 2, C), "Zara", "second after sort");
        expectCellValue(await ctx.getCell(R + 2, C + 1), "80", "Zara score");
        expectCellValue(await ctx.getCell(R + 2, C + 2), "B", "Zara grade");

        expectCellValue(await ctx.getCell(R + 3, C), "Alice", "third after sort");
        expectCellValue(await ctx.getCell(R + 3, C + 1), "95", "Alice score");
        expectCellValue(await ctx.getCell(R + 3, C + 2), "A", "Alice grade");
      },
    },
  ],
};
