//! FILENAME: app/extensions/TestRunner/lib/suites/print.ts
// PURPOSE: Print test suite.
// CONTEXT: Tests getPrintData returns valid print layout information.

import type { TestSuite } from "../types";
import { assertTrue, expectNotNull } from "../assertions";
import { AREA_PRINT } from "../testArea";
import { getPrintData } from "../../../../src/api/backend";

const A = AREA_PRINT;

export const printSuite: TestSuite = {
  name: "Print",
  description: "Tests print data generation.",

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
      name: "Get print data",
      description: "getPrintData returns page layout information.",
      run: async (ctx) => {
        // Add some data so there's content to print
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Header" },
          { row: A.row + 1, col: A.col, value: "Data 1" },
          { row: A.row + 2, col: A.col, value: "Data 2" },
        ]);
        await ctx.settle();

        const printData = await getPrintData();
        expectNotNull(printData, "print data should not be null");
        ctx.log(`Print data: ${JSON.stringify(Object.keys(printData))}`);
      },
    },
  ],
};
