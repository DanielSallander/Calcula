//! FILENAME: app/extensions/TestRunner/lib/suites/clipboard.ts
// PURPOSE: Clipboard operation test suite.
// CONTEXT: Tests copy/paste, cut/paste, and undo workflows.

import type { TestSuite } from "../types";
import { expectCellValue, expectCellEmpty } from "../assertions";
import { CoreCommands } from "../../../../src/api/commands";

export const clipboardSuite: TestSuite = {
  name: "Clipboard Operations",
  description: "Tests copy, cut, paste, and undo workflows.",

  afterEach: async (ctx) => {
    // Clean up test area
    await ctx.setCells([
      { row: 0, col: 0, value: "" },
      { row: 0, col: 1, value: "" },
      { row: 1, col: 0, value: "" },
      { row: 1, col: 1, value: "" },
    ]);
    await ctx.settle();
  },

  tests: [
    {
      name: "Copy and paste a cell value",
      description: "Copies A1 to B1 using clipboard commands.",
      run: async (ctx) => {
        // Set source value
        await ctx.setCells([{ row: 0, col: 0, value: "CopyMe" }]);
        await ctx.settle();

        // Select source
        ctx.setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
        await ctx.settle();

        // Copy
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Select destination
        ctx.setSelection({ startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
        await ctx.settle();

        // Paste
        await ctx.executeCommand(CoreCommands.PASTE);
        await ctx.settle();

        // Verify
        const source = await ctx.getCell(0, 0);
        expectCellValue(source, "CopyMe", "A1");
        const dest = await ctx.getCell(0, 1);
        expectCellValue(dest, "CopyMe", "B1");
      },
    },
    {
      name: "Cut and paste moves the value",
      description: "Cuts A1 to B1, verifying A1 becomes empty.",
      run: async (ctx) => {
        // Set source value
        await ctx.setCells([{ row: 0, col: 0, value: "MoveMe" }]);
        await ctx.settle();

        // Select source
        ctx.setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
        await ctx.settle();

        // Cut
        await ctx.executeCommand(CoreCommands.CUT);
        await ctx.settle();

        // Select destination
        ctx.setSelection({ startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
        await ctx.settle();

        // Paste
        await ctx.executeCommand(CoreCommands.PASTE);
        await ctx.settle();

        // Verify: source should be empty, destination should have the value
        const source = await ctx.getCell(0, 0);
        expectCellEmpty(source, "A1");
        const dest = await ctx.getCell(0, 1);
        expectCellValue(dest, "MoveMe", "B1");
      },
    },
    {
      name: "Undo restores previous state",
      description: "Enters a value, undoes, verifies cell is empty again.",
      run: async (ctx) => {
        // Start clean
        await ctx.setCells([{ row: 0, col: 0, value: "" }]);
        await ctx.settle();

        // Enter value
        await ctx.setCells([{ row: 0, col: 0, value: "UndoMe" }]);
        await ctx.settle();
        const before = await ctx.getCell(0, 0);
        expectCellValue(before, "UndoMe", "A1");

        // Undo
        await ctx.executeCommand(CoreCommands.UNDO);
        await ctx.settle();

        // Verify restored
        const after = await ctx.getCell(0, 0);
        expectCellEmpty(after, "A1");
      },
    },
  ],
};
