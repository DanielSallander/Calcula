//! FILENAME: app/extensions/TestRunner/lib/suites/grouping.ts
// PURPOSE: Grouping/Outline test suite.
// CONTEXT: Tests row/column grouping, collapse/expand, outline info, and clear.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual } from "../assertions";
import { AREA_GROUPING } from "../testArea";
import {
  groupRows,
  ungroupRows,
  groupColumns,
  ungroupColumns,
  collapseRowGroup,
  expandRowGroup,
  getOutlineInfo,
  getHiddenRowsByGroup,
  clearOutline,
} from "@api";

const A = AREA_GROUPING;

export const groupingSuite: TestSuite = {
  name: "Grouping / Outline",
  description: "Tests row/column grouping, collapse/expand, and outline info.",

  afterEach: async (ctx) => {
    try { await clearOutline(); } catch { /* ignore */ }
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
      name: "Group rows",
      description: "groupRows creates a row group visible in outline info.",
      run: async (ctx) => {
        const result = await groupRows(A.row, A.row + 3);
        assertTrue(result.success, "groupRows should succeed");

        const info = await getOutlineInfo(A.row, A.row + 10, A.col, A.col + 5);
        assertTrue(info.maxRowLevel >= 1, "should have at least level 1");
      },
    },
    {
      name: "Group columns",
      description: "groupColumns creates a column group.",
      run: async (ctx) => {
        const result = await groupColumns(A.col, A.col + 2);
        assertTrue(result.success, "groupColumns should succeed");

        const info = await getOutlineInfo(A.row, A.row + 10, A.col, A.col + 5);
        assertTrue(info.maxColLevel >= 1, "should have at least level 1");
      },
    },
    {
      name: "Collapse and expand row group",
      description: "Collapse hides rows, expand shows them.",
      run: async (ctx) => {
        await groupRows(A.row, A.row + 3);

        // Default summary position is BelowRight, so the button row is the end row
        const collapseResult = await collapseRowGroup(A.row + 3);
        assertTrue(collapseResult.success, "collapse should succeed");

        const hidden = await getHiddenRowsByGroup();
        assertTrue(hidden.length > 0, "should have hidden rows after collapse");

        const expandResult = await expandRowGroup(A.row + 3);
        assertTrue(expandResult.success, "expand should succeed");

        const hiddenAfter = await getHiddenRowsByGroup();
        const ourRowsHidden = hiddenAfter.filter(r => r >= A.row && r <= A.row + 3);
        assertEqual(ourRowsHidden.length, 0, "no rows hidden after expand");
      },
    },
    {
      name: "Ungroup rows",
      description: "ungroupRows removes the group.",
      run: async (ctx) => {
        await groupRows(A.row, A.row + 3);
        const result = await ungroupRows(A.row, A.row + 3);
        assertTrue(result.success, "ungroupRows should succeed");

        const info = await getOutlineInfo(A.row, A.row + 10, A.col, A.col + 5);
        // After ungrouping, the row symbols for our range should be gone
        const ourSymbols = info.rowSymbols.filter(
          s => s.row >= A.row && s.row <= A.row + 3 && s.level > 0
        );
        assertEqual(ourSymbols.length, 0, "no row groups in our range");
      },
    },
    {
      name: "Ungroup columns",
      description: "ungroupColumns removes the column group.",
      run: async (ctx) => {
        await groupColumns(A.col, A.col + 2);
        const result = await ungroupColumns(A.col, A.col + 2);
        assertTrue(result.success, "ungroupColumns should succeed");
      },
    },
    {
      name: "Nested row groups",
      description: "Grouping inside a group creates level 2.",
      run: async (ctx) => {
        await groupRows(A.row, A.row + 5);
        await groupRows(A.row + 1, A.row + 3);

        const info = await getOutlineInfo(A.row, A.row + 10, A.col, A.col + 5);
        assertTrue(info.maxRowLevel >= 2, "should have level 2 after nesting");
      },
    },
    {
      name: "Clear outline",
      description: "clearOutline removes all groups.",
      run: async (ctx) => {
        await groupRows(A.row, A.row + 3);
        await groupColumns(A.col, A.col + 2);

        const result = await clearOutline();
        assertTrue(result.success, "clearOutline should succeed");

        const info = await getOutlineInfo(A.row, A.row + 10, A.col, A.col + 5);
        assertEqual(info.maxRowLevel, 0, "no row groups");
        assertEqual(info.maxColLevel, 0, "no col groups");
      },
    },
  ],
};
