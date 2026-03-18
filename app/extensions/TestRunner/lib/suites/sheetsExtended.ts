//! FILENAME: app/extensions/TestRunner/lib/suites/sheetsExtended.ts
// PURPOSE: Extended sheet management test suite.
// CONTEXT: Tests hideSheet, unhideSheet, setTabColor, moveSheet, getActiveSheet.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import {
  hideSheet,
  unhideSheet,
  setTabColor,
  moveSheet,
} from "../../../../src/api";
import {
  getActiveSheet,
  getSheets,
  addSheet,
  deleteSheet,
  setActiveSheet,
} from "../../../../src/api/lib";

export const sheetsExtendedSuite: TestSuite = {
  name: "Sheet Management Extended",
  description: "Tests hide/unhide, tab color, move sheet, and getActiveSheet.",

  afterEach: async (ctx) => {
    // Clean up extra sheets - keep only the first one
    try {
      const result = await getSheets();
      // Make sure the first sheet is active and visible
      if (result.sheets.length > 0) {
        await setActiveSheet(0);
      }
      // Try to unhide all sheets first
      for (let i = 0; i < result.sheets.length; i++) {
        if (result.sheets[i].hidden) {
          try { await unhideSheet(i); } catch { /* ignore */ }
        }
      }
      // Delete any extra sheets we created (reverse order)
      const updated = await getSheets();
      for (let i = updated.sheets.length - 1; i >= 1; i--) {
        try { await deleteSheet(i); } catch { /* ignore */ }
      }
      // Reset tab color on first sheet
      try { await setTabColor(0, ""); } catch { /* ignore */ }
    } catch { /* ignore */ }
    await ctx.settle();
  },

  tests: [
    {
      name: "Get active sheet",
      description: "getActiveSheet returns the current sheet index.",
      run: async (ctx) => {
        const active = await getActiveSheet();
        assertTrue(typeof active === "number", "should return a number");
        assertTrue(active >= 0, "should be non-negative");
      },
    },
    {
      name: "Hide and unhide sheet",
      description: "hideSheet hides, unhideSheet restores visibility.",
      run: async (ctx) => {
        // Need at least 2 sheets (can't hide the only one)
        await addSheet("HiddenSheet");
        await ctx.settle();

        const result = await getSheets();
        const newIdx = result.sheets.findIndex(s => s.name === "HiddenSheet");
        assertTrue(newIdx >= 0, "new sheet should exist");

        // Hide the new sheet
        const hideResult = await hideSheet(newIdx);
        const hiddenSheet = hideResult.sheets[newIdx];
        assertTrue(hiddenSheet.hidden === true, "sheet should be hidden");

        // Unhide it
        const unhideResult = await unhideSheet(newIdx);
        assertTrue(!unhideResult.sheets[newIdx].hidden, "sheet should be visible again");
      },
    },
    {
      name: "Set tab color",
      description: "setTabColor changes the sheet tab color.",
      run: async (ctx) => {
        const result = await setTabColor(0, "#FF5733");
        expectNotNull(result, "setTabColor should return result");

        const sheet = result.sheets[0];
        assertTrue(
          sheet.tabColor !== null && sheet.tabColor !== undefined && sheet.tabColor !== "",
          "tabColor should be set"
        );

        // Clear the color (empty string)
        await setTabColor(0, "");
      },
    },
    {
      name: "Move sheet",
      description: "moveSheet reorders sheets.",
      run: async (ctx) => {
        // Create 2 extra sheets
        await addSheet("SheetA");
        await addSheet("SheetB");
        await ctx.settle();

        const before = await getSheets();
        const idxA = before.sheets.findIndex(s => s.name === "SheetA");
        const idxB = before.sheets.findIndex(s => s.name === "SheetB");
        assertTrue(idxA >= 0, "SheetA exists");
        assertTrue(idxB >= 0, "SheetB exists");
        assertTrue(idxB > idxA, "SheetB should be after SheetA initially");

        // Move SheetB before SheetA
        const moveResult = await moveSheet(idxB, idxA);

        const newIdxA = moveResult.sheets.findIndex(s => s.name === "SheetA");
        const newIdxB = moveResult.sheets.findIndex(s => s.name === "SheetB");
        assertTrue(newIdxB < newIdxA, "SheetB should now be before SheetA");
      },
    },
    {
      name: "Switch active sheet",
      description: "setActiveSheet changes which sheet is active.",
      run: async (ctx) => {
        await addSheet("SwitchTarget");
        await ctx.settle();

        const sheets = await getSheets();
        const targetIdx = sheets.sheets.findIndex(s => s.name === "SwitchTarget");
        assertTrue(targetIdx >= 0, "target sheet exists");

        await setActiveSheet(targetIdx);
        const active = await getActiveSheet();
        assertEqual(active, targetIdx, "active sheet should be the target");

        // Switch back to first sheet
        await setActiveSheet(0);
      },
    },
  ],
};
