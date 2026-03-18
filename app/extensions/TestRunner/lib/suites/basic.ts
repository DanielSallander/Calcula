//! FILENAME: app/extensions/TestRunner/lib/suites/basic.ts
// PURPOSE: Basic cell operation test suite.
// CONTEXT: Tests entering values, formulas, reading back, and clearing.

import type { TestSuite } from "../types";
import { expectCellValue, expectCellEmpty, expectCellFormula } from "../assertions";

export const basicSuite: TestSuite = {
  name: "Basic Cell Operations",
  description: "Tests cell value entry, formulas, and clearing.",

  afterEach: async (ctx) => {
    // Clean up by clearing the test area
    await ctx.setCells([
      { row: 0, col: 0, value: "" },
      { row: 0, col: 1, value: "" },
      { row: 0, col: 2, value: "" },
      { row: 1, col: 0, value: "" },
      { row: 1, col: 1, value: "" },
      { row: 1, col: 2, value: "" },
      { row: 2, col: 0, value: "" },
      { row: 2, col: 1, value: "" },
      { row: 2, col: 2, value: "" },
    ]);
    await ctx.settle();
  },

  tests: [
    {
      name: "Enter and read back a text value",
      description: "Sets a cell to 'Hello' and reads it back.",
      run: async (ctx) => {
        await ctx.setCells([{ row: 0, col: 0, value: "Hello" }]);
        await ctx.settle();
        const cell = await ctx.getCell(0, 0);
        expectCellValue(cell, "Hello", "A1");
      },
    },
    {
      name: "Enter and read back a numeric value",
      description: "Sets a cell to '42' and reads it back.",
      run: async (ctx) => {
        await ctx.setCells([{ row: 0, col: 0, value: "42" }]);
        await ctx.settle();
        const cell = await ctx.getCell(0, 0);
        expectCellValue(cell, "42", "A1");
      },
    },
    {
      name: "Enter a simple formula and verify result",
      description: "Sets =1+2 and verifies the computed value is 3.",
      run: async (ctx) => {
        await ctx.setCells([{ row: 0, col: 0, value: "=1+2" }]);
        await ctx.settle();
        const cell = await ctx.getCell(0, 0);
        expectCellValue(cell, "3", "A1");
        expectCellFormula(cell, "=1+2", "A1");
      },
    },
    {
      name: "Formula referencing other cells",
      description: "A1=10, B1=20, C1=A1+B1 should be 30.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: 0, col: 0, value: "10" },
          { row: 0, col: 1, value: "20" },
          { row: 0, col: 2, value: "=A1+B1" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(0, 2);
        expectCellValue(cell, "30", "C1");
      },
    },
    {
      name: "Enter values in a range",
      description: "Fills a 3x3 area and verifies all cells.",
      run: async (ctx) => {
        const updates = [];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            updates.push({ row: r, col: c, value: `R${r}C${c}` });
          }
        }
        await ctx.setCells(updates);
        await ctx.settle();

        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            const cell = await ctx.getCell(r, c);
            expectCellValue(cell, `R${r}C${c}`, `R${r}C${c}`);
          }
        }
      },
    },
    {
      name: "Clear cell contents",
      description: "Sets a value, then clears it, verifies empty.",
      run: async (ctx) => {
        await ctx.setCells([{ row: 0, col: 0, value: "ToBeCleared" }]);
        await ctx.settle();
        const before = await ctx.getCell(0, 0);
        expectCellValue(before, "ToBeCleared", "A1");

        await ctx.setCells([{ row: 0, col: 0, value: "" }]);
        await ctx.settle();
        const after = await ctx.getCell(0, 0);
        expectCellEmpty(after, "A1");
      },
    },
  ],
};
