//! FILENAME: app/extensions/TestRunner/lib/suites/rowCol.ts
// PURPOSE: Row & column operations test suite.
// CONTEXT: Tests insert/delete rows/columns, custom dimensions,
//          and formula reference shifting.

import type { TestSuite } from "../types";
import {
  expectCellValue,
  expectCellEmpty,
  assertTrue,
  assertEqual,
} from "../assertions";
import { AREA_ROW_COL } from "../testArea";
import {
  insertRows,
  insertColumns,
  deleteRows,
  deleteColumns,
  getColumnWidth,
  getRowHeight,
} from "@api";
// Import set functions from api/lib (the barrel's setColumnWidth is a grid action creator,
// but api/lib re-exports the actual Tauri commands from tauri-api)
import {
  setColumnWidth,
  setRowHeight,
} from "@api/lib";

const A = AREA_ROW_COL;

export const rowColSuite: TestSuite = {
  name: "Row & Column Operations",
  description: "Tests insert/delete rows/cols, dimensions, and formula shift.",

  afterEach: async (ctx) => {
    // Clear test area
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 6; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Insert row shifts data down",
      description: "Cell below insert point moves down by one row.",
      run: async (ctx) => {
        // Place a value at our test row
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Above" },
          { row: A.row + 1, col: A.col, value: "Below" },
        ]);
        await ctx.settle();

        // Insert a row at A.row + 1 (pushes "Below" down)
        await insertRows(A.row + 1, 1);
        await ctx.settle();

        // "Above" stays at A.row
        expectCellValue(await ctx.getCell(A.row, A.col), "Above", "row above insert");
        // The inserted row should be empty
        expectCellEmpty(await ctx.getCell(A.row + 1, A.col), "inserted row");
        // "Below" moved to A.row + 2
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "Below", "shifted row");

        // Clean up: delete the inserted row
        await deleteRows(A.row + 1, 1);
        await ctx.settle();
      },
    },
    {
      name: "Insert column shifts data right",
      description: "Cell to the right of insert moves right by one column.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Left" },
          { row: A.row, col: A.col + 1, value: "Right" },
        ]);
        await ctx.settle();

        // Insert a column at A.col + 1 (pushes "Right" right)
        await insertColumns(A.col + 1, 1);
        await ctx.settle();

        expectCellValue(await ctx.getCell(A.row, A.col), "Left", "col left of insert");
        expectCellEmpty(await ctx.getCell(A.row, A.col + 1), "inserted col");
        expectCellValue(await ctx.getCell(A.row, A.col + 2), "Right", "shifted col");

        // Clean up
        await deleteColumns(A.col + 1, 1);
        await ctx.settle();
      },
    },
    {
      name: "Delete row shifts data up",
      description: "Cell below deletion moves up.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Keep" },
          { row: A.row + 1, col: A.col, value: "Delete" },
          { row: A.row + 2, col: A.col, value: "Moves" },
        ]);
        await ctx.settle();

        // Delete the middle row
        await deleteRows(A.row + 1, 1);
        await ctx.settle();

        expectCellValue(await ctx.getCell(A.row, A.col), "Keep", "row above delete");
        expectCellValue(await ctx.getCell(A.row + 1, A.col), "Moves", "shifted up");

        // Restore: insert the row back to keep row count stable
        await insertRows(A.row + 1, 1);
        await ctx.settle();
      },
    },
    {
      name: "Delete column shifts data left",
      description: "Cell to the right of deletion moves left.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Keep" },
          { row: A.row, col: A.col + 1, value: "Delete" },
          { row: A.row, col: A.col + 2, value: "Moves" },
        ]);
        await ctx.settle();

        await deleteColumns(A.col + 1, 1);
        await ctx.settle();

        expectCellValue(await ctx.getCell(A.row, A.col), "Keep", "col left of delete");
        expectCellValue(await ctx.getCell(A.row, A.col + 1), "Moves", "shifted left");

        // Restore
        await insertColumns(A.col + 1, 1);
        await ctx.settle();
      },
    },
    {
      name: "Set and get column width",
      description: "Custom column width persists.",
      run: async (ctx) => {
        await setColumnWidth(A.col, 200);
        await ctx.settle();

        const width = await getColumnWidth(A.col);
        assertTrue(width !== null, "Width should not be null");
        assertEqual(width!, 200, "custom column width");

        // Reset to default (null means "use default")
        await setColumnWidth(A.col, 100);
        await ctx.settle();
      },
    },
    {
      name: "Set and get row height",
      description: "Custom row height persists.",
      run: async (ctx) => {
        await setRowHeight(A.row, 50);
        await ctx.settle();

        const height = await getRowHeight(A.row);
        assertTrue(height !== null, "Height should not be null");
        assertEqual(height!, 50, "custom row height");

        // Reset
        await setRowHeight(A.row, 25);
        await ctx.settle();
      },
    },
    {
      name: "Insert row preserves formula references",
      description: "Formula references shift when rows are inserted above.",
      run: async (ctx) => {
        // Set up: value in row, formula referencing it two rows below
        await ctx.setCells([
          { row: A.row, col: A.col, value: "42" },
          { row: A.row + 2, col: A.col, value: `=${A.ref(0, 0)}*2` },
        ]);
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row + 2, A.col), "84", "formula before insert");

        // Insert a row between value and formula
        await insertRows(A.row + 1, 1);
        await ctx.settle();

        // Formula should now be at row+3 and still reference the value
        const shifted = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(shifted, "84", "formula after row insert (shifted down)");

        // Clean up
        await deleteRows(A.row + 1, 1);
        await ctx.settle();
      },
    },
  ],
};
