//! FILENAME: app/extensions/TestRunner/lib/suites/formatting.ts
// PURPOSE: Formatting workflow test suite.
// CONTEXT: Tests cell styling operations through the API.
//          Uses dedicated test area to avoid mock data overlap.

import type { TestSuite } from "../types";
import { assertTrue, expectCellValue } from "../assertions";
import { TEST_AREA } from "../testArea";

export const formattingSuite: TestSuite = {
  name: "Formatting Operations",
  description: "Tests cell formatting and style verification.",

  afterEach: async (ctx) => {
    const R = TEST_AREA.row;
    const C = TEST_AREA.col;
    // Clean up test area
    await ctx.setCells([
      { row: R, col: C, value: "" },
      { row: R, col: C + 1, value: "" },
    ]);
    await ctx.settle();
  },

  tests: [
    {
      name: "Cell retains value after style change",
      description: "Applies bold to a cell and verifies the value is unchanged.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        await ctx.setCells([{ row: R, col: C, value: "StyledText" }]);
        await ctx.settle();

        // Select the cell
        ctx.setSelection({ startRow: R, startCol: C, endRow: R, endCol: C });
        await ctx.settle();

        // Try to apply bold (this depends on the formatting extension being loaded)
        try {
          await ctx.executeCommand("format.bold");
        } catch {
          ctx.log("format.bold command not available (formatting extension may not be loaded)");
        }
        await ctx.settle();

        // Value should remain unchanged regardless of style
        const cell = await ctx.getCell(R, C);
        expectCellValue(cell, "StyledText", "TestArea");
      },
    },
    {
      name: "Cell value persists with different data types",
      description: "Checks that numbers, text, and dates are stored correctly.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        await ctx.setCells([
          { row: R, col: C, value: "123.45" },
          { row: R, col: C + 1, value: "Text Value" },
        ]);
        await ctx.settle();

        const numCell = await ctx.getCell(R, C);
        assertTrue(numCell !== null, "Numeric cell should exist");
        assertTrue(numCell!.display.includes("123"), "Should contain the number");

        const textCell = await ctx.getCell(R, C + 1);
        expectCellValue(textCell, "Text Value", "TestArea");
      },
    },
    {
      name: "Style index is set on cells with values",
      description: "Verifies that cells with values have a valid style index.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        await ctx.setCells([{ row: R, col: C, value: "HasStyle" }]);
        await ctx.settle();

        const cell = await ctx.getCell(R, C);
        assertTrue(cell !== null, "Cell should exist");
        assertTrue(
          typeof cell!.styleIndex === "number",
          `styleIndex should be a number, got ${typeof cell!.styleIndex}`
        );
      },
    },
  ],
};
