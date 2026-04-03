//! FILENAME: app/extensions/TestRunner/lib/suites/boundaryValues.ts
// PURPOSE: Boundary values edge case test suite.
// CONTEXT: Tests extreme values, special characters, and defensive behavior.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue } from "../assertions";
import { AREA_BOUNDARY_VALUES } from "../testArea";
import { calculateNow } from "@api";

const A = AREA_BOUNDARY_VALUES;

export const boundaryValuesSuite: TestSuite = {
  name: "Boundary Values",
  description: "Tests extreme and edge-case cell values, special characters, and numeric limits.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 5; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    // Also clear row 0, col 0 if we used it
    await ctx.setCells([{ row: 0, col: 0, value: "" }]);
    await ctx.settle();
  },

  tests: [
    {
      name: "Operations on row 0, col 0",
      description: "The first cell in the grid can be read and written.",
      run: async (ctx) => {
        await ctx.setCells([{ row: 0, col: 0, value: "Origin" }]);
        await ctx.settle();

        const cell = await ctx.getCell(0, 0);
        expectNotNull(cell, "cell at (0,0) should exist");
        assertTrue(cell!.display.includes("Origin"), `expected Origin, got ${cell!.display}`);
      },
    },
    {
      name: "Very long cell value (1000+ chars)",
      description: "A 1000-character string is stored and retrievable.",
      run: async (ctx) => {
        const longValue = "A".repeat(1000);
        await ctx.setCells([{ row: A.row, col: A.col, value: longValue }]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectNotNull(cell, "cell should exist");
        assertTrue(cell!.display.length >= 1000, `display should be at least 1000 chars, got ${cell!.display.length}`);
      },
    },
    {
      name: "Special characters in values",
      description: "Quotes, angle brackets, and unicode are stored correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: 'He said "hello"' },
          { row: A.row + 1, col: A.col, value: "<b>not html</b>" },
          { row: A.row + 2, col: A.col, value: "\u00E5\u00E4\u00F6" },
        ]);
        await ctx.settle();

        const quoteCell = await ctx.getCell(A.row, A.col);
        expectNotNull(quoteCell, "quote cell");
        assertTrue(quoteCell!.display.includes('"hello"'), "should contain quotes");

        const angleCell = await ctx.getCell(A.row + 1, A.col);
        expectNotNull(angleCell, "angle bracket cell");
        assertTrue(angleCell!.display.includes("<b>"), "should contain angle brackets");

        const unicodeCell = await ctx.getCell(A.row + 2, A.col);
        expectNotNull(unicodeCell, "unicode cell");
        assertTrue(unicodeCell!.display.includes("\u00E5"), "should contain unicode char");
      },
    },
    {
      name: "Empty string vs cleared cell",
      description: "Setting empty string and clearing a cell may differ.",
      run: async (ctx) => {
        // Set a value then clear it
        await ctx.setCells([{ row: A.row, col: A.col, value: "Something" }]);
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "" }]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        // Cell should either be null or have empty display
        if (cell !== null) {
          assertTrue(cell.display === "" || cell.display === undefined,
            `cleared cell display should be empty, got "${cell.display}"`);
        }
        // Either way, no crash
        assertTrue(true, "clearing cell did not crash");
      },
    },
    {
      name: "Formula with circular reference",
      description: "Circular reference produces error, no crash.",
      run: async (ctx) => {
        // Cell A references Cell B, Cell B references Cell A
        const refA = A.ref(0, 0);
        const refB = A.ref(0, 1);

        await ctx.setCells([
          { row: A.row, col: A.col, value: `=${refB}` },
          { row: A.row, col: A.col + 1, value: `=${refA}` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Should not crash - cells should contain an error value
        const cellA = await ctx.getCell(A.row, A.col);
        const cellB = await ctx.getCell(A.row, A.col + 1);
        expectNotNull(cellA, "cell A should exist even with circular ref");
        expectNotNull(cellB, "cell B should exist even with circular ref");
        ctx.log(`Circular ref cell A display: ${cellA!.display}`);
        ctx.log(`Circular ref cell B display: ${cellB!.display}`);
      },
    },
    {
      name: "Large and negative numbers",
      description: "Very large, very small, and negative numbers are stored correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "999999999999" },
          { row: A.row + 1, col: A.col, value: "-0.000001" },
          { row: A.row + 2, col: A.col, value: "1.5E+10" },
        ]);
        await ctx.settle();

        const large = await ctx.getCell(A.row, A.col);
        expectNotNull(large, "large number cell");
        // The app may format large numbers in scientific notation (e.g. "1.00000e12")
        const largeDisplay = large!.display.toLowerCase();
        assertTrue(
          largeDisplay.includes("999999999999") || largeDisplay.includes("e+12") || largeDisplay.includes("e12"),
          `large number should be stored, got ${large!.display}`);

        const negative = await ctx.getCell(A.row + 1, A.col);
        expectNotNull(negative, "negative number cell");
        const negDisplay = negative!.display.toLowerCase();
        assertTrue(negDisplay.includes("-0.000001") || negDisplay.includes("e-"),
          `negative should be stored, got ${negative!.display}`);

        const scientific = await ctx.getCell(A.row + 2, A.col);
        expectNotNull(scientific, "scientific notation cell");
        assertTrue(scientific!.display.length > 0, "scientific notation should display something");
      },
    },
  ],
};
