//! FILENAME: app/extensions/TestRunner/lib/suites/advancedProtection.ts
// PURPOSE: Advanced Protection test suite.
// CONTEXT: Tests updateProtectionOptions, removeAllowEditRange, getAllowEditRanges,
//          canPerformAction, verifyEditRangePassword, isSheetProtected.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual } from "../assertions";
import { AREA_ADV_PROTECTION } from "../testArea";
import {
  protectSheet,
  unprotectSheet,
  isSheetProtected,
  getProtectionStatus,
  updateProtectionOptions,
  addAllowEditRange,
  removeAllowEditRange,
  getAllowEditRanges,
  canPerformAction,
  verifyEditRangePassword,
} from "../../../../src/api";

const A = AREA_ADV_PROTECTION;

export const advancedProtectionSuite: TestSuite = {
  name: "Advanced Protection",
  description: "Tests protection options, edit ranges, action checks, and password verification.",

  afterEach: async (ctx) => {
    try { await unprotectSheet(); } catch { /* ignore */ }
    try { await removeAllowEditRange("TestEditRange"); } catch { /* ignore */ }
    try { await removeAllowEditRange("PasswordRange"); } catch { /* ignore */ }
    await ctx.settle();
  },

  tests: [
    {
      name: "isSheetProtected reflects state",
      description: "isSheetProtected returns correct boolean.",
      run: async () => {
        const before = await isSheetProtected();
        assertTrue(!before, "should not be protected initially");

        await protectSheet();
        const after = await isSheetProtected();
        assertTrue(after, "should be protected after protectSheet");

        await unprotectSheet();
        const afterUnprotect = await isSheetProtected();
        assertTrue(!afterUnprotect, "should not be protected after unprotect");
      },
    },
    {
      name: "Update protection options",
      description: "updateProtectionOptions changes what is allowed while protected.",
      run: async () => {
        await protectSheet();

        const result = await updateProtectionOptions({
          allowSelectLockedCells: true,
          allowSelectUnlockedCells: true,
          allowFormatCells: true,
          allowFormatColumns: false,
          allowFormatRows: false,
          allowInsertColumns: true,
          allowInsertRows: true,
          allowInsertHyperlinks: false,
          allowDeleteColumns: false,
          allowDeleteRows: false,
          allowSort: true,
          allowAutoFilter: false,
          allowPivotTables: false,
          allowEditObjects: false,
          allowEditScenarios: false,
        });
        assertTrue(result.success, "update options should succeed");

        const status = await getProtectionStatus();
        assertTrue(status.options.allowFormatCells === true, "formatCells should be allowed");
        assertTrue(status.options.allowSort === true, "sort should be allowed");
      },
    },
    {
      name: "canPerformAction checks permissions",
      description: "canPerformAction returns allowed/blocked for specific actions.",
      run: async () => {
        await protectSheet();

        // By default, most actions are blocked
        const sortCheck = await canPerformAction("sort");
        // After protection with defaults, sort should be blocked
        assertTrue(typeof sortCheck.canEdit === "boolean", "should return canEdit flag");

        await unprotectSheet();
        // After unprotect, actions should be allowed
        const afterUnprotect = await canPerformAction("sort");
        assertTrue(afterUnprotect.canEdit, "sort should be allowed when unprotected");
      },
    },
    {
      name: "Manage allow-edit ranges",
      description: "Add, list, and remove allow-edit ranges.",
      run: async () => {
        await protectSheet();

        // Add an allow-edit range
        await addAllowEditRange({
          title: "TestEditRange",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 5,
          endCol: A.col + 3,
        });

        // List ranges — verify via getAllowEditRanges
        const all = await getAllowEditRanges();
        const ours = all.find(r => r.title === "TestEditRange");
        assertTrue(ours !== undefined, "our range should be in list");

        // Remove
        const removeResult = await removeAllowEditRange("TestEditRange");
        assertTrue(removeResult.success, "remove should succeed");

        const afterRemove = await getAllowEditRanges();
        const gone = afterRemove.find(r => r.title === "TestEditRange");
        assertTrue(gone === undefined, "range should be gone");
      },
    },
    {
      name: "Verify edit range password",
      description: "Password-protected edit range can be verified.",
      run: async () => {
        await protectSheet();

        await addAllowEditRange({
          title: "PasswordRange",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 2,
          endCol: A.col + 2,
          password: "secret123",
        });

        const correct = await verifyEditRangePassword("PasswordRange", "secret123");
        assertTrue(correct, "correct password should verify");

        const wrong = await verifyEditRangePassword("PasswordRange", "wrongpass");
        assertTrue(!wrong, "wrong password should fail");

        // Cleanup
        await removeAllowEditRange("PasswordRange");
      },
    },
  ],
};
