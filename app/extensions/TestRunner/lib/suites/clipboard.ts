//! FILENAME: app/extensions/TestRunner/lib/suites/clipboard.ts
// PURPOSE: Clipboard operation test suite.
// CONTEXT: Tests copy/paste, cut/paste, and undo workflows.
//          Uses dedicated test area to avoid mock data overlap.
//          Uses longer settle times after setSelection to allow React re-render
//          (the clipboard handlers use useCallback with selection in deps).

import type { TestSuite } from "../types";
import { expectCellValue, expectCellEmpty } from "../assertions";
import { CoreCommands } from "@api/commands";
import { TEST_AREA } from "../testArea";

export const clipboardSuite: TestSuite = {
  name: "Clipboard Operations",
  description: "Tests copy, cut, paste, and undo workflows.",

  afterEach: async (ctx) => {
    const R = TEST_AREA.row;
    const C = TEST_AREA.col;
    // Clean up test area
    await ctx.setCells([
      { row: R, col: C, value: "" },
      { row: R, col: C + 1, value: "" },
      { row: R + 1, col: C, value: "" },
      { row: R + 1, col: C + 1, value: "" },
    ]);
    await ctx.settle();
  },

  tests: [
    {
      name: "Copy and paste a cell value",
      description: "Copies a cell to an adjacent cell using clipboard commands.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;

        // Set source value
        await ctx.setCells([{ row: R, col: C, value: "CopyMe" }]);
        await ctx.settle();

        // Select source — use longer settle to let React re-render
        // so the useCallback handlers capture the new selection
        ctx.setSelection({ startRow: R, startCol: C, endRow: R, endCol: C });
        await ctx.settle();
        await ctx.settle(); // extra settle for React render cycle

        // Copy
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Select destination
        ctx.setSelection({ startRow: R, startCol: C + 1, endRow: R, endCol: C + 1 });
        await ctx.settle();
        await ctx.settle();

        // Paste
        await ctx.executeCommand(CoreCommands.PASTE);
        await ctx.settle();

        // Verify
        const source = await ctx.getCell(R, C);
        expectCellValue(source, "CopyMe", "source");
        const dest = await ctx.getCell(R, C + 1);
        expectCellValue(dest, "CopyMe", "dest");
      },
    },
    {
      name: "Cut and paste moves the value",
      description: "Cuts a cell to an adjacent cell, verifying source becomes empty.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;

        // Set source value
        await ctx.setCells([{ row: R, col: C, value: "MoveMe" }]);
        await ctx.settle();

        // Select source
        ctx.setSelection({ startRow: R, startCol: C, endRow: R, endCol: C });
        await ctx.settle();
        await ctx.settle();

        // Cut
        await ctx.executeCommand(CoreCommands.CUT);
        await ctx.settle();

        // Select destination
        ctx.setSelection({ startRow: R, startCol: C + 1, endRow: R, endCol: C + 1 });
        await ctx.settle();
        await ctx.settle();

        // Paste
        await ctx.executeCommand(CoreCommands.PASTE);
        await ctx.settle();

        // Verify: source should be empty, destination should have the value
        const source = await ctx.getCell(R, C);
        expectCellEmpty(source, "source");
        const dest = await ctx.getCell(R, C + 1);
        expectCellValue(dest, "MoveMe", "dest");
      },
    },
    {
      name: "Undo restores previous state",
      description: "Enters a value, undoes via Tauri API, verifies cell is empty again.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;

        // Start clean
        await ctx.setCells([{ row: R, col: C, value: "" }]);
        await ctx.settle();

        // Enter value
        await ctx.setCells([{ row: R, col: C, value: "UndoMe" }]);
        await ctx.settle();
        const before = await ctx.getCell(R, C);
        expectCellValue(before, "UndoMe", "before undo");

        // Undo — use the direct undo method (bypasses command registry)
        await ctx.undo();
        await ctx.settle();

        // Verify restored
        const after = await ctx.getCell(R, C);
        expectCellEmpty(after, "after undo");
      },
    },
  ],
};
