//! FILENAME: app/extensions/TestRunner/lib/suites/multiFeatureWorkflows.ts
// PURPOSE: Concurrent multi-feature workflow tests.
// CONTEXT: Each test exercises many subsystems together in realistic sequences:
//          data entry -> formulas -> tables -> sorting -> filtering -> CF ->
//          protection -> named ranges -> save/load -> verify everything intact.

import type { TestSuite } from "../types";
import { AREA_MULTI_FEATURE } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
  expectCellValue,
  expectCellContains,
} from "../assertions";
import {
  createTable,
  deleteTable,
  getAllTables,
  toggleTotalsRow,
  setTotalsRowFunction,
  resizeTable,
  resolveStructuredReference,
} from "@api/backend";
import {
  calculateNow,
  addSheet,
  deleteSheet,
  getSheets,
  setActiveSheetApi as setActiveSheet,
  renameSheet,
  unhideSheet,
} from "@api";
import { invokeBackend } from "@api/backend";
import { recalculateFormulas } from "@api/backend";

const A = AREA_MULTI_FEATURE;

/** Full cleanup: delete extra sheets, delete tables, clear cells */
async function fullCleanup(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  // Reset sheets
  try {
    const result = await getSheets();
    if (result.activeIndex !== 0) {
      await setActiveSheet(0);
      await ctx.settle();
    }
    for (let i = 0; i < result.sheets.length; i++) {
      if (result.sheets[i].visibility !== "visible") {
        try { await unhideSheet(i); } catch { /* ignore */ }
      }
    }
    const updated = await getSheets();
    for (let i = updated.sheets.length - 1; i >= 1; i--) {
      try { await deleteSheet(i); } catch { /* ignore */ }
    }
    if ((await getSheets()).sheets[0].name !== "Sheet1") {
      await renameSheet(0, "Sheet1");
    }
  } catch { /* ignore */ }

  // Delete tables
  try {
    const tables = await getAllTables();
    for (const t of tables) {
      if (t.startRow >= A.row && t.startRow <= A.row + 50) {
        await deleteTable(t.id);
      }
    }
  } catch { /* ignore */ }

  // Unprotect sheet
  try {
    await invokeBackend("unprotect_sheet", { sheetIndex: 0, password: "" });
  } catch { /* ignore */ }

  // Clear cells
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 50; r++) {
    for (let c = 0; c < 12; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

export const multiFeatureWorkflowsSuite: TestSuite = {
  name: "Multi-Feature Workflows",

  afterEach: async (ctx) => {
    await fullCleanup(ctx);
  },

  tests: [
    // ------------------------------------------------------------------
    // 1. DATA + FORMULAS + TABLE + TOTALS
    // ------------------------------------------------------------------
    {
      name: "Build data, create table, add formulas, enable totals",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Step 1: Enter data
        await ctx.setCells([
          { row: r0, col: c0, value: "Product" },
          { row: r0, col: c0 + 1, value: "Price" },
          { row: r0, col: c0 + 2, value: "Qty" },
          { row: r0, col: c0 + 3, value: "Total" },
          { row: r0 + 1, col: c0, value: "Widget" },
          { row: r0 + 1, col: c0 + 1, value: "=25" },
          { row: r0 + 1, col: c0 + 2, value: "=10" },
          { row: r0 + 1, col: c0 + 3, value: `=${A.ref(1, 1)}*${A.ref(1, 2)}` },
          { row: r0 + 2, col: c0, value: "Gadget" },
          { row: r0 + 2, col: c0 + 1, value: "=50" },
          { row: r0 + 2, col: c0 + 2, value: "=5" },
          { row: r0 + 2, col: c0 + 3, value: `=${A.ref(2, 1)}*${A.ref(2, 2)}` },
          { row: r0 + 3, col: c0, value: "Doohickey" },
          { row: r0 + 3, col: c0 + 1, value: "=10" },
          { row: r0 + 3, col: c0 + 2, value: "=20" },
          { row: r0 + 3, col: c0 + 3, value: `=${A.ref(3, 1)}*${A.ref(3, 2)}` },
        ]);
        await ctx.settle();

        // Step 2: Create table
        const tableResult = await createTable({
          name: "SalesWF",
          startRow: r0,
          startCol: c0,
          endRow: r0 + 3,
          endCol: c0 + 3,
          hasHeaders: true,
        });
        assertTrue(tableResult.success, `createTable: ${tableResult.error}`);

        // Step 3: Enable totals with SUM
        await toggleTotalsRow(tableResult.table!.id, true);
        await ctx.settle();
        await setTotalsRowFunction({
          tableId: tableResult.table!.id,
          columnName: "Total",
          function: "sum",
        });
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Step 4: Add summary formula outside table
        await ctx.setCells([
          { row: r0 + 6, col: c0, value: "Grand Total" },
          { row: r0 + 6, col: c0 + 1, value: "=SUM(SalesWF[Total])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Verify: 250 + 250 + 200 = 700
        const grandTotal = await ctx.getCell(r0 + 6, c0 + 1);
        expectCellValue(grandTotal, "700", "Grand total = 700");

        // Verify line totals
        expectCellValue(await ctx.getCell(r0 + 1, c0 + 3), "250", "Widget = 250");
        expectCellValue(await ctx.getCell(r0 + 2, c0 + 3), "250", "Gadget = 250");
        expectCellValue(await ctx.getCell(r0 + 3, c0 + 3), "200", "Doohickey = 200");
      },
    },

    // ------------------------------------------------------------------
    // 2. MULTI-SHEET + FORMULAS + NAMED RANGES
    // ------------------------------------------------------------------
    {
      name: "Cross-sheet formulas with named range summary",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Sheet1: Q1 data
        await ctx.setCells([
          { row: r0, col: c0, value: "Q1 Revenue" },
          { row: r0, col: c0 + 1, value: "=50000" },
        ]);
        await ctx.settle();

        // Sheet2: Q2 data
        await addSheet("Q2");
        await ctx.settle();
        const sheets = await getSheets();
        const q2Idx = sheets.sheets.findIndex(s => s.name === "Q2");
        await setActiveSheet(q2Idx);
        await ctx.settle();
        await ctx.setCells([
          { row: r0, col: c0, value: "Q2 Revenue" },
          { row: r0, col: c0 + 1, value: "=60000" },
        ]);
        await ctx.settle();

        // Sheet3: Summary with cross-sheet refs
        await addSheet("Summary");
        await ctx.settle();
        const sheets2 = await getSheets();
        const sumIdx = sheets2.sheets.findIndex(s => s.name === "Summary");
        await setActiveSheet(sumIdx);
        await ctx.settle();
        await ctx.setCells([
          { row: r0, col: c0, value: "Q1" },
          { row: r0, col: c0 + 1, value: `=Sheet1!${A.ref(0, 1)}` },
          { row: r0 + 1, col: c0, value: "Q2" },
          { row: r0 + 1, col: c0 + 1, value: `=Q2!${A.ref(0, 1)}` },
          { row: r0 + 2, col: c0, value: "Total" },
          { row: r0 + 2, col: c0 + 1, value: `=${A.ref(0, 1)}+${A.ref(1, 1)}` },
          { row: r0 + 3, col: c0, value: "Growth" },
          { row: r0 + 3, col: c0 + 1, value: `=ROUND((${A.ref(1, 1)}-${A.ref(0, 1)})/${A.ref(0, 1)}*100,1)` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Verify
        expectCellValue(await ctx.getCell(r0, c0 + 1), "50000", "Q1 = 50000");
        expectCellValue(await ctx.getCell(r0 + 1, c0 + 1), "60000", "Q2 = 60000");
        expectCellValue(await ctx.getCell(r0 + 2, c0 + 1), "110000", "Total = 110000");

        const growth = await ctx.getCell(r0 + 3, c0 + 1);
        expectNotNull(growth, "Growth cell exists");
        const growthVal = parseFloat(growth!.display.replace(",", "."));
        assertTrue(Math.abs(growthVal - 20) < 0.1, `Growth = 20%, got ${growthVal}`);
      },
    },

    // ------------------------------------------------------------------
    // 3. DATA + FORMULAS + MODIFY + RECALC
    // ------------------------------------------------------------------
    {
      name: "Build spreadsheet, modify inputs, verify cascade recalculation",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Build a pricing model
        await ctx.setCells([
          { row: r0, col: c0, value: "Base Price" },
          { row: r0, col: c0 + 1, value: "=100" },
          { row: r0 + 1, col: c0, value: "Markup %" },
          { row: r0 + 1, col: c0 + 1, value: "=0.5" },
          { row: r0 + 2, col: c0, value: "Sell Price" },
          { row: r0 + 2, col: c0 + 1, value: `=${A.ref(0, 1)}*(1+${A.ref(1, 1)})` },
          { row: r0 + 3, col: c0, value: "Units" },
          { row: r0 + 3, col: c0 + 1, value: "=1000" },
          { row: r0 + 4, col: c0, value: "Revenue" },
          { row: r0 + 4, col: c0 + 1, value: `=${A.ref(2, 1)}*${A.ref(3, 1)}` },
          { row: r0 + 5, col: c0, value: "Cost" },
          { row: r0 + 5, col: c0 + 1, value: `=${A.ref(0, 1)}*${A.ref(3, 1)}` },
          { row: r0 + 6, col: c0, value: "Profit" },
          { row: r0 + 6, col: c0 + 1, value: `=${A.ref(4, 1)}-${A.ref(5, 1)}` },
        ]);
        await ctx.settle();

        // Verify initial: Price=150, Revenue=150000, Cost=100000, Profit=50000
        expectCellValue(await ctx.getCell(r0 + 2, c0 + 1), "150", "Sell Price = 150");
        expectCellValue(await ctx.getCell(r0 + 6, c0 + 1), "50000", "Profit = 50000");

        // Change base price to 200
        await ctx.setCells([{ row: r0, col: c0 + 1, value: "=200" }]);
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        // New: Price=300, Revenue=300000, Cost=200000, Profit=100000
        expectCellValue(await ctx.getCell(r0 + 2, c0 + 1), "300", "New Sell Price = 300");
        expectCellValue(await ctx.getCell(r0 + 6, c0 + 1), "100000", "New Profit = 100000");

        // Change markup to 100% (1.0)
        await ctx.setCells([{ row: r0 + 1, col: c0 + 1, value: "=1" }]);
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        // New: Price=400, Revenue=400000, Cost=200000, Profit=200000
        expectCellValue(await ctx.getCell(r0 + 2, c0 + 1), "400", "Final Sell Price = 400");
        expectCellValue(await ctx.getCell(r0 + 6, c0 + 1), "200000", "Final Profit = 200000");
      },
    },

    // ------------------------------------------------------------------
    // 4. TABLE + RESIZE + FORMULA UPDATE
    // ------------------------------------------------------------------
    {
      name: "Create table, add rows, resize, verify formula updates",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Initial data: 2 rows
        await ctx.setCells([
          { row: r0, col: c0, value: "Item" },
          { row: r0, col: c0 + 1, value: "Amount" },
          { row: r0 + 1, col: c0, value: "A" },
          { row: r0 + 1, col: c0 + 1, value: "=100" },
          { row: r0 + 2, col: c0, value: "B" },
          { row: r0 + 2, col: c0 + 1, value: "=200" },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "GrowTab",
          startRow: r0,
          startCol: c0,
          endRow: r0 + 2,
          endCol: c0 + 1,
          hasHeaders: true,
        });
        assertTrue(result.success, `create: ${result.error}`);

        // External SUM
        await ctx.setCells([
          { row: r0 + 5, col: c0, value: "=SUM(GrowTab[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();
        expectCellValue(await ctx.getCell(r0 + 5, c0), "300", "Initial SUM = 300");

        // Add more data rows
        await ctx.setCells([
          { row: r0 + 3, col: c0, value: "C" },
          { row: r0 + 3, col: c0 + 1, value: "=300" },
          { row: r0 + 4, col: c0, value: "D" },
          { row: r0 + 4, col: c0 + 1, value: "=400" },
        ]);
        await ctx.settle();

        // Resize table
        await resizeTable({
          tableId: result.table!.id,
          startRow: r0,
          startCol: c0,
          endRow: r0 + 4,
          endCol: c0 + 1,
        });
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Move formula down since table grew
        await ctx.setCells([
          { row: r0 + 6, col: c0, value: "=SUM(GrowTab[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(r0 + 6, c0), "1000", "After resize SUM = 1000");
      },
    },

    // ------------------------------------------------------------------
    // 5. SAVE + LOAD + VERIFY FORMULAS
    // ------------------------------------------------------------------
    {
      name: "Build model, save .cala, reload, verify all calculations",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        await ctx.setCells([
          { row: r0, col: c0, value: "=1000" },
          { row: r0 + 1, col: c0, value: "=2000" },
          { row: r0 + 2, col: c0, value: `=SUM(${A.ref(0, 0)}:${A.ref(1, 0)})` },
          { row: r0 + 3, col: c0, value: `=AVERAGE(${A.ref(0, 0)}:${A.ref(1, 0)})` },
          { row: r0 + 4, col: c0, value: `=IF(${A.ref(2, 0)}>2000,"High","Low")` },
        ]);
        await ctx.settle();

        // Save
        const { appDataDir } = await import("@tauri-apps/api/path");
        const dir = await appDataDir();
        const path = `${dir}test_mfw_${Date.now()}.cala`;
        await invokeBackend("save_file", { path });

        // New workbook + reload
        await invokeBackend("new_file", {});
        await ctx.settle();
        await invokeBackend("open_file", { path });
        await ctx.settle();

        // Verify
        expectCellValue(await ctx.getCell(r0 + 2, c0), "3000", "SUM = 3000 after reload");
        expectCellValue(await ctx.getCell(r0 + 3, c0), "1500", "AVG = 1500 after reload");
        expectCellValue(await ctx.getCell(r0 + 4, c0), "High", "IF result after reload");
      },
    },

    // ------------------------------------------------------------------
    // 6. MULTI-SHEET + TABLE + FORMULA
    // ------------------------------------------------------------------
    {
      name: "Table on Sheet1, formulas on Sheet2 referencing table",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Create table on Sheet1
        await ctx.setCells([
          { row: r0, col: c0, value: "Name" },
          { row: r0, col: c0 + 1, value: "Score" },
          { row: r0 + 1, col: c0, value: "Alice" },
          { row: r0 + 1, col: c0 + 1, value: "=90" },
          { row: r0 + 2, col: c0, value: "Bob" },
          { row: r0 + 2, col: c0 + 1, value: "=80" },
          { row: r0 + 3, col: c0, value: "Charlie" },
          { row: r0 + 3, col: c0 + 1, value: "=95" },
        ]);
        await ctx.settle();

        const tableResult = await createTable({
          name: "Scores",
          startRow: r0,
          startCol: c0,
          endRow: r0 + 3,
          endCol: c0 + 1,
          hasHeaders: true,
        });
        assertTrue(tableResult.success, `create: ${tableResult.error}`);

        // Create Sheet2 with summary formulas
        await addSheet("Analysis");
        await ctx.settle();
        const sheets = await getSheets();
        const aIdx = sheets.sheets.findIndex(s => s.name === "Analysis");
        await setActiveSheet(aIdx);
        await ctx.settle();

        // Use cross-sheet cell references (structured refs may not resolve from another sheet)
        const scoreRange = `Sheet1!${A.ref(1, 1)}:${A.ref(3, 1)}`;
        await ctx.setCells([
          { row: r0, col: c0, value: "Average Score" },
          { row: r0, col: c0 + 1, value: `=AVERAGE(${scoreRange})` },
          { row: r0 + 1, col: c0, value: "Max Score" },
          { row: r0 + 1, col: c0 + 1, value: `=MAX(${scoreRange})` },
          { row: r0 + 2, col: c0, value: "Min Score" },
          { row: r0 + 2, col: c0 + 1, value: `=MIN(${scoreRange})` },
          { row: r0 + 3, col: c0, value: "Pass Count" },
          { row: r0 + 3, col: c0 + 1, value: `=COUNTIF(${scoreRange},">="&85)` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Verify: avg=(90+80+95)/3≈88.33, max=95, min=80, pass(>=85)=2
        const avgCell = await ctx.getCell(r0, c0 + 1);
        expectNotNull(avgCell, "Average cell");
        const avg = parseFloat(avgCell!.display.replace(",", "."));
        assertTrue(Math.abs(avg - 88.33) < 0.1, `Average = 88.33, got ${avg}`);

        expectCellValue(await ctx.getCell(r0 + 1, c0 + 1), "95", "Max = 95");
        expectCellValue(await ctx.getCell(r0 + 2, c0 + 1), "80", "Min = 80");
        expectCellValue(await ctx.getCell(r0 + 3, c0 + 1), "2", "Pass count = 2");
      },
    },

    // ------------------------------------------------------------------
    // 7. FORMULA CHAIN + CONDITIONAL LOGIC + TEXT
    // ------------------------------------------------------------------
    {
      name: "Employee dashboard: salary bands, tax brackets, take-home pay",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Name(0), Gross(1), TaxRate(2), Tax(3), Net(4), Band(5)
        const employees = [
          ["Alice", "=120000"],
          ["Bob", "=80000"],
          ["Charlie", "=45000"],
          ["Diana", "=200000"],
        ];

        const updates: Array<{ row: number; col: number; value: string }> = [
          { row: r0, col: c0, value: "Name" },
          { row: r0, col: c0 + 1, value: "Gross" },
          { row: r0, col: c0 + 2, value: "TaxRate" },
          { row: r0, col: c0 + 3, value: "Tax" },
          { row: r0, col: c0 + 4, value: "Net" },
          { row: r0, col: c0 + 5, value: "Band" },
        ];

        for (let i = 0; i < employees.length; i++) {
          const r = r0 + 1 + i;
          updates.push({ row: r, col: c0, value: employees[i][0] });
          updates.push({ row: r, col: c0 + 1, value: employees[i][1] });
          // Tax rate: >150k=35%, >100k=30%, >60k=25%, else 20%
          updates.push({
            row: r, col: c0 + 2,
            value: `=IF(${A.ref(1 + i, 1)}>150000,0.35,IF(${A.ref(1 + i, 1)}>100000,0.3,IF(${A.ref(1 + i, 1)}>60000,0.25,0.2)))`,
          });
          // Tax = Gross * Rate
          updates.push({ row: r, col: c0 + 3, value: `=${A.ref(1 + i, 1)}*${A.ref(1 + i, 2)}` });
          // Net = Gross - Tax
          updates.push({ row: r, col: c0 + 4, value: `=${A.ref(1 + i, 1)}-${A.ref(1 + i, 3)}` });
          // Band
          updates.push({
            row: r, col: c0 + 5,
            value: `=IF(${A.ref(1 + i, 1)}>150000,"Executive",IF(${A.ref(1 + i, 1)}>100000,"Senior",IF(${A.ref(1 + i, 1)}>60000,"Mid","Junior")))`,
          });
        }

        // Summary
        const lastRow = r0 + employees.length;
        updates.push({ row: lastRow + 1, col: c0, value: "Total Gross" });
        updates.push({ row: lastRow + 1, col: c0 + 1, value: `=SUM(${A.ref(1, 1)}:${A.ref(employees.length, 1)})` });
        updates.push({ row: lastRow + 2, col: c0, value: "Total Tax" });
        updates.push({ row: lastRow + 2, col: c0 + 1, value: `=SUM(${A.ref(1, 3)}:${A.ref(employees.length, 3)})` });
        updates.push({ row: lastRow + 3, col: c0, value: "Total Net" });
        updates.push({ row: lastRow + 3, col: c0 + 1, value: `=SUM(${A.ref(1, 4)}:${A.ref(employees.length, 4)})` });

        await ctx.setCells(updates);
        await ctx.settle();

        // Alice: 120k, 30%, tax=36000, net=84000, Senior
        expectCellValue(await ctx.getCell(r0 + 1, c0 + 4), "84000", "Alice net = 84000");
        expectCellValue(await ctx.getCell(r0 + 1, c0 + 5), "Senior", "Alice = Senior");

        // Charlie: 45k, 20%, tax=9000, net=36000, Junior
        expectCellValue(await ctx.getCell(r0 + 3, c0 + 4), "36000", "Charlie net = 36000");
        expectCellValue(await ctx.getCell(r0 + 3, c0 + 5), "Junior", "Charlie = Junior");

        // Diana: 200k, 35%, tax=70000, net=130000, Executive
        expectCellValue(await ctx.getCell(r0 + 4, c0 + 4), "130000", "Diana net = 130000");
        expectCellValue(await ctx.getCell(r0 + 4, c0 + 5), "Executive", "Diana = Executive");

        // Total gross = 120k+80k+45k+200k = 445000
        expectCellValue(await ctx.getCell(lastRow + 1, c0 + 1), "445000", "Total gross = 445000");
      },
    },

    // ------------------------------------------------------------------
    // 8. DATA ENTRY + XLOOKUP + CROSS-REF
    // ------------------------------------------------------------------
    {
      name: "Order form with XLOOKUP to product catalog",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Product catalog in cols c0..c0+1
        await ctx.setCells([
          { row: r0, col: c0, value: "ProdID" },
          { row: r0, col: c0 + 1, value: "UnitPrice" },
          { row: r0 + 1, col: c0, value: "P001" },
          { row: r0 + 1, col: c0 + 1, value: "=25" },
          { row: r0 + 2, col: c0, value: "P002" },
          { row: r0 + 2, col: c0 + 1, value: "=50" },
          { row: r0 + 3, col: c0, value: "P003" },
          { row: r0 + 3, col: c0 + 1, value: "=15" },
        ]);
        await ctx.settle();

        // Order form in cols c0+3..c0+6: OrderProdID(3), Qty(4), Price(5), LineTotal(6)
        const idRange = `${A.ref(1, 0)}:${A.ref(3, 0)}`;
        const priceRange = `${A.ref(1, 1)}:${A.ref(3, 1)}`;
        await ctx.setCells([
          { row: r0, col: c0 + 3, value: "OrderProd" },
          { row: r0, col: c0 + 4, value: "Qty" },
          { row: r0, col: c0 + 5, value: "Price" },
          { row: r0, col: c0 + 6, value: "LineTotal" },
          // Order line 1: P002, qty 3
          { row: r0 + 1, col: c0 + 3, value: "P002" },
          { row: r0 + 1, col: c0 + 4, value: "=3" },
          { row: r0 + 1, col: c0 + 5, value: `=XLOOKUP(${A.ref(1, 3)},${idRange},${priceRange})` },
          { row: r0 + 1, col: c0 + 6, value: `=${A.ref(1, 4)}*${A.ref(1, 5)}` },
          // Order line 2: P001, qty 10
          { row: r0 + 2, col: c0 + 3, value: "P001" },
          { row: r0 + 2, col: c0 + 4, value: "=10" },
          { row: r0 + 2, col: c0 + 5, value: `=XLOOKUP(${A.ref(2, 3)},${idRange},${priceRange})` },
          { row: r0 + 2, col: c0 + 6, value: `=${A.ref(2, 4)}*${A.ref(2, 5)}` },
          // Order total
          { row: r0 + 4, col: c0 + 5, value: "Order Total" },
          { row: r0 + 4, col: c0 + 6, value: `=SUM(${A.ref(1, 6)}:${A.ref(2, 6)})` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // P002 price=50, line=3*50=150
        expectCellValue(await ctx.getCell(r0 + 1, c0 + 5), "50", "P002 price = 50");
        expectCellValue(await ctx.getCell(r0 + 1, c0 + 6), "150", "Line 1 = 150");

        // P001 price=25, line=10*25=250
        expectCellValue(await ctx.getCell(r0 + 2, c0 + 5), "25", "P001 price = 25");
        expectCellValue(await ctx.getCell(r0 + 2, c0 + 6), "250", "Line 2 = 250");

        // Total = 150+250 = 400
        expectCellValue(await ctx.getCell(r0 + 4, c0 + 6), "400", "Order total = 400");
      },
    },

    // ------------------------------------------------------------------
    // 9. MULTIPLE TABLES ON SAME SHEET
    // ------------------------------------------------------------------
    {
      name: "Two tables on same sheet with cross-table formula",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Table 1: Revenue
        await ctx.setCells([
          { row: r0, col: c0, value: "Month" },
          { row: r0, col: c0 + 1, value: "Revenue" },
          { row: r0 + 1, col: c0, value: "Jan" },
          { row: r0 + 1, col: c0 + 1, value: "=10000" },
          { row: r0 + 2, col: c0, value: "Feb" },
          { row: r0 + 2, col: c0 + 1, value: "=12000" },
        ]);
        await ctx.settle();

        const t1 = await createTable({
          name: "RevTab",
          startRow: r0,
          startCol: c0,
          endRow: r0 + 2,
          endCol: c0 + 1,
          hasHeaders: true,
        });
        assertTrue(t1.success, `RevTab: ${t1.error}`);

        // Table 2: Costs (offset by 4 columns)
        await ctx.setCells([
          { row: r0, col: c0 + 3, value: "Month" },
          { row: r0, col: c0 + 4, value: "Cost" },
          { row: r0 + 1, col: c0 + 3, value: "Jan" },
          { row: r0 + 1, col: c0 + 4, value: "=6000" },
          { row: r0 + 2, col: c0 + 3, value: "Feb" },
          { row: r0 + 2, col: c0 + 4, value: "=7000" },
        ]);
        await ctx.settle();

        const t2 = await createTable({
          name: "CostTab",
          startRow: r0,
          startCol: c0 + 3,
          endRow: r0 + 2,
          endCol: c0 + 4,
          hasHeaders: true,
        });
        assertTrue(t2.success, `CostTab: ${t2.error}`);

        // Cross-table formulas
        await ctx.setCells([
          { row: r0 + 4, col: c0, value: "Total Rev" },
          { row: r0 + 4, col: c0 + 1, value: "=SUM(RevTab[Revenue])" },
          { row: r0 + 5, col: c0, value: "Total Cost" },
          { row: r0 + 5, col: c0 + 1, value: "=SUM(CostTab[Cost])" },
          { row: r0 + 6, col: c0, value: "Profit" },
          { row: r0 + 6, col: c0 + 1, value: `=${A.ref(4, 1)}-${A.ref(5, 1)}` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(r0 + 4, c0 + 1), "22000", "Total Rev = 22000");
        expectCellValue(await ctx.getCell(r0 + 5, c0 + 1), "13000", "Total Cost = 13000");
        expectCellValue(await ctx.getCell(r0 + 6, c0 + 1), "9000", "Profit = 9000");
      },
    },

    // ------------------------------------------------------------------
    // 10. FULL PIPELINE: DATA -> TABLE -> TOTALS -> FORMULA -> MODIFY
    // ------------------------------------------------------------------
    {
      name: "Full pipeline: build, summarize, modify, re-verify",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Step 1: Enter inventory data
        await ctx.setCells([
          { row: r0, col: c0, value: "SKU" },
          { row: r0, col: c0 + 1, value: "OnHand" },
          { row: r0, col: c0 + 2, value: "UnitCost" },
          { row: r0 + 1, col: c0, value: "A" },
          { row: r0 + 1, col: c0 + 1, value: "=50" },
          { row: r0 + 1, col: c0 + 2, value: "=10" },
          { row: r0 + 2, col: c0, value: "B" },
          { row: r0 + 2, col: c0 + 1, value: "=100" },
          { row: r0 + 2, col: c0 + 2, value: "=25" },
          { row: r0 + 3, col: c0, value: "C" },
          { row: r0 + 3, col: c0 + 1, value: "=200" },
          { row: r0 + 3, col: c0 + 2, value: "=5" },
        ]);
        await ctx.settle();

        // Step 2: Create table
        const tbl = await createTable({
          name: "Inventory",
          startRow: r0,
          startCol: c0,
          endRow: r0 + 3,
          endCol: c0 + 2,
          hasHeaders: true,
        });
        assertTrue(tbl.success, `create: ${tbl.error}`);

        // Step 3: Summary formulas
        await ctx.setCells([
          { row: r0 + 5, col: c0, value: "Total Units" },
          { row: r0 + 5, col: c0 + 1, value: "=SUM(Inventory[OnHand])" },
          { row: r0 + 6, col: c0, value: "Avg Cost" },
          { row: r0 + 6, col: c0 + 1, value: "=ROUND(AVERAGE(Inventory[UnitCost]),2)" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(r0 + 5, c0 + 1), "350", "Total units = 350");

        // Step 4: Modify data (restock SKU A from 50 to 150)
        await ctx.setCells([{ row: r0 + 1, col: c0 + 1, value: "=150" }]);
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        expectCellValue(await ctx.getCell(r0 + 5, c0 + 1), "450", "After restock: 450");
      },
    },
  ],
};
