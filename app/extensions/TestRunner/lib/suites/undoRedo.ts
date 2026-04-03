//! FILENAME: app/extensions/TestRunner/lib/suites/undoRedo.ts
// PURPOSE: Undo/Redo test suite.
// CONTEXT: Tests multi-step undo, redo, batch undo, and redo invalidation.
//          Uses ctx.undo() which calls the Tauri backend directly.

import type { TestSuite } from "../types";
import { expectCellValue, expectCellEmpty, assertTrue } from "../assertions";
import { AREA_UNDO_REDO } from "../testArea";
import { redo as tauriRedo } from "@api";

const A = AREA_UNDO_REDO;

export const undoRedoSuite: TestSuite = {
  name: "Undo / Redo",
  description: "Tests multi-step undo, redo, batch undo, and redo invalidation.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Undo single edit",
      description: "Set a value, undo, verify cell is empty.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "" }]);
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "One" }]);
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row, A.col), "One", "before undo");

        await ctx.undo();
        await ctx.settle();
        expectCellEmpty(await ctx.getCell(A.row, A.col), "after undo");
      },
    },
    {
      name: "Redo after undo",
      description: "Set, undo, redo — value restored.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "" }]);
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "RedoMe" }]);
        await ctx.settle();

        await ctx.undo();
        await ctx.settle();
        expectCellEmpty(await ctx.getCell(A.row, A.col), "after undo");

        await tauriRedo();
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row, A.col), "RedoMe", "after redo");
      },
    },
    {
      name: "Multiple undo steps",
      description: "Three edits, undo all three.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "" }]);
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "First" }]);
        await ctx.settle();
        await ctx.setCells([{ row: A.row, col: A.col, value: "Second" }]);
        await ctx.settle();
        await ctx.setCells([{ row: A.row, col: A.col, value: "Third" }]);
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row, A.col), "Third", "after 3 edits");

        await ctx.undo();
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row, A.col), "Second", "after 1st undo");

        await ctx.undo();
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row, A.col), "First", "after 2nd undo");

        await ctx.undo();
        await ctx.settle();
        expectCellEmpty(await ctx.getCell(A.row, A.col), "after 3rd undo");
      },
    },
    {
      name: "Undo batch operation",
      description: "setCells with multiple cells, single undo clears all.",
      run: async (ctx) => {
        // Ensure clean
        await ctx.setCells([
          { row: A.row, col: A.col, value: "" },
          { row: A.row, col: A.col + 1, value: "" },
          { row: A.row, col: A.col + 2, value: "" },
        ]);
        await ctx.settle();

        // Batch write
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row, col: A.col + 1, value: "B" },
          { row: A.row, col: A.col + 2, value: "C" },
        ]);
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row, A.col), "A", "batch cell 0");
        expectCellValue(await ctx.getCell(A.row, A.col + 1), "B", "batch cell 1");

        // Single undo should revert the entire batch
        await ctx.undo();
        await ctx.settle();
        expectCellEmpty(await ctx.getCell(A.row, A.col), "batch cell 0 after undo");
        expectCellEmpty(await ctx.getCell(A.row, A.col + 1), "batch cell 1 after undo");
        expectCellEmpty(await ctx.getCell(A.row, A.col + 2), "batch cell 2 after undo");
      },
    },
    {
      name: "New edit invalidates redo stack",
      description: "Set A, set B, undo, set C — redo does nothing (C stays).",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "" }]);
        await ctx.settle();

        await ctx.setCells([{ row: A.row, col: A.col, value: "A" }]);
        await ctx.settle();
        await ctx.setCells([{ row: A.row, col: A.col, value: "B" }]);
        await ctx.settle();

        // Undo B -> A
        await ctx.undo();
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row, A.col), "A", "after undo B");

        // New edit C — this should invalidate the redo stack
        await ctx.setCells([{ row: A.row, col: A.col, value: "C" }]);
        await ctx.settle();

        // Redo should have no effect — redo stack was cleared
        await tauriRedo();
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row, A.col), "C", "after redo (should stay C)");
      },
    },
  ],
};
