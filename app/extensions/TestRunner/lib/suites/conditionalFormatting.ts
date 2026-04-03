//! FILENAME: app/extensions/TestRunner/lib/suites/conditionalFormatting.ts
// PURPOSE: Conditional formatting test suite.
// CONTEXT: Tests adding, evaluating, getting, deleting, and clearing CF rules.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_COND_FORMAT } from "../testArea";
import {
  addConditionalFormat,
  getConditionalFormat,
  getAllConditionalFormats,
  deleteConditionalFormat,
  evaluateConditionalFormats,
  clearConditionalFormatsInRange,
} from "@api";
import type {
  AddCFParams,
  CellValueRule,
  ContainsTextRule,
  ConditionalFormat,
  ConditionalFormatRange,
  DuplicateValuesRule,
} from "@api";

const A = AREA_COND_FORMAT;

function makeRange(rowOffset = 0, colOffset = 0, rows = 5): ConditionalFormatRange {
  return {
    startRow: A.row + rowOffset,
    startCol: A.col + colOffset,
    endRow: A.row + rowOffset + rows - 1,
    endCol: A.col + colOffset,
  };
}

const RED_BG: ConditionalFormat = { backgroundColor: "#FF0000" };
const GREEN_BG: ConditionalFormat = { backgroundColor: "#00FF00" };
const BOLD_FORMAT: ConditionalFormat = { bold: true };

