//! FILENAME: app/extensions/TestRunner/lib/suites/utilities.ts
// PURPOSE: Utility functions test suite.
// CONTEXT: Tests grid bounds, cell count, data region detection, column index
//          conversion, cell collection, content checks, undo state, etc.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_UTILITIES } from "../testArea";
import { indexToCol, colToIndex, detectDataRegion } from "../../../../src/api";
import {
  getGridBounds,
  getCellCount,
  getCellCollection,
  getCollectionTexts,
  getUndoState,
  countMatches,
  getStyleCount,
  getAllColumnWidths,
  getAllRowHeights,
} from "../../../../src/api/lib";

const A = AREA_UTILITIES;

export const utilitiesSuite: TestSuite = {
  name: "Utility Functions",
  description: "Tests grid info, column conversion, data region detection, and misc utilities.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 5; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "indexToCol converts column index to letter",
      description: "0=A, 25=Z, 26=AA, etc.",
      run: async () => {
        assertEqual(indexToCol(0), "A", "0 -> A");
        assertEqual(indexToCol(1), "B", "1 -> B");
        assertEqual(indexToCol(25), "Z", "25 -> Z");
        assertEqual(indexToCol(26), "AA", "26 -> AA");
        assertEqual(indexToCol(27), "AB", "27 -> AB");
        assertEqual(indexToCol(701), "ZZ", "701 -> ZZ");
      },
    },
    {
      name: "colToIndex converts letter to column index",
      description: "A=0, Z=25, AA=26, etc.",
      run: async () => {
        assertEqual(colToIndex("A"), 0, "A -> 0");
        assertEqual(colToIndex("B"), 1, "B -> 1");
        assertEqual(colToIndex("Z"), 25, "Z -> 25");
        assertEqual(colToIndex("AA"), 26, "AA -> 26");
        assertEqual(colToIndex("AB"), 27, "AB -> 27");
      },
    },
    {
      name: "getGridBounds returns valid bounds",
      description: "Grid bounds are non-negative dimensions.",
      run: async () => {
        const bounds = await getGridBounds();
        assertTrue(Array.isArray(bounds), "should return array");
        assertTrue(bounds[0] >= 0, "rows >= 0");
        assertTrue(bounds[1] >= 0, "cols >= 0");
      },
    },
    {
      name: "getCellCount returns count",
      description: "Cell count is non-negative.",
      run: async () => {
        const count = await getCellCount();
        assertTrue(typeof count === "number", "should be a number");
        assertTrue(count >= 0, "count >= 0");
      },
    },
    {
      name: "detectDataRegion finds contiguous data",
      description: "Returns bounding rectangle of filled cells.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row, col: A.col + 1, value: "B" },
          { row: A.row + 1, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col + 1, value: "2" },
          { row: A.row + 2, col: A.col, value: "3" },
          { row: A.row + 2, col: A.col + 1, value: "4" },
        ]);
        await ctx.settle();

        const region = await detectDataRegion(A.row, A.col);
        expectNotNull(region, "should detect a region");
        // Region should at least contain our data
        assertTrue(region![0] <= A.row, "startRow <= our first row");
        assertTrue(region![2] >= A.row + 2, "endRow >= our last row");
        assertTrue(region![1] <= A.col, "startCol <= our first col");
        assertTrue(region![3] >= A.col + 1, "endCol >= our last col");
      },
    },
    {
      name: "getCellCollection returns cell data",
      description: "getCellCollection retrieves collection preview for a cell.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Hello" }]);
        await ctx.settle();

        const collection = await getCellCollection(A.row, A.col);
        assertTrue(collection !== null, "should return a collection result");
      },
    },
    {
      name: "getUndoState returns valid state",
      description: "Undo state has canUndo and canRedo flags.",
      run: async () => {
        const state = await getUndoState();
        assertTrue(typeof state.canUndo === "boolean", "canUndo should be boolean");
        assertTrue(typeof state.canRedo === "boolean", "canRedo should be boolean");
      },
    },
    {
      name: "countMatches counts search hits",
      description: "countMatches returns correct number of matches.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "apple" },
          { row: A.row + 1, col: A.col, value: "banana" },
          { row: A.row + 2, col: A.col, value: "apple pie" },
        ]);
        await ctx.settle();

        const count = await countMatches("apple");
        assertTrue(count >= 2, `should find at least 2 matches, found ${count}`);
      },
    },
    {
      name: "getStyleCount returns positive count",
      description: "At least one style (the default) should exist.",
      run: async () => {
        const count = await getStyleCount();
        assertTrue(count >= 1, `should have at least 1 style, got ${count}`);
      },
    },
    {
      name: "getAllColumnWidths and getAllRowHeights",
      description: "Returns arrays of custom dimension overrides.",
      run: async () => {
        const colWidths = await getAllColumnWidths();
        assertTrue(Array.isArray(colWidths), "column widths should be array");

        const rowHeights = await getAllRowHeights();
        assertTrue(Array.isArray(rowHeights), "row heights should be array");
      },
    },
  ],
};
