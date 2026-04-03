//! FILENAME: app/extensions/TestRunner/lib/suites/tracing.ts
// PURPOSE: Tracing test suite.
// CONTEXT: Tests trace precedents and trace dependents.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual } from "../assertions";
import { AREA_TRACING } from "../testArea";
import { tracePrecedents, traceDependents } from "@api";

const A = AREA_TRACING;

export const tracingSuite: TestSuite = {
  name: "Tracing",
  description: "Tests trace precedents and trace dependents.",

  afterEach: async (ctx) => {
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
      name: "Trace precedents of formula",
      description: "Formula referencing cells returns those cells as precedents.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: `=${A.ref(0, 0)}+${A.ref(1, 0)}` },
        ]);
        await ctx.settle();

        const result = await tracePrecedents(A.row + 2, A.col);
        // Results may be in cells array or ranges array depending on implementation
        const totalRefs = result.cells.length + result.ranges.length;
        assertTrue(totalRefs >= 1, `Should have at least 1 precedent ref, got cells=${result.cells.length} ranges=${result.ranges.length}`);
        ctx.log(`Precedents: ${result.cells.length} cells, ${result.ranges.length} ranges`);
      },
    },
    {
      name: "Trace dependents of value cell",
      description: "Cell referenced by formula shows that formula as dependent.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: `=${A.ref(0, 0)}*2` },
          { row: A.row + 2, col: A.col, value: `=${A.ref(0, 0)}+5` },
        ]);
        await ctx.settle();

        const result = await traceDependents(A.row, A.col);
        const totalRefs = result.cells.length + result.ranges.length;
        assertTrue(totalRefs >= 1, `Should have at least 1 dependent ref, got cells=${result.cells.length} ranges=${result.ranges.length}`);
        ctx.log(`Dependents: ${result.cells.length} cells, ${result.ranges.length} ranges`);
      },
    },
    {
      name: "Trace precedents of value cell returns empty",
      description: "A constant value has no precedents.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "42" },
        ]);
        await ctx.settle();

        const result = await tracePrecedents(A.row, A.col);
        assertEqual(result.cells.length, 0, "constant should have no precedents");
        assertEqual(result.ranges.length, 0, "no range precedents either");
      },
    },
    {
      name: "Trace precedents with range reference",
      description: "SUM over a range returns the range as a precedent.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: "2" },
          { row: A.row + 2, col: A.col, value: "3" },
          { row: A.row + 3, col: A.col, value: `=SUM(${A.ref(0, 0)}:${A.ref(2, 0)})` },
        ]);
        await ctx.settle();

        const result = await tracePrecedents(A.row + 3, A.col);
        // Should have either individual cells or a range
        const totalRefs = result.cells.length + result.ranges.length;
        assertTrue(totalRefs >= 1, `Should have at least 1 precedent reference, got ${totalRefs}`);
      },
    },
  ],
};
