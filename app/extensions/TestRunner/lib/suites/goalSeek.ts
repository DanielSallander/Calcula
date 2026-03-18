//! FILENAME: app/extensions/TestRunner/lib/suites/goalSeek.ts
// PURPOSE: Goal seek test suite.
// CONTEXT: Tests finding input values that produce desired formula results.

import type { TestSuite } from "../types";
import { assertTrue, expectCellContains } from "../assertions";
import { AREA_GOAL_SEEK } from "../testArea";
import { goalSeek } from "../../../../src/api";

const A = AREA_GOAL_SEEK;

export const goalSeekSuite: TestSuite = {
  name: "Goal Seek",
  description: "Tests goal seek for finding input values.",

  afterEach: async (ctx) => {
    const clears = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Simple goal seek (multiply by 2)",
      description: "Formula =K*2, seek 100 => K should be ~50.",
      run: async (ctx) => {
        // Variable cell
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: `=${A.ref(0, 0)}*2` },
        ]);
        await ctx.settle();

        const result = await goalSeek({
          targetRow: A.row + 1,
          targetCol: A.col,
          targetValue: 100,
          variableRow: A.row,
          variableCol: A.col,
        });

        assertTrue(result.foundSolution, "Should find a solution");
        // Variable should be close to 50
        assertTrue(
          Math.abs(result.variableValue - 50) < 0.01,
          `Variable should be ~50, got ${result.variableValue}`
        );
      },
    },
    {
      name: "Goal seek with combined formula",
      description: "Formula combining operations finds correct input.",
      run: async (ctx) => {
        // Variable cell = K, formula = (K + 10) * 3
        // If we want result = 60, then K + 10 = 20, K = 10
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: `=(${A.ref(0, 0)}+10)*3` },
        ]);
        await ctx.settle();

        const result = await goalSeek({
          targetRow: A.row + 1,
          targetCol: A.col,
          targetValue: 60,
          variableRow: A.row,
          variableCol: A.col,
        });

        assertTrue(result.foundSolution, "Should find a solution");
        assertTrue(
          Math.abs(result.variableValue - 10) < 0.1,
          `Variable should be ~10, got ${result.variableValue}`
        );
      },
    },
    {
      name: "Goal seek reports convergence info",
      description: "Result includes iteration count.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: `=${A.ref(0, 0)}*5` },
        ]);
        await ctx.settle();

        const result = await goalSeek({
          targetRow: A.row + 1,
          targetCol: A.col,
          targetValue: 250,
          variableRow: A.row,
          variableCol: A.col,
        });

        assertTrue(result.iterations > 0, "Should report iterations > 0");
        ctx.log(`Converged in ${result.iterations} iterations`);
      },
    },
  ],
};
