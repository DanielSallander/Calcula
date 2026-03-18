//! FILENAME: app/extensions/TestRunner/lib/suites/freezePanes.ts
// PURPOSE: Freeze panes test suite.
// CONTEXT: Tests freezing/unfreezing rows and columns.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual } from "../assertions";
import { AREA_FREEZE_PANES } from "../testArea";
import { freezePanes, loadFreezePanesConfig } from "../../../../src/api";

const A = AREA_FREEZE_PANES;

export const freezePanesSuite: TestSuite = {
  name: "Freeze Panes",
  description: "Tests freeze/unfreeze rows and columns.",

  afterEach: async (ctx) => {
    // Always unfreeze after each test
    try { await freezePanes(null, null); } catch { /* ignore */ }
    await ctx.settle();
  },

  tests: [
    {
      name: "Freeze rows",
      description: "freezePanes sets frozen rows, loadFreezePanesConfig confirms.",
      run: async (ctx) => {
        await freezePanes(3, null);
        await ctx.settle();

        const config = await loadFreezePanesConfig();
        assertEqual(config.freezeRow, 3, "freezeRow should be 3");
        assertTrue(config.freezeCol === null, "freezeCol should be null");
      },
    },
    {
      name: "Freeze columns",
      description: "freezePanes sets frozen columns.",
      run: async (ctx) => {
        await freezePanes(null, 2);
        await ctx.settle();

        const config = await loadFreezePanesConfig();
        assertTrue(config.freezeRow === null, "freezeRow should be null");
        assertEqual(config.freezeCol, 2, "freezeCol should be 2");
      },
    },
    {
      name: "Freeze both rows and columns",
      description: "Both dimensions frozen simultaneously.",
      run: async (ctx) => {
        await freezePanes(2, 3);
        await ctx.settle();

        const config = await loadFreezePanesConfig();
        assertEqual(config.freezeRow, 2, "freezeRow");
        assertEqual(config.freezeCol, 3, "freezeCol");
      },
    },
    {
      name: "Unfreeze all",
      description: "Setting null/null removes freeze.",
      run: async (ctx) => {
        await freezePanes(5, 5);
        await ctx.settle();

        await freezePanes(null, null);
        await ctx.settle();

        const config = await loadFreezePanesConfig();
        assertTrue(config.freezeRow === null, "freezeRow should be null after unfreeze");
        assertTrue(config.freezeCol === null, "freezeCol should be null after unfreeze");
      },
    },
  ],
};
