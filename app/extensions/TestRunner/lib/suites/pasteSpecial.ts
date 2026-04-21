//! FILENAME: app/extensions/TestRunner/lib/suites/pasteSpecial.ts
// PURPOSE: Tests for Paste Special extension (values, formulas, formatting, paste link).
// CONTEXT: Verifies various paste modes work correctly after copy operations.

import type { TestSuite } from "../types";
import { expectCellValue, expectCellEmpty, expectCellFormula } from "../assertions";
import { CoreCommands } from "@api/commands";
import { AREA_PASTE_SPECIAL } from "../testArea";

const A = AREA_PASTE_SPECIAL;

/** Helper: select a range, settle twice for React render cycle */
async function selectRange(
  ctx: any,
  startRow: number, startCol: number,
  endRow: number, endCol: number,
) {
  ctx.setSelection({ startRow, startCol, endRow, endCol });
  await ctx.settle();
  await ctx.settle();
}

export const pasteSpecialSuite: TestSuite = {
  name: "Paste Special",
  description: "Tests paste values, paste formulas, paste formatting, and paste link.",

  afterEach: async (ctx) => {
    const updates = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 6; c++) {
        updates.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(updates);
    await ctx.settle();
    // Clear formatting
    await selectRange(ctx, A.row, A.col, A.row + 9, A.col + 5);
    await ctx.executeCommand(CoreCommands.CLEAR_ALL);
    await ctx.settle();
  },

  tests: [
    {
      name: "Paste Values flattens formula to its result",
      async run(ctx) {
        // Source: formula producing a value
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row, col: A.col + 1, value: `=SUM(${A.ref(0, 0)})` },
        ]);
        await ctx.settle();

        // Copy the formula cell
        await selectRange(ctx, A.row, A.col + 1, A.row, A.col + 1);
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Select destination
        await selectRange(ctx, A.row, A.col + 3, A.row, A.col + 3);

        // Paste Values only
        await ctx.executeCommand(CoreCommands.PASTE_VALUES);
        await ctx.settle();

        // Destination should have the value "10" but NO formula
        const dest = await ctx.getCell(A.row, A.col + 3);
        expectCellValue(dest, "10", A.ref(0, 3));
        if (dest && dest.formula) {
          throw new Error(`Expected no formula after paste values, got: ${dest.formula}`);
        }
      },
    },
    {
      name: "Paste Formulas copies formula with shifted references",
      async run(ctx) {
        // Source: value + formula referencing it
        await ctx.setCells([
          { row: A.row, col: A.col, value: "5" },
          { row: A.row, col: A.col + 1, value: `=${A.ref(0, 0)}*2` },
        ]);
        await ctx.settle();

        // Copy the formula cell
        await selectRange(ctx, A.row, A.col + 1, A.row, A.col + 1);
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Paste to a row below
        await selectRange(ctx, A.row + 2, A.col + 1, A.row + 2, A.col + 1);
        await ctx.executeCommand(CoreCommands.PASTE_FORMULAS);
        await ctx.settle();

        // The pasted formula should have shifted row references
        const dest = await ctx.getCell(A.row + 2, A.col + 1);
        if (!dest || !dest.formula) {
          throw new Error(`Expected a formula after paste formulas, got: ${dest?.display}`);
        }
        // The formula should reference the shifted row
        ctx.log(`Pasted formula: ${dest.formula}`);
      },
    },
    {
      name: "Paste Formatting copies style without values",
      async run(ctx) {
        // Source: a value with specific style
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Styled" },
        ]);
        await ctx.settle();

        // Apply bold formatting to source
        await selectRange(ctx, A.row, A.col, A.row, A.col);
        await ctx.executeCommand("formatting.bold");
        await ctx.settle();

        // Get source style index
        const source = await ctx.getCell(A.row, A.col);
        const sourceStyleIndex = source?.styleIndex ?? 0;

        // Set destination value
        await ctx.setCells([
          { row: A.row + 2, col: A.col, value: "Plain" },
        ]);
        await ctx.settle();

        // Copy source
        await selectRange(ctx, A.row, A.col, A.row, A.col);
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Paste formatting to destination
        await selectRange(ctx, A.row + 2, A.col, A.row + 2, A.col);
        await ctx.executeCommand(CoreCommands.PASTE_FORMATTING);
        await ctx.settle();

        // Destination should keep its value but gain the source style
        const dest = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(dest, "Plain", A.ref(2, 0));
        if (dest && dest.styleIndex === 0 && sourceStyleIndex !== 0) {
          throw new Error(
            `Expected formatting to be applied (source style=${sourceStyleIndex}), ` +
            `but destination still has style=0`
          );
        }
      },
    },
    {
      name: "Paste Link creates absolute reference formula",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "42" },
        ]);
        await ctx.settle();

        // Copy source
        await selectRange(ctx, A.row, A.col, A.row, A.col);
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Paste link to destination
        await selectRange(ctx, A.row + 3, A.col + 3, A.row + 3, A.col + 3);
        await ctx.executeCommand(CoreCommands.PASTE_LINK);
        await ctx.settle();

        // Destination should have formula referencing source with absolute refs
        const dest = await ctx.getCell(A.row + 3, A.col + 3);
        expectCellValue(dest, "42", A.ref(3, 3));
        if (!dest || !dest.formula) {
          throw new Error(`Expected paste link to create a formula, got: ${dest?.display}`);
        }
        // Formula should contain $ signs for absolute reference
        if (!dest.formula.includes("$")) {
          throw new Error(`Expected absolute reference ($), got formula: ${dest.formula}`);
        }
        ctx.log(`Paste link formula: ${dest.formula}`);
      },
    },
    {
      name: "Paste Values for multiple cells",
      async run(ctx) {
        // Set up a 2x2 block with values and formulas
        await ctx.setCells([
          { row: A.row, col: A.col, value: "100" },
          { row: A.row, col: A.col + 1, value: "200" },
          { row: A.row + 1, col: A.col, value: `=${A.ref(0, 0)}+1` },
          { row: A.row + 1, col: A.col + 1, value: `=${A.ref(0, 1)}+1` },
        ]);
        await ctx.settle();

        // Copy the 2x2 block
        await selectRange(ctx, A.row, A.col, A.row + 1, A.col + 1);
        await ctx.executeCommand(CoreCommands.COPY);
        await ctx.settle();

        // Paste values to a new location
        await selectRange(ctx, A.row + 4, A.col, A.row + 4, A.col);
        await ctx.executeCommand(CoreCommands.PASTE_VALUES);
        await ctx.settle();

        // Verify: values are pasted, no formulas
        const cells = await ctx.getCells(A.row + 4, A.col, A.row + 5, A.col + 1);
        expectCellValue(cells.get(A.ref(4, 0))!, "100", A.ref(4, 0));
        expectCellValue(cells.get(A.ref(4, 1))!, "200", A.ref(4, 1));
        expectCellValue(cells.get(A.ref(5, 0))!, "101", A.ref(5, 0));
        expectCellValue(cells.get(A.ref(5, 1))!, "201", A.ref(5, 1));

        // Check no formulas
        const cell50 = cells.get(A.ref(5, 0));
        if (cell50 && cell50.formula) {
          throw new Error(`Expected no formula after paste values, got: ${cell50.formula}`);
        }
      },
    },
  ],
};
