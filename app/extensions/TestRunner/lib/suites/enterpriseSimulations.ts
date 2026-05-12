//! FILENAME: app/extensions/TestRunner/lib/suites/enterpriseSimulations.ts
// PURPOSE: Enterprise-grade spreadsheet simulations combining many features.
// CONTEXT: Each test builds a complete real-world spreadsheet with multiple
//          interacting subsystems: multi-sheet models, tables, named ranges,
//          cross-sheet lookups, conditional formatting, data validation,
//          sorting, filtering, goal seek, and scenarios -- all in one test.

import type { TestSuite } from "../types";
import { AREA_ENTERPRISE } from "../testArea";
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
  addConditionalFormat,
  deleteConditionalFormat,
  getAllConditionalFormats,
  goalSeek,
  scenarioAdd,
  scenarioShow,
  scenarioList,
  scenarioDelete,
  sortRange,
  applyAutoFilter,
  removeAutoFilter,
  setColumnFilterValues,
  isRowFiltered,
} from "@api/backend";
import {
  calculateNow,
  addSheet,
  deleteSheet,
  getSheets,
  setActiveSheetApi as setActiveSheet,
  renameSheet,
  unhideSheet,
  createNamedRange,
  deleteNamedRange,
  getAllNamedRanges,
  setDataValidation,
  clearDataValidation,
  mergeCells,
  unmergeCells,
  getMergedRegions,
} from "@api";
import { invokeBackend, recalculateFormulas } from "@api/backend";

const A = AREA_ENTERPRISE;

/** Full cleanup */
async function fullCleanup(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  // Sheets
  try {
    const result = await getSheets();
    if (result.activeIndex !== 0) { await setActiveSheet(0); await ctx.settle(); }
    for (let i = 0; i < result.sheets.length; i++) {
      if (result.sheets[i].visibility !== "visible") try { await unhideSheet(i); } catch { /**/ }
    }
    const updated = await getSheets();
    for (let i = updated.sheets.length - 1; i >= 1; i--) try { await deleteSheet(i); } catch { /**/ }
    if ((await getSheets()).sheets[0].name !== "Sheet1") await renameSheet(0, "Sheet1");
  } catch { /**/ }
  // Tables
  try { const t = await getAllTables(); for (const x of t) await deleteTable(x.id); } catch { /**/ }
  // Named ranges
  try { const nr = await getAllNamedRanges(); for (const x of nr) if (x.name.startsWith("Ent")) await deleteNamedRange(x.name); } catch { /**/ }
  // CF
  try { const cf = await getAllConditionalFormats(); for (const x of cf) if (x.ranges.some(r => r.startRow >= A.row)) await deleteConditionalFormat(x.id); } catch { /**/ }
  // AutoFilter
  try { await removeAutoFilter(); } catch { /**/ }
  // Scenarios
  try { const s = await scenarioList(0); for (const x of s.scenarios) await scenarioDelete({ name: x.name, sheetIndex: 0 }); } catch { /**/ }
  // Merge
  try { const m = await getMergedRegions(); for (const x of m) if (x.startRow >= A.row) await unmergeCells(x.startRow, x.startCol); } catch { /**/ }
  // Validation
  try { await clearDataValidation(A.row, A.col, A.row + 60, A.col + 10); } catch { /**/ }
  // Unprotect
  try { await invokeBackend("unprotect_sheet", { sheetIndex: 0, password: "" }); } catch { /**/ }
  // Cells
  await setActiveSheet(0); await ctx.settle();
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 60; r++) for (let c = 0; c < 12; c++) clears.push({ row: A.row + r, col: A.col + c, value: "" });
  await ctx.setCells(clears);
  await ctx.settle();
}

async function goToSheet(name: string, ctx: { settle: () => Promise<void> }) {
  const sheets = await getSheets();
  const idx = sheets.sheets.findIndex(s => s.name === name);
  assertTrue(idx >= 0, `Sheet "${name}" should exist`);
  await setActiveSheet(idx);
  await ctx.settle();
}

