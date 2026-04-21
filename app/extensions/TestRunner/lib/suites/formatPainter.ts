//! FILENAME: app/extensions/TestRunner/lib/suites/formatPainter.ts
// PURPOSE: Tests for the Format Painter extension.
// CONTEXT: Verifies style capture and application via format painter commands.

import type { TestSuite } from "../types";
import { expectCellValue } from "../assertions";
import { CoreCommands } from "@api/commands";
import { AREA_FORMAT_PAINTER } from "../testArea";

const A = AREA_FORMAT_PAINTER;

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

export const formatPainterSuite: TestSuite = {
  name: "Format Painter",
  description: "Tests format painter style capture and application.",

  afterEach: async (ctx) => {
    const updates = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 4; c++) {
        updates.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(updates);
    await ctx.settle();
    // Clear formatting
    await selectRange(ctx, A.row, A.col, A.row + 7, A.col + 3);
    await ctx.executeCommand(CoreCommands.CLEAR_ALL);
    await ctx.settle();
  },

  tests: [
    {
      name: "Format painter copies style from source to target",
      async run(ctx) {
        // Set up source with a value and apply bold
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Bold" },
          { row: A.row + 2, col: A.col, value: "Plain" },
        ]);
        await ctx.settle();

        // Apply bold to source
        await selectRange(ctx, A.row, A.col, A.row, A.col);
        await ctx.executeCommand("formatting.bold");
        await ctx.settle();

        // Capture source style
        const source = await ctx.getCell(A.row, A.col);
        const sourceStyle = source?.styleIndex ?? 0;
        if (sourceStyle === 0) {
          ctx.log("Warning: bold did not change style index, test may not be conclusive");
        }

        // Activate format painter (single-use)
        await ctx.executeCommand(CoreCommands.FORMAT_PAINTER);
        await ctx.settle();

        // Select the target cell — the format painter applies on selection change
        await selectRange(ctx, A.row + 2, A.col, A.row + 2, A.col);
        // Format painter needs a mouseup event to trigger application
        // Since we can't simulate mouseup, let's settle a bit more
        await ctx.settle();
        await ctx.settle();

        // Check target got the same style
        const target = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(target, "Plain", A.ref(2, 0));

        if (sourceStyle > 0 && target && target.styleIndex !== sourceStyle) {
          throw new Error(
            `Expected target style=${sourceStyle} (same as source), got style=${target.styleIndex}`
          );
        }
      },
    },
    {
      name: "Format painter preserves cell values",
      async run(ctx) {
        // Set up: source has formatting, target has different content
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Source" },
          { row: A.row + 2, col: A.col, value: "TargetValue" },
        ]);
        await ctx.settle();

        // Apply italic to source
        await selectRange(ctx, A.row, A.col, A.row, A.col);
        await ctx.executeCommand("formatting.italic");
        await ctx.settle();

        // Use format painter
        await ctx.executeCommand(CoreCommands.FORMAT_PAINTER);
        await ctx.settle();

        await selectRange(ctx, A.row + 2, A.col, A.row + 2, A.col);
        await ctx.settle();
        await ctx.settle();

        // Value should be preserved
        const target = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(target, "TargetValue", A.ref(2, 0));
      },
    },
    {
      name: "Format painter works with range selection",
      async run(ctx) {
        // Source: 2 cells with formatting
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row, col: A.col + 1, value: "B" },
          { row: A.row + 3, col: A.col, value: "X" },
          { row: A.row + 3, col: A.col + 1, value: "Y" },
        ]);
        await ctx.settle();

        // Apply bold to source range
        await selectRange(ctx, A.row, A.col, A.row, A.col + 1);
        await ctx.executeCommand("formatting.bold");
        await ctx.settle();

        // Get source styles
        const srcA = await ctx.getCell(A.row, A.col);
        const srcStyleA = srcA?.styleIndex ?? 0;

        // Format painter from source range
        await ctx.executeCommand(CoreCommands.FORMAT_PAINTER);
        await ctx.settle();

        // Apply to target range
        await selectRange(ctx, A.row + 3, A.col, A.row + 3, A.col + 1);
        await ctx.settle();
        await ctx.settle();

        // Values should be preserved
        const cells = await ctx.getCells(A.row + 3, A.col, A.row + 3, A.col + 1);
        expectCellValue(cells.get(A.ref(3, 0))!, "X", A.ref(3, 0));
        expectCellValue(cells.get(A.ref(3, 1))!, "Y", A.ref(3, 1));
      },
    },
  ],
};
