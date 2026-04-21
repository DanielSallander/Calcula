//! FILENAME: app/extensions/TestRunner/lib/suites/protection.ts
// PURPOSE: Protection test suite.
// CONTEXT: Tests sheet protection, cell protection, allow-edit ranges, and workbook protection.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_PROTECTION } from "../testArea";
import {
  protectSheet,
  unprotectSheet,
  isSheetProtected,
  getProtectionStatus,
  canEditCell,
  setCellProtection,
  getCellProtection,
  addAllowEditRange,
  removeAllowEditRange,
  getAllowEditRanges,
  protectWorkbook,
  unprotectWorkbook,
  isWorkbookProtected,
} from "@api";

const A = AREA_PROTECTION;

export const protectionSuite: TestSuite = {
  name: "Protection",
  description: "Tests sheet protection, cell protection, allow-edit ranges, workbook protection.",

  afterEach: async (ctx) => {
    // Always unprotect after each test
    try { await unprotectSheet(); } catch { /* ignore */ }
    try { await unprotectWorkbook(); } catch { /* ignore */ }
    try { await removeAllowEditRange("TestEditRange"); } catch { /* ignore */ }
    // Reset cell protection to default (locked) for the test area
    try {
      await setCellProtection({
        startRow: A.row, startCol: A.col,
        endRow: A.row + 4, endCol: A.col + 2,
        locked: true,
      });
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
      name: "Protect and unprotect sheet",
      description: "isSheetProtected reflects state.",
      run: async (ctx) => {
        const before = await isSheetProtected();
        assertTrue(!before, "should not be protected initially");

        const result = await protectSheet();
        assertTrue(result.success, "protectSheet should succeed");

        const during = await isSheetProtected();
        assertTrue(during, "should be protected after protectSheet");

        const unResult = await unprotectSheet();
        assertTrue(unResult.success, "unprotectSheet should succeed");

        const after = await isSheetProtected();
        assertTrue(!after, "should not be protected after unprotect");
      },
    },
    {
      name: "Protection status details",
      description: "getProtectionStatus returns correct info.",
      run: async (ctx) => {
        await protectSheet();
        const status = await getProtectionStatus();
        assertTrue(status.isProtected, "should be protected");
        assertTrue(!status.hasPassword, "no password set");
        expectNotNull(status.options, "options should exist");
      },
    },
    {
      name: "Protect with password",
      description: "Cannot unprotect without password.",
      run: async (ctx) => {
        await protectSheet({ password: "test123" });
        const status = await getProtectionStatus();
        assertTrue(status.hasPassword, "should have password");

        // Unprotect with wrong password should fail
        const wrongResult = await unprotectSheet("wrongpass");
        assertTrue(!wrongResult.success, "wrong password should fail");

        // Unprotect with correct password
        const rightResult = await unprotectSheet("test123");
        assertTrue(rightResult.success, "correct password should succeed");
      },
    },
    {
      name: "canEditCell when protected",
      description: "Locked cells cannot be edited when sheet is protected.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "locked" }]);
        await ctx.settle();

        await protectSheet();

        const check = await canEditCell(A.row, A.col);
        assertTrue(!check.canEdit, "locked cell should not be editable when protected");
      },
    },
    {
      name: "Unlock cell allows editing when protected",
      description: "setCellProtection with locked=false allows editing.",
      run: async (ctx) => {
        // Unlock the cell first
        await setCellProtection({
          startRow: A.row, startCol: A.col,
          endRow: A.row, endCol: A.col,
          locked: false,
        });
        await ctx.settle();

        await protectSheet();

        const check = await canEditCell(A.row, A.col);
        assertTrue(check.canEdit, "unlocked cell should be editable when protected");
      },
    },
    {
      name: "Get and set cell protection",
      description: "getCellProtection reflects setCellProtection.",
      run: async (ctx) => {
        await setCellProtection({
          startRow: A.row, startCol: A.col,
          endRow: A.row, endCol: A.col,
          locked: false, formulaHidden: true,
        });
        await ctx.settle();

        const prot = await getCellProtection(A.row, A.col);
        assertTrue(!prot.locked, "should be unlocked");
        assertTrue(prot.formulaHidden, "formula should be hidden");
      },
    },
    {
      name: "Allow edit range",
      description: "addAllowEditRange lets editing within the range.",
      run: async (ctx) => {
        await addAllowEditRange({
          title: "TestEditRange",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 2, endCol: A.col + 2,
        });
        await protectSheet();

        const ranges = await getAllowEditRanges();
        assertTrue(ranges.length >= 1, "should have at least 1 range");
        const found = ranges.find(r => r.title === "TestEditRange");
        assertTrue(found !== undefined, "our range should be in the list");

        // Cells inside the range should be editable
        const check = await canEditCell(A.row, A.col);
        assertTrue(check.canEdit, "cell in allow-edit range should be editable");
      },
    },
    {
      name: "Workbook protection",
      description: "protectWorkbook / unprotectWorkbook / isWorkbookProtected.",
      run: async (ctx) => {
        const before = await isWorkbookProtected();
        assertTrue(!before, "workbook should not be protected initially");

        const result = await protectWorkbook();
        assertTrue(result.success, "protectWorkbook should succeed");
        assertTrue(await isWorkbookProtected(), "should be protected");

        const unResult = await unprotectWorkbook();
        assertTrue(unResult.success, "unprotectWorkbook should succeed");
        assertTrue(!(await isWorkbookProtected()), "should not be protected");
      },
    },
  ],
};
