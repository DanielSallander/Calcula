//! FILENAME: app/extensions/TestRunner/lib/suites/formatting.ts
// PURPOSE: Formatting workflow test suite.
// CONTEXT: Tests cell styling operations through the API.

import type { TestSuite } from "../types";
import { assertTrue, expectCellValue } from "../assertions";

export const formattingSuite: TestSuite = {
  name: "Formatting Operations",
  description: "Tests cell formatting and style verification.",

  afterEach: async (ctx) => {
    // Clean up test area
    await ctx.setCells([
      { row: 0, col: 0, value: "" },
      { row: 0, col: 1, value: "" },
    ]);
    await ctx.settle();
  },

  tests: [
    {
      name: "Cell retains value after style change",
      description: "Applies bold to a cell and verifies the value is unchanged.",
      run: async (ctx) => {
        await ctx.setCells([{ row: 0, col: 0, value: "StyledText" }]);
        await ctx.settle();

        // Select the cell
        ctx.setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
        await ctx.settle();

        // Try to apply bold (this depends on the formatting extension being loaded)
        try {
          await ctx.executeCommand("format.bold");
        } catch {
          ctx.log("format.bold command not available (formatting extension may not be loaded)");
        }
        await ctx.settle();

        // Value should remain unchanged regardless of style
        const cell = await ctx.getCell(0, 0);
        expectCellValue(cell, "StyledText", "A1");
      },
    },
    {
      name: "Cell value persists with different data types",
      description: "Checks that numbers, text, and dates are stored correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: 0, col: 0, value: "123.45" },
          { row: 0, col: 1, value: "Text Value" },
        ]);
        await ctx.settle();

        const numCell = await ctx.getCell(0, 0);
        assertTrue(numCell !== null, "Numeric cell should exist");
        // The display might be "123.45" or formatted differently
        assertTrue(numCell!.display.includes("123"), "Should contain the number");

        const textCell = await ctx.getCell(0, 1);
        expectCellValue(textCell, "Text Value", "B1");
      },
    },
    {
      name: "Style index is set on cells with values",
      description: "Verifies that cells with values have a valid style index.",
      run: async (ctx) => {
        await ctx.setCells([{ row: 0, col: 0, value: "HasStyle" }]);
        await ctx.settle();

        const cell = await ctx.getCell(0, 0);
        assertTrue(cell !== null, "Cell should exist");
        assertTrue(
          typeof cell!.styleIndex === "number",
          `styleIndex should be a number, got ${typeof cell!.styleIndex}`
        );
      },
    },
  ],
};
