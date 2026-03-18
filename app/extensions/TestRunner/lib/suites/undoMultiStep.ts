//! FILENAME: app/extensions/TestRunner/lib/suites/undoMultiStep.ts
// PURPOSE: Undo multi-step cross-feature integration tests.
// CONTEXT: Verifies undo correctly reverts multi-feature operations.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectCellValue, expectCellEmpty } from "../assertions";
import { AREA_UNDO_MULTISTEP } from "../testArea";
import {
  mergeCells,
  unmergeCells,
  getMergedRegions,
  sortRangeByColumn,
  setDataValidation,
  getDataValidation,
  clearDataValidation,
  beginUndoTransaction,
  commitUndoTransaction,
  createWholeNumberRule,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
} from "../../../../src/api";

const A = AREA_UNDO_MULTISTEP;

function makeValidation(rule: ReturnType<typeof createWholeNumberRule>) {
  return {
    rule,
    errorAlert: DEFAULT_ERROR_ALERT,
    prompt: DEFAULT_PROMPT,
    ignoreBlanks: true,
  };
}

export const undoMultiStepSuite: TestSuite = {
  name: "Undo Multi-Step Integration",
  description: "Tests undo reverts across multiple feature layers.",

  afterEach: async (ctx) => {
    try {
      // Unmerge anything in test area
      const merged = await getMergedRegions();
      for (const m of merged) {
        if (m.startRow >= A.row && m.startRow <= A.row + 10 && m.startCol >= A.col && m.startCol <= A.col + 5) {
          await unmergeCells(m.startRow, m.startCol);
        }
      }
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
      name: "Enter data then undo reverts",
      description: "setCells followed by undo leaves cell empty.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Hello" }]);
        await ctx.settle();

        const before = await ctx.getCell(A.row, A.col);
        expectCellValue(before, "Hello", "cell");

        await ctx.undo();
        await ctx.settle();

        const after = await ctx.getCell(A.row, A.col);
        expectCellEmpty(after, "cell after undo");
      },
    },
    {
      name: "Set validation persists independently of undo",
      description: "Data validation is not part of the undo stack.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("between", 1, 100);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        const dvBefore = await getDataValidation(A.row, A.col);
        assertTrue(dvBefore !== null, "validation should exist");

        // Undo does not revert validation — it's not on the undo stack
        await ctx.undo();
        await ctx.settle();

        const dvAfter = await getDataValidation(A.row, A.col);
        assertTrue(dvAfter !== null, "validation should persist (not undoable)");
      },
    },
    {
      name: "Merge then undo unmerges",
      description: "mergeCells followed by undo removes the merge.",
      run: async (ctx) => {
        await mergeCells(A.row, A.col, A.row + 1, A.col + 1);
        await ctx.settle();

        const mergedBefore = await getMergedRegions();
        const ourMerge = mergedBefore.find(m =>
          m.startRow === A.row && m.startCol === A.col
        );
        assertTrue(ourMerge !== undefined, "merge should exist");

        await ctx.undo();
        await ctx.settle();

        const mergedAfter = await getMergedRegions();
        const gone = mergedAfter.find(m =>
          m.startRow === A.row && m.startCol === A.col
        );
        assertTrue(gone === undefined, "merge should be gone after undo");
      },
    },
    {
      name: "Sort then undo restores original order",
      description: "Sort ascending, verify, undo, verify original order.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "C" },
          { row: A.row + 1, col: A.col, value: "A" },
          { row: A.row + 2, col: A.col, value: "B" },
        ]);
        await ctx.settle();

        await sortRangeByColumn(A.row, A.col, A.row + 2, A.col, A.col, true, false);
        await ctx.settle();

        // Verify sorted order
        expectCellValue(await ctx.getCell(A.row, A.col), "A", "first after sort");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "B", "second after sort");
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "C", "third after sort");

        await ctx.undo();
        await ctx.settle();

        // Verify original order restored
        expectCellValue(await ctx.getCell(A.row, A.col), "C", "first after undo");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "A", "second after undo");
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "B", "third after undo");
      },
    },
    {
      name: "Transaction groups multiple operations",
      description: "beginUndoTransaction + 3 setCells + commit = single undo reverts all.",
      run: async (ctx) => {
        await beginUndoTransaction("batch test");

        await ctx.setCells([
          { row: A.row, col: A.col, value: "One" },
          { row: A.row + 1, col: A.col, value: "Two" },
          { row: A.row + 2, col: A.col, value: "Three" },
        ]);

        await commitUndoTransaction();
        await ctx.settle();

        // All 3 cells should have values
        expectCellValue(await ctx.getCell(A.row, A.col), "One", "cell 1");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "Two", "cell 2");
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "Three", "cell 3");

        // Single undo should revert all 3
        await ctx.undo();
        await ctx.settle();

        expectCellEmpty(await ctx.getCell(A.row, A.col), "cell 1 after undo");
        expectCellEmpty(await ctx.getCell(A.row + 1, A.col), "cell 2 after undo");
        expectCellEmpty(await ctx.getCell(A.row + 2, A.col), "cell 3 after undo");
      },
    },
  ],
};
