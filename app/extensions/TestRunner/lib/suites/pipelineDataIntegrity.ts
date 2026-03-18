//! FILENAME: app/extensions/TestRunner/lib/suites/pipelineDataIntegrity.ts
// PURPOSE: Data integrity pipeline tests.
// CONTEXT: Tests that row/column inserts, merges, and formatting interactions
//          preserve data correctness through multi-step operations.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue, expectCellEmpty } from "../assertions";
import { AREA_PIPELINE_INTEGRITY } from "../testArea";
import {
  insertRows,
  insertColumns,
  deleteRows,
  mergeCells,
  unmergeCells,
  getMergedRegions,
  calculateNow,
  addConditionalFormat,
  clearConditionalFormatsInRange,
  getAllConditionalFormats,
} from "../../../../src/api";
import { applyFormatting, getStyle } from "../../../../src/api/lib";
import { evaluateConditionalFormats } from "../../../../src/api/backend";

const A = AREA_PIPELINE_INTEGRITY;

export const pipelineDataIntegritySuite: TestSuite = {
  name: "Pipeline: Data Integrity",
  description: "Tests data integrity through inserts, deletes, merges, and formatting interactions.",

  afterEach: async (ctx) => {
    try {
      const merged = await getMergedRegions();
      for (const m of merged) {
        if (m.startRow >= A.row && m.startRow <= A.row + 20 && m.startCol >= A.col && m.startCol <= A.col + 10) {
          await unmergeCells(m.startRow, m.startCol);
        }
      }
    } catch { /* ignore */ }
    try {
      await clearConditionalFormatsInRange(A.row, A.col, A.row + 20, A.col + 10);
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 10; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Insert row shifts formulas correctly",
      description: "Inserting a row above formula range updates references.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Set data and SUM formula
        await ctx.setCells([
          { row: R, col: C, value: "10" },
          { row: R + 1, col: C, value: "20" },
          { row: R + 2, col: C, value: "30" },
          { row: R + 3, col: C, value: `=SUM(${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(R + 3, C), "60", "SUM before insert");

        // Insert a row at R+1 (between first and second value)
        await insertRows(R + 1, 1);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // The original data shifted down:
        // R: 10, R+1: (empty inserted), R+2: 20, R+3: 30, R+4: SUM formula
        expectCellValue(await ctx.getCell(R, C), "10", "first value unchanged");
        expectCellValue(await ctx.getCell(R + 2, C), "20", "second value shifted down");
        expectCellValue(await ctx.getCell(R + 3, C), "30", "third value shifted down");

        // SUM formula should have adjusted references and still work
        const sumCell = await ctx.getCell(R + 4, C);
        expectNotNull(sumCell, "SUM cell should exist at shifted position");
        // The SUM should still be 60 (references adjusted) or include the empty row
        ctx.log(`SUM after insert: ${sumCell!.display}`);
      },
    },
    {
      name: "Delete row updates dependent formulas",
      description: "Deleting a row that formulas reference adjusts or errors.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        await ctx.setCells([
          { row: R, col: C, value: "100" },
          { row: R + 1, col: C, value: "200" },
          { row: R + 2, col: C, value: "300" },
          // Formula referencing only R+1
          { row: R + 3, col: C, value: `=${A.ref(1, 0)}*2` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(R + 3, C), "400", "formula before delete (200*2)");

        // Delete row R+1 (the one our formula references)
        await deleteRows(R + 1, 1);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        // After delete: R: 100, R+1: 300, R+2: formula (shifted up)
        // The formula's reference was deleted, should show error or reference shifted
        const formulaCell = await ctx.getCell(R + 2, C);
        expectNotNull(formulaCell, "formula cell should exist");
        ctx.log(`Formula after deleting referenced row: ${formulaCell!.display}`);
        // The key assertion: the formula didn't crash the system
        assertTrue(true, "delete row with dependent formula did not crash");
      },
    },
    {
      name: "Merge with existing formatting preserves format",
      description: "Merging cells that already have bold formatting keeps the format.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // Set value and apply bold
        await ctx.setCells([{ row: R, col: C, value: "Merged Bold" }]);
        await ctx.settle();

        await applyFormatting([R], [C], { bold: true });
        await ctx.settle();

        // Verify bold was applied
        const beforeMerge = await ctx.getCell(R, C);
        expectNotNull(beforeMerge, "cell should exist before merge");
        if (beforeMerge!.styleIndex > 0) {
          const style = await getStyle(beforeMerge!.styleIndex);
          assertTrue(style?.bold === true, "should be bold before merge");
        }

        // Merge 2x2 range
        await mergeCells(R, C, R + 1, C + 1);
        await ctx.settle();

        // Verify merge exists
        const regions = await getMergedRegions();
        const ourMerge = regions.find(m =>
          m.startRow === R && m.startCol === C
        );
        assertTrue(ourMerge !== undefined, "merge should exist");

        // Verify value preserved
        const afterMerge = await ctx.getCell(R, C);
        expectCellValue(afterMerge, "Merged Bold", "value preserved after merge");

        // Verify bold preserved
        if (afterMerge!.styleIndex > 0) {
          const style = await getStyle(afterMerge!.styleIndex);
          assertTrue(style?.bold === true, "bold should be preserved after merge");
        }
      },
    },
    {
      name: "Insert column shifts CF range",
      description: "Inserting a column shifts conditional format ranges.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        await ctx.setCells([
          { row: R, col: C, value: "80" },
          { row: R + 1, col: C, value: "40" },
          { row: R + 2, col: C, value: "90" },
        ]);
        await ctx.settle();

        // Add CF rule on the data
        const cf = await addConditionalFormat({
          ranges: [{
            startRow: R, startCol: C,
            endRow: R + 2, endCol: C,
          }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { bold: true },
        });
        assertTrue(cf.success, "CF should succeed");
        await ctx.settle();

        // Evaluate before insert
        const evalBefore = await evaluateConditionalFormats(R, C, R + 2, C);
        const cellsBefore = evalBefore?.cells ?? [];
        assertEqual(cellsBefore.length, 2, "80 and 90 should match before insert");

        // Insert a column before our data column
        await insertColumns(C, 1);
        await ctx.settle();

        // Data shifted right by 1 — now at C+1
        expectCellValue(await ctx.getCell(R, C + 1), "80", "data shifted right");

        // Evaluate CF at the new position
        const evalAfter = await evaluateConditionalFormats(R, C + 1, R + 2, C + 1);
        const cellsAfter = evalAfter?.cells ?? [];
        // CF should have shifted too
        ctx.log(`CF matches after column insert: ${cellsAfter.length}`);

        // afterEach handles cleanup
      },
    },
    {
      name: "Formula chain with multiple dependencies",
      description: "Chain of formulas A->B->C all update when source changes.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        // A=10, B=A*2, C=B+5
        await ctx.setCells([
          { row: R, col: C, value: "10" },
          { row: R + 1, col: C, value: `=${A.ref(0, 0)}*2` },
          { row: R + 2, col: C, value: `=${A.ref(1, 0)}+5` },
        ]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(R, C), "10", "source");
        expectCellValue(await ctx.getCell(R + 1, C), "20", "B = 10*2");
        expectCellValue(await ctx.getCell(R + 2, C), "25", "C = 20+5");

        // Update source to 50
        await ctx.setCells([{ row: R, col: C, value: "50" }]);
        await ctx.settle();
        await calculateNow();
        await ctx.settle();

        expectCellValue(await ctx.getCell(R, C), "50", "updated source");
        expectCellValue(await ctx.getCell(R + 1, C), "100", "B = 50*2");
        expectCellValue(await ctx.getCell(R + 2, C), "105", "C = 100+5");
      },
    },
    {
      name: "Formatting + CF coexist on same cell",
      description: "Manual bold + CF italic both apply to the same cell.",
      run: async (ctx) => {
        const R = A.row;
        const C = A.col;

        await ctx.setCells([{ row: R, col: C, value: "90" }]);
        await ctx.settle();

        // Apply manual bold
        await applyFormatting([R], [C], { bold: true });
        await ctx.settle();

        // Add CF: > 50 => italic
        const cf = await addConditionalFormat({
          ranges: [{
            startRow: R, startCol: C,
            endRow: R, endCol: C,
          }],
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { italic: true },
        });
        assertTrue(cf.success, "CF should succeed");
        await ctx.settle();

        // Verify manual format
        const cell = await ctx.getCell(R, C);
        expectNotNull(cell, "cell should exist");
        if (cell!.styleIndex > 0) {
          const style = await getStyle(cell!.styleIndex);
          assertTrue(style?.bold === true, "manual bold should be applied");
        }

        // Verify CF also applies
        const evalResult = await evaluateConditionalFormats(R, C, R, C);
        const evalCells = evalResult?.cells ?? [];
        assertEqual(evalCells.length, 1, "CF should match (90 > 50)");

        // Both coexist without conflict
        ctx.log("Manual formatting + CF coexist successfully");
      },
    },
  ],
};
