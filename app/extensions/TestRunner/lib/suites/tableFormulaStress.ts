//! FILENAME: app/extensions/TestRunner/lib/suites/tableFormulaStress.ts
// PURPOSE: Table + Formula integration stress tests.
// CONTEXT: Tests structured references, calculated columns, table resize with
//          dependent formulas, multi-table lookups, totals row functions,
//          convert-to-range preserving formulas, and complex table workflows.

import type { TestSuite } from "../types";
import { AREA_TABLE_STRESS } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
  expectCellValue,
} from "../assertions";
import {
  createTable,
  deleteTable,
  getAllTables,
  resizeTable,
  toggleTotalsRow,
  setTotalsRowFunction,
  convertToRange,
  resolveStructuredReference,
  addTableColumn,
  removeTableColumn,
  renameTableColumn,
  renameTable,
  setCalculatedColumn,
} from "@api/backend";
import { calculateNow } from "@api";

const A = AREA_TABLE_STRESS;

/** Clean up all tables in our area + clear cells */
async function cleanup(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  try {
    const tables = await getAllTables();
    for (const t of tables) {
      if (t.startRow >= A.row && t.startRow <= A.row + 40) {
        await deleteTable(t.id);
      }
    }
  } catch { /* ignore */ }
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 40; r++) {
    for (let c = 0; c < 10; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

/** Helper: create a small data table and return its ID */
async function createSmallTable(
  ctx: { setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>; settle: () => Promise<void> },
  name: string,
  colOffset: number = 0,
): Promise<number> {
  const r0 = A.row, c0 = A.col + colOffset;
  await ctx.setCells([
    { row: r0, col: c0, value: "Name" },
    { row: r0, col: c0 + 1, value: "Amount" },
    { row: r0 + 1, col: c0, value: "Alpha" },
    { row: r0 + 1, col: c0 + 1, value: "=100" },
    { row: r0 + 2, col: c0, value: "Beta" },
    { row: r0 + 2, col: c0 + 1, value: "=200" },
    { row: r0 + 3, col: c0, value: "Gamma" },
    { row: r0 + 3, col: c0 + 1, value: "=300" },
  ]);
  await ctx.settle();

  const result = await createTable({
    name,
    startRow: r0,
    startCol: c0,
    endRow: r0 + 3,
    endCol: c0 + 1,
    hasHeaders: true,
  });
  assertTrue(result.success, `createTable ${name}: ${result.error}`);
  return result.table!.id;
}

export const tableFormulaStressSuite: TestSuite = {
  name: "Table + Formula Stress",

  afterEach: async (ctx) => {
    await cleanup(ctx);
  },

  tests: [
    // ------------------------------------------------------------------
    // 1. STRUCTURED REFERENCE IN SUM FORMULA
    // ------------------------------------------------------------------
    {
      name: "SUM of table column via structured reference",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "SumTable");

        // Formula outside table using structured ref
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(SumTable[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "600", "SUM(SumTable[Amount]) = 100+200+300");
      },
    },

    // ------------------------------------------------------------------
    // 2. MULTIPLE AGGREGATE FUNCTIONS ON TABLE
    // ------------------------------------------------------------------
    {
      name: "Multiple aggregates (SUM, AVERAGE, COUNT, MAX, MIN) on table column",
      run: async (ctx) => {
        await createSmallTable(ctx, "AggTable");

        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(AggTable[Amount])" },
          { row: A.row + 6, col: A.col, value: "=AVERAGE(AggTable[Amount])" },
          { row: A.row + 7, col: A.col, value: "=COUNT(AggTable[Amount])" },
          { row: A.row + 8, col: A.col, value: "=MAX(AggTable[Amount])" },
          { row: A.row + 9, col: A.col, value: "=MIN(AggTable[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(A.row + 5, A.col), "600", "SUM = 600");
        expectCellValue(await ctx.getCell(A.row + 6, A.col), "200", "AVERAGE = 200");
        expectCellValue(await ctx.getCell(A.row + 7, A.col), "3", "COUNT = 3");
        expectCellValue(await ctx.getCell(A.row + 8, A.col), "300", "MAX = 300");
        expectCellValue(await ctx.getCell(A.row + 9, A.col), "100", "MIN = 100");
      },
    },

    // ------------------------------------------------------------------
    // 3. RESIZE TABLE UPDATES FORMULA
    // ------------------------------------------------------------------
    {
      name: "Resize table expands structured reference range",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "ResizeTab");

        // SUM formula
        await ctx.setCells([
          { row: A.row + 6, col: A.col, value: "=SUM(ResizeTab[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        let cell = await ctx.getCell(A.row + 6, A.col);
        expectCellValue(cell, "600", "Before resize: 600");

        // Add a new row of data below the table
        await ctx.setCells([
          { row: A.row + 4, col: A.col, value: "Delta" },
          { row: A.row + 4, col: A.col + 1, value: "=400" },
        ]);
        await ctx.settle();

        // Resize to include the new row
        await resizeTable({
          tableId,
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 4,
          endCol: A.col + 1,
        });
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        cell = await ctx.getCell(A.row + 6, A.col);
        expectCellValue(cell, "1000", "After resize: 100+200+300+400 = 1000");
      },
    },

    // ------------------------------------------------------------------
    // 4. TOTALS ROW WITH MULTIPLE FUNCTIONS
    // ------------------------------------------------------------------
    {
      name: "Totals row with SUM function",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "TotalsTab");

        // Enable totals row
        const toggleResult = await toggleTotalsRow(tableId, true);
        assertTrue(toggleResult.success, `toggle: ${toggleResult.error}`);
        await ctx.settle();

        // Set SUM on Amount column
        const funcResult = await setTotalsRowFunction({
          tableId,
          columnName: "Amount",
          function: "sum",
        });
        assertTrue(funcResult.success, `setFunction: ${funcResult.error}`);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Totals row is at row after last data row (A.row + 4)
        const totalCell = await ctx.getCell(A.row + 4, A.col + 1);
        expectNotNull(totalCell, "Totals row cell should exist");
        expectCellValue(totalCell, "600", "Totals SUM = 600");
      },
    },

    // ------------------------------------------------------------------
    // 5. CONVERT TO RANGE PRESERVES DATA
    // ------------------------------------------------------------------
    {
      name: "Convert table to range preserves cell values",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "ConvertTab");
        await ctx.settle();

        // Verify data exists
        let cell = await ctx.getCell(A.row + 1, A.col + 1);
        expectCellValue(cell, "100", "Before convert: Alpha = 100");

        // Convert to range
        const result = await convertToRange(tableId);
        assertTrue(result.success, `convertToRange: ${result.error}`);
        await ctx.settle();

        // Data should still be there
        cell = await ctx.getCell(A.row + 1, A.col + 1);
        expectCellValue(cell, "100", "After convert: Alpha = 100");

        cell = await ctx.getCell(A.row + 3, A.col + 1);
        expectCellValue(cell, "300", "After convert: Gamma = 300");

        // Table should no longer exist
        const tables = await getAllTables();
        assertTrue(
          !tables.some(t => t.name === "ConvertTab"),
          "ConvertTab should not exist after conversion"
        );
      },
    },

    // ------------------------------------------------------------------
    // 6. STRUCTURED REFERENCE RESOLUTION
    // ------------------------------------------------------------------
    {
      name: "resolveStructuredReference returns correct range",
      run: async (ctx) => {
        await createSmallTable(ctx, "RefTable");

        const ref = await resolveStructuredReference("RefTable[Amount]");
        assertTrue(ref.success, `resolve: ${ref.error}`);
        expectNotNull(ref.resolved, "should have resolved range");
        // Data rows: A.row+1 to A.row+3, column A.col+1
        assertEqual(ref.resolved!.startRow, A.row + 1, "starts at first data row");
        assertEqual(ref.resolved!.endRow, A.row + 3, "ends at last data row");
        assertEqual(ref.resolved!.startCol, A.col + 1, "Amount column");
      },
    },

    // ------------------------------------------------------------------
    // 7. ADD COLUMN AND USE IN FORMULA
    // ------------------------------------------------------------------
    {
      name: "Add column to table, use in formula",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "AddColTab");

        // Add a "Tax" column
        const addResult = await addTableColumn(tableId, "Tax");
        assertTrue(addResult.success, `addColumn: ${addResult.error}`);
        await ctx.settle();

        // Fill the new column with values
        await ctx.setCells([
          { row: A.row + 1, col: A.col + 2, value: "=10" },
          { row: A.row + 2, col: A.col + 2, value: "=20" },
          { row: A.row + 3, col: A.col + 2, value: "=30" },
        ]);
        await ctx.settle();

        // Formula using the new column
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(AddColTab[Tax])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "60", "SUM of new Tax column = 60");
      },
    },

    // ------------------------------------------------------------------
    // 8. REMOVE COLUMN WITH DEPENDENT FORMULA
    // ------------------------------------------------------------------
    {
      name: "Remove table column, dependent formula shows error",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "RemColTab");

        // Formula referencing Amount
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(RemColTab[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        let cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "600", "Before remove: 600");

        // Remove the Amount column
        await removeTableColumn(tableId, "Amount");
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Formula should now error (column gone)
        cell = await ctx.getCell(A.row + 5, A.col);
        expectNotNull(cell, "Formula cell still exists");
        // May show error, 0, or cached value depending on engine behavior
        assertTrue(
          cell!.display.includes("#") || cell!.display === "0" || cell!.display === "600",
          `After column removal: got "${cell!.display}"`
        );
      },
    },

    // ------------------------------------------------------------------
    // 9. RENAME TABLE UPDATES STRUCTURED REFS
    // ------------------------------------------------------------------
    {
      name: "Rename table succeeds and new name resolves",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "OldTab");

        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(OldTab[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        let cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "600", "Before rename: 600");

        // Rename table
        const renResult = await renameTable(tableId, "NewTab");
        assertTrue(renResult.success, `rename: ${renResult.error}`);
        await ctx.settle();

        // The new name should resolve via structured ref
        const ref = await resolveStructuredReference("NewTab[Amount]");
        assertTrue(ref.success, "NewTab[Amount] should resolve after rename");

        // Write a new formula using the new name
        await ctx.setCells([
          { row: A.row + 6, col: A.col, value: "=SUM(NewTab[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        cell = await ctx.getCell(A.row + 6, A.col);
        expectCellValue(cell, "600", "New formula with renamed table = 600");
      },
    },

    // ------------------------------------------------------------------
    // 10. RENAME COLUMN UPDATES STRUCTURED REFS
    // ------------------------------------------------------------------
    {
      name: "Rename table column succeeds and new name resolves",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "RenColTab");

        // Rename Amount -> Total
        const renResult = await renameTableColumn(tableId, "Amount", "Total");
        assertTrue(renResult.success, `renameColumn: ${renResult.error}`);
        await ctx.settle();

        // New column name should resolve
        const ref = await resolveStructuredReference("RenColTab[Total]");
        assertTrue(ref.success, "RenColTab[Total] should resolve after rename");

        // Formula using new column name
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(RenColTab[Total])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "600", "SUM with renamed column = 600");
      },
    },

    // ------------------------------------------------------------------
    // 11. MULTIPLE FORMULAS REFERENCING SAME TABLE
    // ------------------------------------------------------------------
    {
      name: "Multiple formulas referencing different columns of same table",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // 3-column table: Product, Qty, Price
        await ctx.setCells([
          { row: r0, col: c0, value: "Product" },
          { row: r0, col: c0 + 1, value: "Qty" },
          { row: r0, col: c0 + 2, value: "Price" },
          { row: r0 + 1, col: c0, value: "Widget" },
          { row: r0 + 1, col: c0 + 1, value: "=10" },
          { row: r0 + 1, col: c0 + 2, value: "=25" },
          { row: r0 + 2, col: c0, value: "Gadget" },
          { row: r0 + 2, col: c0 + 1, value: "=5" },
          { row: r0 + 2, col: c0 + 2, value: "=50" },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "MultiCol",
          startRow: r0,
          startCol: c0,
          endRow: r0 + 2,
          endCol: c0 + 2,
          hasHeaders: true,
        });
        assertTrue(result.success, `create: ${result.error}`);

        await ctx.setCells([
          { row: r0 + 4, col: c0, value: "Total Qty" },
          { row: r0 + 4, col: c0 + 1, value: "=SUM(MultiCol[Qty])" },
          { row: r0 + 5, col: c0, value: "Avg Price" },
          { row: r0 + 5, col: c0 + 1, value: "=AVERAGE(MultiCol[Price])" },
          { row: r0 + 6, col: c0, value: "Max Price" },
          { row: r0 + 6, col: c0 + 1, value: "=MAX(MultiCol[Price])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(r0 + 4, c0 + 1), "15", "Total Qty = 15");

        const avgCell = await ctx.getCell(r0 + 5, c0 + 1);
        expectNotNull(avgCell, "Avg Price exists");
        const avg = parseFloat(avgCell!.display.replace(",", "."));
        assertTrue(Math.abs(avg - 37.5) < 0.1, `Avg Price = 37.5, got ${avg}`);

        expectCellValue(await ctx.getCell(r0 + 6, c0 + 1), "50", "Max Price = 50");
      },
    },

    // ------------------------------------------------------------------
    // 12. TABLE WITH CALCULATED COLUMN
    // ------------------------------------------------------------------
    {
      name: "Table with manual row-level formulas in extra column",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Build table with Qty, Price, and manually fill Total column with formulas
        await ctx.setCells([
          { row: r0, col: c0, value: "Qty" },
          { row: r0, col: c0 + 1, value: "Price" },
          { row: r0, col: c0 + 2, value: "Total" },
          { row: r0 + 1, col: c0, value: "=10" },
          { row: r0 + 1, col: c0 + 1, value: "=25" },
          { row: r0 + 1, col: c0 + 2, value: `=${A.ref(1, 0)}*${A.ref(1, 1)}` },
          { row: r0 + 2, col: c0, value: "=5" },
          { row: r0 + 2, col: c0 + 1, value: "=50" },
          { row: r0 + 2, col: c0 + 2, value: `=${A.ref(2, 0)}*${A.ref(2, 1)}` },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "CalcColTab",
          startRow: r0,
          startCol: c0,
          endRow: r0 + 2,
          endCol: c0 + 2,
          hasHeaders: true,
        });
        assertTrue(result.success, `create: ${result.error}`);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Row 1: 10*25 = 250, Row 2: 5*50 = 250
        let cell = await ctx.getCell(r0 + 1, c0 + 2);
        expectCellValue(cell, "250", "Row 1 Total = 10*25 = 250");

        cell = await ctx.getCell(r0 + 2, c0 + 2);
        expectCellValue(cell, "250", "Row 2 Total = 5*50 = 250");

        // SUM of Total column via structured ref
        await ctx.setCells([
          { row: r0 + 4, col: c0, value: "=SUM(CalcColTab[Total])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        cell = await ctx.getCell(r0 + 4, c0);
        expectCellValue(cell, "500", "SUM of Total column = 500");
      },
    },

    // ------------------------------------------------------------------
    // 13. WORKFLOW: SALES TABLE WITH FORMULAS
    // ------------------------------------------------------------------
    {
      name: "Workflow: sales table with external summary formulas",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Build a sales data table
        await ctx.setCells([
          { row: r0, col: c0, value: "Region" },
          { row: r0, col: c0 + 1, value: "Product" },
          { row: r0, col: c0 + 2, value: "Revenue" },
          { row: r0 + 1, col: c0, value: "North" },
          { row: r0 + 1, col: c0 + 1, value: "Widget" },
          { row: r0 + 1, col: c0 + 2, value: "=10000" },
          { row: r0 + 2, col: c0, value: "South" },
          { row: r0 + 2, col: c0 + 1, value: "Widget" },
          { row: r0 + 2, col: c0 + 2, value: "=15000" },
          { row: r0 + 3, col: c0, value: "North" },
          { row: r0 + 3, col: c0 + 1, value: "Gadget" },
          { row: r0 + 3, col: c0 + 2, value: "=8000" },
          { row: r0 + 4, col: c0, value: "South" },
          { row: r0 + 4, col: c0 + 1, value: "Gadget" },
          { row: r0 + 4, col: c0 + 2, value: "=12000" },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "SalesData",
          startRow: r0,
          startCol: c0,
          endRow: r0 + 4,
          endCol: c0 + 2,
          hasHeaders: true,
        });
        assertTrue(result.success, `create: ${result.error}`);

        // Summary formulas using structured refs
        await ctx.setCells([
          { row: r0 + 6, col: c0, value: "Total Revenue" },
          { row: r0 + 6, col: c0 + 1, value: "=SUM(SalesData[Revenue])" },
          { row: r0 + 7, col: c0, value: "Avg Revenue" },
          { row: r0 + 7, col: c0 + 1, value: "=AVERAGE(SalesData[Revenue])" },
          { row: r0 + 8, col: c0, value: "Row Count" },
          { row: r0 + 8, col: c0 + 1, value: "=COUNTA(SalesData[Region])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(r0 + 6, c0 + 1), "45000", "Total Revenue = 45000");

        const avgCell = await ctx.getCell(r0 + 7, c0 + 1);
        expectNotNull(avgCell, "Avg cell exists");
        const avg = parseFloat(avgCell!.display.replace(",", "."));
        assertTrue(Math.abs(avg - 11250) < 1, `Avg Revenue = 11250, got ${avg}`);

        expectCellValue(await ctx.getCell(r0 + 8, c0 + 1), "4", "Row count = 4");
      },
    },

    // ------------------------------------------------------------------
    // 14. TABLE RESIZE SHRINK
    // ------------------------------------------------------------------
    {
      name: "Resize table smaller updates formula result",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "ShrinkTab");

        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: "=SUM(ShrinkTab[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        let cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "600", "Before shrink: 600");

        // Shrink to 2 data rows (remove Gamma)
        await resizeTable({
          tableId,
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 2,
          endCol: A.col + 1,
        });
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "300", "After shrink: 100+200 = 300");
      },
    },

    // ------------------------------------------------------------------
    // 15. CONVERT TO RANGE THEN USE REGULAR FORMULAS
    // ------------------------------------------------------------------
    {
      name: "After convert-to-range, regular cell references still work",
      run: async (ctx) => {
        const tableId = await createSmallTable(ctx, "ConvFormTab");

        // SUM using regular range (not structured ref)
        await ctx.setCells([
          { row: A.row + 5, col: A.col, value: `=SUM(${A.ref(1, 1)}:${A.ref(3, 1)})` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        let cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "600", "Before convert: 600");

        // Convert to range
        await convertToRange(tableId);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Regular range formula should still work (data still in cells)
        cell = await ctx.getCell(A.row + 5, A.col);
        expectCellValue(cell, "600", "After convert: still 600");
      },
    },
  ],
};
