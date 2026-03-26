//! FILENAME: app/extensions/TestRunner/lib/suites/lambda.ts
// PURPOSE: Test suite for LAMBDA and helper functions (MAP, REDUCE, SCAN, MAKEARRAY, BYROW, BYCOL).
// CONTEXT: Validates that the new LAMBDA paradigm works end-to-end through formula evaluation.

import type { TestSuite } from "../types";
import {
  expectCellValue,
  expectCellContains,
  assertTrue,
} from "../assertions";
import { AREA_LAMBDA } from "../testArea";

const A = AREA_LAMBDA;

export const lambdaSuite: TestSuite = {
  name: "LAMBDA & Helpers",
  description: "Tests LAMBDA, MAP, REDUCE, SCAN, MAKEARRAY, BYROW, BYCOL functions.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 8; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    // ====================================================================
    // LAMBDA basics
    // ====================================================================
    {
      name: "LAMBDA inline invocation",
      description: "LAMBDA(x, x+1)(10) returns 11.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=LAMBDA(x, x+1)(10)" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "11", "LAMBDA(x,x+1)(10)");
      },
    },
    {
      name: "LAMBDA multi-param",
      description: "LAMBDA(a, b, a*b)(3, 7) returns 21.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=LAMBDA(a, b, a*b)(3, 7)" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "21", "LAMBDA(a,b,a*b)(3,7)");
      },
    },
    {
      name: "LAMBDA with cell references",
      description: "LAMBDA that reads cell values as arguments.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "5" },
          { row: A.row, col: A.col + 1, value: "3" },
          { row: A.row, col: A.col + 2, value: `=LAMBDA(x, y, x^y)(${A.ref(0, 0)}, ${A.ref(0, 1)})` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col + 2);
        expectCellValue(cell, "125", "LAMBDA 5^3");
      },
    },
    {
      name: "LAMBDA no-param (thunk)",
      description: "LAMBDA with no parameters, just a body.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=LAMBDA(42)()" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "42", "LAMBDA thunk");
      },
    },

    // ====================================================================
    // LET + LAMBDA integration
    // ====================================================================
    {
      name: "LET with LAMBDA",
      description: "LET(double, LAMBDA(x, x*2), double(15)) returns 30.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=LET(double, LAMBDA(x, x*2), double(15))" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "30", "LET+LAMBDA double(15)");
      },
    },

    // ====================================================================
    // MAP
    // ====================================================================
    {
      name: "MAP basic",
      description: "MAP({1,2,3}, LAMBDA(x, x*10)) returns {10,20,30}.",
      run: async (ctx) => {
        // Put source data in a column
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: "2" },
          { row: A.row + 2, col: A.col, value: "3" },
          // MAP formula in adjacent column — should spill 3 rows
          { row: A.row, col: A.col + 1, value: `=MAP(${A.ref(0, 0)}:${A.ref(2, 0)}, LAMBDA(x, x*10))` },
        ]);
        await ctx.settle();
        const c0 = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(c0, "10", "MAP row 0");
        const c1 = await ctx.getCell(A.row + 1, A.col + 1);
        expectCellValue(c1, "20", "MAP row 1");
        const c2 = await ctx.getCell(A.row + 2, A.col + 1);
        expectCellValue(c2, "30", "MAP row 2");
      },
    },
    {
      name: "MAP with string operation",
      description: "MAP over text values with LAMBDA(x, LEN(x)).",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "hi" },
          { row: A.row + 1, col: A.col, value: "hello" },
          { row: A.row + 2, col: A.col, value: "hey" },
          { row: A.row, col: A.col + 1, value: `=MAP(${A.ref(0, 0)}:${A.ref(2, 0)}, LAMBDA(x, LEN(x)))` },
        ]);
        await ctx.settle();
        const c0 = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(c0, "2", "LEN(hi)");
        const c1 = await ctx.getCell(A.row + 1, A.col + 1);
        expectCellValue(c1, "5", "LEN(hello)");
        const c2 = await ctx.getCell(A.row + 2, A.col + 1);
        expectCellValue(c2, "3", "LEN(hey)");
      },
    },

    // ====================================================================
    // REDUCE
    // ====================================================================
    {
      name: "REDUCE sum accumulator",
      description: "REDUCE(0, {1,2,3,4}, LAMBDA(acc, x, acc+x)) returns 10.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: "2" },
          { row: A.row + 2, col: A.col, value: "3" },
          { row: A.row + 3, col: A.col, value: "4" },
          { row: A.row, col: A.col + 1, value: `=REDUCE(0, ${A.ref(0, 0)}:${A.ref(3, 0)}, LAMBDA(acc, x, acc+x))` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(cell, "10", "REDUCE sum");
      },
    },
    {
      name: "REDUCE product accumulator",
      description: "REDUCE(1, {2,3,4}, LAMBDA(acc, x, acc*x)) returns 24.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "2" },
          { row: A.row + 1, col: A.col, value: "3" },
          { row: A.row + 2, col: A.col, value: "4" },
          { row: A.row, col: A.col + 1, value: `=REDUCE(1, ${A.ref(0, 0)}:${A.ref(2, 0)}, LAMBDA(acc, x, acc*x))` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(cell, "24", "REDUCE product");
      },
    },

    // ====================================================================
    // SCAN
    // ====================================================================
    {
      name: "SCAN running total",
      description: "SCAN(0, {1,2,3}, LAMBDA(acc, x, acc+x)) returns {1,3,6}.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: "2" },
          { row: A.row + 2, col: A.col, value: "3" },
          { row: A.row, col: A.col + 1, value: `=SCAN(0, ${A.ref(0, 0)}:${A.ref(2, 0)}, LAMBDA(acc, x, acc+x))` },
        ]);
        await ctx.settle();
        const c0 = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(c0, "1", "SCAN row 0");
        const c1 = await ctx.getCell(A.row + 1, A.col + 1);
        expectCellValue(c1, "3", "SCAN row 1");
        const c2 = await ctx.getCell(A.row + 2, A.col + 1);
        expectCellValue(c2, "6", "SCAN row 2");
      },
    },

    // ====================================================================
    // MAKEARRAY
    // ====================================================================
    {
      name: "MAKEARRAY basic",
      description: "MAKEARRAY(3, 2, LAMBDA(r, c, r*10+c)) builds a 3x2 grid.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=MAKEARRAY(3, 2, LAMBDA(r, c, r*10+c))" },
        ]);
        await ctx.settle();
        // Row 1: (1,1)=11, (1,2)=12
        const c00 = await ctx.getCell(A.row, A.col);
        expectCellValue(c00, "11", "MAKEARRAY(1,1)");
        const c01 = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(c01, "12", "MAKEARRAY(1,2)");
        // Row 2: (2,1)=21, (2,2)=22
        const c10 = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(c10, "21", "MAKEARRAY(2,1)");
        const c11 = await ctx.getCell(A.row + 1, A.col + 1);
        expectCellValue(c11, "22", "MAKEARRAY(2,2)");
        // Row 3: (3,1)=31, (3,2)=32
        const c20 = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(c20, "31", "MAKEARRAY(3,1)");
        const c21 = await ctx.getCell(A.row + 2, A.col + 1);
        expectCellValue(c21, "32", "MAKEARRAY(3,2)");
      },
    },
    {
      name: "MAKEARRAY single cell",
      description: "MAKEARRAY(1, 1, LAMBDA(r, c, 99)) returns 99.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=MAKEARRAY(1, 1, LAMBDA(r, c, 99))" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "99", "MAKEARRAY 1x1");
      },
    },

    // ====================================================================
    // BYROW
    // ====================================================================
    {
      name: "BYROW with SUM",
      description: "BYROW over 3x2 grid, summing each row.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row,     col: A.col,     value: "1" },
          { row: A.row,     col: A.col + 1, value: "2" },
          { row: A.row + 1, col: A.col,     value: "3" },
          { row: A.row + 1, col: A.col + 1, value: "4" },
          { row: A.row + 2, col: A.col,     value: "5" },
          { row: A.row + 2, col: A.col + 1, value: "6" },
          // BYROW in col+2
          { row: A.row, col: A.col + 2, value: `=BYROW(${A.ref(0, 0)}:${A.ref(2, 1)}, LAMBDA(row, SUM(row)))` },
        ]);
        await ctx.settle();
        const c0 = await ctx.getCell(A.row, A.col + 2);
        expectCellValue(c0, "3", "BYROW SUM row 0");
        const c1 = await ctx.getCell(A.row + 1, A.col + 2);
        expectCellValue(c1, "7", "BYROW SUM row 1");
        const c2 = await ctx.getCell(A.row + 2, A.col + 2);
        expectCellValue(c2, "11", "BYROW SUM row 2");
      },
    },

    // ====================================================================
    // BYCOL
    // ====================================================================
    {
      name: "BYCOL with SUM",
      description: "BYCOL over 3x2 grid, summing each column.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row,     col: A.col,     value: "1" },
          { row: A.row,     col: A.col + 1, value: "2" },
          { row: A.row + 1, col: A.col,     value: "3" },
          { row: A.row + 1, col: A.col + 1, value: "4" },
          { row: A.row + 2, col: A.col,     value: "5" },
          { row: A.row + 2, col: A.col + 1, value: "6" },
          // BYCOL in row+3 — should produce 2 horizontal results
          { row: A.row + 3, col: A.col, value: `=BYCOL(${A.ref(0, 0)}:${A.ref(2, 1)}, LAMBDA(col, SUM(col)))` },
        ]);
        await ctx.settle();
        const c0 = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(c0, "9", "BYCOL SUM col 0");
        const c1 = await ctx.getCell(A.row + 3, A.col + 1);
        expectCellValue(c1, "12", "BYCOL SUM col 1");
      },
    },

    // ====================================================================
    // COLLECT integration (3D / List)
    // ====================================================================
    {
      name: "MAP with COLLECT returns List",
      description: "MAP result wrapped in COLLECT stays in a single cell.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: "30" },
          { row: A.row, col: A.col + 1, value: `=COLLECT(MAP(${A.ref(0, 0)}:${A.ref(2, 0)}, LAMBDA(x, x*2)))` },
        ]);
        await ctx.settle();
        // COLLECT wraps the array into a List — should show in a single cell
        const cell = await ctx.getCell(A.row, A.col + 1);
        assertTrue(cell !== null, "COLLECT(MAP) cell should exist");
        expectCellContains(cell, "List", "COLLECT(MAP) should display as List");
        // The cell below should be empty (not spilled)
        const below = await ctx.getCell(A.row + 1, A.col + 1);
        assertTrue(
          below === null || below.display === "",
          "COLLECT prevents spill — cell below should be empty"
        );
      },
    },

    // ====================================================================
    // Edge cases / error handling
    // ====================================================================
    {
      name: "LAMBDA arity mismatch",
      description: "Calling a 2-param LAMBDA with 1 argument returns error.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=LAMBDA(a, b, a+b)(5)" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        assertTrue(cell !== null, "Cell should exist");
        assertTrue(
          cell!.display.includes("#") || cell!.display.includes("ERR") || cell!.display.includes("VALUE"),
          `Expected error for arity mismatch, got "${cell!.display}"`
        );
      },
    },
    {
      name: "Nested LAMBDA",
      description: "LAMBDA returning another LAMBDA (currying).",
      run: async (ctx) => {
        // add = LAMBDA(a, LAMBDA(b, a+b)); add(3)(4) = 7
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=LAMBDA(a, LAMBDA(b, a+b))(3)(4)" },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "7", "Curried LAMBDA 3+4");
      },
    },
    {
      name: "LAMBDA with IF branching",
      description: "LAMBDA using IF internally for conditional logic.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: "-2" },
          { row: A.row + 2, col: A.col, value: "3" },
          // MAP with absolute value via IF
          { row: A.row, col: A.col + 1, value: `=MAP(${A.ref(0, 0)}:${A.ref(2, 0)}, LAMBDA(x, IF(x<0, -x, x)))` },
        ]);
        await ctx.settle();
        const c0 = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(c0, "1", "abs(1)");
        const c1 = await ctx.getCell(A.row + 1, A.col + 1);
        expectCellValue(c1, "2", "abs(-2)");
        const c2 = await ctx.getCell(A.row + 2, A.col + 1);
        expectCellValue(c2, "3", "abs(3)");
      },
    },
    {
      name: "REDUCE with string concatenation",
      description: "REDUCE to build a string from numbers.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: "2" },
          { row: A.row + 2, col: A.col, value: "3" },
          { row: A.row, col: A.col + 1, value: `=REDUCE("", ${A.ref(0, 0)}:${A.ref(2, 0)}, LAMBDA(acc, x, CONCATENATE(acc, x)))` },
        ]);
        await ctx.settle();
        const cell = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(cell, "123", "REDUCE concat");
      },
    },
    {
      name: "MAKEARRAY with formula body",
      description: "MAKEARRAY(2, 2, LAMBDA(r, c, r+c)) produces addition table.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=MAKEARRAY(2, 2, LAMBDA(r, c, r+c))" },
        ]);
        await ctx.settle();
        const c00 = await ctx.getCell(A.row, A.col);
        expectCellValue(c00, "2", "(1+1)");
        const c01 = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(c01, "3", "(1+2)");
        const c10 = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(c10, "3", "(2+1)");
        const c11 = await ctx.getCell(A.row + 1, A.col + 1);
        expectCellValue(c11, "4", "(2+2)");
      },
    },
    {
      name: "LAMBDA recalculates on dependency change",
      description: "MAP formula updates when source data changes.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row, col: A.col + 1, value: `=MAP(${A.ref(0, 0)}:${A.ref(1, 0)}, LAMBDA(x, x+1))` },
        ]);
        await ctx.settle();
        const c0 = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(c0, "11", "MAP initial row 0");

        // Change source data
        await ctx.setCells([
          { row: A.row, col: A.col, value: "100" },
        ]);
        await ctx.settle();
        const c0b = await ctx.getCell(A.row, A.col + 1);
        expectCellValue(c0b, "101", "MAP after update row 0");
      },
    },
  ],
};
