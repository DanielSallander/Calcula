//! FILENAME: app/extensions/TestRunner/lib/suites/namedRanges.ts
// PURPOSE: Named ranges test suite.
// CONTEXT: Tests create, get, list, delete, rename, and formula usage.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull, expectCellValue } from "../assertions";
import { AREA_NAMED_RANGES } from "../testArea";
import {
  createNamedRange,
  getNamedRange,
  getAllNamedRanges,
  deleteNamedRange,
  renameNamedRange,
  updateNamedRange,
  calculateNow,
} from "../../../../src/api";

const A = AREA_NAMED_RANGES;

export const namedRangesSuite: TestSuite = {
  name: "Named Ranges",
  description: "Tests named range CRUD and formula usage.",

  afterEach: async (ctx) => {
    // Clean up all named ranges we might have created
    const names = ["TestRange", "FormulaRange", "ToDelete", "OldName", "NewName", "UpdateMe"];
    for (const name of names) {
      try { await deleteNamedRange(name); } catch { /* ignore */ }
    }
    const clears = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 3; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Create a named range",
      description: "getNamedRange returns the created range.",
      run: async (ctx) => {
        const refersTo = `${A.ref(0, 0)}:${A.ref(2, 0)}`;
        const result = await createNamedRange("TestRange", null, refersTo);
        await ctx.settle();

        assertTrue(result.success, "Create should succeed");
        const nr = await getNamedRange("TestRange");
        expectNotNull(nr, "Named range should exist");
        assertEqual(nr!.name, "TestRange", "name");
      },
    },
    {
      name: "Use named range in formula",
      description: "=SUM(FormulaRange) computes correctly.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "20" },
          { row: A.row + 2, col: A.col, value: "30" },
        ]);
        await ctx.settle();

        const refersTo = `${A.ref(0, 0)}:${A.ref(2, 0)}`;
        await createNamedRange("FormulaRange", null, refersTo);
        await ctx.settle();

        await ctx.setCells([
          { row: A.row + 4, col: A.col, value: "=SUM(FormulaRange)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 4, A.col);
        expectCellValue(cell, "60", "SUM of named range");
      },
    },
    {
      name: "List all named ranges",
      description: "getAllNamedRanges includes created range.",
      run: async (ctx) => {
        await createNamedRange("TestRange", null, `${A.ref(0, 0)}:${A.ref(0, 2)}`);
        await ctx.settle();

        const all = await getAllNamedRanges();
        assertTrue(
          all.some(nr => nr.name === "TestRange"),
          "TestRange should be in the list"
        );
      },
    },
    {
      name: "Delete a named range",
      description: "getNamedRange returns null after delete.",
      run: async (ctx) => {
        await createNamedRange("ToDelete", null, `${A.ref(0, 0)}`);
        await ctx.settle();

        const result = await deleteNamedRange("ToDelete");
        assertTrue(result.success, "Delete should succeed");

        const nr = await getNamedRange("ToDelete");
        assertTrue(nr === null, "Should be null after delete");
      },
    },
    {
      name: "Rename a named range",
      description: "Old name gone, new name works.",
      run: async (ctx) => {
        await createNamedRange("OldName", null, `${A.ref(0, 0)}`);
        await ctx.settle();

        const result = await renameNamedRange("OldName", "NewName");
        assertTrue(result.success, "Rename should succeed");

        const old = await getNamedRange("OldName");
        assertTrue(old === null, "OldName should be gone");

        const renamed = await getNamedRange("NewName");
        expectNotNull(renamed, "NewName should exist");
      },
    },
    {
      name: "Update named range reference",
      description: "Formula using name reflects new range.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "5" },
          { row: A.row + 1, col: A.col, value: "100" },
        ]);
        await ctx.settle();

        // Create range pointing to row 0 only
        await createNamedRange("UpdateMe", null, A.ref(0, 0));
        await ctx.settle();

        await ctx.setCells([
          { row: A.row + 3, col: A.col, value: "=UpdateMe" },
        ]);
        await ctx.settle();
        expectCellValue(await ctx.getCell(A.row + 3, A.col), "5", "before update");

        // Update to point to row 1
        await updateNamedRange("UpdateMe", null, A.ref(1, 0));
        await calculateNow();
        await ctx.settle();

        // Re-read — the formula should pick up the new reference
        const cell = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(cell, "100", "after update");
      },
    },
  ],
};
