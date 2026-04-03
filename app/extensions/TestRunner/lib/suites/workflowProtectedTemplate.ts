//! FILENAME: app/extensions/TestRunner/lib/suites/workflowProtectedTemplate.ts
// PURPOSE: Protected template workflow end-to-end test.
// CONTEXT: Creates a template with locked headers, unlocked data area,
//          validation, allow-edit ranges, and protection.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue } from "../assertions";
import { AREA_WF_PROTECTED_TEMPLATE } from "../testArea";
import {
  protectSheet,
  unprotectSheet,
  isSheetProtected,
  canEditCell,
  setCellProtection,
  getCellProtection,
  addAllowEditRange,
  removeAllowEditRange,
  getAllowEditRanges,
  setDataValidation,
  getDataValidation,
  clearDataValidation,
  createWholeNumberRule,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
} from "@api";

const A = AREA_WF_PROTECTED_TEMPLATE;

function makeValidation(rule: ReturnType<typeof createWholeNumberRule>) {
  return {
    rule,
    errorAlert: DEFAULT_ERROR_ALERT,
    prompt: DEFAULT_PROMPT,
    ignoreBlanks: true,
  };
}

export const workflowProtectedTemplateSuite: TestSuite = {
  name: "Workflow: Protected Template",
  description: "End-to-end protected template with locked headers, validation, and allow-edit ranges.",

  afterEach: async (ctx) => {
    try { await unprotectSheet(); } catch { /* ignore */ }
    try { await removeAllowEditRange("TemplateDataArea"); } catch { /* ignore */ }
    try {
      await clearDataValidation(A.row, A.col, A.row + 6, A.col + 3);
    } catch { /* ignore */ }
    // Reset cell protection to default (locked)
    try {
      await setCellProtection({
        startRow: A.row, startCol: A.col,
        endRow: A.row + 6, endCol: A.col + 3,
        locked: true,
      });
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
      name: "Create and use protected template",
      description: "Locked headers, unlocked data area, validation on Age, allow-edit range, protection.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Step 1: Set up headers
        await ctx.setCells([
          { row: R, col: C, value: "Name" },
          { row: R, col: C + 1, value: "Age" },
          { row: R, col: C + 2, value: "Department" },
        ]);
        await ctx.settle();

        // Step 2: Add some template data rows
        await ctx.setCells([
          { row: R + 1, col: C, value: "Alice" },
          { row: R + 1, col: C + 1, value: "30" },
          { row: R + 1, col: C + 2, value: "Engineering" },
          { row: R + 2, col: C, value: "Bob" },
          { row: R + 2, col: C + 1, value: "45" },
          { row: R + 2, col: C + 2, value: "Marketing" },
        ]);
        await ctx.settle();

        // Step 3: Unlock data area (rows 1-4, all columns)
        await setCellProtection({
          startRow: R + 1, startCol: C,
          endRow: R + 4, endCol: C + 2,
          locked: false,
        });
        await ctx.settle();

        // Step 4: Add validation on Age column (1-150)
        const ageRule = createWholeNumberRule("between", 1, 150);
        await setDataValidation(R + 1, C + 1, R + 4, C + 1, makeValidation(ageRule));
        await ctx.settle();

        // Step 5: Add allow-edit range for the data area
        await addAllowEditRange({
          title: "TemplateDataArea",
          startRow: R + 1, startCol: C,
          endRow: R + 4, endCol: C + 2,
        });

        // Step 6: Protect the sheet
        await protectSheet();
        await ctx.settle();

        // Verify: header row should NOT be editable
        const headerCheck = await canEditCell(R, C);
        assertTrue(!headerCheck.canEdit, "header cell should not be editable when protected");

        // Verify: data area should be editable (allow-edit range)
        const dataCheck = await canEditCell(R + 1, C);
        assertTrue(dataCheck.canEdit, "data area cell should be editable via allow-edit range");

        // Verify: validation exists on Age column
        const dv = await getDataValidation(R + 1, C + 1);
        expectNotNull(dv, "Age column should have validation");

        // Verify: allow-edit ranges include ours
        const ranges = await getAllowEditRanges();
        const found = ranges.find(r => r.title === "TemplateDataArea");
        assertTrue(found !== undefined, "TemplateDataArea should be in allow-edit ranges");

        // Verify: protection is active
        const prot = await isSheetProtected();
        assertTrue(prot, "sheet should be protected");

        ctx.log("Protected template workflow completed successfully");
      },
    },
    {
      name: "Template survives protect/unprotect cycle",
      description: "Validation and cell protection persist through protect/unprotect.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Set up minimal template
        await ctx.setCells([
          { row: R, col: C, value: "Header" },
          { row: R + 1, col: C, value: "Data" },
        ]);
        await ctx.settle();

        // Unlock data row
        await setCellProtection({
          startRow: R + 1, startCol: C,
          endRow: R + 1, endCol: C,
          locked: false,
        });
        await ctx.settle();

        // Add validation
        const rule = createWholeNumberRule("between", 1, 100);
        await setDataValidation(R + 1, C, R + 1, C, makeValidation(rule));
        await ctx.settle();

        // Protect then unprotect
        await protectSheet();
        await ctx.settle();
        await unprotectSheet();
        await ctx.settle();

        // Verify validation persists
        const dv = await getDataValidation(R + 1, C);
        expectNotNull(dv, "validation should persist after protect/unprotect cycle");

        // Verify cell protection persists (unlocked)
        const prot = await getCellProtection(R + 1, C);
        assertTrue(!prot.locked, "cell should remain unlocked after protect/unprotect cycle");

        // Verify data intact
        expectCellValue(await ctx.getCell(R, C), "Header", "header intact");
        expectCellValue(await ctx.getCell(R + 1, C), "Data", "data intact");
      },
    },
  ],
};
