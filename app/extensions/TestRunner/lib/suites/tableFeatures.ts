//! FILENAME: app/extensions/TestRunner/lib/suites/tableFeatures.ts
// PURPOSE: Table + CF/Validation/Sort cross-feature integration tests.
// CONTEXT: Tests tables combined with conditional formatting, data validation, and sorting.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue } from "../assertions";
import { AREA_TABLE_FEATURES } from "../testArea";
import {
  createTable,
  deleteTable,
  getAllTables,
  sortRangeByColumn,
} from "../../../../src/api/backend";
import {
  addConditionalFormat,
  getAllConditionalFormats,
  clearConditionalFormatsInRange,
  setDataValidation,
  getDataValidation,
  clearDataValidation,
  validatePendingValue,
  createWholeNumberRule,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
  calculateNow,
} from "../../../../src/api";
import { evaluateConditionalFormats } from "../../../../src/api/backend";

const A = AREA_TABLE_FEATURES;

function makeValidation(rule: ReturnType<typeof createWholeNumberRule>) {
  return {
    rule,
    errorAlert: DEFAULT_ERROR_ALERT,
    prompt: DEFAULT_PROMPT,
    ignoreBlanks: true,
  };
}

export const tableFeaturesSuite: TestSuite = {
  name: "Table + Features Integration",
  description: "Tests tables combined with conditional formatting, validation, and sorting.",

  afterEach: async (ctx) => {
    try {
      const tables = await getAllTables();
      for (const t of tables) {
        if (t.startRow >= A.row && t.startRow <= A.row + 30) {
          await deleteTable(t.id);
        }
      }
    } catch { /* ignore */ }
    try {
      await clearConditionalFormatsInRange(A.row, A.col, A.row + 15, A.col + 5);
    } catch { /* ignore */ }
    try {
      await clearDataValidation(A.row, A.col, A.row + 15, A.col + 5);
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 6; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "CF rule on table data range",
      description: "Conditional format applied to table data range evaluates correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Score" },
          { row: A.row + 1, col: A.col, value: "80" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: "90" },
        ]);
        await ctx.settle();

        const table = await createTable({
          name: "CFTable",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 3, endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(table.success, `create: ${table.error}`);

        // Add CF rule: Score > 50 => bold
        const cf = await addConditionalFormat({
          ranges: [{
            startRow: A.row + 1, startCol: A.col,
            endRow: A.row + 3, endCol: A.col,
          }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { bold: true },
        });
        assertTrue(cf.success, "CF should succeed");
        await ctx.settle();

        // Evaluate CF — only matching cells are returned
        const evalResult = await evaluateConditionalFormats(
          A.row + 1, A.col, A.row + 3, A.col
        );
        const cells = evalResult?.cells ?? [];
        // evaluateConditionalFormats returns only cells that match rules
        assertEqual(cells.length, 2, "2 cells should match CF rule (80, 90)");
      },
    },
    {
      name: "Validation on table column",
      description: "Data validation applied to table column validates correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Age" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "25" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "30" },
        ]);
        await ctx.settle();

        const table = await createTable({
          name: "ValTable",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 2, endCol: A.col + 1,
          hasHeaders: true,
        });
        assertTrue(table.success, `create: ${table.error}`);

        // Add validation on Age column (1-150)
        const ageRule = createWholeNumberRule("between", 1, 150);
        await setDataValidation(
          A.row + 1, A.col + 1, A.row + 2, A.col + 1,
          makeValidation(ageRule)
        );
        await ctx.settle();

        // Verify validation exists
        const dv = await getDataValidation(A.row + 1, A.col + 1);
        expectNotNull(dv, "validation should exist on Age column");

        // Validate values
        const valid = await validatePendingValue(A.row + 1, A.col + 1, "25");
        assertTrue(valid.isValid, "25 should be valid for 1-150");

        const invalid = await validatePendingValue(A.row + 1, A.col + 1, "200");
        assertTrue(!invalid.isValid, "200 should be invalid for 1-150");
      },
    },
    {
      name: "Sort table data preserves structure",
      description: "Sorting table data range maintains table integrity.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Value" },
          { row: A.row + 1, col: A.col, value: "Charlie" },
          { row: A.row + 1, col: A.col + 1, value: "30" },
          { row: A.row + 2, col: A.col, value: "Alice" },
          { row: A.row + 2, col: A.col + 1, value: "10" },
          { row: A.row + 3, col: A.col, value: "Bob" },
          { row: A.row + 3, col: A.col + 1, value: "20" },
        ]);
        await ctx.settle();

        const table = await createTable({
          name: "SortTable",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 3, endCol: A.col + 1,
          hasHeaders: true,
        });
        assertTrue(table.success, `create: ${table.error}`);

        // Sort by Name column ascending
        await sortRangeByColumn(
          A.row + 1, A.col, A.row + 3, A.col + 1,
          A.col, true, false
        );
        await ctx.settle();

        // Verify sorted order
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "Alice", "first after sort");
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "Bob", "second after sort");
        expectCellValue(await ctx.getCell(A.row + 3, A.col), "Charlie", "third after sort");

        // Verify corresponding values moved with names
        expectCellValue(await ctx.getCell(A.row + 1, A.col + 1), "10", "Alice's value");
        expectCellValue(await ctx.getCell(A.row + 2, A.col + 1), "20", "Bob's value");
        expectCellValue(await ctx.getCell(A.row + 3, A.col + 1), "30", "Charlie's value");

        // Table should still exist
        const tables = await getAllTables();
        const ours = tables.find(t => t.name === "SortTable");
        expectNotNull(ours, "table should still exist after sort");
      },
    },
    {
      name: "Table with CF and validation combined",
      description: "Table has both CF rule and validation on same column.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Rating" },
          { row: A.row + 1, col: A.col, value: "8" },
          { row: A.row + 2, col: A.col, value: "3" },
          { row: A.row + 3, col: A.col, value: "9" },
        ]);
        await ctx.settle();

        const table = await createTable({
          name: "ComboTable",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 3, endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(table.success, `create: ${table.error}`);

        // Validation: 1-10
        const rule = createWholeNumberRule("between", 1, 10);
        await setDataValidation(
          A.row + 1, A.col, A.row + 3, A.col,
          makeValidation(rule)
        );
        await ctx.settle();

        // CF: > 5 gets bold
        const cf = await addConditionalFormat({
          ranges: [{
            startRow: A.row + 1, startCol: A.col,
            endRow: A.row + 3, endCol: A.col,
          }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "5" },
          format: { bold: true },
        });
        assertTrue(cf.success, "CF should succeed");
        await ctx.settle();

        // Verify validation works
        const validResult = await validatePendingValue(A.row + 1, A.col, "7");
        assertTrue(validResult.isValid, "7 is valid for 1-10");
        const invalidResult = await validatePendingValue(A.row + 1, A.col, "15");
        assertTrue(!invalidResult.isValid, "15 is invalid for 1-10");

        // Verify CF evaluates
        const evalResult = await evaluateConditionalFormats(
          A.row + 1, A.col, A.row + 3, A.col
        );
        const cfCells = evalResult?.cells ?? [];
        assertEqual(cfCells.length, 2, "8 and 9 should match CF (> 5)");

        // Both features coexist
        const dv = await getDataValidation(A.row + 1, A.col);
        expectNotNull(dv, "validation should still exist");
        const allCF = await getAllConditionalFormats();
        assertTrue(allCF.length >= 1, "CF rule should still exist");
      },
    },
  ],
};
