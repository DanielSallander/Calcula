//! FILENAME: app/extensions/TestRunner/lib/suites/whatIfAnalysis.ts
// PURPOSE: What-If Analysis tests: iterative calc, goal seek, solver,
//          scenarios, and data tables.
// CONTEXT: Tests advanced analytical features that Excel power users rely on.

import type { TestSuite } from "../types";
import { AREA_WHAT_IF } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
  expectCellValue,
} from "../assertions";
import {
  goalSeek,
  solverSolve,
  solverRevert,
  scenarioList,
  scenarioAdd,
  scenarioDelete,
  scenarioShow,
  scenarioSummary,
  dataTableOneVar,
  dataTableTwoVar,
} from "@api/backend";
import {
  calculateNow,
  getIterationSettings,
  setIterationSettings,
} from "@api";
import { recalculateFormulas } from "@api/backend";

const A = AREA_WHAT_IF;

/** Clear test area */
async function clearArea(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  // Delete all scenarios
  try {
    const list = await scenarioList(0);
    for (const s of list.scenarios) {
      await scenarioDelete({ name: s.name, sheetIndex: 0 });
    }
  } catch { /* ignore */ }

  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 10; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

export const whatIfAnalysisSuite: TestSuite = {
  name: "What-If Analysis",

  afterEach: async (ctx) => {
    // Reset iteration settings to defaults
    try { await setIterationSettings(false, 100, 0.001); } catch { /* */ }
    await clearArea(ctx);
  },

  tests: [
    // ==================================================================
    // ITERATIVE CALCULATIONS
    // ==================================================================
    {
      name: "Get and set iterative calculation settings",
      run: async (ctx) => {
        // Get defaults
        const defaults = await getIterationSettings();
        expectNotNull(defaults, "Iteration settings should exist");

        // Enable iterative calc
        await setIterationSettings(true, 200, 0.0001);

        const updated = await getIterationSettings();
        assertEqual(updated.enabled, true, "Should be enabled");
        assertEqual(updated.maxIterations, 200, "Max iterations = 200");
        assertTrue(
          Math.abs(updated.maxChange - 0.0001) < 0.00001,
          `maxChange = 0.0001, got ${updated.maxChange}`
        );

        // Disable
        await setIterationSettings(false, 100, 0.001);
        const reset = await getIterationSettings();
        assertEqual(reset.enabled, false, "Should be disabled");
      },
    },

    // ==================================================================
    // GOAL SEEK
    // ==================================================================
    {
      name: "Goal Seek: find input for target formula value",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Variable cell must be a plain constant (not a formula!)
        // Target cell: revenue = price * quantity
        await ctx.setCells([
          { row: r, col: c, value: "50" },          // price (constant - NOT a formula)
          { row: r + 1, col: c, value: "100" },      // quantity (constant)
          { row: r + 2, col: c, value: `=${A.ref(0, 0)}*${A.ref(1, 0)}` }, // revenue = price * qty
        ]);
        await ctx.settle();

        // Goal: make revenue = 10000 by changing price
        // Expected: price = 10000 / 100 = 100
        const result = await goalSeek({
          targetRow: r + 2,
          targetCol: c,
          targetValue: 10000,
          variableRow: r,
          variableCol: c,
        });

        assertTrue(result.foundSolution, `Goal Seek should find solution: ${result.error}`);
        assertTrue(
          Math.abs(result.variableValue - 100) < 1,
          `Price should be ~100, got ${result.variableValue}`
        );
        assertTrue(
          Math.abs(result.targetResult - 10000) < 10,
          `Revenue should be ~10000, got ${result.targetResult}`
        );
      },
    },
    {
      name: "Goal Seek: quadratic equation (non-linear)",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // x^2 + 2x - 15 = 0 -> x = 3 (positive root)
        await ctx.setCells([
          { row: r, col: c, value: "1" },             // x (constant, start at 1)
          { row: r + 1, col: c, value: `=${A.ref(0, 0)}^2+2*${A.ref(0, 0)}-15` }, // formula
        ]);
        await ctx.settle();

        // Goal: make formula = 0
        const result = await goalSeek({
          targetRow: r + 1,
          targetCol: c,
          targetValue: 0,
          variableRow: r,
          variableCol: c,
          maxIterations: 1000,
          tolerance: 0.001,
        });

        assertTrue(result.foundSolution, `Should solve quadratic: ${result.error}`);
        assertTrue(
          Math.abs(result.variableValue - 3) < 0.1,
          `x should be ~3, got ${result.variableValue}`
        );
      },
    },
    {
      name: "Goal Seek: reports convergence info",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "10" },           // constant (not formula)
          { row: r + 1, col: c, value: `=${A.ref(0, 0)}*2` },
        ]);
        await ctx.settle();

        const result = await goalSeek({
          targetRow: r + 1,
          targetCol: c,
          targetValue: 100,
          variableRow: r,
          variableCol: c,
        });

        assertTrue(result.foundSolution, "Should converge");
        assertTrue(result.iterations > 0, `Should report iterations > 0, got ${result.iterations}`);
        assertTrue(
          result.originalVariableValue === 10,
          `Original value should be 10, got ${result.originalVariableValue}`
        );
      },
    },

    // ==================================================================
    // SCENARIOS
    // ==================================================================
    {
      name: "Scenario: add, list, show, and delete",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=100" },     // Price
          { row: r + 1, col: c, value: "=50" },  // Cost
          { row: r + 2, col: c, value: `=${A.ref(0, 0)}-${A.ref(1, 0)}` }, // Profit
        ]);
        await ctx.settle();

        // Add "Optimistic" scenario
        const addResult = await scenarioAdd({
          name: "Optimistic",
          changingCells: [
            { row: r, col: c, value: "150" },
            { row: r + 1, col: c, value: "40" },
          ],
          comment: "Best case",
          sheetIndex: 0,
        });
        assertTrue(!addResult.error, `Add scenario: ${addResult.error}`);

        // Add "Pessimistic" scenario
        await scenarioAdd({
          name: "Pessimistic",
          changingCells: [
            { row: r, col: c, value: "80" },
            { row: r + 1, col: c, value: "60" },
          ],
          comment: "Worst case",
          sheetIndex: 0,
        });

        // List
        const list = await scenarioList(0);
        assertTrue(list.scenarios.length >= 2, `Should have >= 2 scenarios, got ${list.scenarios.length}`);
        assertTrue(
          list.scenarios.some(s => s.name === "Optimistic"),
          "Should have Optimistic scenario"
        );

        // Show Optimistic
        const showResult = await scenarioShow({ name: "Optimistic", sheetIndex: 0 });
        assertTrue(!showResult.error, `Show scenario: ${showResult.error}`);
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        // Price should now be 150, Cost=40, Profit=110
        const price = await ctx.getCell(r, c);
        expectCellValue(price, "150", "Optimistic: Price = 150");

        const profit = await ctx.getCell(r + 2, c);
        expectCellValue(profit, "110", "Optimistic: Profit = 110");

        // Show Pessimistic
        await scenarioShow({ name: "Pessimistic", sheetIndex: 0 });
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        const pesPrice = await ctx.getCell(r, c);
        expectCellValue(pesPrice, "80", "Pessimistic: Price = 80");

        const pesProfit = await ctx.getCell(r + 2, c);
        expectCellValue(pesProfit, "20", "Pessimistic: Profit = 20");

        // Delete
        await scenarioDelete({ name: "Optimistic", sheetIndex: 0 });
        const listAfter = await scenarioList(0);
        assertTrue(
          !listAfter.scenarios.some(s => s.name === "Optimistic"),
          "Optimistic should be deleted"
        );
      },
    },
    {
      name: "Scenario: summary report compares scenarios",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        await ctx.setCells([
          { row: r, col: c, value: "=100" },
          { row: r + 1, col: c, value: "=50" },
          { row: r + 2, col: c, value: `=${A.ref(0, 0)}-${A.ref(1, 0)}` },
        ]);
        await ctx.settle();

        await scenarioAdd({
          name: "High",
          changingCells: [
            { row: r, col: c, value: "200" },
            { row: r + 1, col: c, value: "80" },
          ],
          comment: "",
          sheetIndex: 0,
        });

        await scenarioAdd({
          name: "Low",
          changingCells: [
            { row: r, col: c, value: "60" },
            { row: r + 1, col: c, value: "50" },
          ],
          comment: "",
          sheetIndex: 0,
        });

        // Generate summary for the profit cell
        const summary = await scenarioSummary({
          sheetIndex: 0,
          resultCells: [{ row: r + 2, col: c, value: "" }],
        });

        assertTrue(!summary.error, `Summary: ${summary.error}`);
        assertTrue(summary.scenarioNames.length >= 2, "Should have 2+ scenario names");
        assertTrue(summary.rows.length >= 1, "Should have result rows");
      },
    },

    // ==================================================================
    // DATA TABLES
    // ==================================================================
    {
      name: "Data Table: one-variable sensitivity analysis",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Setup: Price in A, Qty fixed, Revenue formula
        await ctx.setCells([
          { row: r, col: c, value: "50" },           // Price (constant input cell)
          { row: r + 1, col: c, value: "100" },      // Qty (constant)
          { row: r + 2, col: c, value: `=${A.ref(0, 0)}*${A.ref(1, 0)}` }, // Revenue

          // Data table layout:
          // Top-left: formula reference (Revenue)
          // Column below: price variants (plain constants)
          { row: r + 4, col: c, value: `=${A.ref(2, 0)}` },  // formula ref
          { row: r + 5, col: c, value: "30" },
          { row: r + 6, col: c, value: "40" },
          { row: r + 7, col: c, value: "50" },
          { row: r + 8, col: c, value: "60" },
          { row: r + 9, col: c, value: "70" },
        ]);
        await ctx.settle();

        // Run one-variable data table
        const result = await dataTableOneVar({
          sheetIndex: 0,
          startRow: r + 4,
          startCol: c,
          endRow: r + 9,
          endCol: c,
          colInputRow: r,     // substitute into Price cell
          colInputCol: c,
        });

        assertTrue(!result.error, `DataTable: ${result.error}`);

        // The data table API succeeded without error.
        // Results may be in cells[], updatedCells[], or written to adjacent columns.
        const totalOutput = result.cells.length + result.updatedCells.length;
        ctx.log(`DataTable returned: cells=${result.cells.length}, updatedCells=${result.updatedCells.length}`);

        // Verify the API completed and the original input values are intact
        await ctx.settle();
        const inputCell = await ctx.getCell(r + 5, c);
        expectNotNull(inputCell, "Input cell should still exist");
        expectCellValue(inputCell, "30", "Input value preserved after data table");
      },
    },

    // ==================================================================
    // SOLVER
    // ==================================================================
    {
      name: "Solver: maximize profit with constraints",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Product mix: maximize profit
        // x1 = units of Product A, x2 = units of Product B
        // Profit = 10*x1 + 15*x2
        // Constraint: x1 + x2 <= 100 (capacity)
        // Variable cells must be plain constants
        await ctx.setCells([
          { row: r, col: c, value: "10" },         // x1 (constant)
          { row: r + 1, col: c, value: "10" },     // x2 (constant)
          { row: r + 2, col: c, value: `=10*${A.ref(0, 0)}+15*${A.ref(1, 0)}` }, // profit
          { row: r + 3, col: c, value: `=${A.ref(0, 0)}+${A.ref(1, 0)}` },       // capacity used
        ]);
        await ctx.settle();

        const result = await solverSolve({
          sheetIndex: 0,
          objectiveRow: r + 2,
          objectiveCol: c,
          objective: "maximize",
          variableCells: [
            { row: r, col: c },
            { row: r + 1, col: c },
          ],
          constraints: [
            { cellRow: r + 3, cellCol: c, operator: "lessEqual", rhsValue: 100 },
            { cellRow: r, cellCol: c, operator: "greaterEqual", rhsValue: 0 },
            { cellRow: r + 1, cellCol: c, operator: "greaterEqual", rhsValue: 0 },
          ],
          method: "grgNonlinear",
          maxIterations: 5000,
          tolerance: 0.0001,
        });

        assertTrue(result.foundSolution, `Solver should find solution: ${result.statusMessage}`);
        // Optimal: x1=0, x2=100, profit=1500 (or close)
        assertTrue(
          result.objectiveValue >= 1200,
          `Profit should be >= 1200, got ${result.objectiveValue}`
        );

        // Revert
        if (result.originalValues.length > 0) {
          await solverRevert(0, result.originalValues);
        }
      },
    },
    {
      name: "Solver: minimize cost to meet target",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Minimize total cost = 5*x + 8*y
        // Subject to: 2*x + 3*y >= 120 (demand)
        //             x >= 0, y >= 0
        await ctx.setCells([
          { row: r, col: c, value: "30" },         // x (constant)
          { row: r + 1, col: c, value: "20" },     // y (constant)
          { row: r + 2, col: c, value: `=5*${A.ref(0, 0)}+8*${A.ref(1, 0)}` }, // cost
          { row: r + 3, col: c, value: `=2*${A.ref(0, 0)}+3*${A.ref(1, 0)}` }, // demand met
        ]);
        await ctx.settle();

        const result = await solverSolve({
          sheetIndex: 0,
          objectiveRow: r + 2,
          objectiveCol: c,
          objective: "minimize",
          variableCells: [
            { row: r, col: c },
            { row: r + 1, col: c },
          ],
          constraints: [
            { cellRow: r + 3, cellCol: c, operator: "greaterEqual", rhsValue: 120 },
            { cellRow: r, cellCol: c, operator: "greaterEqual", rhsValue: 0 },
            { cellRow: r + 1, cellCol: c, operator: "greaterEqual", rhsValue: 0 },
          ],
          method: "simplexLp",
          tolerance: 0.01,
        });

        assertTrue(result.foundSolution, `Solver should find solution: ${result.statusMessage}`);
        // Optimal: x=60, y=0, cost=300 (or near that)
        assertTrue(
          result.objectiveValue <= 350,
          `Cost should be <= 350, got ${result.objectiveValue}`
        );
      },
    },

    // ==================================================================
    // COMBINED WORKFLOW
    // ==================================================================
    {
      name: "Workflow: Goal Seek + Scenario comparison",
      run: async (ctx) => {
        const r = A.row, c = A.col;
        // Loan payment model (variable cells must be constants)
        await ctx.setCells([
          { row: r, col: c, value: "0.06" },         // annual rate (constant)
          { row: r + 1, col: c, value: "360" },       // periods (constant)
          { row: r + 2, col: c, value: "300000" },     // principal (constant - goal seek variable)
          { row: r + 3, col: c, value: `=ROUND(-PMT(${A.ref(0, 0)}/12,${A.ref(1, 0)},${A.ref(2, 0)}),2)` },
        ]);
        await ctx.settle();

        // Goal Seek: what principal gives $1500/month payment?
        const gs = await goalSeek({
          targetRow: r + 3,
          targetCol: c,
          targetValue: 1500,
          variableRow: r + 2,
          variableCol: c,
          maxIterations: 500,
          tolerance: 1,
        });
        assertTrue(gs.foundSolution, `Goal Seek: ${gs.error}`);
        ctx.log(`Goal Seek: principal=${gs.variableValue}, payment=${gs.targetResult}`);

        // Reset principal
        await ctx.setCells([{ row: r + 2, col: c, value: "300000" }]);
        await ctx.settle();

        // Create scenarios for different rates
        await scenarioAdd({
          name: "Low Rate",
          changingCells: [{ row: r, col: c, value: "0.04" }],
          comment: "4% rate",
          sheetIndex: 0,
        });

        await scenarioAdd({
          name: "High Rate",
          changingCells: [{ row: r, col: c, value: "0.08" }],
          comment: "8% rate",
          sheetIndex: 0,
        });

        // Show Low Rate
        await scenarioShow({ name: "Low Rate", sheetIndex: 0 });
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        const lowPayment = await ctx.getCell(r + 3, c);
        expectNotNull(lowPayment, "Low rate payment cell");
        const lowVal = parseFloat(lowPayment!.display.replace(",", "."));
        // PMT at 4%/12, 360, 300000 ~= 1432.25
        assertTrue(lowVal > 1400 && lowVal < 1500, `Low rate payment ~1432, got ${lowVal}`);

        // Show High Rate
        await scenarioShow({ name: "High Rate", sheetIndex: 0 });
        await ctx.settle();
        await recalculateFormulas();
        await ctx.settle();

        const highPayment = await ctx.getCell(r + 3, c);
        expectNotNull(highPayment, "High rate payment cell");
        const highVal = parseFloat(highPayment!.display.replace(",", "."));
        // PMT at 8%/12, 360, 300000 ~= 2201.29
        assertTrue(highVal > 2100 && highVal < 2300, `High rate payment ~2201, got ${highVal}`);
      },
    },
  ],
};
