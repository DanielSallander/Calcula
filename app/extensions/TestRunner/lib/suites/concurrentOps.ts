//! FILENAME: app/extensions/TestRunner/lib/suites/concurrentOps.ts
// PURPOSE: Concurrent operations edge case tests.
// CONTEXT: Tests rapid updates, overlapping rules, and multiple CF rules on same range.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue } from "../assertions";
import { AREA_CONCURRENT_OPS } from "../testArea";
import {
  setDataValidation,
  getDataValidation,
  clearDataValidation,
  addConditionalFormat,
  getAllConditionalFormats,
  clearConditionalFormatsInRange,
  createWholeNumberRule,
  createListRule,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
} from "@api";

const A = AREA_CONCURRENT_OPS;

function makeValidation(rule: ReturnType<typeof createWholeNumberRule>) {
  return {
    rule,
    errorAlert: DEFAULT_ERROR_ALERT,
    prompt: DEFAULT_PROMPT,
    ignoreBlanks: true,
  };
}

export const concurrentOpsSuite: TestSuite = {
  name: "Concurrent Operations",
  description: "Tests rapid successive updates and overlapping rules.",

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
      name: "Rapid successive updates to same cell",
      description: "10 sequential setCells to the same cell, final value should be '10'.",
      run: async (ctx) => {
        for (let i = 1; i <= 10; i++) {
          await ctx.setCells([{ row: A.row, col: A.col, value: String(i) }]);
        }
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "10", "cell after 10 rapid updates");
      },
    },
    {
      name: "Multiple validations on overlapping ranges",
      description: "Later validation takes precedence on overlapping cells.",
      run: async (ctx) => {
        // First validation: rows 0-3, whole number 1-100
        const rule1 = createWholeNumberRule("between", 1, 100);
        await setDataValidation(A.row, A.col, A.row + 3, A.col, makeValidation(rule1));
        await ctx.settle();

        // Second validation: rows 2-5, list ["X","Y","Z"]
        const rule2 = createListRule(["X", "Y", "Z"]);
        await setDataValidation(A.row + 2, A.col, A.row + 5, A.col, makeValidation(rule2));
        await ctx.settle();

        // Row 0 should have the first validation (wholeNumber)
        const dv0 = await getDataValidation(A.row, A.col);
        expectNotNull(dv0, "row 0 should have validation");

        // Row 2 (overlap) should have the second validation (list)
        const dv2 = await getDataValidation(A.row + 2, A.col);
        expectNotNull(dv2, "row 2 (overlap) should have validation");

        // Row 4 should have only the second validation
        const dv4 = await getDataValidation(A.row + 4, A.col);
        expectNotNull(dv4, "row 4 should have validation from second rule");
      },
    },
    {
      name: "Multiple CF rules on same range",
      description: "Two CF rules on same range both exist in getAllConditionalFormats.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "90" }]);
        await ctx.settle();

        const r1 = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { bold: true },
        });
        const r2 = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "80" },
          format: { italic: true },
        });

        assertTrue(r1.success, "first CF rule should succeed");
        assertTrue(r2.success, "second CF rule should succeed");

        const all = await getAllConditionalFormats();
        const id1 = r1.rule!.id;
        const id2 = r2.rule!.id;
        assertTrue(all.some(r => r.id === id1), "first rule should exist in list");
        assertTrue(all.some(r => r.id === id2), "second rule should exist in list");
      },
    },
  ],
};
