//! FILENAME: app/extensions/TestRunner/lib/suites/checkbox.ts
// PURPOSE: Tests for the Checkbox extension toggle behavior.
// CONTEXT: Verifies checkbox insert, toggle, and value persistence.

import type { TestSuite } from "../types";
import { expectCellValue } from "../assertions";
import { AREA_CHECKBOX } from "../testArea";

const A = AREA_CHECKBOX;

export const checkboxSuite: TestSuite = {
  name: "Checkbox",
  description: "Tests checkbox insert, toggle, and value behavior.",

  afterEach: async (ctx) => {
    // Clear test area and remove any checkbox formatting
    const updates = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        updates.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(updates);
    await ctx.settle();
    // Clear formatting that may include checkbox flag
    ctx.setSelection({
      startRow: A.row, startCol: A.col,
      endRow: A.row + 4, endCol: A.col + 2,
    });
    await ctx.settle();
    await ctx.executeCommand("core.edit.clearAll");
    await ctx.settle();
  },

  tests: [
    {
      name: "Insert checkbox initializes cell to FALSE",
      async run(ctx) {
        // Select a cell and insert checkbox
        ctx.setSelection({
          startRow: A.row, startCol: A.col,
          endRow: A.row, endCol: A.col,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("checkbox.insert");
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "FALSE", A.ref(0, 0));
      },
    },
    {
      name: "Toggle checkbox from FALSE to TRUE",
      async run(ctx) {
        // Set up a checkbox cell
        ctx.setSelection({
          startRow: A.row, startCol: A.col,
          endRow: A.row, endCol: A.col,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("checkbox.insert");
        await ctx.settle();

        // Verify initial state
        let cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "FALSE", A.ref(0, 0));

        // Toggle to TRUE
        await ctx.executeCommand("checkbox.toggle");
        await ctx.settle();

        cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "TRUE", A.ref(0, 0));
      },
    },
    {
      name: "Toggle checkbox from TRUE back to FALSE",
      async run(ctx) {
        ctx.setSelection({
          startRow: A.row, startCol: A.col,
          endRow: A.row, endCol: A.col,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("checkbox.insert");
        await ctx.settle();

        // Toggle to TRUE
        await ctx.executeCommand("checkbox.toggle");
        await ctx.settle();

        let cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "TRUE", A.ref(0, 0));

        // Toggle back to FALSE
        await ctx.executeCommand("checkbox.toggle");
        await ctx.settle();

        cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "FALSE", A.ref(0, 0));
      },
    },
    {
      name: "Multi-cell checkbox toggle uses active cell state",
      async run(ctx) {
        // Insert checkboxes in two cells
        ctx.setSelection({
          startRow: A.row, startCol: A.col,
          endRow: A.row + 1, endCol: A.col,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("checkbox.insert");
        await ctx.settle();

        // Both should be FALSE
        let cells = await ctx.getCells(A.row, A.col, A.row + 1, A.col);
        expectCellValue(cells.get(A.ref(0, 0))!, "FALSE", A.ref(0, 0));
        expectCellValue(cells.get(A.ref(1, 0))!, "FALSE", A.ref(1, 0));

        // Select both and toggle — should set all to TRUE
        ctx.setSelection({
          startRow: A.row, startCol: A.col,
          endRow: A.row + 1, endCol: A.col,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("checkbox.toggle");
        await ctx.settle();

        cells = await ctx.getCells(A.row, A.col, A.row + 1, A.col);
        expectCellValue(cells.get(A.ref(0, 0))!, "TRUE", A.ref(0, 0));
        expectCellValue(cells.get(A.ref(1, 0))!, "TRUE", A.ref(1, 0));
      },
    },
  ],
};
