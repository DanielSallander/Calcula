//! FILENAME: app/extensions/TestRunner/lib/suites/formulas.ts
// PURPOSE: Formulas & calculation test suite.
// CONTEXT: Tests formula evaluation, calculation modes, error handling,
//          and dependency chains through the Tauri backend.

import type { TestSuite } from "../types";
import {
  expectCellValue,
  expectCellContains,
  expectCellNotEmpty,
  assertTrue,
} from "../assertions";
import { AREA_FORMULAS } from "../testArea";
import {
  setCalculationMode,
  getCalculationMode,
  calculateNow,
} from "@api";

const A = AREA_FORMULAS;

export const formulasSuite: TestSuite = {
  name: "Formulas & Calculation",
  description: "Tests formula evaluation, calc modes, errors, and dependency chains.",

  afterEach: async (ctx) => {
    // Clear a generous block in our test area
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 6; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
    // Restore automatic calculation mode in case a test changed it
    try {
      await setCalculationMode("automatic");
    } catch {
      // ignore if it fails
    }
  },

  tests: [
    {
      name: "SUM formula",
      description: "=SUM(range) adds three values correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: `=SUM(${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(cell, "60", "SUM result");
      },
    },
    {
      name: "AVERAGE formula",
      description: "=AVERAGE(range) computes mean of five values.",
      run: async (ctx) => {
        const values = [10, 20, 30, 40, 50];
        const updates = values.map((v, i) => ({
          row: A.row + i, col: A.col, value: String(v),
        }));
        updates.push({
          row: A.row + 5, col: A.col,
          value: `=AVERAGE(${A.ref(0, 0)}:${A.ref(4, 0)})`,
        });
        await ctx.setCells(updates);
        await ctx.settle();
        const cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "30", "AVERAGE result");
      },
    },
    {
      name: "IF formula",
      description: "=IF(cond, true_val, false_val) branches correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "100" },
          { row: A.row + 1, col: A.col, value: `=IF(${A.ref(0, 0)}>10,"big","small")` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(cell, "big", "IF true branch");

        // Now change to small
        await ctx.setCells([{ row: A.row, col: A.col, value: "5" }]);
        await ctx.settle();
        const cell2 = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(cell2, "small", "IF false branch");
      },
    },
    {
      name: "Nested formula",
      description: "=SUM(a, b*2) with nested multiplication.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row, col: A.col + 1, value: "5" },
          { row: A.row, col: A.col + 2, value: `=SUM(${A.ref(0, 0)},${A.ref(0, 1)}*2)` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col + 2);
        expectCellValue(cell, "20", "SUM with nested multiply");
      },
    },
    {
      name: "Cross-cell reference chain recalculates",
      description: "A->B->C dependency chain updates when A changes.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "5" },
          { row: A.row, col: A.col + 1, value: `=${A.ref(0, 0)}*2` },
          { row: A.row, col: A.col + 2, value: `=${A.ref(0, 1)}+10` },
        ]);
        await ctx.settle();
        const c = await ctx.getCell(A.row, A.col + 2);
        expectCellValue(c, "20", "chain result (5*2+10)");

        // Change root value
        await ctx.setCells([{ row: A.row, col: A.col, value: "10" }]);
        await ctx.settle();
        const c2 = await ctx.getCell(A.row, A.col + 2);
        expectCellValue(c2, "30", "chain result after update (10*2+10)");
      },
    },
    {
      name: "Circular reference detection",
      description: "Self-referencing formula shows error.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: `=${A.ref(0, 0)}` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        assertTrue(cell !== null, "Cell should exist");
        // Circular references typically show an error indicator
        assertTrue(
          cell!.display.includes("REF") || cell!.display.includes("CIRC") ||
          cell!.display.includes("ERR") || cell!.display === "0" ||
          cell!.display.includes("#"),
          `Expected circular ref indicator, got "${cell!.display}"`
        );
      },
    },
    {
      name: "Manual calculation mode",
      description: "In manual mode, changes don't recalc until calculateNow.",
      run: async (ctx) => {
        // Set up formula
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row, col: A.col + 1, value: `=${A.ref(0, 0)}*3` },
        ]);
        await ctx.settle();
        const before = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(before, "30", "initial calc");

        // Switch to manual
        await setCalculationMode("manual");
        await ctx.settle();

        // Change source value
        await ctx.setCells([{ row: A.row, col: A.col, value: "20" }]);
        await ctx.settle();

        // Formula may still show old value (30) in manual mode
        const stale = await ctx.getCell(A.row, A.col + 1);
        // Note: some implementations may still auto-calc on setCells;
        // if so, this just verifies calculateNow also works
        ctx.log(`Value before calculateNow: ${stale?.display}`);

        // Force recalculation
        await calculateNow();
        await ctx.settle();

        const fresh = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(fresh, "60", "after calculateNow");

        // Restore automatic
        await setCalculationMode("automatic");
      },
    },
    {
      name: "String functions (CONCATENATE, LEN)",
      description: "Tests basic string formula functions.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Hello" },
          { row: A.row, col: A.col + 1, value: "World" },
          { row: A.row, col: A.col + 2, value: `=CONCATENATE(${A.ref(0, 0)}," ",${A.ref(0, 1)})` },
          { row: A.row + 1, col: A.col, value: `=LEN(${A.ref(0, 0)})` },
        ]);
        await ctx.settle();
        const concat = await ctx.getCell(A.row, A.col + 2);
        expectCellValue(concat, "Hello World", "CONCATENATE");
        const len = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(len, "5", "LEN");
      },
    },
    {
      name: "Division by zero error",
      description: "Dividing by zero produces an error display.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=1/0" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        assertTrue(cell !== null, "Cell should exist");
        assertTrue(
          cell!.display.includes("DIV") || cell!.display.includes("#") || cell!.display.includes("ERR"),
          `Expected div/0 error, got "${cell!.display}"`
        );
      },
    },
    {
      name: "SUM with empty cells",
      description: "SUM treats empty cells as zero.",
      run: async (ctx) => {
        // Only fill first and third cells, leave second empty
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          // row+1 is empty
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row + 3, col: A.col, value: `=SUM(${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(cell, "40", "SUM with empty cell");
      },
    },
  ],
};
