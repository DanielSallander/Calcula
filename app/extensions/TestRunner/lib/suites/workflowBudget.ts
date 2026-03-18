//! FILENAME: app/extensions/TestRunner/lib/suites/workflowBudget.ts
// PURPOSE: Budget worksheet end-to-end workflow test.
// CONTEXT: Creates a complete budget with formulas, validation, CF, and sort.

import type { TestSuite } from "../types";
import { assertTrue, expectNotNull, expectCellValue } from "../assertions";
import { AREA_WF_BUDGET } from "../testArea";
import {
  calculateNow,
  sortRangeByColumn,
  addConditionalFormat,
  clearConditionalFormatsInRange,
  setDataValidation,
  clearDataValidation,
  validateCell,
  createWholeNumberRule,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
  beginUndoTransaction,
  commitUndoTransaction,
} from "../../../../src/api";
import { evaluateConditionalFormats } from "../../../../src/api/backend";

const A = AREA_WF_BUDGET;

function makeValidation(rule: ReturnType<typeof createWholeNumberRule>) {
  return {
    rule,
    errorAlert: DEFAULT_ERROR_ALERT,
    prompt: DEFAULT_PROMPT,
    ignoreBlanks: true,
  };
}

export const workflowBudgetSuite: TestSuite = {
  name: "Workflow: Budget Worksheet",
  description: "End-to-end budget creation with formulas, validation, CF, and sort.",

  afterEach: async (ctx) => {
    try {
      await clearConditionalFormatsInRange(A.row, A.col, A.row + 10, A.col + 5);
    } catch { /* ignore */ }
    try {
      await clearDataValidation(A.row, A.col, A.row + 10, A.col + 5);
    } catch { /* ignore */ }
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
      name: "Build complete budget worksheet",
      description: "Headers, data, formulas, validation, CF, sort — all verified.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Step 1: Headers
        await ctx.setCells([
          { row: R, col: C, value: "Category" },
          { row: R, col: C + 1, value: "Budget" },
          { row: R, col: C + 2, value: "Actual" },
          { row: R, col: C + 3, value: "Variance" },
        ]);
        await ctx.settle();

        // Step 2: Data rows
        await ctx.setCells([
          { row: R + 1, col: C, value: "Rent" },
          { row: R + 1, col: C + 1, value: "1000" },
          { row: R + 1, col: C + 2, value: "1100" },
          { row: R + 2, col: C, value: "Food" },
          { row: R + 2, col: C + 1, value: "500" },
          { row: R + 2, col: C + 2, value: "450" },
          { row: R + 3, col: C, value: "Transport" },
          { row: R + 3, col: C + 1, value: "200" },
          { row: R + 3, col: C + 2, value: "250" },
          { row: R + 4, col: C, value: "Utils" },
          { row: R + 4, col: C + 1, value: "150" },
          { row: R + 4, col: C + 2, value: "120" },
        ]);
        await ctx.settle();

        // Step 3: Variance formulas (Actual - Budget)
        const budgetCol = A.colLetter(1);
        const actualCol = A.colLetter(2);
        await ctx.setCells([
          { row: R + 1, col: C + 3, value: `=${actualCol}${A.rowRef(1)}-${budgetCol}${A.rowRef(1)}` },
          { row: R + 2, col: C + 3, value: `=${actualCol}${A.rowRef(2)}-${budgetCol}${A.rowRef(2)}` },
          { row: R + 3, col: C + 3, value: `=${actualCol}${A.rowRef(3)}-${budgetCol}${A.rowRef(3)}` },
          { row: R + 4, col: C + 3, value: `=${actualCol}${A.rowRef(4)}-${budgetCol}${A.rowRef(4)}` },
        ]);
        await ctx.settle();

        // Step 4: SUM row
        await ctx.setCells([
          { row: R + 5, col: C, value: "TOTAL" },
          { row: R + 5, col: C + 1, value: `=SUM(${budgetCol}${A.rowRef(1)}:${budgetCol}${A.rowRef(4)})` },
          { row: R + 5, col: C + 2, value: `=SUM(${actualCol}${A.rowRef(1)}:${actualCol}${A.rowRef(4)})` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Verify SUM
        const totalBudget = await ctx.getCell(R + 5, C + 1);
        expectNotNull(totalBudget, "total budget cell");
        assertTrue(totalBudget!.display.includes("1850"), `budget total should be 1850, got ${totalBudget!.display}`);

        // Step 5: Validation on Budget column (> 0)
        const rule = createWholeNumberRule("greaterThan", 0);
        await setDataValidation(R + 1, C + 1, R + 4, C + 1, makeValidation(rule));
        await ctx.settle();

        // Test validation
        await ctx.setCells([{ row: R + 1, col: C + 1, value: "1000" }]);
        await ctx.settle();
        const valid = await validateCell(R + 1, C + 1);
        assertTrue(valid.isValid, "1000 should be valid (> 0)");

        // Step 6: CF on Variance (< 0 = over budget)
        const addCF = await addConditionalFormat({
          ranges: [{ startRow: R + 1, startCol: C + 3, endRow: R + 4, endCol: C + 3 }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "0" },
          format: { bold: true },
        });
        assertTrue(addCF.success, "CF should be added");

        // Evaluate — Rent variance is +100, Transport is +50, so 2 should match > 0
        const evalResult = await evaluateConditionalFormats(R + 1, C + 3, R + 4, C + 3);
        const positiveMatches = evalResult.cells.filter(c => c.col === C + 3);
        assertTrue(positiveMatches.length >= 2, `at least 2 positive variances, got ${positiveMatches.length}`);

        // Step 7: Sort by Budget descending (data rows only)
        await sortRangeByColumn(R + 1, C, R + 4, C + 3, C + 1, false, false);
        await ctx.settle();

        // After sort, highest budget (Rent=1000) should be first data row
        const firstAfterSort = await ctx.getCell(R + 1, C);
        expectNotNull(firstAfterSort, "first data row after sort");
        expectCellValue(firstAfterSort, "Rent", "first row after desc sort by budget");

        ctx.log("Budget workflow completed successfully");
      },
    },
    {
      name: "Budget undo restores state",
      description: "Undo transaction reverts entire budget creation.",
      run: async (ctx) => {
        await beginUndoTransaction("budget creation");

        await ctx.setCells([
          { row: A.row, col: A.col, value: "Category" },
          { row: A.row, col: A.col + 1, value: "Budget" },
          { row: A.row + 1, col: A.col, value: "Rent" },
          { row: A.row + 1, col: A.col + 1, value: "1000" },
        ]);

        await commitUndoTransaction();
        await ctx.settle();

        // Verify data exists
        expectCellValue(await ctx.getCell(A.row, A.col), "Category", "header");

        // Single undo should revert all
        await ctx.undo();
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        assertTrue(cell === null || cell.display === "", "cell should be empty after undo");
      },
    },
  ],
};
