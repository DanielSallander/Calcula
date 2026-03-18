//! FILENAME: app/extensions/TestRunner/lib/suites/basic.ts
// PURPOSE: Basic cell operation test suite.
// CONTEXT: Tests entering values, formulas, reading back, and clearing.
//          Uses a dedicated test area (row 500+, col 10+) to avoid overlapping with mock data.

import type { TestSuite } from "../types";
import { expectCellValue, expectCellEmpty, expectCellFormula } from "../assertions";
import { TEST_AREA } from "../testArea";

export const basicSuite: TestSuite = {
  name: "Basic Cell Operations",
  description: "Tests cell value entry, formulas, and clearing.",

  afterEach: async (ctx) => {
    const R = TEST_AREA.row;
    const C = TEST_AREA.col;
    // Clean up by clearing the test area
    await ctx.setCells([
      { row: R, col: C, value: "" },
      { row: R, col: C + 1, value: "" },
      { row: R, col: C + 2, value: "" },
      { row: R + 1, col: C, value: "" },
      { row: R + 1, col: C + 1, value: "" },
      { row: R + 1, col: C + 2, value: "" },
      { row: R + 2, col: C, value: "" },
      { row: R + 2, col: C + 1, value: "" },
      { row: R + 2, col: C + 2, value: "" },
    ]);
    await ctx.settle();
  },

  tests: [
    {
      name: "Enter and read back a text value",
      description: "Sets a cell to 'Hello' and reads it back.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        await ctx.setCells([{ row: R, col: C, value: "Hello" }]);
        await ctx.settle();
        const cell = await ctx.getCell(R, C);
        expectCellValue(cell, "Hello", "TestArea");
      },
    },
    {
      name: "Enter and read back a numeric value",
      description: "Sets a cell to '42' and reads it back.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        await ctx.setCells([{ row: R, col: C, value: "42" }]);
        await ctx.settle();
        const cell = await ctx.getCell(R, C);
        expectCellValue(cell, "42", "TestArea");
      },
    },
    {
      name: "Enter a simple formula and verify result",
      description: "Sets =1+2 and verifies the computed value is 3.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        await ctx.setCells([{ row: R, col: C, value: "=1+2" }]);
        await ctx.settle();
        const cell = await ctx.getCell(R, C);
        expectCellValue(cell, "3", "TestArea");
        expectCellFormula(cell, "=1+2", "TestArea");
      },
    },
    {
      name: "Formula referencing other cells",
      description: "Tests cell references within the test area.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        // Use absolute cell references based on the test area coordinates
        const col0Letter = TEST_AREA.colLetter;
        const col1Letter = TEST_AREA.colLetter2;
        const rowRef = R + 1; // 1-based row reference for formulas
        await ctx.setCells([
          { row: R, col: C, value: "10" },
          { row: R, col: C + 1, value: "20" },
          { row: R, col: C + 2, value: `=${col0Letter}${rowRef}+${col1Letter}${rowRef}` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(R, C + 2);
        expectCellValue(cell, "30", "TestArea formula");
      },
    },
    {
      name: "Enter values in a range",
      description: "Fills a 3x3 area and verifies all cells.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        const updates = [];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            updates.push({ row: R + r, col: C + c, value: `R${r}C${c}` });
          }
        }
        await ctx.setCells(updates);
        await ctx.settle();

        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            const cell = await ctx.getCell(R + r, C + c);
            expectCellValue(cell, `R${r}C${c}`, `R${r}C${c}`);
          }
        }
      },
    },
    {
      name: "Clear cell contents",
      description: "Sets a value, then clears it, verifies empty.",
      run: async (ctx) => {
        const R = TEST_AREA.row;
        const C = TEST_AREA.col;
        await ctx.setCells([{ row: R, col: C, value: "ToBeCleared" }]);
        await ctx.settle();
        const before = await ctx.getCell(R, C);
        expectCellValue(before, "ToBeCleared", "TestArea");

        await ctx.setCells([{ row: R, col: C, value: "" }]);
        await ctx.settle();
        const after = await ctx.getCell(R, C);
        expectCellEmpty(after, "TestArea");
      },
    },
  ],
};
