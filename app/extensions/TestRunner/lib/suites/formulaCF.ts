//! FILENAME: app/extensions/TestRunner/lib/suites/formulaCF.ts
// PURPOSE: Formula + Conditional Formatting cross-feature integration tests.
// CONTEXT: Verifies CF rules evaluate correctly on formula-computed values.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_FORMULA_CF } from "../testArea";
import {
  addConditionalFormat,
  getAllConditionalFormats,
  clearConditionalFormatsInRange,
  calculateNow,
} from "../../../../src/api";
import { evaluateConditionalFormats } from "../../../../src/api/backend";

const A = AREA_FORMULA_CF;

export const formulaCFSuite: TestSuite = {
  name: "Formula + CF Integration",
  description: "Tests conditional formatting evaluation on formula-computed cell values.",

  afterEach: async (ctx) => {
    try {
      await clearConditionalFormatsInRange(A.row, A.col, A.row + 10, A.col + 5);
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 5; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Formula result triggers CF greaterThan rule",
      description: "Cell with =10+20+21 (=51) should match CF > 50.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "=10+20+21" }]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const addResult = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { bold: true },
        });
        assertTrue(addResult.success, `add CF should succeed: ${addResult.error}`);

        const evalResult = await evaluateConditionalFormats(A.row, A.col, A.row, A.col);
        const match = evalResult.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(match, "cell with 51 should match CF > 50");
      },
    },
    {
      name: "CF expression rule referencing another cell",
      description: "CF expression on cell B checks if B > 150, where B = A*2 and A = 100.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "100" },
          { row: A.row, col: A.col + 1, value: `=${A.ref(0, 0)}*2` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Verify the formula computed correctly
        const cell = await ctx.getCell(A.row, A.col + 1);
        expectNotNull(cell, "formula cell should exist");
        assertTrue(cell!.display.includes("200"), `expected 200, got ${cell!.display}`);

        const addResult = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col + 1, endRow: A.row, endCol: A.col + 1 }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "150" },
          format: { italic: true },
        });
        assertTrue(addResult.success, `add CF should succeed: ${addResult.error}`);

        const evalResult = await evaluateConditionalFormats(A.row, A.col + 1, A.row, A.col + 1);
        const match = evalResult.cells.find(c => c.row === A.row && c.col === A.col + 1);
        expectNotNull(match, "cell with 200 should match CF > 150");
      },
    },
    {
      name: "Update formula re-evaluates CF",
      description: "Change formula from =40 (no match) to =60 (match for > 50).",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "=40" }]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const addResult = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { bold: true },
        });
        assertTrue(addResult.success, `add CF should succeed: ${addResult.error}`);

        // Should NOT match with value 40
        const evalBefore = await evaluateConditionalFormats(A.row, A.col, A.row, A.col);
        const matchBefore = evalBefore.cells.find(c => c.row === A.row && c.col === A.col);
        assertTrue(matchBefore === undefined, "cell with 40 should NOT match CF > 50");

        // Update formula to =60
        await ctx.setCells([{ row: A.row, col: A.col, value: "=60" }]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // Should match now
        const evalAfter = await evaluateConditionalFormats(A.row, A.col, A.row, A.col);
        const matchAfter = evalAfter.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(matchAfter, "cell with 60 should match CF > 50");
      },
    },
    {
      name: "Multiple CF rules on formula cell",
      description: "Two CF rules (>50 and >70) on cell with =75, both should be present.",
      run: async (ctx) => {
        await ctx.setCells([{ row: A.row, col: A.col, value: "=75" }]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        const r1 = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { bold: true },
        });
        const r2 = await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row, endCol: A.col }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "70" },
          format: { italic: true },
        });
        assertTrue(r1.success && r2.success, "both CF rules should be added");

        const all = await getAllConditionalFormats();
        const id1 = r1.rule!.id;
        const id2 = r2.rule!.id;
        assertTrue(all.some(r => r.id === id1), "first rule should exist");
        assertTrue(all.some(r => r.id === id2), "second rule should exist");
      },
    },
    {
      name: "CF on range with mixed formula/literal values",
      description: "3 cells: 30, =20+40, 80. CF > 50 should match 2 cells.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "30" },
          { row: A.row + 1, col: A.col, value: "=20+40" },
          { row: A.row + 2, col: A.col, value: "80" },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        await addConditionalFormat({
          ranges: [{ startRow: A.row, startCol: A.col, endRow: A.row + 2, endCol: A.col }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { bold: true },
        });

        const evalResult = await evaluateConditionalFormats(A.row, A.col, A.row + 2, A.col);
        const matches = evalResult.cells.filter(
          c => c.col === A.col && c.row >= A.row && c.row <= A.row + 2
        );
        assertEqual(matches.length, 2, `expected 2 matches (60 and 80), got ${matches.length}`);
      },
    },
  ],
};
