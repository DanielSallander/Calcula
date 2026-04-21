//! FILENAME: app/extensions/TestRunner/lib/suites/mockData.ts
// PURPOSE: Test suite that verifies mock data is loaded correctly.
// CONTEXT: Runs when app is started with VITE_LOAD_MOCK_DATA=true (yarn tauri:dev:data).
//          Tests read-only operations against the known CSV data structure.

import type { TestSuite } from "../types";
import { expectCellValue, assertTrue, assertEqual } from "../assertions";

/**
 * Mock data structure (from mockData.csv.ts):
 * Row 0: Headers - first_name, last_name, gender, city, sales
 * Row 1+: Data rows - Swedish names, cities, sales numbers
 *
 * First data row: Erik, Johansson, Male, Stockholm, 452
 */
export const mockDataSuite: TestSuite = {
  name: "Mock Data Verification",
  description: "Verifies the prefilled mock data is loaded correctly (requires yarn tauri:dev:data).",

  // Wait for mock data to be loaded (it loads with a delay after mount)
  beforeEach: async (ctx) => {
    const maxWait = 5000;
    const interval = 100;
    let waited = 0;
    while (waited < maxWait) {
      const cell = await ctx.getCell(0, 0);
      if (cell && cell.display && cell.display !== "") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;
    }
  },

  tests: [
    {
      name: "Header row contains expected columns",
      description: "Verifies the CSV headers are in row 0.",
      run: async (ctx) => {
        const headers = ["first_name", "last_name", "gender", "city", "sales"];
        for (let col = 0; col < headers.length; col++) {
          const cell = await ctx.getCell(0, col);
          expectCellValue(cell, headers[col], `Row0Col${col}`);
        }
      },
    },
    {
      name: "First data row has expected values",
      description: "Checks row 1 (Erik, Johansson, Male, Stockholm, 452).",
      run: async (ctx) => {
        const expected = ["Erik", "Johansson", "Male", "Stockholm", "452"];
        for (let col = 0; col < expected.length; col++) {
          const cell = await ctx.getCell(1, col);
          expectCellValue(cell, expected[col], `Row1Col${col}`);
        }
      },
    },
    {
      name: "Data has multiple rows",
      description: "Verifies several rows exist beyond the header.",
      run: async (ctx) => {
        // Check row 10 exists (should be within the dataset)
        const cell = await ctx.getCell(10, 0);
        assertTrue(cell !== null && cell.display !== "", "Row 10 should have data");
      },
    },
    {
      name: "Sales column contains numeric values",
      description: "Verifies the sales column (col 4) has numeric data.",
      run: async (ctx) => {
        for (let row = 1; row <= 5; row++) {
          const cell = await ctx.getCell(row, 4);
          assertTrue(cell !== null, `Cell at row ${row}, col 4 should exist`);
          const num = Number(cell!.display);
          assertTrue(!isNaN(num), `Sales value at row ${row} should be numeric, got "${cell!.display}"`);
          assertTrue(num > 0, `Sales value at row ${row} should be positive`);
        }
      },
    },
    {
      name: "Gender column has valid values",
      description: "Verifies gender column contains only Male or Female.",
      run: async (ctx) => {
        const validGenders = ["Male", "Female"];
        for (let row = 1; row <= 10; row++) {
          const cell = await ctx.getCell(row, 2);
          assertTrue(cell !== null, `Gender cell at row ${row} should exist`);
          assertTrue(
            validGenders.includes(cell!.display),
            `Gender at row ${row}: expected Male/Female, got "${cell!.display}"`
          );
        }
      },
    },
    {
      name: "Formula on mock data works",
      description: "Writes a SUM formula on the sales column and verifies it computes.",
      tags: ["write"],
      run: async (ctx) => {
        // Write a SUM formula in an empty area (row 0, col 7 = H1)
        await ctx.setCells([{ row: 0, col: 7, value: "=E2+E3" }]);
        await ctx.settle();

        const cell = await ctx.getCell(0, 7);
        assertTrue(cell !== null, "Formula cell should exist");
        // E2=452 (Erik Johansson), E3=819 (Erik Andersson) => 1271
        assertEqual(cell!.display, "1271", "SUM of E2+E3");

        // Clean up
        await ctx.setCells([{ row: 0, col: 7, value: "" }]);
        await ctx.settle();
      },
    },
  ],
};
