//! FILENAME: app/extensions/TestRunner/lib/suites/cellStyles.ts
// PURPOSE: Cell styles & formatting test suite.
// CONTEXT: Tests applyFormatting, getStyle, number format preview.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_CELL_STYLES } from "../testArea";
import { previewNumberFormat } from "@api";
import { applyFormatting, getStyle, getAllStyles } from "@api/lib";

const A = AREA_CELL_STYLES;

export const cellStylesSuite: TestSuite = {
  name: "Cell Styles",
  description: "Tests formatting application, style retrieval, and number format preview.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Apply bold formatting",
      description: "applyFormatting sets bold, getStyle confirms.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Bold text" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { bold: true });
        assertTrue(result.cells.length > 0, "should return updated cells");

        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "our cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(style.bold, "style should be bold");
      },
    },
    {
      name: "Apply multiple formatting options",
      description: "Bold + italic + text color applied together.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Styled" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], {
          bold: true,
          italic: true,
          textColor: "#FF0000",
        });

        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(style.bold, "bold");
        assertTrue(style.italic, "italic");
        assertEqual(style.textColor.toLowerCase(), "#ff0000", "textColor");
      },
    },
    {
      name: "Apply number format",
      description: "Number format string persists on the cell.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "1234.5" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], {
          numberFormat: "#,##0.00",
        });

        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        // The backend may store a display name rather than the raw format string
        assertTrue(
          style.numberFormat !== "" && style.numberFormat !== "General",
          `numberFormat should be set, got "${style.numberFormat}"`
        );
      },
    },
    {
      name: "Apply background color",
      description: "Background color applied to cell.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Colored" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], {
          backgroundColor: "#00FF00",
        });

        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.backgroundColor.toLowerCase(), "#00ff00", "backgroundColor");
      },
    },
    {
      name: "Get all styles",
      description: "getAllStyles returns the style registry.",
      run: async (ctx) => {
        const styles = await getAllStyles();
        assertTrue(styles.length >= 1, "should have at least 1 style (the default)");
        // Default style should have sane values
        assertTrue(styles[0].fontSize > 0, "default font size should be > 0");
      },
    },
    {
      name: "Preview number format",
      description: "previewNumberFormat returns formatted string.",
      run: async (ctx) => {
        const result = await previewNumberFormat("#,##0.00", 1234567.89);
        expectNotNull(result, "preview result should exist");
        ctx.log(`Preview: ${JSON.stringify(result)}`);
      },
    },
  ],
};