export const conditionalFormattingSuite: TestSuite = {
  name: "Conditional Formatting",
  description: "Tests CF rule CRUD, evaluation, and range clear.",

  afterEach: async (ctx) => {
    try {
      await clearConditionalFormatsInRange(A.row, A.col, A.row + 20, A.col + 5);
    } catch { /* ignore */ }
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
      name: "Add cell value rule (greaterThan)",
      description: "Rule is created and retrievable.",
      run: async (ctx) => {
        const rule: CellValueRule = {
          type: "cellValue",
          operator: "greaterThan",
          value1: "50",
        };
        const params: AddCFParams = {
          rule,
          format: RED_BG,
          ranges: [makeRange()],
        };
        const result = await addConditionalFormat(params);
        assertTrue(result.success, "addConditionalFormat should succeed");
        expectNotNull(result.rule, "rule should be returned");

        const retrieved = await getConditionalFormat(result.rule!.id);
        expectNotNull(retrieved, "getConditionalFormat should return the rule");
        assertEqual(retrieved!.rule.type, "cellValue", "rule type");
      },
    },
    {
      name: "Evaluate cell value rule",
      description: "Matching cells get the format applied.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "100" },
          { row: A.row + 1, col: A.col, value: "30" },
          { row: A.row + 2, col: A.col, value: "75" },
        ]);
        await ctx.settle();

        const rule: CellValueRule = {
          type: "cellValue",
          operator: "greaterThan",
          value1: "50",
        };
        await addConditionalFormat({
          rule,
          format: RED_BG,
          ranges: [makeRange(0, 0, 3)],
        });
        await ctx.settle();

        const evalResult = await evaluateConditionalFormats(
          A.row, A.col, A.row + 2, A.col
        );
        // Cells 100 and 75 should match (>50), cell 30 should not
        const matchingRows = evalResult.cells.map(c => c.row);
        assertTrue(matchingRows.includes(A.row), "100 should match");
        assertTrue(matchingRows.includes(A.row + 2), "75 should match");
        assertTrue(!matchingRows.includes(A.row + 1), "30 should not match");
      },
    },
    {
      name: "Contains text rule",
      description: "Cells containing text match.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Hello World" },
          { row: A.row + 1, col: A.col, value: "Goodbye" },
          { row: A.row + 2, col: A.col, value: "Hello Again" },
        ]);
        await ctx.settle();

        const rule: ContainsTextRule = {
          type: "containsText",
          ruleType: "contains",
          text: "Hello",
        };
        await addConditionalFormat({
          rule,
          format: GREEN_BG,
          ranges: [makeRange(0, 0, 3)],
        });
        await ctx.settle();

        const evalResult = await evaluateConditionalFormats(
          A.row, A.col, A.row + 2, A.col
        );
        const matchingRows = evalResult.cells.map(c => c.row);
        assertTrue(matchingRows.includes(A.row), "Hello World should match");
        assertTrue(matchingRows.includes(A.row + 2), "Hello Again should match");
        assertTrue(!matchingRows.includes(A.row + 1), "Goodbye should not match");
      },
    },
    {
      name: "Between rule",
      description: "Values between two bounds match.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "5" },
          { row: A.row + 1, col: A.col, value: "15" },
          { row: A.row + 2, col: A.col, value: "25" },
        ]);
        await ctx.settle();

        const rule: CellValueRule = {
          type: "cellValue",
          operator: "between",
          value1: "10",
          value2: "20",
        };
        await addConditionalFormat({
          rule,
          format: BOLD_FORMAT,
          ranges: [makeRange(0, 0, 3)],
        });
        await ctx.settle();

        const evalResult = await evaluateConditionalFormats(
          A.row, A.col, A.row + 2, A.col
        );
        const matchingRows = evalResult.cells.map(c => c.row);
        assertTrue(matchingRows.includes(A.row + 1), "15 should match (between 10-20)");
      },
    },
    {
      name: "Duplicate values rule",
      description: "Duplicate values get formatting.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Apple" },
          { row: A.row + 1, col: A.col, value: "Banana" },
          { row: A.row + 2, col: A.col, value: "Apple" },
          { row: A.row + 3, col: A.col, value: "Cherry" },
        ]);
        await ctx.settle();

        const rule: DuplicateValuesRule = { type: "duplicateValues" };
        await addConditionalFormat({
          rule,
          format: RED_BG,
          ranges: [makeRange(0, 0, 4)],
        });
        await ctx.settle();

        const evalResult = await evaluateConditionalFormats(
          A.row, A.col, A.row + 3, A.col
        );
        const matchingRows = evalResult.cells.map(c => c.row);
        assertTrue(matchingRows.includes(A.row), "first Apple should match");
        assertTrue(matchingRows.includes(A.row + 2), "second Apple should match");
      },
    },
    {
      name: "Delete CF rule",
      description: "Rule is gone after deletion.",
      run: async (ctx) => {
        const rule: CellValueRule = {
          type: "cellValue",
          operator: "equal",
          value1: "1",
        };
        const result = await addConditionalFormat({
          rule,
          format: RED_BG,
          ranges: [makeRange()],
        });
        const ruleId = result.rule!.id;

        const delResult = await deleteConditionalFormat(ruleId);
        assertTrue(delResult.success, "delete should succeed");

        const check = await getConditionalFormat(ruleId);
        assertTrue(check === null, "rule should be null after delete");
      },
    },
    {
      name: "Get all CF rules",
      description: "getAllConditionalFormats includes created rules.",
      run: async (ctx) => {
        const rule: CellValueRule = {
          type: "cellValue",
          operator: "greaterThan",
          value1: "0",
        };
        const result = await addConditionalFormat({
          rule,
          format: GREEN_BG,
          ranges: [makeRange()],
        });
        const ruleId = result.rule!.id;

        const all = await getAllConditionalFormats();
        assertTrue(all.length > 0, "should have at least one rule");
        const found = all.find(r => r.id === ruleId);
        assertTrue(found !== undefined, "our rule should be in the list");
      },
    },
    {
      name: "Clear CF rules in range",
      description: "clearConditionalFormatsInRange removes rules.",
      run: async (ctx) => {
        const rule: CellValueRule = {
          type: "cellValue",
          operator: "lessThan",
          value1: "100",
        };
        await addConditionalFormat({
          rule,
          format: RED_BG,
          ranges: [makeRange()],
        });
        await addConditionalFormat({
          rule,
          format: GREEN_BG,
          ranges: [makeRange()],
        });

        const cleared = await clearConditionalFormatsInRange(
          A.row, A.col, A.row + 10, A.col + 5
        );
        assertTrue(cleared >= 2, `Should clear at least 2 rules, cleared ${cleared}`);

        const remaining = await getAllConditionalFormats();
        const inRange = remaining.filter(r =>
          r.ranges.some(rng =>
            rng.startRow >= A.row && rng.endRow <= A.row + 10 &&
            rng.startCol >= A.col && rng.endCol <= A.col + 5
          )
        );
        assertEqual(inRange.length, 0, "no rules should remain in range");
      },
    },
  ],
};
