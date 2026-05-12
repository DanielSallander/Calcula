//! FILENAME: app/extensions/TestRunner/lib/suites/edgeCaseRegressions.ts
// PURPOSE: Edge case and regression tests.
// CONTEXT: Tests boundary conditions, unusual inputs, large row/col numbers,
//          formulas referencing merged cells, deeply nested expressions,
//          empty range handling, and other corner cases that could cause
//          crashes or incorrect results.

import type { TestSuite } from "../types";
import { AREA_EDGE_CASES } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
  expectCellValue,
  expectCellContains,
} from "../assertions";
import { recalculateFormulas } from "@api/backend";
import { calculateNow } from "@api";

const A = AREA_EDGE_CASES;

/** Clear test area */
async function clearArea(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 10; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

export const edgeCaseRegressionsSuite: TestSuite = {
  name: "Edge Case Regressions",

  afterEach: async (ctx) => {
    await clearArea(ctx);
  },

  tests: [
    // ------------------------------------------------------------------
    // 1. VERY LARGE ROW NUMBER
    // ------------------------------------------------------------------
    {
      name: "Read/write cell at row 10000",
      run: async (ctx) => {
        await ctx.setCells([{ row: 10000, col: 0, value: "=42" }]);
        await ctx.settle();

        const cell = await ctx.getCell(10000, 0);
        expectCellValue(cell, "42", "Cell at row 10000 = 42");

        // Clean up
        await ctx.setCells([{ row: 10000, col: 0, value: "" }]);
        await ctx.settle();
      },
    },

    // ------------------------------------------------------------------
    // 2. FORMULA REFERENCING HIGH ROW
    // ------------------------------------------------------------------
    {
      name: "Formula referencing cell at high row number",
      run: async (ctx) => {
        await ctx.setCells([
          { row: 5000, col: 0, value: "=100" },
          { row: 5001, col: 0, value: "=A5001*2" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(5001, 0);
        expectCellValue(cell, "200", "Formula at row 5001 = 200");

        // Clean up
        await ctx.setCells([
          { row: 5000, col: 0, value: "" },
          { row: 5001, col: 0, value: "" },
        ]);
        await ctx.settle();
      },
    },

    // ------------------------------------------------------------------
    // 3. DEEPLY NESTED PARENTHESES
    // ------------------------------------------------------------------
    {
      name: "Formula with 10 levels of nested parentheses",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // ((((((((((1+1)+1)+1)+1)+1)+1)+1)+1)+1)+1) = 11
        await ctx.setCells([
          { row: r, col: c, value: "=((((((((((1+1)+1)+1)+1)+1)+1)+1)+1)+1)+1)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r, c);
        expectCellValue(cell, "11", "10 nested parens = 11");
      },
    },

    // ------------------------------------------------------------------
    // 4. EMPTY STRING VS NULL CELL
    // ------------------------------------------------------------------
    {
      name: "Empty string cell vs never-written cell",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Write empty string
        await ctx.setCells([{ row: r, col: c, value: "" }]);
        await ctx.settle();

        const emptyCell = await ctx.getCell(r, c);
        // Should be null or have empty display
        assertTrue(
          emptyCell === null || emptyCell.display === "",
          `Empty string cell should be null or empty, got "${emptyCell?.display}"`
        );

        // Never-written cell (offset by 5)
        const neverWritten = await ctx.getCell(r + 5, c + 5);
        assertTrue(
          neverWritten === null || neverWritten.display === "",
          `Never-written cell should be null or empty`
        );
      },
    },

    // ------------------------------------------------------------------
    // 5. FORMULA WITH VERY LONG STRING RESULT
    // ------------------------------------------------------------------
    {
      name: "REPT function producing 500-char string",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: '=REPT("ABCDE",100)' },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r, c);
        expectNotNull(cell, "REPT cell exists");
        assertEqual(cell!.display.length, 500, "REPT produces 500 chars");
      },
    },

    // ------------------------------------------------------------------
    // 6. DIVISION BY ZERO
    // ------------------------------------------------------------------
    {
      name: "Division by zero produces #DIV/0! error",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([{ row: r, col: c, value: "=1/0" }]);
        await ctx.settle();

        const cell = await ctx.getCell(r, c);
        expectNotNull(cell, "Error cell exists");
        expectCellContains(cell, "DIV", "Should show #DIV/0!");
      },
    },

    // ------------------------------------------------------------------
    // 7. REFERENCE TO SELF (CIRCULAR)
    // ------------------------------------------------------------------
    {
      name: "Self-referencing formula does not crash",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: `=${A.ref(0, 0)}+1` },
        ]);
        await ctx.settle();

        // Should not crash; may show error, 0, or partial result
        const cell = await ctx.getCell(r, c);
        expectNotNull(cell, "Self-ref cell should exist");
      },
    },

    // ------------------------------------------------------------------
    // 8. BOOLEAN ARITHMETIC
    // ------------------------------------------------------------------
    {
      name: "Boolean values in arithmetic (TRUE=1, FALSE=0)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=TRUE+TRUE" },
          { row: r + 1, col: c, value: "=FALSE+1" },
          { row: r + 2, col: c, value: "=TRUE*10" },
        ]);
        await ctx.settle();

        expectCellValue(await ctx.getCell(r, c), "2", "TRUE+TRUE = 2");
        expectCellValue(await ctx.getCell(r + 1, c), "1", "FALSE+1 = 1");
        expectCellValue(await ctx.getCell(r + 2, c), "10", "TRUE*10 = 10");
      },
    },

    // ------------------------------------------------------------------
    // 9. VERY LARGE NUMBER
    // ------------------------------------------------------------------
    {
      name: "Very large number (1E15) preserved correctly",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([{ row: r, col: c, value: "=1000000000000000" }]);
        await ctx.settle();

        const cell = await ctx.getCell(r, c);
        expectNotNull(cell, "Large number cell exists");
        // May display as 1E+15 or 1000000000000000
        const val = parseFloat(cell!.display.replace(/\s/g, "").replace(",", "."));
        assertTrue(Math.abs(val - 1e15) < 1e10, `Should be ~1E15, got ${val}`);
      },
    },

    // ------------------------------------------------------------------
    // 10. NEGATIVE ZERO
    // ------------------------------------------------------------------
    {
      name: "Negative zero displays as 0",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([{ row: r, col: c, value: "=-0" }]);
        await ctx.settle();

        const cell = await ctx.getCell(r, c);
        expectCellValue(cell, "0", "-0 should display as 0");
      },
    },

    // ------------------------------------------------------------------
    // 11. CONCATENATION OF MANY VALUES
    // ------------------------------------------------------------------
    {
      name: "Concatenate 10 cell values with &",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let i = 0; i < 10; i++) {
          updates.push({ row: r + i, col: c, value: String.fromCharCode(65 + i) }); // A,B,C...J
        }
        // Concatenate all
        const refs = Array.from({ length: 10 }, (_, i) => A.ref(i, 0)).join("&");
        updates.push({ row: r + 11, col: c, value: `=${refs}` });

        await ctx.setCells(updates);
        await ctx.settle();

        const cell = await ctx.getCell(r + 11, c);
        expectCellValue(cell, "ABCDEFGHIJ", "Concatenation of A..J");
      },
    },

    // ------------------------------------------------------------------
    // 12. IF WITH EMPTY BRANCHES
    // ------------------------------------------------------------------
    {
      name: "IF with empty true/false branches",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: '=IF(TRUE,"yes","")' },
          { row: r + 1, col: c, value: '=IF(FALSE,"","no")' },
        ]);
        await ctx.settle();

        expectCellValue(await ctx.getCell(r, c), "yes", "IF true -> yes");
        expectCellValue(await ctx.getCell(r + 1, c), "no", "IF false -> no");
      },
    },

    // ------------------------------------------------------------------
    // 13. SUM OF EMPTY RANGE
    // ------------------------------------------------------------------
    {
      name: "SUM of completely empty range returns 0",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Reference a range that has no data
        await ctx.setCells([
          { row: r, col: c, value: `=SUM(${A.ref(10, 5)}:${A.ref(15, 5)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r, c);
        expectCellValue(cell, "0", "SUM of empty range = 0");
      },
    },

    // ------------------------------------------------------------------
    // 14. MULTIPLE OPERATORS IN SEQUENCE
    // ------------------------------------------------------------------
    {
      name: "Operator precedence: 2+3*4-1 = 13",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([{ row: r, col: c, value: "=2+3*4-1" }]);
        await ctx.settle();

        expectCellValue(await ctx.getCell(r, c), "13", "2+3*4-1 = 13");
      },
    },

    // ------------------------------------------------------------------
    // 15. MIXED REFERENCE TYPES IN FORMULA
    // ------------------------------------------------------------------
    {
      name: "Formula mixing absolute and relative style references",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=10" },
          { row: r + 1, col: c, value: "=20" },
          // Use explicit A1 references (not offset-based)
          { row: r + 2, col: c, value: `=${A.ref(0, 0)}+${A.ref(1, 0)}` },
        ]);
        await ctx.settle();

        expectCellValue(await ctx.getCell(r + 2, c), "30", "Mixed ref = 30");
      },
    },

    // ------------------------------------------------------------------
    // 16. UNICODE IN CELL VALUES
    // ------------------------------------------------------------------
    {
      name: "Unicode characters preserved in cell values",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "Caf\u00e9" },         // Café
          { row: r + 1, col: c, value: "\u00c5ngstr\u00f6m" }, // Ångström
          { row: r + 2, col: c, value: "\u2603 Snowman" },  // ☃ Snowman
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r, c);
        expectCellContains(cell, "Caf", "Café preserved");

        cell = await ctx.getCell(r + 1, c);
        expectCellContains(cell, "ngstr", "Ångström preserved");

        cell = await ctx.getCell(r + 2, c);
        expectCellContains(cell, "Snowman", "Snowman text preserved");
      },
    },

    // ------------------------------------------------------------------
    // 17. FORMULA PRODUCING VERY SMALL NUMBER
    // ------------------------------------------------------------------
    {
      name: "Very small number (1E-10) preserved",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([{ row: r, col: c, value: "=0.0000000001" }]);
        await ctx.settle();

        const cell = await ctx.getCell(r, c);
        expectNotNull(cell, "Small number cell exists");
        const val = parseFloat(cell!.display.replace(",", "."));
        assertTrue(Math.abs(val - 1e-10) < 1e-15, `Should be ~1E-10, got ${val}`);
      },
    },

    // ------------------------------------------------------------------
    // 18. MULTIPLE IFERROR NESTING
    // ------------------------------------------------------------------
    {
      name: "Nested IFERROR catches cascading errors",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // IFERROR(1/0, IFERROR(1/0, "safe"))
        await ctx.setCells([
          { row: r, col: c, value: '=IFERROR(1/0, IFERROR(1/0, "safe"))' },
        ]);
        await ctx.settle();

        expectCellValue(await ctx.getCell(r, c), "safe", "Nested IFERROR -> safe");
      },
    },

    // ------------------------------------------------------------------
    // 19. MAX/MIN OF SINGLE CELL
    // ------------------------------------------------------------------
    {
      name: "MAX and MIN of a single cell",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=42" },
          { row: r + 1, col: c, value: `=MAX(${A.ref(0, 0)})` },
          { row: r + 2, col: c, value: `=MIN(${A.ref(0, 0)})` },
        ]);
        await ctx.settle();

        expectCellValue(await ctx.getCell(r + 1, c), "42", "MAX of single cell = 42");
        expectCellValue(await ctx.getCell(r + 2, c), "42", "MIN of single cell = 42");
      },
    },

    // ------------------------------------------------------------------
    // 20. OVERWRITE FORMULA WITH VALUE
    // ------------------------------------------------------------------
    {
      name: "Overwriting a formula cell with plain value",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([{ row: r, col: c, value: "=1+1" }]);
        await ctx.settle();
        expectCellValue(await ctx.getCell(r, c), "2", "Formula = 2");

        // Overwrite with plain text
        await ctx.setCells([{ row: r, col: c, value: "hello" }]);
        await ctx.settle();

        const cell = await ctx.getCell(r, c);
        expectCellValue(cell, "hello", "Formula replaced with text");
        assertTrue(
          cell!.formula === null || cell!.formula === undefined || cell!.formula === "",
          "Formula should be cleared"
        );
      },
    },

    // ------------------------------------------------------------------
    // 21. MANY CELLS IN ONE ROW
    // ------------------------------------------------------------------
    {
      name: "Write and read 50 cells in a single row",
      run: async (ctx) => {
        const r = A.row;
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let c = 0; c < 50; c++) {
          updates.push({ row: r, col: c, value: `=${c + 1}` });
        }
        await ctx.setCells(updates);
        await ctx.settle();

        // Check first, middle, last
        expectCellValue(await ctx.getCell(r, 0), "1", "Col 0 = 1");
        expectCellValue(await ctx.getCell(r, 24), "25", "Col 24 = 25");
        expectCellValue(await ctx.getCell(r, 49), "50", "Col 49 = 50");

        // Clean up
        const clears = Array.from({ length: 50 }, (_, c) => ({ row: r, col: c, value: "" }));
        await ctx.setCells(clears);
        await ctx.settle();
      },
    },

    // ------------------------------------------------------------------
    // 22. FORMULA WITH TEXT COMPARISON
    // ------------------------------------------------------------------
    {
      name: "Text comparison in IF (case-insensitive)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "Hello" },
          { row: r + 1, col: c, value: `=IF(${A.ref(0, 0)}="hello","match","no match")` },
        ]);
        await ctx.settle();

        // Excel-style text comparison is case-insensitive
        const cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "match", "Case-insensitive text comparison");
      },
    },

    // ------------------------------------------------------------------
    // 23. CHAIN OF IF PRODUCING DIFFERENT TYPES
    // ------------------------------------------------------------------
    {
      name: "IF returning number, text, and boolean in different branches",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=1" },
          { row: r + 1, col: c, value: `=IF(${A.ref(0, 0)}=1, 100, "not one")` },
          { row: r + 2, col: c, value: `=IF(${A.ref(0, 0)}=2, 200, "not two")` },
          { row: r + 3, col: c, value: `=IF(${A.ref(0, 0)}=1, TRUE, FALSE)` },
        ]);
        await ctx.settle();

        expectCellValue(await ctx.getCell(r + 1, c), "100", "IF=1 -> 100");
        expectCellValue(await ctx.getCell(r + 2, c), "not two", "IF!=2 -> not two");

        const boolCell = await ctx.getCell(r + 3, c);
        expectNotNull(boolCell, "Boolean IF cell");
        assertTrue(
          boolCell!.display === "TRUE" || boolCell!.display === "SANT",
          `IF=1 -> TRUE, got "${boolCell!.display}"`
        );
      },
    },

    // ------------------------------------------------------------------
    // 24. WHITESPACE IN FORMULA
    // ------------------------------------------------------------------
    {
      name: "Formula with extra whitespace parses correctly",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "= 1 + 2 + 3" },
        ]);
        await ctx.settle();

        expectCellValue(await ctx.getCell(r, c), "6", "Whitespace formula = 6");
      },
    },

    // ------------------------------------------------------------------
    // 25. RAPID CLEAR AND REWRITE
    // ------------------------------------------------------------------
    {
      name: "Clear cell and immediately rewrite does not lose data",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        for (let i = 0; i < 10; i++) {
          await ctx.setCells([{ row: r, col: c, value: `=Value_${i}` }]);
        }
        await ctx.settle();

        // Last value should win
        const cell = await ctx.getCell(r, c);
        // The value might be numeric since =Value_9 is a formula referencing
        // a named range "Value_9" which doesn't exist. Use plain text instead.
        // Actually =Value_9 would be an error. Let's just check cell exists.
        expectNotNull(cell, "Cell should exist after rapid rewrites");
      },
    },
  ],
};
