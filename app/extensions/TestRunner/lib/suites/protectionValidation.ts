//! FILENAME: app/extensions/TestRunner/lib/suites/protectionValidation.ts
// PURPOSE: Protection + Validation cross-feature integration tests.
// CONTEXT: Verifies validation rules work correctly alongside sheet protection.

import type { TestSuite } from "../types";
import { assertTrue, expectNotNull } from "../assertions";
import { AREA_PROTECTION_VALIDATION } from "../testArea";
import {
  protectSheet,
  unprotectSheet,
  isSheetProtected,
  getProtectionStatus,
  setCellProtection,
  canEditCell,
  addAllowEditRange,
  removeAllowEditRange,
  setDataValidation,
  getDataValidation,
  clearDataValidation,
  validateCell,
  getAllDataValidations,
  createWholeNumberRule,
  createListRule,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
} from "@api";

const A = AREA_PROTECTION_VALIDATION;

function makeValidation(rule: ReturnType<typeof createWholeNumberRule>) {
  return {
    rule,
    errorAlert: DEFAULT_ERROR_ALERT,
    prompt: DEFAULT_PROMPT,
    ignoreBlanks: true,
  };
}

export const protectionValidationSuite: TestSuite = {
  name: "Protection + Validation Integration",
  description: "Tests that validation rules work correctly alongside sheet protection.",

  afterEach: async (ctx) => {
    try { await unprotectSheet(); } catch { /* ignore */ }
    try { await removeAllowEditRange("PV_TestRange"); } catch { /* ignore */ }
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
      name: "Validation works on protected sheet",
      description: "Set validation, protect, then validateCell still returns correct results.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("between", 1, 100);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await protectSheet();
        await ctx.settle();

        // Write a valid value and check
        await ctx.setCells([{ row: A.row, col: A.col, value: "50" }]);
        await ctx.settle();
        const valid = await validateCell(A.row, A.col);
        assertTrue(valid.isValid, "50 should be valid (between 1-100) even when protected");

        // Write an invalid value and check
        await ctx.setCells([{ row: A.row, col: A.col, value: "200" }]);
        await ctx.settle();
        const invalid = await validateCell(A.row, A.col);
        assertTrue(!invalid.isValid, "200 should be invalid (not between 1-100) even when protected");
      },
    },
    {
      name: "Allow-edit range with validation rule",
      description: "List validation + allow-edit range: cell is editable and validation enforced.",
      run: async (ctx) => {
        const rule = createListRule(["A", "B", "C"]);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await addAllowEditRange({
          title: "PV_TestRange",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 2,
          endCol: A.col + 2,
        });
        await protectSheet();
        await ctx.settle();

        // Cell should be editable via allow-edit range
        const editCheck = await canEditCell(A.row, A.col);
        assertTrue(editCheck.canEdit, "cell in allow-edit range should be editable");

        // Validation should still work
        await ctx.setCells([{ row: A.row, col: A.col, value: "A" }]);
        await ctx.settle();
        const valid = await validateCell(A.row, A.col);
        assertTrue(valid.isValid, "'A' should be valid (in list)");

        await ctx.setCells([{ row: A.row, col: A.col, value: "X" }]);
        await ctx.settle();
        const invalid = await validateCell(A.row, A.col);
        assertTrue(!invalid.isValid, "'X' should be invalid (not in list)");
      },
    },
    {
      name: "Unlock cell + validation enforced",
      description: "Unlocked cell is editable when protected, but validation still checked.",
      run: async (ctx) => {
        await setCellProtection({
          startRow: A.row, startCol: A.col,
          endRow: A.row, endCol: A.col,
          locked: false,
        });
        await ctx.settle();

        const rule = createWholeNumberRule("between", 1, 50);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await protectSheet();
        await ctx.settle();

        const editCheck = await canEditCell(A.row, A.col);
        assertTrue(editCheck.canEdit, "unlocked cell should be editable when protected");

        await ctx.setCells([{ row: A.row, col: A.col, value: "25" }]);
        await ctx.settle();
        const valid = await validateCell(A.row, A.col);
        assertTrue(valid.isValid, "25 should be valid (between 1-50)");

        await ctx.setCells([{ row: A.row, col: A.col, value: "100" }]);
        await ctx.settle();
        const invalid = await validateCell(A.row, A.col);
        assertTrue(!invalid.isValid, "100 should be invalid (not between 1-50)");
      },
    },
    {
      name: "Validation persists through protect/unprotect cycle",
      description: "Validation rule survives protection toggle.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("greaterThan", 0);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await protectSheet();
        await ctx.settle();

        await unprotectSheet();
        await ctx.settle();

        const dv = await getDataValidation(A.row, A.col);
        expectNotNull(dv, "validation should persist after protect/unprotect cycle");
      },
    },
    {
      name: "Protection status + validation status together",
      description: "Both getProtectionStatus and getAllDataValidations report correct state.",
      run: async (ctx) => {
        const rule = createWholeNumberRule("between", 1, 100);
        await setDataValidation(A.row, A.col, A.row, A.col, makeValidation(rule));
        await ctx.settle();

        await protectSheet();
        await ctx.settle();

        const protStatus = await getProtectionStatus();
        assertTrue(protStatus.isProtected, "sheet should be protected");

        const validations = await getAllDataValidations();
        assertTrue(validations.length >= 1, "should have at least 1 validation");
        const ours = validations.find(v =>
          v.startRow <= A.row && v.endRow >= A.row &&
          v.startCol <= A.col && v.endCol >= A.col
        );
        expectNotNull(ours, "our validation should be present while protected");
      },
    },
  ],
};