export const enterpriseSimulationsSuite: TestSuite = {
  name: "Enterprise Simulations",
  afterEach: async (ctx) => { await fullCleanup(ctx); },

  tests: [
    // ==================================================================
    // 1. SALES PIPELINE: Table + Sort + Filter + Named Range + CF + Summary
    // ==================================================================
    {
      name: "Sales pipeline: table + sort + filter + CF + named range summary",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // Build sales data
        const deals = [
          ["Acme Corp", "North", "=50000", "Won"],
          ["Beta Inc", "South", "=30000", "Lost"],
          ["Gamma LLC", "North", "=75000", "Won"],
          ["Delta Co", "East", "=20000", "Pending"],
          ["Epsilon SA", "South", "=90000", "Won"],
          ["Zeta Ltd", "East", "=15000", "Lost"],
          ["Eta Group", "North", "=60000", "Pending"],
          ["Theta Corp", "West", "=45000", "Won"],
        ];

        const updates: Array<{ row: number; col: number; value: string }> = [
          { row: r, col: c, value: "Company" },
          { row: r, col: c + 1, value: "Region" },
          { row: r, col: c + 2, value: "Amount" },
          { row: r, col: c + 3, value: "Status" },
        ];
        for (let i = 0; i < deals.length; i++) {
          for (let j = 0; j < 4; j++) {
            updates.push({ row: r + 1 + i, col: c + j, value: deals[i][j] });
          }
        }
        await ctx.setCells(updates);
        await ctx.settle();

        // Create table
        const tbl = await createTable({
          name: "EntPipeline",
          startRow: r, startCol: c, endRow: r + deals.length, endCol: c + 3,
          hasHeaders: true,
        });
        assertTrue(tbl.success, `createTable: ${tbl.error}`);

        // Enable totals with SUM on Amount
        await toggleTotalsRow(tbl.table!.id, true);
        await setTotalsRowFunction({ tableId: tbl.table!.id, columnName: "Amount", function: "sum" });
        await ctx.settle();

        // Named range for Won deals amount column
        await createNamedRange("EntWonDeals", 0, `=Sheet1!${A.ref(1, 2)}:${A.ref(deals.length, 2)}`);

        // Summary formulas below table
        const sumRow = r + deals.length + 3;
        await ctx.setCells([
          { row: sumRow, col: c, value: "Total Pipeline" },
          { row: sumRow, col: c + 1, value: "=SUM(EntPipeline[Amount])" },
          { row: sumRow + 1, col: c, value: "Won Count" },
          { row: sumRow + 1, col: c + 1, value: `=COUNTIF(${A.ref(1, 3)}:${A.ref(deals.length, 3)},"Won")` },
          { row: sumRow + 2, col: c, value: "Avg Deal Size" },
          { row: sumRow + 2, col: c + 1, value: "=AVERAGE(EntPipeline[Amount])" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Verify total: 50+30+75+20+90+15+60+45 = 385000
        const total = await ctx.getCell(sumRow, c + 1);
        expectCellValue(total, "385000", "Total pipeline = 385000");

        // Won count: 4 (Acme, Gamma, Epsilon, Theta)
        expectCellValue(await ctx.getCell(sumRow + 1, c + 1), "4", "Won count = 4");

        // Sort by Amount descending
        await sortRange(r, c, r + deals.length, c + 3, [{ key: 2, ascending: false }], { hasHeaders: true });
        await ctx.settle();

        // First row after sort should be Epsilon (90000)
        const topDeal = await ctx.getCell(r + 1, c);
        expectCellValue(topDeal, "Epsilon SA", "Top deal after sort = Epsilon SA");

        // Add CF: highlight Won deals in green
        await addConditionalFormat({
          ranges: [{ startRow: r + 1, startCol: c + 3, endRow: r + deals.length, endCol: c + 3 }],
          rule: { type: "containsText", ruleType: "contains", text: "Won" },
          format: { backgroundColor: "#C6EFCE", textColor: "#006100" },
          stopIfTrue: false,
        });

        // Apply autofilter and show only Won
        await applyAutoFilter(r, c, r + deals.length, c + 3);
        await ctx.settle();
        await setColumnFilterValues(3, ["Won"]);
        await ctx.settle();

        // Lost/Pending rows should be hidden
        // Find a Lost row and check it's filtered
        let foundHidden = false;
        for (let i = 1; i <= deals.length; i++) {
          const hidden = await isRowFiltered(r + i);
          if (hidden) { foundHidden = true; break; }
        }
        assertTrue(foundHidden, "At least one non-Won row should be hidden");

        await deleteNamedRange("EntWonDeals");
      },
    },

    // ==================================================================
    // 2. MULTI-SHEET INVENTORY: Products + Warehouses + Dashboard
    // ==================================================================
    {
      name: "Multi-sheet inventory: products, warehouses, dashboard with XLOOKUP",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // Sheet 1: Products catalog
        await renameSheet(0, "Products");
        await ctx.settle();
        await ctx.setCells([
          { row: r, col: c, value: "SKU" }, { row: r, col: c + 1, value: "Name" }, { row: r, col: c + 2, value: "Cost" },
          { row: r + 1, col: c, value: "P01" }, { row: r + 1, col: c + 1, value: "Widget" }, { row: r + 1, col: c + 2, value: "=10" },
          { row: r + 2, col: c, value: "P02" }, { row: r + 2, col: c + 1, value: "Gadget" }, { row: r + 2, col: c + 2, value: "=25" },
          { row: r + 3, col: c, value: "P03" }, { row: r + 3, col: c + 1, value: "Doohickey" }, { row: r + 3, col: c + 2, value: "=5" },
        ]);
        await ctx.settle();

        // Sheet 2: Warehouse stock
        await addSheet("Warehouse");
        await ctx.settle();
        await goToSheet("Warehouse", ctx);
        await ctx.setCells([
          { row: r, col: c, value: "SKU" }, { row: r, col: c + 1, value: "Qty" }, { row: r, col: c + 2, value: "Location" },
          { row: r + 1, col: c, value: "P01" }, { row: r + 1, col: c + 1, value: "=500" }, { row: r + 1, col: c + 2, value: "NYC" },
          { row: r + 2, col: c, value: "P02" }, { row: r + 2, col: c + 1, value: "=200" }, { row: r + 2, col: c + 2, value: "LAX" },
          { row: r + 3, col: c, value: "P03" }, { row: r + 3, col: c + 1, value: "=1000" }, { row: r + 3, col: c + 2, value: "CHI" },
          { row: r + 4, col: c, value: "P01" }, { row: r + 4, col: c + 1, value: "=300" }, { row: r + 4, col: c + 2, value: "LAX" },
        ]);
        await ctx.settle();

        // Sheet 3: Dashboard
        await addSheet("Dashboard");
        await ctx.settle();
        await goToSheet("Dashboard", ctx);

        const skuRange = `Products!${A.ref(1, 0)}:${A.ref(3, 0)}`;
        const nameRange = `Products!${A.ref(1, 1)}:${A.ref(3, 1)}`;
        const costRange = `Products!${A.ref(1, 2)}:${A.ref(3, 2)}`;
        const whSkuRange = `Warehouse!${A.ref(1, 0)}:${A.ref(4, 0)}`;
        const whQtyRange = `Warehouse!${A.ref(1, 1)}:${A.ref(4, 1)}`;

        await ctx.setCells([
          { row: r, col: c, value: "SKU" },
          { row: r, col: c + 1, value: "Product" },
          { row: r, col: c + 2, value: "Unit Cost" },
          { row: r, col: c + 3, value: "Total Stock" },
          { row: r, col: c + 4, value: "Inventory Value" },
        ]);

        for (let i = 0; i < 3; i++) {
          const sku = `"P0${i + 1}"`;
          const dr = r + 1 + i;
          await ctx.setCells([
            { row: dr, col: c, value: `P0${i + 1}` },
            { row: dr, col: c + 1, value: `=XLOOKUP(${A.ref(1 + i, 0)},${skuRange},${nameRange})` },
            { row: dr, col: c + 2, value: `=XLOOKUP(${A.ref(1 + i, 0)},${skuRange},${costRange})` },
            { row: dr, col: c + 3, value: `=SUMIF(${whSkuRange},${A.ref(1 + i, 0)},${whQtyRange})` },
            { row: dr, col: c + 4, value: `=${A.ref(1 + i, 2)}*${A.ref(1 + i, 3)}` },
          ]);
        }

        // Totals
        await ctx.setCells([
          { row: r + 5, col: c, value: "TOTALS" },
          { row: r + 5, col: c + 3, value: `=SUM(${A.ref(1, 3)}:${A.ref(3, 3)})` },
          { row: r + 5, col: c + 4, value: `=SUM(${A.ref(1, 4)}:${A.ref(3, 4)})` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // P01: Widget, cost=10, stock=500+300=800, value=8000
        expectCellValue(await ctx.getCell(r + 1, c + 1), "Widget", "P01 = Widget");
        expectCellValue(await ctx.getCell(r + 1, c + 3), "800", "P01 total stock = 800");
        expectCellValue(await ctx.getCell(r + 1, c + 4), "8000", "P01 value = 8000");

        // P02: Gadget, cost=25, stock=200, value=5000
        expectCellValue(await ctx.getCell(r + 2, c + 4), "5000", "P02 value = 5000");

        // P03: Doohickey, cost=5, stock=1000, value=5000
        expectCellValue(await ctx.getCell(r + 3, c + 4), "5000", "P03 value = 5000");

        // Total stock: 800+200+1000 = 2000
        expectCellValue(await ctx.getCell(r + 5, c + 3), "2000", "Total stock = 2000");

        // Total value: 8000+5000+5000 = 18000
        expectCellValue(await ctx.getCell(r + 5, c + 4), "18000", "Total inventory value = 18000");
      },
    },

    // ==================================================================
    // 3. LOAN CALCULATOR WITH GOAL SEEK + SCENARIOS + VALIDATION
    // ==================================================================
    {
      name: "Loan calculator: PMT + Goal Seek + Scenarios + validation",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // Loan model with validation on inputs
        await ctx.setCells([
          { row: r, col: c, value: "Loan Calculator" },
          { row: r + 1, col: c, value: "Principal" }, { row: r + 1, col: c + 1, value: "250000" },
          { row: r + 2, col: c, value: "Annual Rate" }, { row: r + 2, col: c + 1, value: "0.065" },
          { row: r + 3, col: c, value: "Years" }, { row: r + 3, col: c + 1, value: "30" },
          { row: r + 4, col: c, value: "Monthly Payment" },
          { row: r + 4, col: c + 1, value: `=ROUND(-PMT(${A.ref(2, 1)}/12,${A.ref(3, 1)}*12,${A.ref(1, 1)}),2)` },
          { row: r + 5, col: c, value: "Total Paid" },
          { row: r + 5, col: c + 1, value: `=ROUND(${A.ref(4, 1)}*${A.ref(3, 1)}*12,2)` },
          { row: r + 6, col: c, value: "Total Interest" },
          { row: r + 6, col: c + 1, value: `=${A.ref(5, 1)}-${A.ref(1, 1)}` },
        ]);
        await ctx.settle();

        // Merge title
        await mergeCells(r, c, r, c + 1);
        await ctx.settle();

        // Add validation: principal 10000-1000000
        await setDataValidation(r + 1, c + 1, r + 1, c + 1, {
          rule: { decimal: { formula1: 10000, formula2: 1000000, operator: "between" } },
          errorAlert: { title: "Error", message: "10K-1M", style: "stop", showAlert: true },
          prompt: { title: "Principal", message: "Enter 10,000 - 1,000,000", showPrompt: true },
          ignoreBlanks: true,
        });

        // Verify payment ~$1580
        const pmt = await ctx.getCell(r + 4, c + 1);
        expectNotNull(pmt, "PMT cell");
        const pmtVal = parseFloat(pmt!.display.replace(",", ".").replace(/\s/g, ""));
        assertTrue(pmtVal > 1500 && pmtVal < 1700, `PMT ~1580, got ${pmtVal}`);

        // Goal Seek: what principal for $1200/month payment?
        const gs = await goalSeek({
          targetRow: r + 4, targetCol: c + 1,
          targetValue: 1200,
          variableRow: r + 1, variableCol: c + 1,
          maxIterations: 500, tolerance: 1,
        });
        assertTrue(gs.foundSolution, `Goal Seek: ${gs.error}`);
        assertTrue(gs.variableValue > 150000 && gs.variableValue < 200000,
          `Principal for $1200/month should be ~190k, got ${gs.variableValue}`);

        // Reset principal
        await ctx.setCells([{ row: r + 1, col: c + 1, value: "250000" }]);
        await ctx.settle();

        // Create scenarios for different rates
        await scenarioAdd({
          name: "Low Rate",
          changingCells: [{ row: r + 2, col: c + 1, value: "0.04" }],
          comment: "4%", sheetIndex: 0,
        });
        await scenarioAdd({
          name: "High Rate",
          changingCells: [{ row: r + 2, col: c + 1, value: "0.08" }],
          comment: "8%", sheetIndex: 0,
        });

        // Show Low Rate scenario
        await scenarioShow({ name: "Low Rate", sheetIndex: 0 });
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        const lowPmt = await ctx.getCell(r + 4, c + 1);
        const lowVal = parseFloat(lowPmt!.display.replace(",", ".").replace(/\s/g, ""));
        assertTrue(lowVal > 1100 && lowVal < 1300, `Low rate PMT ~1194, got ${lowVal}`);

        await unmergeCells(r, c);
      },
    },

    // ==================================================================
    // 4. PROJECT TRACKER: 3 sheets + table + CF + formulas
    // ==================================================================
    {
      name: "Project tracker: tasks table + status CF + cross-sheet summary",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // Sheet 1: Tasks
        await renameSheet(0, "Tasks");
        await ctx.settle();

        const tasks = [
          ["Design", "=40", "=32", "Alice"],
          ["Development", "=160", "=120", "Bob"],
          ["Testing", "=80", "=80", "Charlie"],
          ["Deployment", "=24", "=10", "Alice"],
          ["Documentation", "=40", "=35", "Diana"],
        ];

        const taskUpdates: Array<{ row: number; col: number; value: string }> = [
          { row: r, col: c, value: "Task" },
          { row: r, col: c + 1, value: "Planned Hrs" },
          { row: r, col: c + 2, value: "Actual Hrs" },
          { row: r, col: c + 3, value: "Owner" },
          { row: r, col: c + 4, value: "% Complete" },
          { row: r, col: c + 5, value: "Status" },
        ];

        for (let i = 0; i < tasks.length; i++) {
          const tr = r + 1 + i;
          taskUpdates.push({ row: tr, col: c, value: tasks[i][0] });
          taskUpdates.push({ row: tr, col: c + 1, value: tasks[i][1] });
          taskUpdates.push({ row: tr, col: c + 2, value: tasks[i][2] });
          taskUpdates.push({ row: tr, col: c + 3, value: tasks[i][3] });
          // % Complete = MIN(Actual/Planned, 1)
          taskUpdates.push({
            row: tr, col: c + 4,
            value: `=ROUND(MIN(${A.ref(1 + i, 2)}/${A.ref(1 + i, 1)},1)*100,0)`,
          });
          // Status
          taskUpdates.push({
            row: tr, col: c + 5,
            value: `=IF(${A.ref(1 + i, 4)}>=100,"Done",IF(${A.ref(1 + i, 4)}>=50,"In Progress","Not Started"))`,
          });
        }
        await ctx.setCells(taskUpdates);
        await ctx.settle();

        // Add CF: highlight "Done" green, "In Progress" yellow
        await addConditionalFormat({
          ranges: [{ startRow: r + 1, startCol: c + 5, endRow: r + tasks.length, endCol: c + 5 }],
          rule: { type: "containsText", ruleType: "contains", text: "Done" },
          format: { backgroundColor: "#C6EFCE" },
          stopIfTrue: false,
        });

        // Sheet 2: Summary
        await addSheet("Summary");
        await ctx.settle();
        await goToSheet("Summary", ctx);

        const plannedRange = `Tasks!${A.ref(1, 1)}:${A.ref(tasks.length, 1)}`;
        const actualRange = `Tasks!${A.ref(1, 2)}:${A.ref(tasks.length, 2)}`;
        const pctRange = `Tasks!${A.ref(1, 4)}:${A.ref(tasks.length, 4)}`;
        const statusRange = `Tasks!${A.ref(1, 5)}:${A.ref(tasks.length, 5)}`;

        await ctx.setCells([
          { row: r, col: c, value: "Project Summary" },
          { row: r + 1, col: c, value: "Total Planned" },
          { row: r + 1, col: c + 1, value: `=SUM(${plannedRange})` },
          { row: r + 2, col: c, value: "Total Actual" },
          { row: r + 2, col: c + 1, value: `=SUM(${actualRange})` },
          { row: r + 3, col: c, value: "Avg Completion" },
          { row: r + 3, col: c + 1, value: `=ROUND(AVERAGE(${pctRange}),1)` },
          { row: r + 4, col: c, value: "Tasks Done" },
          { row: r + 4, col: c + 1, value: `=COUNTIF(${statusRange},"Done")` },
          { row: r + 5, col: c, value: "Tasks In Progress" },
          { row: r + 5, col: c + 1, value: `=COUNTIF(${statusRange},"In Progress")` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Total planned: 40+160+80+24+40 = 344
        expectCellValue(await ctx.getCell(r + 1, c + 1), "344", "Total planned = 344");

        // Total actual: 32+120+80+10+35 = 277
        expectCellValue(await ctx.getCell(r + 2, c + 1), "277", "Total actual = 277");

        // Tasks Done: Testing (100%) = 1
        expectCellValue(await ctx.getCell(r + 4, c + 1), "1", "Tasks Done = 1");

        // Tasks In Progress: Design(80%), Dev(75%), Doc(88%) = 3
        expectCellValue(await ctx.getCell(r + 5, c + 1), "3", "Tasks In Progress = 3");
      },
    },

    // ==================================================================
    // 5. EXPENSE REPORT: Validation + Named Ranges + .cala Save/Load
    // ==================================================================
    {
      name: "Expense report: validation + categories + save/load round-trip",
      run: async (ctx) => {
        const r = A.row, c = A.col;

        // Categories (for validation list)
        const categories = ["Travel", "Meals", "Supplies", "Software", "Other"];

        // Expense entries
        await ctx.setCells([
          { row: r, col: c, value: "Date" },
          { row: r, col: c + 1, value: "Category" },
          { row: r, col: c + 2, value: "Amount" },
          { row: r, col: c + 3, value: "Description" },
          { row: r + 1, col: c, value: "2024-01-15" }, { row: r + 1, col: c + 1, value: "Travel" },
          { row: r + 1, col: c + 2, value: "=350" }, { row: r + 1, col: c + 3, value: "Flight to NYC" },
          { row: r + 2, col: c, value: "2024-01-15" }, { row: r + 2, col: c + 1, value: "Meals" },
          { row: r + 2, col: c + 2, value: "=45" }, { row: r + 2, col: c + 3, value: "Client dinner" },
          { row: r + 3, col: c, value: "2024-01-16" }, { row: r + 3, col: c + 1, value: "Software" },
          { row: r + 3, col: c + 2, value: "=99" }, { row: r + 3, col: c + 3, value: "License" },
          { row: r + 4, col: c, value: "2024-01-17" }, { row: r + 4, col: c + 1, value: "Travel" },
          { row: r + 4, col: c + 2, value: "=200" }, { row: r + 4, col: c + 3, value: "Hotel" },
          { row: r + 5, col: c, value: "2024-01-17" }, { row: r + 5, col: c + 1, value: "Meals" },
          { row: r + 5, col: c + 2, value: "=30" }, { row: r + 5, col: c + 3, value: "Team lunch" },
        ]);
        await ctx.settle();

        // Add validation: category must be from list
        await setDataValidation(r + 1, c + 1, r + 5, c + 1, {
          rule: { list: { source: { values: categories }, inCellDropdown: true } },
          errorAlert: { title: "Invalid Category", message: "Choose from list", style: "stop", showAlert: true },
          prompt: { title: "Category", message: "Select a category", showPrompt: true },
          ignoreBlanks: false,
        });

        // Summary by category using SUMIF
        await ctx.setCells([
          { row: r + 7, col: c, value: "Category Summary" },
          { row: r + 8, col: c, value: "Travel" },
          { row: r + 8, col: c + 1, value: `=SUMIF(${A.ref(1, 1)}:${A.ref(5, 1)},"Travel",${A.ref(1, 2)}:${A.ref(5, 2)})` },
          { row: r + 9, col: c, value: "Meals" },
          { row: r + 9, col: c + 1, value: `=SUMIF(${A.ref(1, 1)}:${A.ref(5, 1)},"Meals",${A.ref(1, 2)}:${A.ref(5, 2)})` },
          { row: r + 10, col: c, value: "Software" },
          { row: r + 10, col: c + 1, value: `=SUMIF(${A.ref(1, 1)}:${A.ref(5, 1)},"Software",${A.ref(1, 2)}:${A.ref(5, 2)})` },
          { row: r + 11, col: c, value: "TOTAL" },
          { row: r + 11, col: c + 1, value: `=SUM(${A.ref(1, 2)}:${A.ref(5, 2)})` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Travel: 350+200 = 550
        expectCellValue(await ctx.getCell(r + 8, c + 1), "550", "Travel total = 550");
        // Meals: 45+30 = 75
        expectCellValue(await ctx.getCell(r + 9, c + 1), "75", "Meals total = 75");
        // Total: 350+45+99+200+30 = 724
        expectCellValue(await ctx.getCell(r + 11, c + 1), "724", "Grand total = 724");

        // Save and reload
        const { appDataDir } = await import("@tauri-apps/api/path");
        const dir = await appDataDir();
        const path = `${dir}test_expense_${Date.now()}.cala`;
        await invokeBackend("save_file", { path });
        await invokeBackend("new_file", {});
        await ctx.settle();
        await invokeBackend("open_file", { path });
        await ctx.settle();

        // Verify formulas survived round-trip
        expectCellValue(await ctx.getCell(r + 11, c + 1), "724", "Total after reload = 724");
        expectCellValue(await ctx.getCell(r + 8, c + 1), "550", "Travel after reload = 550");
      },
    },
  ],
};
