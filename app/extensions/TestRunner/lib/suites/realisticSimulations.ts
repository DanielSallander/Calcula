//! FILENAME: app/extensions/TestRunner/lib/suites/realisticSimulations.ts
// PURPOSE: Realistic full-spreadsheet simulation tests.
// CONTEXT: Each test builds an entire realistic spreadsheet layout with mock data,
//          formulas, tables, cross-sheet references, and dashboards — then verifies
//          correctness end-to-end. Simulates real-world spreadsheet use cases.

import type { TestSuite } from "../types";
import { AREA_SIMULATIONS } from "../testArea";
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

const A = AREA_SIMULATIONS;

/** Full cleanup */
async function fullCleanup(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  try {
    const result = await getSheets();
    if (result.activeIndex !== 0) { await setActiveSheet(0); await ctx.settle(); }
    for (let i = 0; i < result.sheets.length; i++) {
      if (result.sheets[i].visibility !== "visible") {
        try { await unhideSheet(i); } catch { /* */ }
      }
    }
    const updated = await getSheets();
    for (let i = updated.sheets.length - 1; i >= 1; i--) {
      try { await deleteSheet(i); } catch { /* */ }
    }
    if ((await getSheets()).sheets[0].name !== "Sheet1") {
      await renameSheet(0, "Sheet1");
    }
  } catch { /* */ }
  try {
    const tables = await getAllTables();
    for (const t of tables) { await deleteTable(t.id); }
  } catch { /* */ }
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 80; r++) {
    for (let c = 0; c < 12; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

/** Helper to switch to a sheet by name */
async function goToSheet(name: string, ctx: { settle: () => Promise<void> }) {
  const sheets = await getSheets();
  const idx = sheets.sheets.findIndex(s => s.name === name);
  assertTrue(idx >= 0, `Sheet "${name}" should exist`);
  await setActiveSheet(idx);
  await ctx.settle();
}

export const realisticSimulationsSuite: TestSuite = {
  name: "Realistic Simulations",

  afterEach: async (ctx) => {
    await fullCleanup(ctx);
  },

  tests: [
    // ==================================================================
    // 1. COMPANY P&L (3 SHEETS: Assumptions, P&L, Dashboard)
    // ==================================================================
    {
      name: "Simulation: 3-sheet company P&L model",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // === SHEET 1: Assumptions ===
        await renameSheet(0, "Assumptions");
        await ctx.settle();
        await ctx.setCells([
          { row: r, col: c, value: "Parameter" },
          { row: r, col: c + 1, value: "Value" },
          { row: r + 1, col: c, value: "Revenue Growth" },
          { row: r + 1, col: c + 1, value: "=0.15" },
          { row: r + 2, col: c, value: "COGS %" },
          { row: r + 2, col: c + 1, value: "=0.55" },
          { row: r + 3, col: c, value: "SGA %" },
          { row: r + 3, col: c + 1, value: "=0.20" },
          { row: r + 4, col: c, value: "Tax Rate" },
          { row: r + 4, col: c + 1, value: "=0.25" },
          { row: r + 5, col: c, value: "Base Revenue" },
          { row: r + 5, col: c + 1, value: "=1000000" },
        ]);
        await ctx.settle();

        // === SHEET 2: P&L ===
        await addSheet("PnL");
        await ctx.settle();
        await goToSheet("PnL", ctx);

        // Build 4-year P&L: Year headers
        await ctx.setCells([
          { row: r, col: c, value: "Line Item" },
          { row: r, col: c + 1, value: "Year 1" },
          { row: r, col: c + 2, value: "Year 2" },
          { row: r, col: c + 3, value: "Year 3" },
          { row: r, col: c + 4, value: "Year 4" },
        ]);
        await ctx.settle();

        const baseRev = `Assumptions!${A.ref(5, 1)}`;
        const growth = `Assumptions!${A.ref(1, 1)}`;
        const cogsPct = `Assumptions!${A.ref(2, 1)}`;
        const sgaPct = `Assumptions!${A.ref(3, 1)}`;
        const taxRate = `Assumptions!${A.ref(4, 1)}`;

        // Revenue row
        const revUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r + 1, col: c, value: "Revenue" },
          { row: r + 1, col: c + 1, value: `=${baseRev}` },
        ];
        for (let y = 2; y <= 4; y++) {
          revUpdates.push({
            row: r + 1, col: c + y,
            value: `=${A.ref(1, y - 1)}*(1+${growth})`,
          });
        }

        // COGS row
        const cogsUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r + 2, col: c, value: "COGS" },
        ];
        for (let y = 1; y <= 4; y++) {
          cogsUpdates.push({
            row: r + 2, col: c + y,
            value: `=${A.ref(1, y)}*${cogsPct}`,
          });
        }

        // Gross Profit
        const gpUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r + 3, col: c, value: "Gross Profit" },
        ];
        for (let y = 1; y <= 4; y++) {
          gpUpdates.push({
            row: r + 3, col: c + y,
            value: `=${A.ref(1, y)}-${A.ref(2, y)}`,
          });
        }

        // SGA
        const sgaUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r + 4, col: c, value: "SGA" },
        ];
        for (let y = 1; y <= 4; y++) {
          sgaUpdates.push({
            row: r + 4, col: c + y,
            value: `=${A.ref(1, y)}*${sgaPct}`,
          });
        }

        // EBIT
        const ebitUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r + 5, col: c, value: "EBIT" },
        ];
        for (let y = 1; y <= 4; y++) {
          ebitUpdates.push({
            row: r + 5, col: c + y,
            value: `=${A.ref(3, y)}-${A.ref(4, y)}`,
          });
        }

        // Tax
        const taxUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r + 6, col: c, value: "Tax" },
        ];
        for (let y = 1; y <= 4; y++) {
          taxUpdates.push({
            row: r + 6, col: c + y,
            value: `=${A.ref(5, y)}*${taxRate}`,
          });
        }

        // Net Income
        const niUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r + 7, col: c, value: "Net Income" },
        ];
        for (let y = 1; y <= 4; y++) {
          niUpdates.push({
            row: r + 7, col: c + y,
            value: `=${A.ref(5, y)}-${A.ref(6, y)}`,
          });
        }

        // Margin %
        const marginUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r + 8, col: c, value: "Net Margin %" },
        ];
        for (let y = 1; y <= 4; y++) {
          marginUpdates.push({
            row: r + 8, col: c + y,
            value: `=ROUND(${A.ref(7, y)}/${A.ref(1, y)}*100,1)`,
          });
        }

        await ctx.setCells([
          ...revUpdates, ...cogsUpdates, ...gpUpdates,
          ...sgaUpdates, ...ebitUpdates, ...taxUpdates,
          ...niUpdates, ...marginUpdates,
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Year 1: Rev=1M, COGS=550k, GP=450k, SGA=200k, EBIT=250k, Tax=62500, NI=187500
        const y1Rev = await ctx.getCell(r + 1, c + 1);
        expectCellValue(y1Rev, "1000000", "Y1 Revenue = 1M");

        const y1NI = await ctx.getCell(r + 7, c + 1);
        expectCellValue(y1NI, "187500", "Y1 Net Income = 187500");

        // Year 2: Rev=1M*1.15=1150000
        const y2Rev = await ctx.getCell(r + 1, c + 2);
        expectCellValue(y2Rev, "1150000", "Y2 Revenue = 1.15M");

        // Y1 Margin: 187500/1000000*100 = 18.75 -> 18.8 (ROUND 1 decimal)
        const y1Margin = await ctx.getCell(r + 8, c + 1);
        expectNotNull(y1Margin, "Y1 Margin exists");
        const marginVal = parseFloat(y1Margin!.display.replace(",", "."));
        assertTrue(Math.abs(marginVal - 18.8) < 0.1, `Y1 Margin = 18.8, got ${marginVal}`);

        // === SHEET 3: Dashboard ===
        await addSheet("Dashboard");
        await ctx.settle();
        await goToSheet("Dashboard", ctx);
        await ctx.setCells([
          { row: r, col: c, value: "KPI" },
          { row: r, col: c + 1, value: "Value" },
          { row: r + 1, col: c, value: "Total Revenue (4yr)" },
          { row: r + 1, col: c + 1, value: `=SUM(PnL!${A.ref(1, 1)}:${A.ref(1, 4)})` },
          { row: r + 2, col: c, value: "Total Net Income" },
          { row: r + 2, col: c + 1, value: `=SUM(PnL!${A.ref(7, 1)}:${A.ref(7, 4)})` },
          { row: r + 3, col: c, value: "Y4 Revenue" },
          { row: r + 3, col: c + 1, value: `=PnL!${A.ref(1, 4)}` },
          { row: r + 4, col: c, value: "CAGR Revenue" },
          { row: r + 4, col: c + 1, value: `=ROUND((PnL!${A.ref(1, 4)}/PnL!${A.ref(1, 1)})^(1/3)-1,4)` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Y4 Rev = 1M * 1.15^3 = 1521243.75 (approx)
        const y4Rev = await ctx.getCell(r + 3, c + 1);
        expectNotNull(y4Rev, "Y4 Revenue on Dashboard");
        const y4Val = parseFloat(y4Rev!.display.replace(/\s/g, "").replace(",", "."));
        assertTrue(y4Val > 1500000 && y4Val < 1600000, `Y4 Rev should be ~1.5M, got ${y4Val}`);

        // CAGR = 15% = 0.15
        const cagr = await ctx.getCell(r + 4, c + 1);
        expectNotNull(cagr, "CAGR exists");
        const cagrVal = parseFloat(cagr!.display.replace(",", "."));
        assertTrue(Math.abs(cagrVal - 0.15) < 0.001, `CAGR = 0.15, got ${cagrVal}`);

        // Now change an assumption and verify cascade
        await goToSheet("Assumptions", ctx);
        await ctx.setCells([{ row: r + 1, col: c + 1, value: "=0.20" }]); // Growth -> 20%
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        await goToSheet("PnL", ctx);
        await ctx.settle();
        // Y2 Rev should now be 1M*1.2 = 1200000
        const y2RevNew = await ctx.getCell(r + 1, c + 2);
        expectCellValue(y2RevNew, "1200000", "After growth change: Y2 Rev = 1.2M");
      },
    },

    // ==================================================================
    // 2. EMPLOYEE PAYROLL WITH TABLE + LOOKUPS
    // ==================================================================
    {
      name: "Simulation: employee payroll with tax brackets and benefits table",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // Tax bracket table
        await ctx.setCells([
          { row: r, col: c, value: "Bracket" },
          { row: r, col: c + 1, value: "Rate" },
          { row: r + 1, col: c, value: "=0" },
          { row: r + 1, col: c + 1, value: "=0.10" },
          { row: r + 2, col: c, value: "=40000" },
          { row: r + 2, col: c + 1, value: "=0.22" },
          { row: r + 3, col: c, value: "=85000" },
          { row: r + 3, col: c + 1, value: "=0.32" },
          { row: r + 4, col: c, value: "=160000" },
          { row: r + 4, col: c + 1, value: "=0.37" },
        ]);
        await ctx.settle();

        // Employee data -- use columns 0..5 relative to A.col
        // Name(0), Salary(1), Benefits(2), TaxRate(3), Tax(4), NetPay(5)
        const employees = [
          ["Alice", "=120000", "=5000"],
          ["Bob", "=75000", "=3000"],
          ["Charlie", "=45000", "=2000"],
          ["Diana", "=200000", "=8000"],
          ["Eve", "=55000", "=2500"],
          ["Frank", "=95000", "=4000"],
        ];

        const empUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r, col: c, value: "Name" },
          { row: r, col: c + 1, value: "Salary" },
          { row: r, col: c + 2, value: "Benefits" },
          { row: r, col: c + 3, value: "TaxRate" },
          { row: r, col: c + 4, value: "Tax" },
          { row: r, col: c + 5, value: "NetPay" },
        ];

        for (let i = 0; i < employees.length; i++) {
          const ri = 1 + i; // row offset from A.row
          empUpdates.push({ row: r + ri, col: c, value: employees[i][0] });
          empUpdates.push({ row: r + ri, col: c + 1, value: employees[i][1] });
          empUpdates.push({ row: r + ri, col: c + 2, value: employees[i][2] });
          // Tax rate via nested IF on salary
          const sal = A.ref(ri, 1);
          empUpdates.push({
            row: r + ri, col: c + 3,
            value: `=IF(${sal}>=160000,0.37,IF(${sal}>=85000,0.32,IF(${sal}>=40000,0.22,0.1)))`,
          });
          // Tax = Salary * Rate
          empUpdates.push({
            row: r + ri, col: c + 4,
            value: `=${A.ref(ri, 1)}*${A.ref(ri, 3)}`,
          });
          // Net = Salary - Tax - Benefits
          empUpdates.push({
            row: r + ri, col: c + 5,
            value: `=${A.ref(ri, 1)}-${A.ref(ri, 4)}-${A.ref(ri, 2)}`,
          });
        }

        // Summary row
        const lastEmp = r + employees.length;
        empUpdates.push({ row: lastEmp + 1, col: c, value: "TOTALS" });
        empUpdates.push({
          row: lastEmp + 1, col: c + 1,
          value: `=SUM(${A.ref(1, 1)}:${A.ref(employees.length, 1)})`,
        });
        empUpdates.push({
          row: lastEmp + 1, col: c + 4,
          value: `=SUM(${A.ref(1, 4)}:${A.ref(employees.length, 4)})`,
        });
        empUpdates.push({
          row: lastEmp + 1, col: c + 5,
          value: `=SUM(${A.ref(1, 5)}:${A.ref(employees.length, 5)})`,
        });

        await ctx.setCells(empUpdates);
        await ctx.settle();

        // Alice: 120k, rate=0.32, tax=38400, ben=5000, net=76600
        const aliceTax = await ctx.getCell(r + 1, c + 4);
        expectCellValue(aliceTax, "38400", "Alice tax = 38400");

        const aliceNet = await ctx.getCell(r + 1, c + 5);
        expectCellValue(aliceNet, "76600", "Alice net = 76600");

        // Diana: 200k, rate=0.37, tax=74000, ben=8000, net=118000
        const dianaTax = await ctx.getCell(r + 4, c + 4);
        expectCellValue(dianaTax, "74000", "Diana tax = 74000");

        const dianaNet = await ctx.getCell(r + 4, c + 5);
        expectCellValue(dianaNet, "118000", "Diana net = 118000");

        // Total salary = 120k+75k+45k+200k+55k+95k = 590000
        const totalSal = await ctx.getCell(lastEmp + 1, c + 1);
        expectCellValue(totalSal, "590000", "Total salary = 590000");
      },
    },

    // ==================================================================
    // 3. PRODUCT CATALOG + ORDER SYSTEM
    // ==================================================================
    {
      name: "Simulation: product catalog with order sheet and inventory tracking",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // Product catalog table
        await ctx.setCells([
          { row: r, col: c, value: "SKU" },
          { row: r, col: c + 1, value: "Name" },
          { row: r, col: c + 2, value: "Price" },
          { row: r, col: c + 3, value: "Stock" },
          { row: r + 1, col: c, value: "SKU001" },
          { row: r + 1, col: c + 1, value: "Widget Pro" },
          { row: r + 1, col: c + 2, value: "=29.99" },
          { row: r + 1, col: c + 3, value: "=500" },
          { row: r + 2, col: c, value: "SKU002" },
          { row: r + 2, col: c + 1, value: "Gadget Max" },
          { row: r + 2, col: c + 2, value: "=49.99" },
          { row: r + 2, col: c + 3, value: "=200" },
          { row: r + 3, col: c, value: "SKU003" },
          { row: r + 3, col: c + 1, value: "Doohickey" },
          { row: r + 3, col: c + 2, value: "=9.99" },
          { row: r + 3, col: c + 3, value: "=1000" },
          { row: r + 4, col: c, value: "SKU004" },
          { row: r + 4, col: c + 1, value: "Thingamajig" },
          { row: r + 4, col: c + 2, value: "=79.99" },
          { row: r + 4, col: c + 3, value: "=100" },
        ]);
        await ctx.settle();

        const tbl = await createTable({
          name: "Catalog",
          startRow: r,
          startCol: c,
          endRow: r + 4,
          endCol: c + 3,
          hasHeaders: true,
        });
        assertTrue(tbl.success, `createTable: ${tbl.error}`);

        // Orders (offset to col+6)
        const oc = c + 6;
        const skuRange = `${A.ref(1, 0)}:${A.ref(4, 0)}`;
        const priceRange = `${A.ref(1, 2)}:${A.ref(4, 2)}`;
        const nameRange = `${A.ref(1, 1)}:${A.ref(4, 1)}`;

        const orders = [
          ["SKU002", "=3"],
          ["SKU001", "=10"],
          ["SKU003", "=25"],
          ["SKU004", "=1"],
          ["SKU001", "=5"],
          ["SKU002", "=2"],
        ];

        const orderUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r, col: oc, value: "OrderSKU" },
          { row: r, col: oc + 1, value: "Qty" },
          { row: r, col: oc + 2, value: "Product" },
          { row: r, col: oc + 3, value: "UnitPrice" },
          { row: r, col: oc + 4, value: "LineTotal" },
        ];

        for (let i = 0; i < orders.length; i++) {
          const or = r + 1 + i;
          orderUpdates.push({ row: or, col: oc, value: orders[i][0] });
          orderUpdates.push({ row: or, col: oc + 1, value: orders[i][1] });
          // XLOOKUP product name
          const skuRef = `${String.fromCharCode(75 + oc - c)}${or + 1}`;
          orderUpdates.push({
            row: or, col: oc + 2,
            value: `=XLOOKUP(${skuRef},${skuRange},${nameRange},"Unknown")`,
          });
          // XLOOKUP price
          orderUpdates.push({
            row: or, col: oc + 3,
            value: `=XLOOKUP(${skuRef},${skuRange},${priceRange},0)`,
          });
          // Line total
          const qty = `${String.fromCharCode(75 + oc + 1 - c)}${or + 1}`;
          const price = `${String.fromCharCode(75 + oc + 3 - c)}${or + 1}`;
          orderUpdates.push({
            row: or, col: oc + 4,
            value: `=${qty}*${price}`,
          });
        }

        // Order totals
        const lastOrder = r + orders.length;
        const ltCol = String.fromCharCode(75 + oc + 4 - c);
        orderUpdates.push({ row: lastOrder + 1, col: oc, value: "ORDER TOTAL" });
        orderUpdates.push({
          row: lastOrder + 1, col: oc + 4,
          value: `=SUM(${ltCol}${r + 2}:${ltCol}${lastOrder + 1})`,
        });

        await ctx.setCells(orderUpdates);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Order 1: SKU002, qty=3, price=49.99, total=149.97
        const o1Product = await ctx.getCell(r + 1, oc + 2);
        expectCellValue(o1Product, "Gadget Max", "Order 1 product = Gadget Max");

        const o1Total = await ctx.getCell(r + 1, oc + 4);
        expectNotNull(o1Total, "Order 1 total exists");
        const o1Val = parseFloat(o1Total!.display.replace(",", "."));
        assertTrue(Math.abs(o1Val - 149.97) < 0.01, `Order 1 total = 149.97, got ${o1Val}`);

        // Order total = 3*49.99 + 10*29.99 + 25*9.99 + 1*79.99 + 5*29.99 + 2*49.99
        //             = 149.97 + 299.90 + 249.75 + 79.99 + 149.95 + 99.98 = 1029.54
        const orderTotal = await ctx.getCell(lastOrder + 1, oc + 4);
        expectNotNull(orderTotal, "Order total exists");
        const otVal = parseFloat(orderTotal!.display.replace(",", "."));
        assertTrue(Math.abs(otVal - 1029.54) < 0.1, `Order total = 1029.54, got ${otVal}`);
      },
    },

    // ==================================================================
    // 4. MULTI-SHEET BUDGET WITH QUARTERLY BREAKDOWN
    // ==================================================================
    {
      name: "Simulation: quarterly budget across 4 sheets + annual summary",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        const categories = ["Salaries", "Marketing", "R&D", "Operations", "Travel"];
        const qData = [
          [120, 25, 50, 30, 10],  // Q1 (in thousands)
          [120, 30, 55, 32, 12],  // Q2
          [125, 35, 60, 35, 8],   // Q3
          [125, 40, 65, 38, 15],  // Q4
        ];

        // Create Q1-Q4 sheets with data
        for (let q = 0; q < 4; q++) {
          const sheetName = `Q${q + 1}`;
          if (q === 0) {
            await renameSheet(0, sheetName);
          } else {
            await addSheet(sheetName);
          }
          await ctx.settle();
          await goToSheet(sheetName, ctx);

          const updates: Array<{ row: number; col: number; value: string }> = [
            { row: r, col: c, value: "Category" },
            { row: r, col: c + 1, value: "Budget ($K)" },
          ];
          for (let i = 0; i < categories.length; i++) {
            updates.push({ row: r + 1 + i, col: c, value: categories[i] });
            updates.push({ row: r + 1 + i, col: c + 1, value: `=${qData[q][i]}` });
          }
          // Quarter total
          updates.push({ row: r + 6, col: c, value: "Q Total" });
          updates.push({
            row: r + 6, col: c + 1,
            value: `=SUM(${A.ref(1, 1)}:${A.ref(5, 1)})`,
          });
          await ctx.setCells(updates);
          await ctx.settle();
        }

        // Annual Summary sheet
        await addSheet("Annual");
        await ctx.settle();
        await goToSheet("Annual", ctx);

        const annualUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r, col: c, value: "Category" },
          { row: r, col: c + 1, value: "Q1" },
          { row: r, col: c + 2, value: "Q2" },
          { row: r, col: c + 3, value: "Q3" },
          { row: r, col: c + 4, value: "Q4" },
          { row: r, col: c + 5, value: "Annual" },
        ];

        for (let i = 0; i < categories.length; i++) {
          const dr = r + 1 + i;
          annualUpdates.push({ row: dr, col: c, value: categories[i] });
          for (let q = 1; q <= 4; q++) {
            annualUpdates.push({
              row: dr, col: c + q,
              value: `=Q${q}!${A.ref(1 + i, 1)}`,
            });
          }
          annualUpdates.push({
            row: dr, col: c + 5,
            value: `=SUM(${A.ref(1 + i, 1)}:${A.ref(1 + i, 4)})`,
          });
        }

        // Total row
        annualUpdates.push({ row: r + 6, col: c, value: "TOTAL" });
        for (let col = 1; col <= 5; col++) {
          annualUpdates.push({
            row: r + 6, col: c + col,
            value: `=SUM(${A.ref(1, col)}:${A.ref(5, col)})`,
          });
        }

        await ctx.setCells(annualUpdates);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Q1 total: 120+25+50+30+10 = 235
        const q1Total = await ctx.getCell(r + 1, c + 1); // Salaries Q1
        expectCellValue(q1Total, "120", "Q1 Salaries = 120");

        // Annual Salaries: 120+120+125+125 = 490
        const annSal = await ctx.getCell(r + 1, c + 5);
        expectCellValue(annSal, "490", "Annual Salaries = 490");

        // Annual Total: sum of all categories across all quarters
        // Q1=235, Q2=249, Q3=263, Q4=283 -> Total=1030
        const annTotal = await ctx.getCell(r + 6, c + 5);
        expectCellValue(annTotal, "1030", "Grand annual total = 1030");
      },
    },

    // ==================================================================
    // 5. GRADE BOOK WITH WEIGHTED CATEGORIES + CURVE
    // ==================================================================
    {
      name: "Simulation: university grade book with categories, weights, and curve",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // Weight config
        await ctx.setCells([
          { row: r, col: c, value: "Category" },
          { row: r, col: c + 1, value: "Weight" },
          { row: r + 1, col: c, value: "Homework" },
          { row: r + 1, col: c + 1, value: "=0.2" },
          { row: r + 2, col: c, value: "Midterm" },
          { row: r + 2, col: c + 1, value: "=0.3" },
          { row: r + 3, col: c, value: "Final" },
          { row: r + 3, col: c + 1, value: "=0.5" },
          { row: r + 4, col: c, value: "Curve" },
          { row: r + 4, col: c + 1, value: "=5" },
        ]);
        await ctx.settle();

        // Student data (offset col+3)
        const sc = c + 3;
        const students = [
          ["Alice",   "=95", "=88", "=92"],
          ["Bob",     "=78", "=72", "=68"],
          ["Charlie", "=100", "=95", "=97"],
          ["Diana",   "=60", "=55", "=62"],
          ["Eve",     "=85", "=90", "=88"],
          ["Frank",   "=92", "=85", "=80"],
          ["Grace",   "=70", "=65", "=71"],
          ["Henry",   "=88", "=92", "=94"],
        ];

        const hwW = A.ref(1, 1);
        const mtW = A.ref(2, 1);
        const fnW = A.ref(3, 1);
        const curve = A.ref(4, 1);

        const stuUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r, col: sc, value: "Student" },
          { row: r, col: sc + 1, value: "HW" },
          { row: r, col: sc + 2, value: "Midterm" },
          { row: r, col: sc + 3, value: "Final" },
          { row: r, col: sc + 4, value: "Weighted" },
          { row: r, col: sc + 5, value: "Curved" },
          { row: r, col: sc + 6, value: "Grade" },
        ];

        for (let i = 0; i < students.length; i++) {
          const sr = r + 1 + i;
          stuUpdates.push({ row: sr, col: sc, value: students[i][0] });
          stuUpdates.push({ row: sr, col: sc + 1, value: students[i][1] });
          stuUpdates.push({ row: sr, col: sc + 2, value: students[i][2] });
          stuUpdates.push({ row: sr, col: sc + 3, value: students[i][3] });
          // Weighted = HW*0.2 + MT*0.3 + Final*0.5
          const hwRef = `${String.fromCharCode(75 + sc + 1 - c)}${sr + 1}`;
          const mtRef = `${String.fromCharCode(75 + sc + 2 - c)}${sr + 1}`;
          const fnRef = `${String.fromCharCode(75 + sc + 3 - c)}${sr + 1}`;
          stuUpdates.push({
            row: sr, col: sc + 4,
            value: `=ROUND(${hwRef}*${hwW}+${mtRef}*${mtW}+${fnRef}*${fnW},1)`,
          });
          // Curved = MIN(Weighted + Curve, 100)
          const wtRef = `${String.fromCharCode(75 + sc + 4 - c)}${sr + 1}`;
          stuUpdates.push({
            row: sr, col: sc + 5,
            value: `=MIN(${wtRef}+${curve},100)`,
          });
          // Letter grade
          const cvRef = `${String.fromCharCode(75 + sc + 5 - c)}${sr + 1}`;
          stuUpdates.push({
            row: sr, col: sc + 6,
            value: `=IF(${cvRef}>=93,"A",IF(${cvRef}>=85,"B",IF(${cvRef}>=77,"C",IF(${cvRef}>=70,"D","F"))))`,
          });
        }

        // Stats
        const lastStu = r + students.length;
        const cvCol = `${String.fromCharCode(75 + sc + 5 - c)}`;
        stuUpdates.push({ row: lastStu + 2, col: sc, value: "Class Average" });
        stuUpdates.push({
          row: lastStu + 2, col: sc + 5,
          value: `=ROUND(AVERAGE(${cvCol}${r + 2}:${cvCol}${lastStu + 1}),1)`,
        });
        stuUpdates.push({ row: lastStu + 3, col: sc, value: "Highest" });
        stuUpdates.push({
          row: lastStu + 3, col: sc + 5,
          value: `=MAX(${cvCol}${r + 2}:${cvCol}${lastStu + 1})`,
        });
        stuUpdates.push({ row: lastStu + 4, col: sc, value: "Lowest" });
        stuUpdates.push({
          row: lastStu + 4, col: sc + 5,
          value: `=MIN(${cvCol}${r + 2}:${cvCol}${lastStu + 1})`,
        });
        stuUpdates.push({ row: lastStu + 5, col: sc, value: "A Count" });
        stuUpdates.push({
          row: lastStu + 5, col: sc + 5,
          value: `=COUNTIF(${cvCol}${r + 2}:${cvCol}${lastStu + 1},">="&93)`,
        });

        await ctx.setCells(stuUpdates);
        await ctx.settle();

        // Alice: HW=95, MT=88, Fin=92 -> 95*0.2+88*0.3+92*0.5 = 19+26.4+46 = 91.4
        // Curved = MIN(91.4+5, 100) = 96.4 -> A
        const aliceCurved = await ctx.getCell(r + 1, sc + 5);
        expectNotNull(aliceCurved, "Alice curved");
        const aliceVal = parseFloat(aliceCurved!.display.replace(",", "."));
        assertTrue(Math.abs(aliceVal - 96.4) < 0.2, `Alice curved = 96.4, got ${aliceVal}`);

        const aliceGrade = await ctx.getCell(r + 1, sc + 6);
        expectCellValue(aliceGrade, "A", "Alice grade = A");

        // Diana: HW=60, MT=55, Fin=62 -> 60*0.2+55*0.3+62*0.5 = 12+16.5+31 = 59.5
        // Curved = 64.5 -> F (< 70)
        const dianaGrade = await ctx.getCell(r + 4, sc + 6);
        expectCellValue(dianaGrade, "F", "Diana grade = F");

        // Charlie: 100*0.2+95*0.3+97*0.5 = 20+28.5+48.5 = 97 -> curved 100 (capped) -> A
        const charlieGrade = await ctx.getCell(r + 3, sc + 6);
        expectCellValue(charlieGrade, "A", "Charlie grade = A");
      },
    },
  ],
};
