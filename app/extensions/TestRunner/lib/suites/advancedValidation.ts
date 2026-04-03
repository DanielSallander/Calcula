//! FILENAME: app/extensions/TestRunner/lib/suites/advancedValidation.ts
// PURPOSE: Advanced Data Validation test suite.
// CONTEXT: Tests getAllDataValidations, getValidationListValues, getValidationPrompt,
//          getInvalidCells, hasInCellDropdown, validatePendingValue.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_ADV_VALIDATION } from "../testArea";
import {
  setDataValidation,
  clearDataValidation,
  getAllDataValidations,
  getValidationPrompt,
  getInvalidCells,
  getValidationListValues,
  hasInCellDropdown,
  validatePendingValue,
  createWholeNumberRule,
  createListRule,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
} from "@api";

const A = AREA_ADV_VALIDATION;

/** Helper to build a DataValidation object from a rule. */
function makeValidation(rule: ReturnType<typeof createWholeNumberRule>, prompt?: { title: string; message: string }) {
  return {
    rule,
    errorAlert: DEFAULT_ERROR_ALERT,
    prompt: prompt ? {
      showPrompt: true,
      title: prompt.title,
      message: prompt.message,
    } : DEFAULT_PROMPT,
    ignoreBlanks: true,
  };
}

export const advancedValidationSuite: TestSuite = {
  name: "Advanced Validation",
  description: "Tests validation query APIs: list values, prompts, invalid cells, pending validation.",

  afterEach: async (ctx) => {
    try {
      await clearDataValidation(A.row, A.col, A.row + 10, A.col + 5);
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
      name: "Get all data validations",
      description: "getAllDataValidations lists validation rules on the sheet.",
      run: async (ctx) => {
        const rule = createListRule(["A", "B", "C"]);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        const all = await getAllDataValidations();
        assertTrue(all.length >= 1, "should have at least 1 validation");
        const ours = all.find(v =>
          v.startRow <= A.row && v.endRow >= A.row &&
          v.startCol <= A.col && v.endCol >= A.col
        );
        expectNotNull(ours, "our validation should be in the list");
      },
    },
    {
      name: "Get validation list values",
      description: "getValidationListValues returns dropdown options.",
      run: async (ctx) => {
        const rule = createListRule(["Red", "Green", "Blue"]);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        const values = await getValidationListValues(A.row, A.col);
        expectNotNull(values, "should return list values");
        assertTrue(values!.length === 3, `should have 3 values, got ${values!.length}`);
        assertTrue(values!.includes("Red"), "should include Red");
        assertTrue(values!.includes("Green"), "should include Green");
        assertTrue(values!.includes("Blue"), "should include Blue");
      },
    },
    {
      name: "Has in-cell dropdown",
      description: "hasInCellDropdown returns true for list validation.",
      run: async (ctx) => {
        const rule = createListRule(["X", "Y"]);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        const has = await hasInCellDropdown(A.row, A.col);
        assertTrue(has, "should have dropdown");

        const noDropdown = await hasInCellDropdown(A.row + 5, A.col + 5);
        assertTrue(!noDropdown, "unvalidated cell should not have dropdown");
      },
    },
    {
      name: "Get validation prompt",
      description: "getValidationPrompt returns input message if configured.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("between", 1, 100);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule, {
          title: "Enter number",
          message: "Must be 1-100",
        }));
        await ctx.settle();

        const prompt = await getValidationPrompt(A.row, A.col);
        expectNotNull(prompt, "should have a prompt");
        assertEqual(prompt!.title, "Enter number", "prompt title");
        assertEqual(prompt!.message, "Must be 1-100", "prompt message");
      },
    },
    {
      name: "Validate pending value",
      description: "validatePendingValue checks a value before committing.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("greaterThan", 10);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        const validResult = await validatePendingValue(A.row, A.col, "20");
        assertTrue(validResult.isValid, "20 should be valid (>10)");

        const invalidResult = await validatePendingValue(A.row, A.col, "5");
        assertTrue(!invalidResult.isValid, "5 should be invalid (not >10)");
      },
    },
    {
      name: "Get invalid cells",
      description: "getInvalidCells finds cells violating their validation rules.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "999" },
        ]);
        await ctx.settle();

        const rule = createWholeNumberRule("lessThan", 10);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        const result = await getInvalidCells();
        const ours = result.cells.filter(([r, c]) => r === A.row && c === A.col);
        assertTrue(ours.length > 0, "our cell with 999 should be invalid (not <10)");
      },
    },
  ],
};
