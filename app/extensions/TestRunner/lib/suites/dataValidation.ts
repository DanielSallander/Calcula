//! FILENAME: app/extensions/TestRunner/lib/suites/dataValidation.ts
// PURPOSE: Data validation test suite.
// CONTEXT: Tests setting, getting, validating, and clearing data validation rules.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_DATA_VALIDATION } from "../testArea";
import {
  setDataValidation,
  getDataValidation,
  clearDataValidation,
  validateCell,
  getAllDataValidations,
  createWholeNumberRule,
  createListRule,
  createDecimalRule,
  createTextLengthRule,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
} from "../../../../src/api";

const A = AREA_DATA_VALIDATION;

/** Helper to build a DataValidation object from a rule. */
function makeValidation(rule: ReturnType<typeof createWholeNumberRule>) {
  return {
    rule,
    errorAlert: DEFAULT_ERROR_ALERT,
    prompt: DEFAULT_PROMPT,
    ignoreBlanks: true,
  };
}

export const dataValidationSuite: TestSuite = {
  name: "Data Validation",
  description: "Tests data validation rules, cell validation, and cleanup.",

  afterEach: async (ctx) => {
    // Clear validations in the test area
    try {
      await clearDataValidation(A.row, A.col, A.row + 10, A.col + 5);
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Set whole number validation",
      description: "getDataValidation returns the rule.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("between", 1, 100);
        const validation = makeValidation(rule);
        await setDataValidation(A.row, A.col, A.row, A.col, validation);
        await ctx.settle();

        const dv = await getDataValidation(A.row, A.col);
        expectNotNull(dv, "Validation should exist");
      },
    },
    {
      name: "Valid value passes validation",
      description: "validateCell returns valid for a conforming value.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("between", 1, 100);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "50" }]);
        await ctx.settle();

        const result = await validateCell(A.row, A.col);
        assertTrue(result.isValid, "50 should be valid (between 1-100)");
      },
    },
    {
      name: "Invalid value fails validation",
      description: "validateCell returns invalid for a non-conforming value.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("between", 1, 100);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "200" }]);
        await ctx.settle();

        const result = await validateCell(A.row, A.col);
        assertTrue(!result.isValid, "200 should be invalid (not between 1-100)");
      },
    },
    {
      name: "List validation",
      description: "Only listed values pass validation.",
      run: async (ctx) => {
        const rule = createListRule(["Red", "Green", "Blue"]);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        // Valid value
        await ctx.setCells([{ row: A.row, col: A.col, value: "Red" }]);
        await ctx.settle();
        const valid = await validateCell(A.row, A.col);
        assertTrue(valid.isValid, "Red should be valid");

        // Invalid value
        await ctx.setCells([{ row: A.row, col: A.col, value: "Yellow" }]);
        await ctx.settle();
        const invalid = await validateCell(A.row, A.col);
        assertTrue(!invalid.isValid, "Yellow should be invalid");
      },
    },
    {
      name: "Clear validation",
      description: "getDataValidation returns null after clear.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("greaterThan", 0);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await clearDataValidation(A.row, A.col, A.row, A.col);
        await ctx.settle();

        const dv = await getDataValidation(A.row, A.col);
        assertTrue(dv === null, "Validation should be null after clear");
      },
    },
    {
      name: "Get all validations",
      description: "Returns list of all active rules.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("between", 1, 10);
        await setDataValidation(A.row, A.col, A.row + 2, A.col, makeValidation(rule));
        await ctx.settle();

        const all = await getAllDataValidations();
        assertTrue(all.length > 0, "Should have at least one validation");
        const found = all.find(
          v => v.startRow === A.row && v.startCol === A.col
        );
        assertTrue(found !== undefined, "Our validation should be in the list");
      },
    },
    {
      name: "Decimal range validation",
      description: "Values within range pass, outside fail.",
      run: async (ctx) => {
        const rule = createDecimalRule("between", 0.0, 1.0);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "0.5" }]);
        await ctx.settle();
        assertTrue((await validateCell(A.row, A.col)).isValid, "0.5 should be valid");

        await ctx.setCells([{ row: A.row, col: A.col, value: "1.5" }]);
        await ctx.settle();
        assertTrue(!(await validateCell(A.row, A.col)).isValid, "1.5 should be invalid");
      },
    },
    {
      name: "Text length validation",
      description: "Short and long text checked.",
      run: async (ctx) => {
        const rule = createTextLengthRule("lessThanOrEqual", 5);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "Hi" }]);
        await ctx.settle();
        assertTrue((await validateCell(A.row, A.col)).isValid, "'Hi' should be valid (len 2)");

        await ctx.setCells([{ row: A.row, col: A.col, value: "TooLongText" }]);
        await ctx.settle();
        assertTrue(!(await validateCell(A.row, A.col)).isValid, "'TooLongText' should be invalid");
      },
    },
  ],
};
