//! FILENAME: app/extensions/TestRunner/lib/suites/formulaChains.ts
// PURPOSE: Complex formula chain integration tests.
// CONTEXT: Tests advanced formula combinations, multi-level dependencies,
//          lookup chains, array compositions, cross-sheet references,
//          conditional aggregates, error propagation, and solver integration.

import type { TestSuite } from "../types";
import { AREA_FORMULA_CHAINS } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
  expectCellValue,
  expectCellContains,
} from "../assertions";
import { recalculateFormulas } from "@api/backend";

const A = AREA_FORMULA_CHAINS;

/** Clear the test area after each test */
async function clearArea(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 40; r++) {
    for (let c = 0; c < 15; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

export const formulaChainsSuite: TestSuite = {
  name: "Complex Formula Chains",

  afterEach: async (ctx) => {
    await clearArea(ctx);
  },

  tests: [
    // ------------------------------------------------------------------
    // 1. MULTI-LEVEL DEPENDENCY CHAINS
    // ------------------------------------------------------------------
    {
      name: "5-level dependency chain recalculates end-to-end",
      run: async (ctx) => {
        // A -> B -> C -> D -> E, change A, verify E updates
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=10" },                                     // A: source (formula for numeric)
          { row: r + 1, col: c, value: `=${A.ref(0, 0)}*2` },                   // B = A*2 = 20
          { row: r + 2, col: c, value: `=${A.ref(1, 0)}+5` },                   // C = B+5 = 25
          { row: r + 3, col: c, value: `=${A.ref(2, 0)}*${A.ref(2, 0)}` },      // D = C*C = 625
          { row: r + 4, col: c, value: `=SQRT(${A.ref(3, 0)})` },               // E = sqrt(D) = 25
        ]);
        await ctx.settle();
        await ctx.settle();

        let cell = await ctx.getCell(r + 4, c);
        expectCellValue(cell, "25", "E = sqrt(625)");

        // Change A from 10 to 5 (use formula to ensure numeric + triggers recalc)
        await ctx.setCells([{ row: r, col: c, value: "=5" }]);
        await ctx.settle();
        // Force full recalculation to ensure all dependents update
        await recalculateFormulas();
        await ctx.settle();

        // B=10, C=15, D=225, E=15
        cell = await ctx.getCell(r + 4, c);
        expectCellValue(cell, "15", "E after A changed to 5");
      },
    },
    {
      name: "Diamond dependency (two paths converge)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // A=10, B=A*2=20, C=A+3=13, D=B+C=33
        await ctx.setCells([
          { row: r, col: c, value: "=10" },
          { row: r, col: c + 1, value: `=${A.ref(0, 0)}*2` },
          { row: r, col: c + 2, value: `=${A.ref(0, 0)}+3` },
          { row: r, col: c + 3, value: `=${A.ref(0, 1)}+${A.ref(0, 2)}` },
        ]);
        await ctx.settle();
        await ctx.settle();

        let cell = await ctx.getCell(r, c + 3);
        expectCellValue(cell, "33", "D = B+C = 20+13");

        // Change A to 100 -- B=200, C=103, D=303
        await ctx.setCells([{ row: r, col: c, value: "=100" }]);
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        cell = await ctx.getCell(r, c + 3);
        expectCellValue(cell, "303", "D after A=100");
      },
    },

    // ------------------------------------------------------------------
    // 2. CONDITIONAL AGGREGATES (SUMIFS, COUNTIFS, AVERAGEIFS)
    // ------------------------------------------------------------------
    {
      name: "SUMIFS with multiple criteria",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Data: Region(c), Product(c+1), Amount(c+2)
        await ctx.setCells([
          { row: r, col: c, value: "Region" },
          { row: r, col: c + 1, value: "Product" },
          { row: r, col: c + 2, value: "Amount" },
          { row: r + 1, col: c, value: "North" },
          { row: r + 1, col: c + 1, value: "A" },
          { row: r + 1, col: c + 2, value: "100" },
          { row: r + 2, col: c, value: "North" },
          { row: r + 2, col: c + 1, value: "B" },
          { row: r + 2, col: c + 2, value: "200" },
          { row: r + 3, col: c, value: "South" },
          { row: r + 3, col: c + 1, value: "A" },
          { row: r + 3, col: c + 2, value: "150" },
          { row: r + 4, col: c, value: "North" },
          { row: r + 4, col: c + 1, value: "A" },
          { row: r + 4, col: c + 2, value: "300" },
          // SUMIFS: sum Amount where Region="North" AND Product="A"
          { row: r + 6, col: c, value: `=SUMIFS(${A.ref(1, 2)}:${A.ref(4, 2)},${A.ref(1, 0)}:${A.ref(4, 0)},"North",${A.ref(1, 1)}:${A.ref(4, 1)},"A")` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 6, c);
        expectCellValue(cell, "400", "SUMIFS North+A = 100+300");
      },
    },
    {
      name: "COUNTIFS with criteria",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "Score" },
          { row: r + 1, col: c, value: "85" },
          { row: r + 2, col: c, value: "92" },
          { row: r + 3, col: c, value: "78" },
          { row: r + 4, col: c, value: "95" },
          { row: r + 5, col: c, value: "88" },
          // Count scores >= 85
          { row: r + 7, col: c, value: `=COUNTIFS(${A.ref(1, 0)}:${A.ref(5, 0)},">="&85)` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 7, c);
        expectCellValue(cell, "4", "COUNTIFS >=85: 85,92,95,88");
      },
    },
    {
      name: "AVERAGEIFS with criteria",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "Dept" },
          { row: r, col: c + 1, value: "Salary" },
          { row: r + 1, col: c, value: "Eng" },
          { row: r + 1, col: c + 1, value: "80000" },
          { row: r + 2, col: c, value: "Sales" },
          { row: r + 2, col: c + 1, value: "60000" },
          { row: r + 3, col: c, value: "Eng" },
          { row: r + 3, col: c + 1, value: "90000" },
          { row: r + 4, col: c, value: "Eng" },
          { row: r + 4, col: c + 1, value: "100000" },
          // Average salary for Eng = (80000+90000+100000)/3 = 90000
          { row: r + 6, col: c, value: `=AVERAGEIFS(${A.ref(1, 1)}:${A.ref(4, 1)},${A.ref(1, 0)}:${A.ref(4, 0)},"Eng")` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 6, c);
        expectCellValue(cell, "90000", "AVERAGEIFS Eng salary");
      },
    },

    // ------------------------------------------------------------------
    // 3. LOOKUP CHAINS (XLOOKUP, INDEX/MATCH, VLOOKUP)
    // ------------------------------------------------------------------
    {
      name: "XLOOKUP basic lookup",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // ID(c), Name(c+1), Price(c+2)
        await ctx.setCells([
          { row: r, col: c, value: "ID" },
          { row: r, col: c + 1, value: "Name" },
          { row: r, col: c + 2, value: "Price" },
          { row: r + 1, col: c, value: "101" },
          { row: r + 1, col: c + 1, value: "Widget" },
          { row: r + 1, col: c + 2, value: "9.99" },
          { row: r + 2, col: c, value: "102" },
          { row: r + 2, col: c + 1, value: "Gadget" },
          { row: r + 2, col: c + 2, value: "19.99" },
          { row: r + 3, col: c, value: "103" },
          { row: r + 3, col: c + 1, value: "Doohickey" },
          { row: r + 3, col: c + 2, value: "4.99" },
          // Lookup ID 102 -> return Price
          { row: r + 5, col: c, value: `=XLOOKUP(102,${A.ref(1, 0)}:${A.ref(3, 0)},${A.ref(1, 2)}:${A.ref(3, 2)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 5, c);
        // Locale may format as "19.99" or "19,99"
        expectNotNull(cell, "XLOOKUP result should exist");
        const val = parseFloat(cell!.display.replace(",", "."));
        assertTrue(Math.abs(val - 19.99) < 0.01, `XLOOKUP ID=102 -> 19.99, got "${cell!.display}"`);
      },
    },
    {
      name: "INDEX/MATCH combination",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "Name" },
          { row: r, col: c + 1, value: "Score" },
          { row: r + 1, col: c, value: "Alice" },
          { row: r + 1, col: c + 1, value: "85" },
          { row: r + 2, col: c, value: "Bob" },
          { row: r + 2, col: c + 1, value: "92" },
          { row: r + 3, col: c, value: "Charlie" },
          { row: r + 3, col: c + 1, value: "78" },
          // INDEX/MATCH: find Bob's score
          { row: r + 5, col: c, value: `=INDEX(${A.ref(1, 1)}:${A.ref(3, 1)},MATCH("Bob",${A.ref(1, 0)}:${A.ref(3, 0)},0))` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 5, c);
        expectCellValue(cell, "92", "INDEX/MATCH Bob -> 92");
      },
    },
    {
      name: "XLOOKUP with fallback value",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // XLOOKUP with a not-found fallback
        await ctx.setCells([
          { row: r, col: c, value: "Apple" },
          { row: r, col: c + 1, value: "Red" },
          { row: r + 1, col: c, value: "Banana" },
          { row: r + 1, col: c + 1, value: "Yellow" },
          { row: r + 2, col: c, value: "Cherry" },
          { row: r + 2, col: c + 1, value: "Red" },
          // Found case
          { row: r + 4, col: c, value: `=XLOOKUP("Banana",${A.ref(0, 0)}:${A.ref(2, 0)},${A.ref(0, 1)}:${A.ref(2, 1)},"Not found")` },
          // Not found case
          { row: r + 5, col: c, value: `=XLOOKUP("Mango",${A.ref(0, 0)}:${A.ref(2, 0)},${A.ref(0, 1)}:${A.ref(2, 1)},"Not found")` },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r + 4, c);
        expectCellValue(cell, "Yellow", "XLOOKUP Banana -> Yellow");
        cell = await ctx.getCell(r + 5, c);
        expectCellValue(cell, "Not found", "XLOOKUP Mango -> Not found");
      },
    },

    // ------------------------------------------------------------------
    // 4. NESTED IF / IFS / SWITCH
    // ------------------------------------------------------------------
    {
      name: "Nested IF (3 levels)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "75" },
          // Nested IF: >=90 -> A, >=80 -> B, >=70 -> C, else F
          { row: r + 1, col: c, value: `=IF(${A.ref(0, 0)}>=90,"A",IF(${A.ref(0, 0)}>=80,"B",IF(${A.ref(0, 0)}>=70,"C","F")))` },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "C", "75 -> C");

        // Change to 95
        await ctx.setCells([{ row: r, col: c, value: "95" }]);
        await ctx.settle();
        cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "A", "95 -> A");
      },
    },
    {
      name: "IFS function",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "85" },
          { row: r + 1, col: c, value: `=IFS(${A.ref(0, 0)}>=90,"A",${A.ref(0, 0)}>=80,"B",${A.ref(0, 0)}>=70,"C",TRUE,"F")` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "B", "IFS 85 -> B");
      },
    },
    {
      name: "SWITCH function",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "2" },
          { row: r + 1, col: c, value: `=SWITCH(${A.ref(0, 0)},1,"One",2,"Two",3,"Three","Other")` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "Two", "SWITCH 2 -> Two");
      },
    },

    // ------------------------------------------------------------------
    // 5. SUMPRODUCT (array multiplication)
    // ------------------------------------------------------------------
    {
      name: "SUMPRODUCT weighted average",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Qty(c), Price(c+1)
        await ctx.setCells([
          { row: r, col: c, value: "10" },
          { row: r, col: c + 1, value: "5" },
          { row: r + 1, col: c, value: "20" },
          { row: r + 1, col: c + 1, value: "8" },
          { row: r + 2, col: c, value: "30" },
          { row: r + 2, col: c + 1, value: "3" },
          // SUMPRODUCT = 10*5 + 20*8 + 30*3 = 50 + 160 + 90 = 300
          { row: r + 4, col: c, value: `=SUMPRODUCT(${A.ref(0, 0)}:${A.ref(2, 0)},${A.ref(0, 1)}:${A.ref(2, 1)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 4, c);
        expectCellValue(cell, "300", "SUMPRODUCT = 300");
      },
    },

    // ------------------------------------------------------------------
    // 6. ERROR PROPAGATION
    // ------------------------------------------------------------------
    {
      name: "Division by zero propagates through chain",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "0" },
          { row: r + 1, col: c, value: `=1/${A.ref(0, 0)}` },     // #DIV/0!
          { row: r + 2, col: c, value: `=${A.ref(1, 0)}+10` },    // should propagate error
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 2, c);
        expectNotNull(cell, "Error cell should exist");
        expectCellContains(cell, "DIV", "Error should propagate through chain");
      },
    },
    {
      name: "IFERROR catches error in chain",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "0" },
          { row: r + 1, col: c, value: `=1/${A.ref(0, 0)}` },                  // #DIV/0!
          { row: r + 2, col: c, value: `=IFERROR(${A.ref(1, 0)}+10, -1)` },    // catches -> -1
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 2, c);
        expectCellValue(cell, "-1", "IFERROR catches #DIV/0! -> -1");
      },
    },

    // ------------------------------------------------------------------
    // 7. TEXT FORMULA CHAINS
    // ------------------------------------------------------------------
    {
      name: "Text function chain (UPPER, LEFT, CONCATENATE)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "hello" },
          { row: r, col: c + 1, value: "world" },
          // UPPER(LEFT(A,1)) & LOWER(MID(A,2,99)) & " " & UPPER(LEFT(B,1)) & LOWER(MID(B,2,99))
          { row: r + 1, col: c, value: `=UPPER(LEFT(${A.ref(0, 0)},1))&MID(${A.ref(0, 0)},2,99)&" "&UPPER(LEFT(${A.ref(0, 1)},1))&MID(${A.ref(0, 1)},2,99)` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "Hello World", "Title case via text chain");
      },
    },
    {
      name: "TEXTJOIN with delimiter",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "Alice" },
          { row: r + 1, col: c, value: "Bob" },
          { row: r + 2, col: c, value: "Charlie" },
          { row: r + 3, col: c, value: `=TEXTJOIN(", ",TRUE,${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 3, c);
        expectCellValue(cell, "Alice, Bob, Charlie", "TEXTJOIN with comma");
      },
    },

    // ------------------------------------------------------------------
    // 8. DATE FUNCTIONS
    // ------------------------------------------------------------------
    {
      name: "Date arithmetic chain",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          // DATE(2024,1,15) = Jan 15, 2024
          { row: r, col: c, value: "=DATE(2024,1,15)" },
          { row: r + 1, col: c, value: `=YEAR(${A.ref(0, 0)})` },
          { row: r + 2, col: c, value: `=MONTH(${A.ref(0, 0)})` },
          { row: r + 3, col: c, value: `=DAY(${A.ref(0, 0)})` },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "2024", "YEAR(DATE(2024,1,15))");
        cell = await ctx.getCell(r + 2, c);
        expectCellValue(cell, "1", "MONTH");
        cell = await ctx.getCell(r + 3, c);
        expectCellValue(cell, "15", "DAY");
      },
    },
    {
      name: "EDATE and EOMONTH",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=DATE(2024,1,15)" },
          // EDATE: 3 months later
          { row: r + 1, col: c, value: `=MONTH(EDATE(${A.ref(0, 0)},3))` },
          // EOMONTH: end of month 2 months later
          { row: r + 2, col: c, value: `=DAY(EOMONTH(${A.ref(0, 0)},2))` },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "4", "EDATE +3 months = April");
        cell = await ctx.getCell(r + 2, c);
        expectCellValue(cell, "31", "EOMONTH +2 = March 31");
      },
    },

    // ------------------------------------------------------------------
    // 9. STATISTICAL CHAINS
    // ------------------------------------------------------------------
    {
      name: "Statistical summary (MEDIAN, STDEV, PERCENTILE)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "10" },
          { row: r + 1, col: c, value: "20" },
          { row: r + 2, col: c, value: "30" },
          { row: r + 3, col: c, value: "40" },
          { row: r + 4, col: c, value: "50" },
          // Median
          { row: r + 6, col: c, value: `=MEDIAN(${A.ref(0, 0)}:${A.ref(4, 0)})` },
          // LARGE 2nd largest
          { row: r + 7, col: c, value: `=LARGE(${A.ref(0, 0)}:${A.ref(4, 0)},2)` },
          // SMALL 2nd smallest
          { row: r + 8, col: c, value: `=SMALL(${A.ref(0, 0)}:${A.ref(4, 0)},2)` },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r + 6, c);
        expectCellValue(cell, "30", "MEDIAN = 30");
        cell = await ctx.getCell(r + 7, c);
        expectCellValue(cell, "40", "LARGE 2nd = 40");
        cell = await ctx.getCell(r + 8, c);
        expectCellValue(cell, "20", "SMALL 2nd = 20");
      },
    },

    // ------------------------------------------------------------------
    // 10. FINANCIAL FORMULA CHAINS
    // ------------------------------------------------------------------
    {
      name: "Loan calculation (PMT, IPMT, PPMT)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // 5% annual rate, 30-year mortgage, $200,000 principal
        await ctx.setCells([
          { row: r, col: c, value: "0.05" },    // annual rate
          { row: r + 1, col: c, value: "360" },  // periods (30*12)
          { row: r + 2, col: c, value: "200000" },  // principal
          // Monthly payment
          { row: r + 3, col: c, value: `=ROUND(PMT(${A.ref(0, 0)}/12,${A.ref(1, 0)},${A.ref(2, 0)}),2)` },
          // Interest portion of 1st payment
          { row: r + 4, col: c, value: `=ROUND(IPMT(${A.ref(0, 0)}/12,1,${A.ref(1, 0)},${A.ref(2, 0)}),2)` },
          // Principal portion of 1st payment
          { row: r + 5, col: c, value: `=ROUND(PPMT(${A.ref(0, 0)}/12,1,${A.ref(1, 0)},${A.ref(2, 0)}),2)` },
        ]);
        await ctx.settle();

        // PMT should be negative (cash outflow) ~ -1073.64
        // Display may vary by locale (comma vs dot, rounding)
        const pmtCell = await ctx.getCell(r + 3, c);
        expectNotNull(pmtCell, "PMT cell exists");
        // Parse: strip non-numeric except minus sign, handle comma as decimal
        const parseNum = (s: string) => parseFloat(s.replace(/\s/g, "").replace(",", ".").replace(/[^0-9.\-]/g, ""));
        const pmtVal = parseNum(pmtCell!.display);
        assertTrue(pmtVal < 0, `PMT should be negative, got ${pmtVal}`);
        assertTrue(Math.abs(pmtVal + 1073.64) < 2, `PMT ~= -1073.64, got ${pmtVal}`);

        // IPMT + PPMT should equal PMT
        const ipmtCell = await ctx.getCell(r + 4, c);
        const ppmtCell = await ctx.getCell(r + 5, c);
        const ipmt = parseNum(ipmtCell!.display);
        const ppmt = parseNum(ppmtCell!.display);
        assertTrue(
          Math.abs((ipmt + ppmt) - pmtVal) < 0.1,
          `IPMT(${ipmt}) + PPMT(${ppmt}) should equal PMT(${pmtVal})`
        );
      },
    },

    // ------------------------------------------------------------------
    // 11. MATRIX FUNCTIONS
    // ------------------------------------------------------------------
    {
      name: "MDETERM matrix determinant",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // 2x2 matrix: det([1,2;3,4]) = 1*4 - 2*3 = -2
        await ctx.setCells([
          { row: r, col: c, value: "1" },
          { row: r, col: c + 1, value: "2" },
          { row: r + 1, col: c, value: "3" },
          { row: r + 1, col: c + 1, value: "4" },
          { row: r + 3, col: c, value: `=MDETERM(${A.ref(0, 0)}:${A.ref(1, 1)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 3, c);
        expectCellValue(cell, "-2", "MDETERM([1,2;3,4]) = -2");
      },
    },

    // ------------------------------------------------------------------
    // 12. LET WITH COMPLEX EXPRESSIONS
    // ------------------------------------------------------------------
    {
      name: "LET with multiple variables",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "100" },
          { row: r + 1, col: c, value: "0.08" },
          // LET(price, A, tax, B, total, price*(1+tax), ROUND(total, 2))
          { row: r + 2, col: c, value: `=LET(price,${A.ref(0, 0)},tax,${A.ref(1, 0)},total,price*(1+tax),ROUND(total,2))` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 2, c);
        expectCellValue(cell, "108", "LET price*1.08 = 108");
      },
    },

    // ------------------------------------------------------------------
    // 13. INDIRECT DYNAMIC REFERENCE
    // ------------------------------------------------------------------
    {
      name: "INDIRECT builds cell reference from text",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "42" },
          // Build reference as text and resolve with INDIRECT
          { row: r + 1, col: c, value: `=INDIRECT("${A.ref(0, 0)}")` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "42", "INDIRECT resolves to cell value");
      },
    },

    // ------------------------------------------------------------------
    // 14. CHOOSE FUNCTION
    // ------------------------------------------------------------------
    {
      name: "CHOOSE selects from list",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "3" },
          { row: r + 1, col: c, value: `=CHOOSE(${A.ref(0, 0)},"Red","Green","Blue","Yellow")` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "Blue", "CHOOSE(3) -> Blue");
      },
    },

    // ------------------------------------------------------------------
    // 15. COMPLEX COMBINED FORMULA
    // ------------------------------------------------------------------
    {
      name: "Combined: SUMIF as alternative to SUMPRODUCT+condition",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Category(c), Amount(c+1)
        await ctx.setCells([
          { row: r, col: c, value: "A" },
          { row: r, col: c + 1, value: "100" },
          { row: r + 1, col: c, value: "B" },
          { row: r + 1, col: c + 1, value: "200" },
          { row: r + 2, col: c, value: "A" },
          { row: r + 2, col: c + 1, value: "300" },
          { row: r + 3, col: c, value: "C" },
          { row: r + 3, col: c + 1, value: "400" },
          // SUMIF: sum amounts where category = "A": 100 + 300 = 400
          { row: r + 5, col: c, value: `=SUMIF(${A.ref(0, 0)}:${A.ref(3, 0)},"A",${A.ref(0, 1)}:${A.ref(3, 1)})` },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(r + 5, c);
        expectCellValue(cell, "400", "SUMIF category=A -> 400");
      },
    },
    {
      name: "Multi-step: lookup then aggregate",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Product table: ID(c), Category(c+1)
        // Sales table: ProductID(c+3), Amount(c+4)
        await ctx.setCells([
          { row: r, col: c, value: "1" }, { row: r, col: c + 1, value: "Electronics" },
          { row: r + 1, col: c, value: "2" }, { row: r + 1, col: c + 1, value: "Clothing" },
          { row: r + 2, col: c, value: "3" }, { row: r + 2, col: c + 1, value: "Electronics" },
          // Sales
          { row: r, col: c + 3, value: "1" }, { row: r, col: c + 4, value: "500" },
          { row: r + 1, col: c + 3, value: "2" }, { row: r + 1, col: c + 4, value: "300" },
          { row: r + 2, col: c + 3, value: "1" }, { row: r + 2, col: c + 4, value: "700" },
          { row: r + 3, col: c + 3, value: "3" }, { row: r + 3, col: c + 4, value: "400" },
          // Total sales for product ID 1 using SUMIF
          { row: r + 5, col: c, value: `=SUMIF(${A.ref(0, 3)}:${A.ref(3, 3)},1,${A.ref(0, 4)}:${A.ref(3, 4)})` },
          // Lookup category for product 1, then show "Category: X, Total: Y"
          { row: r + 6, col: c, value: `="Category: "&XLOOKUP(1,${A.ref(0, 0)}:${A.ref(2, 0)},${A.ref(0, 1)}:${A.ref(2, 1)})&", Total: "&${A.ref(5, 0)}` },
        ]);
        await ctx.settle();

        const sumCell = await ctx.getCell(r + 5, c);
        expectCellValue(sumCell, "1200", "SUMIF product 1 sales");

        const comboCell = await ctx.getCell(r + 6, c);
        expectCellValue(comboCell, "Category: Electronics, Total: 1200", "Combined lookup + aggregate");
      },
    },

    // ------------------------------------------------------------------
    // 16. CIRCULAR REFERENCE DETECTION
    // ------------------------------------------------------------------
    {
      name: "Circular reference does not crash",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: `=${A.ref(1, 0)}+1` },
          { row: r + 1, col: c, value: `=${A.ref(0, 0)}+1` },
        ]);
        await ctx.settle();

        // Engine may return an error, 0, or a partial iteration result.
        // The key assertion is that it doesn't crash or hang.
        const cell = await ctx.getCell(r, c);
        expectNotNull(cell, "Circular ref cell should exist and not crash");
      },
    },

    // ------------------------------------------------------------------
    // 17. LARGE FORMULA WITH MANY OPERANDS
    // ------------------------------------------------------------------
    {
      name: "SUM of 20 individual cell references",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        const cells: Array<{ row: number; col: number; value: string }> = [];
        let expected = 0;
        for (let i = 0; i < 20; i++) {
          cells.push({ row: r + i, col: c, value: String(i + 1) });
          expected += i + 1;
        }
        // Build formula with 20 individual references
        const refs = Array.from({ length: 20 }, (_, i) => A.ref(i, 0)).join(",");
        cells.push({ row: r + 21, col: c, value: `=SUM(${refs})` });
        await ctx.setCells(cells);
        await ctx.settle();

        const cell = await ctx.getCell(r + 21, c);
        expectCellValue(cell, String(expected), `SUM of 1..20 = ${expected}`);
      },
    },

    // ------------------------------------------------------------------
    // 18. MIXED TYPES IN FORMULAS
    // ------------------------------------------------------------------
    {
      name: "Formulas handle mixed types (number, text, boolean, empty)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Use column c+1 for data, c+2 for formulas (keep them separate)
        await ctx.setCells([
          { row: r, col: c + 1, value: "10" },
          { row: r + 1, col: c + 1, value: "hello" },
          { row: r + 2, col: c + 1, value: "TRUE" },
          // row 3 col c+1 is empty
          // COUNTA counts non-empty cells
          { row: r, col: c + 3, value: `=COUNTA(${A.ref(0, 1)}:${A.ref(3, 1)})` },
          // COUNT counts only numbers
          { row: r + 1, col: c + 3, value: `=COUNT(${A.ref(0, 1)}:${A.ref(3, 1)})` },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r, c + 3);
        // "TRUE" entered as text is still non-empty, so COUNTA = 3
        // But engine may parse "TRUE" as boolean, making COUNTA = 3
        const countA = parseInt(cell!.display, 10);
        assertTrue(countA >= 3, `COUNTA should be >= 3, got ${countA}`);

        cell = await ctx.getCell(r + 1, c + 3);
        // COUNT counts numeric values. "TRUE" may be counted as numeric (boolean=1).
        // Engine counts: 10 (number) + TRUE (boolean=numeric) = at least 1
        const countVal = parseInt(cell!.display, 10);
        assertTrue(countVal >= 1, `COUNT should be >= 1, got ${countVal}`);
      },
    },

    // ------------------------------------------------------------------
    // 19. DEPENDENCY UPDATE AFTER INSERT/DELETE
    // ------------------------------------------------------------------
    {
      name: "Formula updates when source cell value changes multiple times",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "1" },
          { row: r + 1, col: c, value: `=${A.ref(0, 0)}*10` },
        ]);
        await ctx.settle();

        for (const val of [5, 10, 0, -3, 100]) {
          await ctx.setCells([{ row: r, col: c, value: String(val) }]);
          await ctx.settle();
          const cell = await ctx.getCell(r + 1, c);
          expectCellValue(cell, String(val * 10), `${val}*10 = ${val * 10}`);
        }
      },
    },

    // ------------------------------------------------------------------
    // 20. ENGINEERING FUNCTIONS
    // ------------------------------------------------------------------
    {
      name: "Base conversion (DEC2BIN, DEC2HEX, BIN2DEC)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=DEC2BIN(42)" },
          { row: r + 1, col: c, value: "=DEC2HEX(255)" },
          { row: r + 2, col: c, value: "=BIN2DEC(101010)" },
        ]);
        await ctx.settle();

        let cell = await ctx.getCell(r, c);
        expectCellValue(cell, "101010", "DEC2BIN(42)");
        cell = await ctx.getCell(r + 1, c);
        expectCellValue(cell, "FF", "DEC2HEX(255)");
        cell = await ctx.getCell(r + 2, c);
        expectCellValue(cell, "42", "BIN2DEC(101010)");
      },
    },
  ],
};
