//! FILENAME: app/extensions/TestRunner/lib/suites/flashFill.ts
// PURPOSE: Tests for the Flash Fill extension pattern detection and filling.
// CONTEXT: Verifies flashfill.execute detects patterns from examples and fills cells.

import type { TestSuite } from "../types";
import { expectCellValue, expectCellEmpty } from "../assertions";
import { AREA_FLASH_FILL } from "../testArea";

const A = AREA_FLASH_FILL;

export const flashFillSuite: TestSuite = {
  name: "Flash Fill",
  description: "Tests Flash Fill pattern detection and auto-fill.",

  afterEach: async (ctx) => {
    const updates = [];
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 4; c++) {
        updates.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(updates);
    await ctx.settle();
  },

  tests: [
    {
      name: "Extract first name from full name",
      async run(ctx) {
        // Source data in col 0: full names
        await ctx.setCells([
          { row: A.row, col: A.col, value: "John Smith" },
          { row: A.row + 1, col: A.col, value: "Jane Doe" },
          { row: A.row + 2, col: A.col, value: "Bob Wilson" },
          { row: A.row + 3, col: A.col, value: "Alice Brown" },
          // Example in col 1: first name only
          { row: A.row, col: A.col + 1, value: "John" },
        ]);
        await ctx.settle();

        // Select target column cell and run flash fill
        ctx.setSelection({
          startRow: A.row, startCol: A.col + 1,
          endRow: A.row, endCol: A.col + 1,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("flashfill.execute");
        await ctx.settle();

        // Verify filled cells
        const cells = await ctx.getCells(A.row, A.col + 1, A.row + 3, A.col + 1);
        expectCellValue(cells.get(A.ref(1, 1))!, "Jane", A.ref(1, 1));
        expectCellValue(cells.get(A.ref(2, 1))!, "Bob", A.ref(2, 1));
        expectCellValue(cells.get(A.ref(3, 1))!, "Alice", A.ref(3, 1));
      },
    },
    {
      name: "Extract last name from full name",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "John Smith" },
          { row: A.row + 1, col: A.col, value: "Jane Doe" },
          { row: A.row + 2, col: A.col, value: "Bob Wilson" },
          // Example: last name
          { row: A.row, col: A.col + 1, value: "Smith" },
        ]);
        await ctx.settle();

        ctx.setSelection({
          startRow: A.row, startCol: A.col + 1,
          endRow: A.row, endCol: A.col + 1,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("flashfill.execute");
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col + 1, A.row + 2, A.col + 1);
        expectCellValue(cells.get(A.ref(1, 1))!, "Doe", A.ref(1, 1));
        expectCellValue(cells.get(A.ref(2, 1))!, "Wilson", A.ref(2, 1));
      },
    },
    {
      name: "Uppercase transformation",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "hello" },
          { row: A.row + 1, col: A.col, value: "world" },
          { row: A.row + 2, col: A.col, value: "test" },
          // Example: uppercase
          { row: A.row, col: A.col + 1, value: "HELLO" },
        ]);
        await ctx.settle();

        ctx.setSelection({
          startRow: A.row, startCol: A.col + 1,
          endRow: A.row, endCol: A.col + 1,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("flashfill.execute");
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col + 1, A.row + 2, A.col + 1);
        expectCellValue(cells.get(A.ref(1, 1))!, "WORLD", A.ref(1, 1));
        expectCellValue(cells.get(A.ref(2, 1))!, "TEST", A.ref(2, 1));
      },
    },
    {
      name: "Delimiter-based extraction (email to domain)",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "user@example.com" },
          { row: A.row + 1, col: A.col, value: "admin@test.org" },
          { row: A.row + 2, col: A.col, value: "info@company.net" },
          // Example: domain part
          { row: A.row, col: A.col + 1, value: "example.com" },
        ]);
        await ctx.settle();

        ctx.setSelection({
          startRow: A.row, startCol: A.col + 1,
          endRow: A.row, endCol: A.col + 1,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("flashfill.execute");
        await ctx.settle();

        const cells = await ctx.getCells(A.row, A.col + 1, A.row + 2, A.col + 1);
        expectCellValue(cells.get(A.ref(1, 1))!, "test.org", A.ref(1, 1));
        expectCellValue(cells.get(A.ref(2, 1))!, "company.net", A.ref(2, 1));
      },
    },
    {
      name: "Flash fill preserves existing values in target",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Alpha" },
          { row: A.row + 1, col: A.col, value: "Beta" },
          { row: A.row + 2, col: A.col, value: "Gamma" },
          // Example in row 0, manually filled in row 1
          { row: A.row, col: A.col + 1, value: "ALPHA" },
          { row: A.row + 1, col: A.col + 1, value: "BETA" },
        ]);
        await ctx.settle();

        ctx.setSelection({
          startRow: A.row + 1, startCol: A.col + 1,
          endRow: A.row + 1, endCol: A.col + 1,
        });
        await ctx.settle();
        await ctx.settle();

        await ctx.executeCommand("flashfill.execute");
        await ctx.settle();

        // Row 1 should keep its existing value, row 2 should be filled
        const cells = await ctx.getCells(A.row, A.col + 1, A.row + 2, A.col + 1);
        expectCellValue(cells.get(A.ref(0, 1))!, "ALPHA", A.ref(0, 1));
        expectCellValue(cells.get(A.ref(1, 1))!, "BETA", A.ref(1, 1));
        expectCellValue(cells.get(A.ref(2, 1))!, "GAMMA", A.ref(2, 1));
      },
    },
  ],
};
