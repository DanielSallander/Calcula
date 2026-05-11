//! FILENAME: app/extensions/TestRunner/lib/suites/stressWorkflow.ts
// PURPOSE: Stress tests and complex multi-step workflow tests.
// CONTEXT: Tests large datasets, rapid operations, multi-feature combinations,
//          and realistic end-to-end workflows that exercise many subsystems together.

import type { TestSuite } from "../types";
import { AREA_STRESS } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
  expectCellValue,
  expectCellContains,
} from "../assertions";
import { recalculateFormulas } from "@api/backend";

const A = AREA_STRESS;

/** Clear test area */
async function clearArea(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 200; r++) {
    for (let c = 0; c < 12; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

export const stressWorkflowSuite: TestSuite = {
  name: "Stress & Workflow",

  afterEach: async (ctx) => {
    await clearArea(ctx);
  },

  tests: [
    // ------------------------------------------------------------------
    // 1. LARGE DATA WRITE + READ
    // ------------------------------------------------------------------
    {
      name: "Write and read back 5000 cells",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const ROWS = 500, COLS = 10;
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            updates.push({ row: r0 + r, col: c0 + c, value: `=${r * COLS + c}` });
          }
        }
        await ctx.setCells(updates);
        await ctx.settle();

        // Spot-check several cells
        let cell = await ctx.getCell(r0, c0);
        expectCellValue(cell, "0", "First cell");

        cell = await ctx.getCell(r0 + 249, c0 + 5);
        expectCellValue(cell, "2495", "Middle cell (249*10+5)");

        cell = await ctx.getCell(r0 + 499, c0 + 9);
        expectCellValue(cell, "4999", "Last cell (499*10+9)");
      },
    },

    // ------------------------------------------------------------------
    // 2. MANY FORMULAS REFERENCING EACH OTHER
    // ------------------------------------------------------------------
    {
      name: "100 chained SUM formulas (cumulative running total)",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const updates: Array<{ row: number; col: number; value: string }> = [];

        // Column A: values 1..100
        for (let i = 0; i < 100; i++) {
          updates.push({ row: r0 + i, col: c0, value: `=${i + 1}` });
        }
        // Column B: running SUM — each cell sums the column A range from row 1 to current row
        for (let i = 0; i < 100; i++) {
          const rangeStart = A.ref(0, 0);
          const rangeEnd = A.ref(i, 0);
          updates.push({ row: r0 + i, col: c0 + 1, value: `=SUM(${rangeStart}:${rangeEnd})` });
        }
        await ctx.setCells(updates);
        await ctx.settle();

        // Running total at row 99: SUM(1..100) = 5050
        const cell = await ctx.getCell(r0 + 99, c0 + 1);
        expectCellValue(cell, "5050", "Running total at row 100 = 5050");

        // Running total at row 9: SUM(1..10) = 55
        const cell10 = await ctx.getCell(r0 + 9, c0 + 1);
        expectCellValue(cell10, "55", "Running total at row 10 = 55");
      },
    },

    // ------------------------------------------------------------------
    // 3. RAPID SEQUENTIAL UPDATES TO SAME CELL
    // ------------------------------------------------------------------
    {
      name: "50 rapid updates to source cell with dependent formula",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;

        // Set up formula
        await ctx.setCells([
          { row: r0, col: c0, value: "=0" },
          { row: r0 + 1, col: c0, value: `=${A.ref(0, 0)}*3+7` },
        ]);
        await ctx.settle();

        // Rapidly update source 50 times
        for (let i = 1; i <= 50; i++) {
          await ctx.setCells([{ row: r0, col: c0, value: `=${i}` }]);
        }
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        // Final value should be 50*3+7 = 157
        const cell = await ctx.getCell(r0 + 1, c0);
        expectCellValue(cell, "157", "After 50 rapid updates: 50*3+7 = 157");
      },
    },

    // ------------------------------------------------------------------
    // 4. LARGE BATCH WITH MIXED TYPES
    // ------------------------------------------------------------------
    {
      name: "Batch write 1000 cells with mixed types (text, number, formula)",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let i = 0; i < 1000; i++) {
          const r = r0 + Math.floor(i / 5);
          const c = c0 + (i % 5);
          if (i % 3 === 0) {
            updates.push({ row: r, col: c, value: `Text_${i}` });
          } else if (i % 3 === 1) {
            updates.push({ row: r, col: c, value: `=${i * 10}` });
          } else {
            updates.push({ row: r, col: c, value: `=LEN("item${i}")` });
          }
        }
        await ctx.setCells(updates);
        await ctx.settle();

        // Verify text cell
        const textCell = await ctx.getCell(r0, c0);
        expectCellValue(textCell, "Text_0", "First text cell");

        // Verify number cell (i=1 -> 10)
        const numCell = await ctx.getCell(r0, c0 + 1);
        expectCellValue(numCell, "10", "First number cell (1*10)");

        // Verify formula cell (i=2 -> LEN("item2") = 5)
        const fmtCell = await ctx.getCell(r0, c0 + 2);
        expectCellValue(fmtCell, "5", "LEN(\"item2\") = 5");
      },
    },

    // ------------------------------------------------------------------
    // 5. WORKFLOW: INVOICE CALCULATION
    // ------------------------------------------------------------------
    {
      name: "Workflow: complete invoice with subtotal, tax, discount, total",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Headers: Item(0), Qty(1), Price(2), LineTotal(3)
        await ctx.setCells([
          { row: r0, col: c0, value: "Item" },
          { row: r0, col: c0 + 1, value: "Qty" },
          { row: r0, col: c0 + 2, value: "Price" },
          { row: r0, col: c0 + 3, value: "LineTotal" },
          // 5 line items
          { row: r0 + 1, col: c0, value: "Widget" },
          { row: r0 + 1, col: c0 + 1, value: "=10" },
          { row: r0 + 1, col: c0 + 2, value: "=25" },
          { row: r0 + 1, col: c0 + 3, value: `=${A.ref(1, 1)}*${A.ref(1, 2)}` },
          { row: r0 + 2, col: c0, value: "Gadget" },
          { row: r0 + 2, col: c0 + 1, value: "=5" },
          { row: r0 + 2, col: c0 + 2, value: "=50" },
          { row: r0 + 2, col: c0 + 3, value: `=${A.ref(2, 1)}*${A.ref(2, 2)}` },
          { row: r0 + 3, col: c0, value: "Doohickey" },
          { row: r0 + 3, col: c0 + 1, value: "=20" },
          { row: r0 + 3, col: c0 + 2, value: "=5" },
          { row: r0 + 3, col: c0 + 3, value: `=${A.ref(3, 1)}*${A.ref(3, 2)}` },
          { row: r0 + 4, col: c0, value: "Thingamajig" },
          { row: r0 + 4, col: c0 + 1, value: "=2" },
          { row: r0 + 4, col: c0 + 2, value: "=100" },
          { row: r0 + 4, col: c0 + 3, value: `=${A.ref(4, 1)}*${A.ref(4, 2)}` },
          { row: r0 + 5, col: c0, value: "Whatchamacallit" },
          { row: r0 + 5, col: c0 + 1, value: "=8" },
          { row: r0 + 5, col: c0 + 2, value: "=15" },
          { row: r0 + 5, col: c0 + 3, value: `=${A.ref(5, 1)}*${A.ref(5, 2)}` },
          // Subtotal
          { row: r0 + 7, col: c0 + 2, value: "Subtotal" },
          { row: r0 + 7, col: c0 + 3, value: `=SUM(${A.ref(1, 3)}:${A.ref(5, 3)})` },
          // Discount 10%
          { row: r0 + 8, col: c0 + 2, value: "Discount (10%)" },
          { row: r0 + 8, col: c0 + 3, value: `=${A.ref(7, 3)}*0.1` },
          // After discount
          { row: r0 + 9, col: c0 + 2, value: "After Discount" },
          { row: r0 + 9, col: c0 + 3, value: `=${A.ref(7, 3)}-${A.ref(8, 3)}` },
          // Tax 8%
          { row: r0 + 10, col: c0 + 2, value: "Tax (8%)" },
          { row: r0 + 10, col: c0 + 3, value: `=${A.ref(9, 3)}*0.08` },
          // Grand Total
          { row: r0 + 11, col: c0 + 2, value: "TOTAL" },
          { row: r0 + 11, col: c0 + 3, value: `=${A.ref(9, 3)}+${A.ref(10, 3)}` },
        ]);
        await ctx.settle();

        // Line totals: 250, 250, 100, 200, 120 = 920
        const subtotal = await ctx.getCell(r0 + 7, c0 + 3);
        expectCellValue(subtotal, "920", "Subtotal = 920");

        // Discount: 92
        const discount = await ctx.getCell(r0 + 8, c0 + 3);
        expectCellValue(discount, "92", "Discount = 92");

        // After discount: 828
        const afterDisc = await ctx.getCell(r0 + 9, c0 + 3);
        expectCellValue(afterDisc, "828", "After discount = 828");

        // Tax: 66.24
        const tax = await ctx.getCell(r0 + 10, c0 + 3);
        expectNotNull(tax, "Tax cell exists");
        const taxVal = parseFloat(tax!.display.replace(",", "."));
        assertTrue(Math.abs(taxVal - 66.24) < 0.01, `Tax = 66.24, got ${taxVal}`);

        // Total: 894.24
        const total = await ctx.getCell(r0 + 11, c0 + 3);
        expectNotNull(total, "Total cell exists");
        const totalVal = parseFloat(total!.display.replace(",", "."));
        assertTrue(Math.abs(totalVal - 894.24) < 0.01, `Total = 894.24, got ${totalVal}`);

        // Now change a quantity and verify cascade
        await ctx.setCells([{ row: r0 + 1, col: c0 + 1, value: "=20" }]);
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        // New line total: 20*25 = 500 (was 250)
        // New subtotal: 500+250+100+200+120 = 1170
        const newSubtotal = await ctx.getCell(r0 + 7, c0 + 3);
        expectCellValue(newSubtotal, "1170", "New subtotal after qty change = 1170");
      },
    },

    // ------------------------------------------------------------------
    // 6. WORKFLOW: GRADE BOOK
    // ------------------------------------------------------------------
    {
      name: "Workflow: grade book with weighted averages and letter grades",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Headers: Name(0), HW(1), Midterm(2), Final(3), WeightedAvg(4), Grade(5)
        // Weights: HW=30%, Midterm=30%, Final=40%
        const students = [
          ["Alice", "95", "88", "92"],
          ["Bob", "78", "85", "72"],
          ["Charlie", "100", "95", "98"],
          ["Diana", "65", "70", "68"],
          ["Eve", "88", "92", "90"],
        ];

        const updates: Array<{ row: number; col: number; value: string }> = [
          { row: r0, col: c0, value: "Name" },
          { row: r0, col: c0 + 1, value: "HW" },
          { row: r0, col: c0 + 2, value: "Midterm" },
          { row: r0, col: c0 + 3, value: "Final" },
          { row: r0, col: c0 + 4, value: "Weighted" },
          { row: r0, col: c0 + 5, value: "Grade" },
        ];

        for (let i = 0; i < students.length; i++) {
          const r = r0 + 1 + i;
          updates.push({ row: r, col: c0, value: students[i][0] });
          updates.push({ row: r, col: c0 + 1, value: `=${students[i][1]}` });
          updates.push({ row: r, col: c0 + 2, value: `=${students[i][2]}` });
          updates.push({ row: r, col: c0 + 3, value: `=${students[i][3]}` });
          // Weighted avg: HW*0.3 + Midterm*0.3 + Final*0.4
          updates.push({
            row: r, col: c0 + 4,
            value: `=ROUND(${A.ref(1 + i, 1)}*0.3+${A.ref(1 + i, 2)}*0.3+${A.ref(1 + i, 3)}*0.4,1)`,
          });
          // Letter grade
          updates.push({
            row: r, col: c0 + 5,
            value: `=IF(${A.ref(1 + i, 4)}>=90,"A",IF(${A.ref(1 + i, 4)}>=80,"B",IF(${A.ref(1 + i, 4)}>=70,"C",IF(${A.ref(1 + i, 4)}>=60,"D","F"))))`,
          });
        }

        // Summary row
        const lastDataRow = r0 + students.length;
        updates.push({ row: lastDataRow + 1, col: c0, value: "Class Average" });
        updates.push({
          row: lastDataRow + 1, col: c0 + 4,
          value: `=ROUND(AVERAGE(${A.ref(1, 4)}:${A.ref(students.length, 4)}),1)`,
        });
        updates.push({ row: lastDataRow + 2, col: c0, value: "Highest" });
        updates.push({
          row: lastDataRow + 2, col: c0 + 4,
          value: `=MAX(${A.ref(1, 4)}:${A.ref(students.length, 4)})`,
        });
        updates.push({ row: lastDataRow + 3, col: c0, value: "Lowest" });
        updates.push({
          row: lastDataRow + 3, col: c0 + 4,
          value: `=MIN(${A.ref(1, 4)}:${A.ref(students.length, 4)})`,
        });
        updates.push({ row: lastDataRow + 4, col: c0, value: "Pass Count" });
        updates.push({
          row: lastDataRow + 4, col: c0 + 4,
          value: `=COUNTIF(${A.ref(1, 4)}:${A.ref(students.length, 4)},">="&70)`,
        });

        await ctx.setCells(updates);
        await ctx.settle();

        // Alice: 95*0.3 + 88*0.3 + 92*0.4 = 28.5 + 26.4 + 36.8 = 91.7
        const alice = await ctx.getCell(r0 + 1, c0 + 4);
        expectNotNull(alice, "Alice weighted avg");
        const aliceVal = parseFloat(alice!.display.replace(",", "."));
        assertTrue(Math.abs(aliceVal - 91.7) < 0.1, `Alice avg = 91.7, got ${aliceVal}`);

        // Alice grade = A
        const aliceGrade = await ctx.getCell(r0 + 1, c0 + 5);
        expectCellValue(aliceGrade, "A", "Alice grade = A");

        // Diana: 65*0.3 + 70*0.3 + 68*0.4 = 19.5 + 21 + 27.2 = 67.7
        const diana = await ctx.getCell(r0 + 4, c0 + 4);
        expectNotNull(diana, "Diana weighted avg");
        const dianaVal = parseFloat(diana!.display.replace(",", "."));
        assertTrue(Math.abs(dianaVal - 67.7) < 0.1, `Diana avg = 67.7, got ${dianaVal}`);

        // Diana grade = D
        const dianaGrade = await ctx.getCell(r0 + 4, c0 + 5);
        expectCellValue(dianaGrade, "D", "Diana grade = D");

        // Pass count (>= 70): Alice(91.7), Bob(?), Charlie(?), Eve(?) pass; Diana(67.7) fails
        // Bob: 78*0.3+85*0.3+72*0.4 = 23.4+25.5+28.8 = 77.7 -> pass
        // Charlie: 100*0.3+95*0.3+98*0.4 = 30+28.5+39.2 = 97.7 -> pass
        // Eve: 88*0.3+92*0.3+90*0.4 = 26.4+27.6+36 = 90 -> pass
        // So 4 pass
        const passCount = await ctx.getCell(lastDataRow + 4, c0 + 4);
        expectCellValue(passCount, "4", "Pass count = 4 (Diana fails)");
      },
    },

    // ------------------------------------------------------------------
    // 7. WORKFLOW: SALES DASHBOARD
    // ------------------------------------------------------------------
    {
      name: "Workflow: sales dashboard with SUMIFS, rankings, and percentages",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Sales data: Rep(0), Region(1), Q1(2), Q2(3), Q3(4), Q4(5), Total(6)
        const reps = [
          ["Alice", "North", "=50000", "=55000", "=48000", "=60000"],
          ["Bob", "South", "=45000", "=42000", "=47000", "=51000"],
          ["Charlie", "North", "=60000", "=58000", "=62000", "=65000"],
          ["Diana", "South", "=38000", "=40000", "=36000", "=42000"],
          ["Eve", "East", "=52000", "=54000", "=50000", "=56000"],
        ];

        const updates: Array<{ row: number; col: number; value: string }> = [
          { row: r0, col: c0, value: "Rep" },
          { row: r0, col: c0 + 1, value: "Region" },
          { row: r0, col: c0 + 2, value: "Q1" },
          { row: r0, col: c0 + 3, value: "Q2" },
          { row: r0, col: c0 + 4, value: "Q3" },
          { row: r0, col: c0 + 5, value: "Q4" },
          { row: r0, col: c0 + 6, value: "Total" },
        ];

        for (let i = 0; i < reps.length; i++) {
          const r = r0 + 1 + i;
          for (let c = 0; c < reps[i].length; c++) {
            updates.push({ row: r, col: c0 + c, value: reps[i][c] });
          }
          // Total = Q1+Q2+Q3+Q4
          updates.push({
            row: r, col: c0 + 6,
            value: `=SUM(${A.ref(1 + i, 2)}:${A.ref(1 + i, 5)})`,
          });
        }

        // Summary section
        const sumRow = r0 + reps.length + 2;
        // Grand total
        updates.push({ row: sumRow, col: c0, value: "Grand Total" });
        updates.push({
          row: sumRow, col: c0 + 6,
          value: `=SUM(${A.ref(1, 6)}:${A.ref(reps.length, 6)})`,
        });
        // North total
        updates.push({ row: sumRow + 1, col: c0, value: "North Total" });
        updates.push({
          row: sumRow + 1, col: c0 + 6,
          value: `=SUMIF(${A.ref(1, 1)}:${A.ref(reps.length, 1)},"North",${A.ref(1, 6)}:${A.ref(reps.length, 6)})`,
        });
        // Top performer
        updates.push({ row: sumRow + 2, col: c0, value: "Max Individual" });
        updates.push({
          row: sumRow + 2, col: c0 + 6,
          value: `=MAX(${A.ref(1, 6)}:${A.ref(reps.length, 6)})`,
        });
        // Average per rep
        updates.push({ row: sumRow + 3, col: c0, value: "Average per Rep" });
        updates.push({
          row: sumRow + 3, col: c0 + 6,
          value: `=AVERAGE(${A.ref(1, 6)}:${A.ref(reps.length, 6)})`,
        });
        // Count above 200k
        updates.push({ row: sumRow + 4, col: c0, value: "Reps above 200k" });
        updates.push({
          row: sumRow + 4, col: c0 + 6,
          value: `=COUNTIF(${A.ref(1, 6)}:${A.ref(reps.length, 6)},">="&200000)`,
        });

        await ctx.setCells(updates);
        await ctx.settle();

        // Alice total: 50+55+48+60 = 213000
        const aliceTotal = await ctx.getCell(r0 + 1, c0 + 6);
        expectCellValue(aliceTotal, "213000", "Alice total = 213000");

        // Grand total: 213000+185000+245000+156000+212000 = 1011000
        const grandTotal = await ctx.getCell(sumRow, c0 + 6);
        expectCellValue(grandTotal, "1011000", "Grand total = 1011000");

        // North total: Alice(213000) + Charlie(245000) = 458000
        const northTotal = await ctx.getCell(sumRow + 1, c0 + 6);
        expectCellValue(northTotal, "458000", "North total = 458000");

        // Max: Charlie = 245000
        const maxCell = await ctx.getCell(sumRow + 2, c0 + 6);
        expectCellValue(maxCell, "245000", "Max = Charlie = 245000");

        // Reps above 200k: Alice(213000), Charlie(245000), Eve(212000) = 3
        const above200k = await ctx.getCell(sumRow + 4, c0 + 6);
        expectCellValue(above200k, "3", "3 reps above 200k");
      },
    },

    // ------------------------------------------------------------------
    // 8. MANY INDEPENDENT FORMULAS
    // ------------------------------------------------------------------
    {
      name: "200 independent formulas (no chain dependencies)",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let i = 0; i < 200; i++) {
          // Each formula is independent: =i*i + i
          updates.push({ row: r0 + i, col: c0, value: `=${i}*${i}+${i}` });
        }
        await ctx.setCells(updates);
        await ctx.settle();

        // f(i) = i*i + i: i=0 -> 0, i=10 -> 110, i=99 -> 9900, i=199 -> 39800
        let cell = await ctx.getCell(r0, c0);
        expectCellValue(cell, "0", "f(0) = 0");

        cell = await ctx.getCell(r0 + 10, c0);
        expectCellValue(cell, "110", "f(10) = 110");

        cell = await ctx.getCell(r0 + 99, c0);
        expectCellValue(cell, "9900", "f(99) = 99*99+99 = 9900");

        cell = await ctx.getCell(r0 + 199, c0);
        expectCellValue(cell, "39800", "f(199) = 199*199+199 = 39800");
      },
    },

    // ------------------------------------------------------------------
    // 9. WORKFLOW: LOAN AMORTIZATION TABLE
    // ------------------------------------------------------------------
    {
      name: "Workflow: 12-month loan amortization schedule",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Params: Principal=10000, Annual Rate=6%, Term=12 months
        const updates: Array<{ row: number; col: number; value: string }> = [
          { row: r0, col: c0, value: "Principal" },
          { row: r0, col: c0 + 1, value: "=10000" },
          { row: r0 + 1, col: c0, value: "Annual Rate" },
          { row: r0 + 1, col: c0 + 1, value: "=0.06" },
          { row: r0 + 2, col: c0, value: "Term (months)" },
          { row: r0 + 2, col: c0 + 1, value: "=12" },
          { row: r0 + 3, col: c0, value: "Monthly Payment" },
          { row: r0 + 3, col: c0 + 1, value: `=ROUND(-PMT(${A.ref(1, 1)}/12,${A.ref(2, 1)},${A.ref(0, 1)}),2)` },
          // Amortization table headers: Month(0), Payment(1), Interest(2), Principal(3), Balance(4)
          { row: r0 + 5, col: c0, value: "Month" },
          { row: r0 + 5, col: c0 + 1, value: "Payment" },
          { row: r0 + 5, col: c0 + 2, value: "Interest" },
          { row: r0 + 5, col: c0 + 3, value: "Principal" },
          { row: r0 + 5, col: c0 + 4, value: "Balance" },
        ];

        for (let m = 1; m <= 12; m++) {
          const r = r0 + 5 + m;
          updates.push({ row: r, col: c0, value: `=${m}` });
          // Payment (constant)
          updates.push({ row: r, col: c0 + 1, value: `=${A.ref(3, 1)}` });
          // Interest = previous balance * monthly rate
          if (m === 1) {
            updates.push({ row: r, col: c0 + 2, value: `=ROUND(${A.ref(0, 1)}*${A.ref(1, 1)}/12,2)` });
          } else {
            updates.push({ row: r, col: c0 + 2, value: `=ROUND(${A.ref(5 + m - 1, 4)}*${A.ref(1, 1)}/12,2)` });
          }
          // Principal portion = Payment - Interest
          updates.push({ row: r, col: c0 + 3, value: `=ROUND(${A.ref(5 + m, 1)}-${A.ref(5 + m, 2)},2)` });
          // Balance = previous balance - principal portion
          if (m === 1) {
            updates.push({ row: r, col: c0 + 4, value: `=ROUND(${A.ref(0, 1)}-${A.ref(5 + m, 3)},2)` });
          } else {
            updates.push({ row: r, col: c0 + 4, value: `=ROUND(${A.ref(5 + m - 1, 4)}-${A.ref(5 + m, 3)},2)` });
          }
        }

        await ctx.setCells(updates);
        await ctx.settle();

        // Monthly payment for $10000 at 6% for 12 months ~ $860.66
        const pmtCell = await ctx.getCell(r0 + 3, c0 + 1);
        expectNotNull(pmtCell, "PMT cell exists");
        const pmt = parseFloat(pmtCell!.display.replace(",", "."));
        assertTrue(Math.abs(pmt - 860.66) < 1, `Monthly payment ~860.66, got ${pmt}`);

        // Final balance (month 12) should be close to 0
        const finalBalance = await ctx.getCell(r0 + 17, c0 + 4);
        expectNotNull(finalBalance, "Final balance exists");
        const bal = parseFloat(finalBalance!.display.replace(",", "."));
        assertTrue(Math.abs(bal) < 1, `Final balance should be ~0, got ${bal}`);

        // Total interest paid = sum of interest column
        // Should be roughly 327.96 (12*860.66 - 10000)
      },
    },

    // ------------------------------------------------------------------
    // 10. CONDITIONAL LOGIC AT SCALE
    // ------------------------------------------------------------------
    {
      name: "100 cells with nested IF classifications",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let i = 0; i < 100; i++) {
          const score = i + 1; // 1 to 100
          updates.push({ row: r0 + i, col: c0, value: `=${score}` });
          updates.push({
            row: r0 + i, col: c0 + 1,
            value: `=IF(${A.ref(i, 0)}>=90,"A",IF(${A.ref(i, 0)}>=80,"B",IF(${A.ref(i, 0)}>=70,"C",IF(${A.ref(i, 0)}>=60,"D","F"))))`,
          });
        }
        await ctx.setCells(updates);
        await ctx.settle();

        // Score 100 -> A
        let cell = await ctx.getCell(r0 + 99, c0 + 1);
        expectCellValue(cell, "A", "Score 100 = A");

        // Score 85 -> B
        cell = await ctx.getCell(r0 + 84, c0 + 1);
        expectCellValue(cell, "B", "Score 85 = B");

        // Score 50 -> F
        cell = await ctx.getCell(r0 + 49, c0 + 1);
        expectCellValue(cell, "F", "Score 50 = F");

        // Score 70 -> C
        cell = await ctx.getCell(r0 + 69, c0 + 1);
        expectCellValue(cell, "C", "Score 70 = C");
      },
    },

    // ------------------------------------------------------------------
    // 11. LARGE SUM WITH MANY RANGES
    // ------------------------------------------------------------------
    {
      name: "SUM across 10 separate ranges",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const updates: Array<{ row: number; col: number; value: string }> = [];

        // 10 groups of 10 values each, in different columns
        for (let g = 0; g < 10; g++) {
          for (let i = 0; i < 10; i++) {
            updates.push({ row: r0 + i, col: c0 + g, value: `=${g * 10 + i + 1}` });
          }
        }

        // SUM across all 10 ranges
        const ranges = Array.from({ length: 10 }, (_, g) =>
          `${A.ref(0, g)}:${A.ref(9, g)}`
        ).join(",");
        updates.push({ row: r0 + 11, col: c0, value: `=SUM(${ranges})` });

        await ctx.setCells(updates);
        await ctx.settle();

        // SUM(1..100) = 5050
        const cell = await ctx.getCell(r0 + 11, c0);
        expectCellValue(cell, "5050", "SUM of 10 ranges = SUM(1..100) = 5050");
      },
    },

    // ------------------------------------------------------------------
    // 12. WORKFLOW: DATA CLEANING
    // ------------------------------------------------------------------
    {
      name: "Workflow: clean and transform messy data",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Source data with messy formatting
        await ctx.setCells([
          { row: r0, col: c0, value: "  Alice  " },
          { row: r0 + 1, col: c0, value: "  bob  " },
          { row: r0 + 2, col: c0, value: "CHARLIE" },
          { row: r0 + 3, col: c0, value: "  diana " },
          // Clean column: TRIM + PROPER
          { row: r0, col: c0 + 1, value: `=PROPER(TRIM(${A.ref(0, 0)}))` },
          { row: r0 + 1, col: c0 + 1, value: `=PROPER(TRIM(${A.ref(1, 0)}))` },
          { row: r0 + 2, col: c0 + 1, value: `=PROPER(TRIM(${A.ref(2, 0)}))` },
          { row: r0 + 3, col: c0 + 1, value: `=PROPER(TRIM(${A.ref(3, 0)}))` },
          // Length check
          { row: r0, col: c0 + 2, value: `=LEN(${A.ref(0, 1)})` },
          { row: r0 + 1, col: c0 + 2, value: `=LEN(${A.ref(1, 1)})` },
          { row: r0 + 2, col: c0 + 2, value: `=LEN(${A.ref(2, 1)})` },
          { row: r0 + 3, col: c0 + 2, value: `=LEN(${A.ref(3, 1)})` },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r0, c0 + 1);
        expectCellValue(cell, "Alice", "Cleaned Alice");

        cell = await ctx.getCell(r0 + 1, c0 + 1);
        expectCellValue(cell, "Bob", "Cleaned Bob");

        cell = await ctx.getCell(r0 + 2, c0 + 1);
        expectCellValue(cell, "Charlie", "Cleaned Charlie");

        cell = await ctx.getCell(r0 + 3, c0 + 1);
        expectCellValue(cell, "Diana", "Cleaned Diana");

        // Length: Alice=5, Bob=3, Charlie=7, Diana=5
        cell = await ctx.getCell(r0 + 1, c0 + 2);
        expectCellValue(cell, "3", "LEN(Bob) = 3");
      },
    },

    // ------------------------------------------------------------------
    // 13. STRESS: MANY FORMULAS WITH SUM/AVERAGE
    // ------------------------------------------------------------------
    {
      name: "50 columns of data with row-level SUM and AVERAGE",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const COLS = 10; // 10 data columns to keep within area
        const ROWS = 20;
        const updates: Array<{ row: number; col: number; value: string }> = [];

        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            updates.push({ row: r0 + r, col: c0 + c, value: `=${r * COLS + c + 1}` });
          }
          // SUM of each row
          updates.push({
            row: r0 + r, col: c0 + COLS,
            value: `=SUM(${A.ref(r, 0)}:${A.ref(r, COLS - 1)})`,
          });
          // AVERAGE of each row
          updates.push({
            row: r0 + r, col: c0 + COLS + 1,
            value: `=AVERAGE(${A.ref(r, 0)}:${A.ref(r, COLS - 1)})`,
          });
        }

        await ctx.setCells(updates);
        await ctx.settle();

        // Row 0: values 1..10, SUM=55, AVG=5.5
        const sumCell = await ctx.getCell(r0, c0 + COLS);
        expectCellValue(sumCell, "55", "Row 0 SUM = 55");

        const avgCell = await ctx.getCell(r0, c0 + COLS + 1);
        expectNotNull(avgCell, "Row 0 AVG exists");
        const avg = parseFloat(avgCell!.display.replace(",", "."));
        assertTrue(Math.abs(avg - 5.5) < 0.01, `Row 0 AVG = 5.5, got ${avg}`);

        // Row 19: values 191..200, SUM = 1955, AVG = 195.5
        const lastSum = await ctx.getCell(r0 + 19, c0 + COLS);
        expectCellValue(lastSum, "1955", "Row 19 SUM = 1955");
      },
    },

    // ------------------------------------------------------------------
    // 14. CROSS-COLUMN LOOKUPS AT SCALE
    // ------------------------------------------------------------------
    {
      name: "20 XLOOKUP formulas against a 50-row table",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const updates: Array<{ row: number; col: number; value: string }> = [];

        // Build a 50-row lookup table: ID(c0), Value(c0+1)
        for (let i = 0; i < 50; i++) {
          updates.push({ row: r0 + i, col: c0, value: `Item${i}` });
          updates.push({ row: r0 + i, col: c0 + 1, value: `=${(i + 1) * 100}` });
        }

        // 20 lookup formulas in column c0+3
        for (let i = 0; i < 20; i++) {
          const lookupKey = `Item${i * 2}`; // Even items: 0,2,4,...,38
          updates.push({
            row: r0 + i, col: c0 + 3,
            value: `=XLOOKUP("${lookupKey}",${A.ref(0, 0)}:${A.ref(49, 0)},${A.ref(0, 1)}:${A.ref(49, 1)},"N/A")`,
          });
        }

        await ctx.setCells(updates);
        await ctx.settle();

        // Item0 -> 100, Item2 -> 300, Item38 -> 3900
        let cell = await ctx.getCell(r0, c0 + 3);
        expectCellValue(cell, "100", "XLOOKUP Item0 -> 100");

        cell = await ctx.getCell(r0 + 1, c0 + 3);
        expectCellValue(cell, "300", "XLOOKUP Item2 -> 300");

        cell = await ctx.getCell(r0 + 19, c0 + 3);
        expectCellValue(cell, "3900", "XLOOKUP Item38 -> 3900");
      },
    },

    // ------------------------------------------------------------------
    // 15. WORKFLOW: BUDGET VARIANCE ANALYSIS
    // ------------------------------------------------------------------
    {
      name: "Workflow: budget vs actual with variance and conditional flags",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Category(0), Budget(1), Actual(2), Variance(3), %Var(4), Flag(5)
        const categories = [
          ["Salaries", "=500000", "=520000"],
          ["Marketing", "=100000", "=85000"],
          ["R&D", "=200000", "=210000"],
          ["Operations", "=150000", "=145000"],
          ["Travel", "=50000", "=72000"],
        ];

        const updates: Array<{ row: number; col: number; value: string }> = [
          { row: r0, col: c0, value: "Category" },
          { row: r0, col: c0 + 1, value: "Budget" },
          { row: r0, col: c0 + 2, value: "Actual" },
          { row: r0, col: c0 + 3, value: "Variance" },
          { row: r0, col: c0 + 4, value: "%Var" },
          { row: r0, col: c0 + 5, value: "Flag" },
        ];

        for (let i = 0; i < categories.length; i++) {
          const r = r0 + 1 + i;
          updates.push({ row: r, col: c0, value: categories[i][0] });
          updates.push({ row: r, col: c0 + 1, value: categories[i][1] });
          updates.push({ row: r, col: c0 + 2, value: categories[i][2] });
          // Variance = Actual - Budget
          updates.push({ row: r, col: c0 + 3, value: `=${A.ref(1 + i, 2)}-${A.ref(1 + i, 1)}` });
          // % Variance
          updates.push({ row: r, col: c0 + 4, value: `=ROUND(${A.ref(1 + i, 3)}/${A.ref(1 + i, 1)}*100,1)` });
          // Flag: Over if actual > budget*1.1, Under if actual < budget*0.9, OK otherwise
          updates.push({
            row: r, col: c0 + 5,
            value: `=IF(${A.ref(1 + i, 2)}>${A.ref(1 + i, 1)}*1.1,"OVER",IF(${A.ref(1 + i, 2)}<${A.ref(1 + i, 1)}*0.9,"UNDER","OK"))`,
          });
        }

        // Totals
        const totRow = r0 + categories.length + 1;
        updates.push({ row: totRow, col: c0, value: "TOTAL" });
        updates.push({ row: totRow, col: c0 + 1, value: `=SUM(${A.ref(1, 1)}:${A.ref(categories.length, 1)})` });
        updates.push({ row: totRow, col: c0 + 2, value: `=SUM(${A.ref(1, 2)}:${A.ref(categories.length, 2)})` });
        updates.push({ row: totRow, col: c0 + 3, value: `=SUM(${A.ref(1, 3)}:${A.ref(categories.length, 3)})` });

        await ctx.setCells(updates);
        await ctx.settle();

        // Travel variance: 72000-50000 = 22000, %Var = 44%, Flag = OVER
        const travelVar = await ctx.getCell(r0 + 5, c0 + 3);
        expectCellValue(travelVar, "22000", "Travel variance = 22000");

        const travelFlag = await ctx.getCell(r0 + 5, c0 + 5);
        expectCellValue(travelFlag, "OVER", "Travel flag = OVER");

        // Marketing: 85000-100000 = -15000, -15%, UNDER
        const mktFlag = await ctx.getCell(r0 + 2, c0 + 5);
        expectCellValue(mktFlag, "UNDER", "Marketing flag = UNDER");

        // Operations: 145000-150000 = -5000, -3.3%, OK (within 10%)
        const opsFlag = await ctx.getCell(r0 + 4, c0 + 5);
        expectCellValue(opsFlag, "OK", "Operations flag = OK");

        // Total budget = 1000000
        const totalBudget = await ctx.getCell(totRow, c0 + 1);
        expectCellValue(totalBudget, "1000000", "Total budget = 1000000");

        // Total actual = 520000+85000+210000+145000+72000 = 1032000
        const totalActual = await ctx.getCell(totRow, c0 + 2);
        expectCellValue(totalActual, "1032000", "Total actual = 1032000");
      },
    },
  ],
};
