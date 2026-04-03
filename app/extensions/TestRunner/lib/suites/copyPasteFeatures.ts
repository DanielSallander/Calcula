//! FILENAME: app/extensions/TestRunner/lib/suites/copyPasteFeatures.ts
// PURPOSE: Copy/Paste + Features cross-feature integration tests.
// CONTEXT: Verifies copy/paste preserves formatting, shifts formulas, and clears source on cut.

import type { TestSuite } from "../types";
import { assertTrue, expectCellValue, expectCellEmpty, expectNotNull } from "../assertions";
import { AREA_COPYPASTE_FEATURES } from "../testArea";
import { CoreCommands } from "@api/commands";
import { applyFormatting, getStyle } from "@api/lib";

const A = AREA_COPYPASTE_FEATURES;

export const copyPasteFeaturesSuite: TestSuite = {
  name: "Copy/Paste + Features Integration",
  description: "Tests copy/paste interactions with formatting, formulas, and undo.",

  afterEach: async (ctx) => {
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
      name: "Copy formatted cell preserves style",
      description: "Bold cell copied to dest retains bold style.",
      run: async (ctx) => {
        // Set source value
        await ctx.setCells([{ row: A.row, col: A.col, value: "BoldText" }]);
        await ctx.settle();

        // Apply bold formatting
        const fmtResult = await applyFormatting([A.row], [A.col], { bold: true });
        assertTrue(fmtResult.cells.length > 0, "formatting should return updated cells");
        await ctx.settle();

        // Select source
        ctx.setSelection({ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col });
        await ctx.settle();
        await ctx.settle();

        // Copy
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Select destination
        ctx.setSelection({ startRow: A.row, startCol: A.col + 2, endRow: A.row, endCol: A.col + 2 });
        await ctx.settle();
        await ctx.settle();

        // Paste
        await ctx.executeCommand(CoreCommands.PASTE);
        await ctx.settle();

        // Verify destination has bold style
        const destCell = await ctx.getCell(A.row, A.col + 2);
        expectCellValue(destCell, "BoldText", "dest");
        const destStyle = await getStyle(destCell!.styleIndex);
        assertTrue(destStyle.bold, "pasted cell should have bold style");
      },
    },
    {
      name: "Copy formula adjusts references",
      description: "Formula referencing a cell shifts when pasted one row down.",
      run: async (ctx) => {
        // Helper cell with a value
        await ctx.setCells([
          { row: A.row, col: A.col, value: "100" },
          { row: A.row + 1, col: A.col, value: "200" },
          // Formula referencing the helper cell
          { row: A.row, col: A.col + 1, value: `=${A.ref(0, 0)}` },
        ]);
        await ctx.settle();

        // Verify formula computed correctly
        const srcCell = await ctx.getCell(A.row, A.col + 1);
        expectNotNull(srcCell, "formula cell should exist");
        assertTrue(srcCell!.display.includes("100"), `expected 100, got ${srcCell!.display}`);

        // Select formula cell
        ctx.setSelection({ startRow: A.row, startCol: A.col + 1, endRow: A.row, endCol: A.col + 1 });
        await ctx.settle();
        await ctx.settle();

        // Copy
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Paste one row down
        ctx.setSelection({ startRow: A.row + 1, startCol: A.col + 1, endRow: A.row + 1, endCol: A.col + 1 });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand(CoreCommands.PASTE);
        await ctx.settle();

        // Pasted formula should reference row+1 (value 200)
        const destCell = await ctx.getCell(A.row + 1, A.col + 1);
        expectNotNull(destCell, "pasted formula cell should exist");
        assertTrue(destCell!.display.includes("200"), `pasted formula should evaluate to 200, got ${destCell!.display}`);
      },
    },
    {
      name: "Cut and paste clears source",
      description: "Cut moves value to dest and clears source.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "MoveIt" }]);
        await ctx.settle();

        // Select source
        ctx.setSelection({ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col });
        await ctx.settle();
        await ctx.settle();

        // Cut
        await ctx.executeCommand(CoreCommands.CUT);
        await ctx.settle();

        // Select destination
        ctx.setSelection({ startRow: A.row + 3, startCol: A.col + 3, endRow: A.row + 3, endCol: A.col + 3 });
        await ctx.settle();
        await ctx.settle();

        // Paste
        await ctx.executeCommand(CoreCommands.PASTE);
        await ctx.settle();

        // Verify source is empty, dest has value
        const source = await ctx.getCell(A.row, A.col);
        expectCellEmpty(source, "source after cut");
        const dest = await ctx.getCell(A.row + 3, A.col + 3);
        expectCellValue(dest, "MoveIt", "dest after paste");
      },
    },
    {
      name: "Paste after undo still works",
      description: "Copy value, undo the value, paste still has clipboard content.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "CopyFirst" }]);
        await ctx.settle();

        // Select and copy
        ctx.setSelection({ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col });
        await ctx.settle();
        await ctx.settle();
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Undo the cell value (clipboard should still hold the value)
        await ctx.undo();
        await ctx.settle();

        // Paste to a different cell
        ctx.setSelection({ startRow: A.row + 1, startCol: A.col, endRow: A.row + 1, endCol: A.col });
        await ctx.settle();
        await ctx.settle();
        await ctx.executeCommand(CoreCommands.PASTE);
        await ctx.settle();

        // Dest should have the copied value even though source was undone
        const dest = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(dest, "CopyFirst", "paste should work after undo of source");
      },
    },
  ],
};
