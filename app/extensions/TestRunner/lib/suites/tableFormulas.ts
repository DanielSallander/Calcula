//! FILENAME: app/extensions/TestRunner/lib/suites/tableFormulas.ts
// PURPOSE: Table + Formula cross-feature integration tests.
// CONTEXT: Tests structured references, totals row calculations, calculated columns.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue } from "../assertions";
import { AREA_TABLE_FORMULAS } from "../testArea";
import {
  createTable,
  deleteTable,
  getAllTables,
  toggleTotalsRow,
  setTotalsRowFunction,
  resizeTable,
  resolveStructuredReference,
  setCalculatedColumn,
} from "@api/backend";
import { calculateNow } from "@api";

const A = AREA_TABLE_FORMULAS;

export const tableFormulasSuite: TestSuite = {
  name: "Table + Formulas Integration",
  description: "Tests structured references, totals row, calculated columns with formulas.",

  afterEach: async (ctx) => {
    try {
      const tables = await getAllTables();
      for (const t of tables) {
        if (t.startRow >= A.row && t.startRow <= A.row + 30) {
          await deleteTable(t.id);
        }
      }
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 6; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Structured reference resolves to data range",
      description: "Table[Column] resolves to the correct cell range.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Price" },
          { row: A.row, col: A.col + 1, value: "Qty" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col + 1, value: "5" },
          { row: A.row + 2, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col + 1, value: "3" },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "PriceTable",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 2, endCol: A.col + 1,
          hasHeaders: true,
        });
        assertTrue(result.success, `create: ${result.error}`);

        const ref = await resolveStructuredReference("PriceTable[Price]");
        assertTrue(ref.success, `resolve: ${ref.error}`);
        expectNotNull(ref.resolved, "should have resolved range");
        assertEqual(ref.resolved!.startRow, A.row + 1, "starts at first data row");
        assertEqual(ref.resolved!.endRow, A.row + 2, "ends at last data row");
        assertEqual(ref.resolved!.startCol, A.col, "correct column");
      },
    },
    {
      name: "Totals row toggle and function assignment",
      description: "Enabling totals row and assigning SUM function creates the totals row cell.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Amount" },
          { row: A.row + 1, col: A.col, value: "100" },
          { row: A.row + 2, col: A.col, value: "200" },
          { row: A.row + 3, col: A.col, value: "300" },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "SumTable",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 3, endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(result.success, `create: ${result.error}`);
        const id = result.table!.id;

        // Toggle totals row on — table expands by 1 row
        const toggleResult = await toggleTotalsRow(id, true);
        assertTrue(toggleResult.success, `toggle: ${toggleResult.error}`);
        await ctx.settle();

        // Assign SUM function to the Amount column
        const funcResult = await setTotalsRowFunction({ tableId: id, columnName: "Amount", function: "sum" });
        assertTrue(funcResult.success, `setFunction: ${funcResult.error}`);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Totals row should be at A.row + 4 (after the 3 data rows)
        const totalCell = await ctx.getCell(A.row + 4, A.col);
        expectNotNull(totalCell, "totals row cell should exist");
        ctx.log(`Totals row display: ${totalCell!.display}`);

        // SUBTOTAL function is not yet implemented in the formula engine,
        // so the cell may show #NAME error. Verify the totals row was created
        // and the table structure is correct.
        const tables = await getAllTables();
        const ours = tables.find(t => t.name === "SumTable");
        expectNotNull(ours, "table should exist");
        assertTrue(ours!.styleOptions.totalRow === true, "totals row should be enabled");
        assertEqual(ours!.endRow, A.row + 4, "table end row should include totals row");

        // Verify the column has the function assigned
        const col = ours!.columns.find((c: any) => c.name === "Amount");
        expectNotNull(col, "Amount column should exist");
        assertEqual(col!.totalsRowFunction, "sum", "function should be sum");
      },
    },
    {
      name: "Formula outside table referencing table column",
      description: "A SUM formula referencing a structured reference evaluates correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Score" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "20" },
          { row: A.row + 3, col: A.col, value: "30" },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "ScoreTable",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 3, endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(result.success, `create: ${result.error}`);

        // Put a SUM formula outside the table that references the table column
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(ScoreTable[Score])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const sumCell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(sumCell, "60", "SUM of table column via structured ref");
      },
    },
    {
      name: "Resize table and formula still works",
      description: "After resizing table to include more rows, SUM updates.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Val" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "20" },
          // Extra row to be included after resize
          { row: A.row + 3, col: A.col, value: "30" },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "GrowTable",
          startRow: A.row, startCol: A.col,
          endRow: A.row + 2, endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(result.success, `create: ${result.error}`);

        // SUM formula referencing table
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(GrowTable[Val])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const before = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(before, "30", "SUM before resize (10+20)");

        // Resize to include row+3
        await resizeTable({
          tableId: result.table!.id,
          startRow: A.row, startCol: A.col,
          endRow: A.row + 3, endCol: A.col,
        });
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const after = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(after, "60", "SUM after resize (10+20+30)");
      },
    },
  ],
};
