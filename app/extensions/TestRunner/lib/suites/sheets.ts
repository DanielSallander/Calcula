//! FILENAME: app/extensions/TestRunner/lib/suites/sheets.ts
// PURPOSE: Sheet management test suite.
// CONTEXT: Tests adding, renaming, deleting, copying, moving, and
//          hiding/unhiding sheets via the Tauri backend API.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import {
  getSheets,
  addSheet,
  deleteSheet,
  renameSheet,
  moveSheet,
  copySheet,
  hideSheet,
  unhideSheet,
  setTabColor,
  setActiveSheetApi as setActiveSheet,
} from "@api";

export const sheetsSuite: TestSuite = {
  name: "Sheet Management",
  description: "Tests sheet add, rename, delete, copy, move, hide/unhide, tab color.",

  afterEach: async (ctx) => {
    // Clean up: remove any extra sheets beyond Sheet1.
    // Keep deleting the last sheet until only 1 remains.
    try {
      let result = await getSheets();
      // Unhide all hidden sheets first
      for (const sheet of result.sheets) {
        if (sheet.hidden) {
          await unhideSheet(sheet.index);
        }
      }
      result = await getSheets();
      // Make sure we're on sheet 0 before deleting
      if (result.activeIndex !== 0) {
        await setActiveSheet(0);
      }
      // Delete extra sheets from the end
      while (result.sheets.length > 1) {
        await deleteSheet(result.sheets.length - 1);
        result = await getSheets();
      }
      // Rename back to default if needed
      if (result.sheets[0].name !== "Sheet1") {
        await renameSheet(0, "Sheet1");
      }
    } catch (e) {
      ctx.log(`afterEach cleanup error: ${e}`);
    }
    await ctx.settle();
  },

  tests: [
    {
      name: "Add a new sheet",
      description: "Sheet count increases by one.",
      run: async (ctx) => {
        const before = await getSheets();
        const initialCount = before.sheets.length;

        await addSheet("TestSheet");
        await ctx.settle();

        const after = await getSheets();
        assertEqual(after.sheets.length, initialCount + 1, "sheet count");
        const newSheet = after.sheets.find(s => s.name === "TestSheet");
        assertTrue(newSheet !== undefined, "New sheet 'TestSheet' should exist");
      },
    },
    {
      name: "Rename a sheet",
      description: "Sheet name changes, other sheets unaffected.",
      run: async (ctx) => {
        await addSheet("ToRename");
        await ctx.settle();

        const before = await getSheets();
        const idx = before.sheets.findIndex(s => s.name === "ToRename");
        assertTrue(idx >= 0, "Sheet 'ToRename' should exist");

        await renameSheet(idx, "Renamed");
        await ctx.settle();

        const after = await getSheets();
        assertTrue(
          after.sheets.some(s => s.name === "Renamed"),
          "Sheet should be renamed to 'Renamed'"
        );
        assertTrue(
          !after.sheets.some(s => s.name === "ToRename"),
          "Old name 'ToRename' should be gone"
        );
      },
    },
    {
      name: "Delete a sheet",
      description: "Sheet count decreases by one.",
      run: async (ctx) => {
        await addSheet("ToDelete");
        await ctx.settle();

        const before = await getSheets();
        const initialCount = before.sheets.length;
        const idx = before.sheets.findIndex(s => s.name === "ToDelete");

        await deleteSheet(idx);
        await ctx.settle();

        const after = await getSheets();
        assertEqual(after.sheets.length, initialCount - 1, "sheet count after delete");
        assertTrue(
          !after.sheets.some(s => s.name === "ToDelete"),
          "Deleted sheet should be gone"
        );
      },
    },
    {
      name: "Copy a sheet",
      description: "Creates a copy with a new name.",
      run: async (ctx) => {
        const before = await getSheets();
        const initialCount = before.sheets.length;

        await copySheet(0, "Sheet1 Copy");
        await ctx.settle();

        const after = await getSheets();
        assertEqual(after.sheets.length, initialCount + 1, "sheet count after copy");
        assertTrue(
          after.sheets.some(s => s.name === "Sheet1 Copy"),
          "Copy 'Sheet1 Copy' should exist"
        );
      },
    },
    {
      name: "Move a sheet",
      description: "Sheet changes position in the list.",
      run: async (ctx) => {
        await addSheet("SheetA");
        await addSheet("SheetB");
        await ctx.settle();

        const before = await getSheets();
        const idxA = before.sheets.findIndex(s => s.name === "SheetA");
        const idxB = before.sheets.findIndex(s => s.name === "SheetB");
        assertTrue(idxA < idxB, "SheetA should be before SheetB initially");

        // Move SheetA to after SheetB
        await moveSheet(idxA, idxB);
        await ctx.settle();

        const after = await getSheets();
        const newIdxA = after.sheets.findIndex(s => s.name === "SheetA");
        const newIdxB = after.sheets.findIndex(s => s.name === "SheetB");
        assertTrue(newIdxB < newIdxA, "SheetB should be before SheetA after move");
      },
    },
    {
      name: "Hide and unhide a sheet",
      description: "Sheet visibility toggles correctly.",
      run: async (ctx) => {
        await addSheet("HideMe");
        await ctx.settle();

        const before = await getSheets();
        const idx = before.sheets.findIndex(s => s.name === "HideMe");
        assertTrue(idx >= 0, "Sheet should exist");

        await hideSheet(idx);
        await ctx.settle();

        const hidden = await getSheets();
        const hiddenSheet = hidden.sheets.find(s => s.name === "HideMe");
        expectNotNull(hiddenSheet, "Hidden sheet should still be in list");
        assertTrue(hiddenSheet!.hidden === true, "Sheet should be hidden");

        await unhideSheet(idx);
        await ctx.settle();

        const visible = await getSheets();
        const visibleSheet = visible.sheets.find(s => s.name === "HideMe");
        expectNotNull(visibleSheet, "Unhidden sheet should be in list");
        assertTrue(!visibleSheet!.hidden, "Sheet should be visible");
      },
    },
    {
      name: "Set tab color",
      description: "Tab color is stored on the sheet.",
      run: async (ctx) => {
        await addSheet("Colored");
        await ctx.settle();

        const before = await getSheets();
        const idx = before.sheets.findIndex(s => s.name === "Colored");

        await setTabColor(idx, "#FF0000");
        await ctx.settle();

        const after = await getSheets();
        const sheet = after.sheets.find(s => s.name === "Colored");
        expectNotNull(sheet, "Colored sheet should exist");
        assertEqual(sheet!.tabColor, "#FF0000", "tab color");
      },
    },
    {
      name: "Switch active sheet",
      description: "Active sheet index changes.",
      run: async (ctx) => {
        await addSheet("Other");
        await ctx.settle();

        const before = await getSheets();
        const otherIdx = before.sheets.findIndex(s => s.name === "Other");

        await setActiveSheet(otherIdx);
        await ctx.settle();

        const after = await getSheets();
        assertEqual(after.activeIndex, otherIdx, "active sheet index");
      },
    },
  ],
};
