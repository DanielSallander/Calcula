//! FILENAME: app/extensions/TestRunner/lib/suites/formulaEval.ts
// PURPOSE: Formula Evaluation Debugger test suite.
// CONTEXT: Tests step-through evaluation of formulas (init, evaluate, step in/out, restart, close).

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_FORMULA_EVAL } from "../testArea";
import {
  evalFormulaInit,
  evalFormulaEvaluate,
  evalFormulaStepIn,
  evalFormulaStepOut,
  evalFormulaRestart,
  evalFormulaClose,
} from "../../../../src/api";

const A = AREA_FORMULA_EVAL;

export const formulaEvalSuite: TestSuite = {
  name: "Formula Evaluation Debugger",
  description: "Tests step-through formula evaluation sessions.",

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
      name: "Init evaluation session",
      description: "evalFormulaInit starts a debugging session for a formula cell.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: `=SUM(${A.ref(0, 0)},20)` },
        ]);
        await ctx.settle();

        const state = await evalFormulaInit(A.row + 1, A.col);
        expectNotNull(state.sessionId, "should have session ID");
        assertTrue(state.sessionId.length > 0, "session ID not empty");
        assertTrue(state.formulaDisplay.length > 0, "formula display not empty");
        assertTrue(!state.isComplete, "should not be complete at start");

        // Clean up session
        await evalFormulaClose(state.sessionId);
      },
    },
    {
      name: "Evaluate steps through formula",
      description: "evalFormulaEvaluate advances the evaluation.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "5" },
          { row: A.row + 1, col: A.col, value: `=${A.ref(0, 0)}+10` },
        ]);
        await ctx.settle();

        const init = await evalFormulaInit(A.row + 1, A.col);
        let state = init;

        // Step through until complete or max iterations
        let steps = 0;
        while (!state.isComplete && steps < 20) {
          if (state.canEvaluate) {
            state = await evalFormulaEvaluate(state.sessionId);
          } else {
            break;
          }
          steps++;
        }

        assertTrue(steps > 0, "should take at least 1 step");
        ctx.log(`Evaluated in ${steps} steps, complete=${state.isComplete}`);

        // Final result should be "15" if complete
        if (state.isComplete && state.evaluationResult) {
          assertEqual(state.evaluationResult, "15", "5+10=15");
        }

        await evalFormulaClose(init.sessionId);
      },
    },
    {
      name: "Step in to referenced cell",
      description: "evalFormulaStepIn follows a cell reference.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=1+2" },
          { row: A.row + 1, col: A.col, value: `=${A.ref(0, 0)}*3` },
        ]);
        await ctx.settle();

        const init = await evalFormulaInit(A.row + 1, A.col);

        if (init.canStepIn) {
          const stepped = await evalFormulaStepIn(init.sessionId);
          // After stepping in, we should be evaluating the referenced cell
          assertTrue(stepped.formulaDisplay.length > 0, "should have formula after step in");
          ctx.log(`Stepped in: ${stepped.formulaDisplay}, target: ${stepped.cellReference}`);

          // Step out should return to the parent
          if (stepped.canStepOut) {
            const steppedOut = await evalFormulaStepOut(init.sessionId);
            assertTrue(steppedOut.formulaDisplay.length > 0, "should have formula after step out");
          }
        } else {
          ctx.log("Step in not available at init position (may need to evaluate first)");
        }

        await evalFormulaClose(init.sessionId);
      },
    },
    {
      name: "Restart evaluation",
      description: "evalFormulaRestart resets to the beginning.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=2+3" },
        ]);
        await ctx.settle();

        const init = await evalFormulaInit(A.row, A.col);
        const origDisplay = init.formulaDisplay;

        // Advance a bit
        if (init.canEvaluate) {
          await evalFormulaEvaluate(init.sessionId);
        }

        // Restart
        const restarted = await evalFormulaRestart(init.sessionId);
        assertEqual(restarted.formulaDisplay, origDisplay, "formula should match original after restart");
        assertTrue(!restarted.isComplete, "should not be complete after restart");

        await evalFormulaClose(init.sessionId);
      },
    },
    {
      name: "Close evaluation session",
      description: "evalFormulaClose cleans up the session.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=1+1" },
        ]);
        await ctx.settle();

        const init = await evalFormulaInit(A.row, A.col);
        const closed = await evalFormulaClose(init.sessionId);
        assertTrue(closed, "close should return true");
      },
    },
  ],
};
