//! FILENAME: app/extensions/TestRunner/lib/suites/advancedFilterExtension.ts
// PURPOSE: Integration tests for the Advanced Filter extension.
// CONTEXT: Tests criteria-range-based filtering, copy-to, and unique records.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual } from "../assertions";
import { AREA_ADVANCED_FILTER } from "../testArea";
import { getHiddenRows } from "@api";
import {
  executeAdvancedFilter,
  clearAdvancedFilter,
  parseCriterion,
  parseRangeRef,
  formatRangeRef,
  formatCellRef,
} from "../../../../extensions/AdvancedFilter/lib/advancedFilterEngine";

const A = AREA_ADVANCED_FILTER;

export const advancedFilterExtensionSuite: TestSuite = {
  name: "Advanced Filter Extension",
  description: "Tests criteria-range filtering, copy-to-location, and unique records.",

  afterEach: async (ctx) => {
    clearAdvancedFilter();
    // Clear test area (20 rows x 10 cols)
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
    // ================================================================
    // Unit tests for pure functions
    // ================================================================
    {
      name: "parseCriterion - implicit equals",
      description: "Plain value is treated as '=' operator.",
      run: async () => {
        const c = parseCriterion("Apple");
        assertEqual(c.operator, "=", "operator");
        assertEqual(c.value, "Apple", "value");
        assertTrue(!c.hasWildcard, "no wildcard");
      },
    },
    {
      name: "parseCriterion - comparison operators",
      description: "Supports >, <, >=, <=, <>, =.",
      run: async () => {
        const gt = parseCriterion(">100");
        assertEqual(gt.operator, ">", "gt operator");
        assertEqual(gt.value, "100", "gt value");

        const lte = parseCriterion("<=50");
        assertEqual(lte.operator, "<=", "lte operator");
        assertEqual(lte.value, "50", "lte value");

        const neq = parseCriterion("<>Done");
        assertEqual(neq.operator, "<>", "neq operator");
        assertEqual(neq.value, "Done", "neq value");

        const gte = parseCriterion(">=200");
        assertEqual(gte.operator, ">=", "gte operator");
        assertEqual(gte.value, "200", "gte value");
      },
    },
    {
      name: "parseCriterion - wildcard detection",
      description: "Detects * and ? wildcards in = and <> operators.",
      run: async () => {
        const star = parseCriterion("A*");
        assertTrue(star.hasWildcard, "star wildcard");

        const question = parseCriterion("=T?st");
        assertTrue(question.hasWildcard, "question wildcard");

        const noWild = parseCriterion(">100");
        assertTrue(!noWild.hasWildcard, "no wildcard on >");
      },
    },
    {
      name: "parseRangeRef - standard range",
      description: "Parses A1:D10 into 0-based row/col indices.",
      run: async () => {
        const r = parseRangeRef("A1:D10");
        assertTrue(r !== null, "should parse");
        assertEqual(r![0], 0, "startRow");
        assertEqual(r![1], 0, "startCol");
        assertEqual(r![2], 9, "endRow");
        assertEqual(r![3], 3, "endCol");
      },
    },
    {
      name: "parseRangeRef - single cell",
      description: "Parses B5 as a single-cell range.",
      run: async () => {
        const r = parseRangeRef("B5");
        assertTrue(r !== null, "should parse");
        assertEqual(r![0], 4, "row");
        assertEqual(r![1], 1, "col");
        assertEqual(r![2], 4, "endRow");
        assertEqual(r![3], 1, "endCol");
      },
    },
    {
      name: "parseRangeRef - invalid input",
      description: "Returns null for unparseable strings.",
      run: async () => {
        assertTrue(parseRangeRef("") === null, "empty");
        assertTrue(parseRangeRef("hello") === null, "text");
        assertTrue(parseRangeRef("123") === null, "number");
      },
    },
    {
      name: "formatRangeRef",
      description: "Formats 0-based indices back to A1-style.",
      run: async () => {
        assertEqual(formatRangeRef(0, 0, 9, 3), "A1:D10", "A1:D10");
        assertEqual(formatRangeRef(4, 1, 4, 1), "B5:B5", "B5:B5");
      },
    },
    {
      name: "formatCellRef",
      description: "Formats a single cell reference.",
      run: async () => {
        assertEqual(formatCellRef(0, 0), "A1", "A1");
        assertEqual(formatCellRef(4, 1), "B5", "B5");
      },
    },

    // ================================================================
    // Integration tests: filter in place
    // ================================================================
    {
      name: "Filter in place - single criterion",
      description: "Criteria range with one condition hides non-matching rows.",
      run: async (ctx) => {
        // List range: 3 columns (Name, Dept, Salary), 5 data rows
        await ctx.setCells([
          // Headers (row A.row)
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Dept" },
          { row: A.row, col: A.col + 2, value: "Salary" },
          // Data rows
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "Sales" },
          { row: A.row + 1, col: A.col + 2, value: "50000" },

          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "Engineering" },
          { row: A.row + 2, col: A.col + 2, value: "70000" },

          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "Sales" },
          { row: A.row + 3, col: A.col + 2, value: "55000" },

          { row: A.row + 4, col: A.col, value: "Dave" },
          { row: A.row + 4, col: A.col + 1, value: "Engineering" },
          { row: A.row + 4, col: A.col + 2, value: "80000" },

          { row: A.row + 5, col: A.col, value: "Eve" },
          { row: A.row + 5, col: A.col + 1, value: "Marketing" },
          { row: A.row + 5, col: A.col + 2, value: "60000" },

          // Criteria range (col+5, col+6): Filter Dept = "Sales"
          { row: A.row, col: A.col + 5, value: "Dept" },
          { row: A.row + 1, col: A.col + 5, value: "Sales" },
        ]);
        await ctx.settle();

        const listRange: [number, number, number, number] = [A.row, A.col, A.row + 5, A.col + 2];
        const criteriaRange: [number, number, number, number] = [A.row, A.col + 5, A.row + 1, A.col + 5];

        const result = await executeAdvancedFilter({
          listRange,
          criteriaRange,
          action: "filterInPlace",
          uniqueRecordsOnly: false,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 2, "2 Sales rows match");

        // Hidden rows should be Bob (row+2), Dave (row+4), Eve (row+5)
        const hidden = await getHiddenRows();
        assertTrue(hidden.includes(A.row + 2), "Bob hidden");
        assertTrue(hidden.includes(A.row + 4), "Dave hidden");
        assertTrue(hidden.includes(A.row + 5), "Eve hidden");
        assertTrue(!hidden.includes(A.row + 1), "Alice visible");
        assertTrue(!hidden.includes(A.row + 3), "Carol visible");
      },
    },
    {
      name: "Filter in place - numeric comparison",
      description: "Criteria with >=60000 filters by salary.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Salary" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "50000" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "70000" },
          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "60000" },
          { row: A.row + 4, col: A.col, value: "Dave" },
          { row: A.row + 4, col: A.col + 1, value: "80000" },
          // Criteria: Salary >= 60000
          { row: A.row, col: A.col + 5, value: "Salary" },
          { row: A.row + 1, col: A.col + 5, value: ">=60000" },
        ]);
        await ctx.settle();

        const result = await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 4, A.col + 1],
          criteriaRange: [A.row, A.col + 5, A.row + 1, A.col + 5],
          action: "filterInPlace",
          uniqueRecordsOnly: false,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 3, "Bob, Carol, Dave match");

        const hidden = await getHiddenRows();
        assertTrue(hidden.includes(A.row + 1), "Alice hidden (50000)");
        assertTrue(!hidden.includes(A.row + 2), "Bob visible (70000)");
        assertTrue(!hidden.includes(A.row + 3), "Carol visible (60000)");
        assertTrue(!hidden.includes(A.row + 4), "Dave visible (80000)");
      },
    },
    {
      name: "Filter in place - AND (same row criteria)",
      description: "Two criteria on the same row = AND logic.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Dept" },
          { row: A.row, col: A.col + 2, value: "Salary" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "Sales" },
          { row: A.row + 1, col: A.col + 2, value: "50000" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "Sales" },
          { row: A.row + 2, col: A.col + 2, value: "70000" },
          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "Engineering" },
          { row: A.row + 3, col: A.col + 2, value: "80000" },
          // Criteria: Dept=Sales AND Salary>=60000
          { row: A.row, col: A.col + 5, value: "Dept" },
          { row: A.row, col: A.col + 6, value: "Salary" },
          { row: A.row + 1, col: A.col + 5, value: "Sales" },
          { row: A.row + 1, col: A.col + 6, value: ">=60000" },
        ]);
        await ctx.settle();

        const result = await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 3, A.col + 2],
          criteriaRange: [A.row, A.col + 5, A.row + 1, A.col + 6],
          action: "filterInPlace",
          uniqueRecordsOnly: false,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 1, "only Bob matches (Sales AND >=60000)");

        const hidden = await getHiddenRows();
        assertTrue(hidden.includes(A.row + 1), "Alice hidden");
        assertTrue(!hidden.includes(A.row + 2), "Bob visible");
        assertTrue(hidden.includes(A.row + 3), "Carol hidden");
      },
    },
    {
      name: "Filter in place - OR (multiple criteria rows)",
      description: "Two criteria rows = OR logic.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Dept" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "Sales" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "Engineering" },
          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "Marketing" },
          { row: A.row + 4, col: A.col, value: "Dave" },
          { row: A.row + 4, col: A.col + 1, value: "Sales" },
          // Criteria: Dept=Sales OR Dept=Engineering (two rows)
          { row: A.row, col: A.col + 5, value: "Dept" },
          { row: A.row + 1, col: A.col + 5, value: "Sales" },
          { row: A.row + 2, col: A.col + 5, value: "Engineering" },
        ]);
        await ctx.settle();

        const result = await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 4, A.col + 1],
          criteriaRange: [A.row, A.col + 5, A.row + 2, A.col + 5],
          action: "filterInPlace",
          uniqueRecordsOnly: false,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 3, "Alice, Bob, Dave match");

        const hidden = await getHiddenRows();
        assertTrue(!hidden.includes(A.row + 1), "Alice visible");
        assertTrue(!hidden.includes(A.row + 2), "Bob visible");
        assertTrue(hidden.includes(A.row + 3), "Carol hidden (Marketing)");
        assertTrue(!hidden.includes(A.row + 4), "Dave visible");
      },
    },
    {
      name: "Filter in place - wildcard criterion",
      description: "Wildcard * matches partial strings.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Product" },
          { row: A.row + 1, col: A.col, value: "Apple Juice" },
          { row: A.row + 2, col: A.col, value: "Banana Split" },
          { row: A.row + 3, col: A.col, value: "Apple Pie" },
          { row: A.row + 4, col: A.col, value: "Cherry Tart" },
          // Criteria: Product matches "Apple*"
          { row: A.row, col: A.col + 5, value: "Product" },
          { row: A.row + 1, col: A.col + 5, value: "Apple*" },
        ]);
        await ctx.settle();

        const result = await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 4, A.col],
          criteriaRange: [A.row, A.col + 5, A.row + 1, A.col + 5],
          action: "filterInPlace",
          uniqueRecordsOnly: false,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 2, "Apple Juice and Apple Pie");

        const hidden = await getHiddenRows();
        assertTrue(!hidden.includes(A.row + 1), "Apple Juice visible");
        assertTrue(hidden.includes(A.row + 2), "Banana Split hidden");
        assertTrue(!hidden.includes(A.row + 3), "Apple Pie visible");
        assertTrue(hidden.includes(A.row + 4), "Cherry Tart hidden");
      },
    },

    // ================================================================
    // Integration tests: copy to location
    // ================================================================
    {
      name: "Copy to another location",
      description: "Matching rows are copied to the specified destination.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Score" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "90" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "60" },
          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "85" },
          // Criteria: Score >= 80
          { row: A.row, col: A.col + 4, value: "Score" },
          { row: A.row + 1, col: A.col + 4, value: ">=80" },
        ]);
        await ctx.settle();

        const destRow = A.row + 10;
        const destCol = A.col;
        const result = await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 3, A.col + 1],
          criteriaRange: [A.row, A.col + 4, A.row + 1, A.col + 4],
          action: "copyToLocation",
          copyTo: [destRow, destCol],
          uniqueRecordsOnly: false,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 2, "Alice and Carol match");
        await ctx.settle();

        // Check headers copied
        const headerName = await ctx.getCell(destRow, destCol);
        assertEqual(headerName?.display ?? "", "Name", "header Name copied");
        const headerScore = await ctx.getCell(destRow, destCol + 1);
        assertEqual(headerScore?.display ?? "", "Score", "header Score copied");

        // Check data copied
        const row1Name = await ctx.getCell(destRow + 1, destCol);
        assertEqual(row1Name?.display ?? "", "Alice", "Alice copied");
        const row1Score = await ctx.getCell(destRow + 1, destCol + 1);
        assertEqual(row1Score?.display ?? "", "90", "90 copied");

        const row2Name = await ctx.getCell(destRow + 2, destCol);
        assertEqual(row2Name?.display ?? "", "Carol", "Carol copied");
        const row2Score = await ctx.getCell(destRow + 2, destCol + 1);
        assertEqual(row2Score?.display ?? "", "85", "85 copied");
      },
    },

    // ================================================================
    // Unique records only
    // ================================================================
    {
      name: "Unique records only - filter in place",
      description: "Duplicate rows are hidden when uniqueRecordsOnly is true.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Fruit" },
          { row: A.row, col: A.col + 1, value: "Color" },
          { row: A.row + 1, col: A.col, value: "Apple" },
          { row: A.row + 1, col: A.col + 1, value: "Red" },
          { row: A.row + 2, col: A.col, value: "Banana" },
          { row: A.row + 2, col: A.col + 1, value: "Yellow" },
          { row: A.row + 3, col: A.col, value: "Apple" },
          { row: A.row + 3, col: A.col + 1, value: "Red" },  // duplicate
          { row: A.row + 4, col: A.col, value: "Cherry" },
          { row: A.row + 4, col: A.col + 1, value: "Red" },
          { row: A.row + 5, col: A.col, value: "Banana" },
          { row: A.row + 5, col: A.col + 1, value: "Yellow" },  // duplicate
          // Criteria: empty criteria = match all (just header, no criteria rows)
          { row: A.row, col: A.col + 5, value: "Fruit" },
        ]);
        await ctx.settle();

        const result = await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 5, A.col + 1],
          criteriaRange: [A.row, A.col + 5, A.row, A.col + 5],  // header only, no criteria
          action: "filterInPlace",
          uniqueRecordsOnly: true,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 3, "3 unique records (Apple/Red, Banana/Yellow, Cherry/Red)");

        const hidden = await getHiddenRows();
        // First occurrences visible, duplicates hidden
        assertTrue(!hidden.includes(A.row + 1), "first Apple visible");
        assertTrue(!hidden.includes(A.row + 2), "first Banana visible");
        assertTrue(hidden.includes(A.row + 3), "duplicate Apple hidden");
        assertTrue(!hidden.includes(A.row + 4), "Cherry visible");
        assertTrue(hidden.includes(A.row + 5), "duplicate Banana hidden");
      },
    },
    {
      name: "Unique records - copy to location",
      description: "Only unique matching rows are copied.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "City" },
          { row: A.row + 1, col: A.col, value: "NYC" },
          { row: A.row + 2, col: A.col, value: "LA" },
          { row: A.row + 3, col: A.col, value: "NYC" },  // duplicate
          { row: A.row + 4, col: A.col, value: "Chicago" },
          { row: A.row + 5, col: A.col, value: "LA" },   // duplicate
          // Criteria: match all
          { row: A.row, col: A.col + 4, value: "City" },
        ]);
        await ctx.settle();

        const destRow = A.row + 10;
        const result = await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 5, A.col],
          criteriaRange: [A.row, A.col + 4, A.row, A.col + 4],
          action: "copyToLocation",
          copyTo: [destRow, A.col],
          uniqueRecordsOnly: true,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 3, "3 unique cities");
        await ctx.settle();

        const h = await ctx.getCell(destRow, A.col);
        assertEqual(h?.display ?? "", "City", "header copied");
        const r1 = await ctx.getCell(destRow + 1, A.col);
        assertEqual(r1?.display ?? "", "NYC", "NYC copied");
        const r2 = await ctx.getCell(destRow + 2, A.col);
        assertEqual(r2?.display ?? "", "LA", "LA copied");
        const r3 = await ctx.getCell(destRow + 3, A.col);
        assertEqual(r3?.display ?? "", "Chicago", "Chicago copied");
      },
    },

    // ================================================================
    // Clear advanced filter
    // ================================================================
    {
      name: "Clear advanced filter",
      description: "clearAdvancedFilter unhides all rows.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Val" },
          { row: A.row + 1, col: A.col, value: "A" },
          { row: A.row + 2, col: A.col, value: "B" },
          { row: A.row + 3, col: A.col, value: "A" },
          // Criteria: Val = "A"
          { row: A.row, col: A.col + 5, value: "Val" },
          { row: A.row + 1, col: A.col + 5, value: "A" },
        ]);
        await ctx.settle();

        await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 3, A.col],
          criteriaRange: [A.row, A.col + 5, A.row + 1, A.col + 5],
          action: "filterInPlace",
          uniqueRecordsOnly: false,
        });

        let hidden = await getHiddenRows();
        assertTrue(hidden.includes(A.row + 2), "B should be hidden");

        clearAdvancedFilter();
        hidden = await getHiddenRows();
        assertEqual(hidden.length, 0, "no rows hidden after clear");
      },
    },

    // ================================================================
    // Edge case: not-equals
    // ================================================================
    {
      name: "Filter with <> (not equals)",
      description: "Criteria <>value excludes matching rows.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Status" },
          { row: A.row + 1, col: A.col, value: "Active" },
          { row: A.row + 2, col: A.col, value: "Closed" },
          { row: A.row + 3, col: A.col, value: "Active" },
          { row: A.row + 4, col: A.col, value: "Pending" },
          // Criteria: Status <> "Closed"
          { row: A.row, col: A.col + 5, value: "Status" },
          { row: A.row + 1, col: A.col + 5, value: "<>Closed" },
        ]);
        await ctx.settle();

        const result = await executeAdvancedFilter({
          listRange: [A.row, A.col, A.row + 4, A.col],
          criteriaRange: [A.row, A.col + 5, A.row + 1, A.col + 5],
          action: "filterInPlace",
          uniqueRecordsOnly: false,
        });

        assertTrue(result.success, "should succeed");
        assertEqual(result.matchCount, 3, "3 non-Closed rows");

        const hidden = await getHiddenRows();
        assertTrue(!hidden.includes(A.row + 1), "Active visible");
        assertTrue(hidden.includes(A.row + 2), "Closed hidden");
        assertTrue(!hidden.includes(A.row + 3), "Active visible");
        assertTrue(!hidden.includes(A.row + 4), "Pending visible");
      },
    },
  ],
};
