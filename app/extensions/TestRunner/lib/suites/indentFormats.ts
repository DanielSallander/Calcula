//! FILENAME: app/extensions/TestRunner/lib/suites/indentFormats.ts
// PURPOSE: Tests for indent, shrink-to-fit, and additional number formats.
// CONTEXT: Validates new formatting features added to the style pipeline.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_INDENT_FORMATS } from "../testArea";
import { applyFormatting, getStyle } from "@api/lib";

const A = AREA_INDENT_FORMATS;

export const indentFormatsSuite: TestSuite = {
  name: "Indent & Formats",
  description: "Tests indent, shrink-to-fit, accounting/fraction/special number formats.",

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
    // ---- Indent Tests ----
    {
      name: "Apply indent level 1",
      description: "applyFormatting sets indent=1, getStyle confirms.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Indented" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { indent: 1 });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.indent, 1, "indent should be 1");
      },
    },
    {
      name: "Apply max indent level 15",
      description: "Indent supports up to 15 levels.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Deep indent" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { indent: 15 });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.indent, 15, "indent should be 15");
      },
    },
    {
      name: "Default indent is 0",
      description: "A newly formatted cell without indent should have indent 0.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "No indent" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { bold: true });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.indent, 0, "indent should default to 0");
      },
    },
    {
      name: "Indent combined with other formatting",
      description: "Indent works alongside bold and text alignment.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Bold indent" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], {
          bold: true,
          indent: 3,
          textAlign: "left",
        });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(style.bold, "should be bold");
        assertEqual(style.indent, 3, "indent should be 3");
        assertEqual(style.textAlign, "left", "textAlign should be left");
      },
    },

    // ---- Shrink to Fit Tests ----
    {
      name: "Apply shrink to fit",
      description: "applyFormatting sets shrinkToFit=true, getStyle confirms.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Shrink me" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { shrinkToFit: true });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(style.shrinkToFit === true, "shrinkToFit should be true");
      },
    },
    {
      name: "Default shrinkToFit is false",
      description: "A newly formatted cell without shrinkToFit should have it false.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Normal" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { bold: true });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(style.shrinkToFit === false, "shrinkToFit should default to false");
      },
    },
    {
      name: "Shrink to fit with indent",
      description: "Both properties can be set simultaneously.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Both" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], {
          shrinkToFit: true,
          indent: 2,
        });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(style.shrinkToFit === true, "shrinkToFit should be true");
        assertEqual(style.indent, 2, "indent should be 2");
      },
    },

    // ---- Number Format Tests (Accounting, Fraction, Special) ----
    {
      name: "Apply accounting number format",
      description: "Accounting format string persists on the cell.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "1234.56" }]);
        await ctx.settle();

        const fmt = '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)';
        const result = await applyFormatting([A.row], [A.col], { numberFormat: fmt });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(
          style.numberFormat !== "" && style.numberFormat !== "General",
          `numberFormat should be set, got "${style.numberFormat}"`
        );
      },
    },
    {
      name: "Apply fraction number format",
      description: "Fraction format (halves) persists on the cell.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "1.5" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { numberFormat: "# ?/2" });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(
          style.numberFormat !== "" && style.numberFormat !== "General",
          `numberFormat should be set for fraction, got "${style.numberFormat}"`
        );
      },
    },
    {
      name: "Apply special number format (zip code)",
      description: "Zip code format persists on the cell.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "1234" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { numberFormat: "00000" });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertTrue(
          style.numberFormat !== "" && style.numberFormat !== "General",
          `numberFormat should be set for zip code, got "${style.numberFormat}"`
        );
      },
    },
    {
      name: "Apply formatting to multiple cells",
      description: "Indent and shrinkToFit apply across a range.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row, col: A.col + 1, value: "B" },
          { row: A.row + 1, col: A.col, value: "C" },
        ]);
        await ctx.settle();

        const result = await applyFormatting(
          [A.row, A.row + 1],
          [A.col, A.col + 1],
          { indent: 2, shrinkToFit: true }
        );

        assertTrue(result.cells.length >= 3, "should have at least 3 updated cells");

        for (const c of result.cells) {
          const style = await getStyle(c.styleIndex);
          assertEqual(style.indent, 2, `indent should be 2 for cell (${c.row},${c.col})`);
          assertTrue(style.shrinkToFit === true, `shrinkToFit should be true for cell (${c.row},${c.col})`);
        }
      },
    },
  ],
};
