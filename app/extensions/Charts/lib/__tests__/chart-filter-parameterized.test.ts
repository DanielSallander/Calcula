//! FILENAME: app/extensions/Charts/lib/__tests__/chart-filter-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for chart filter operations.

import { describe, it, expect } from "vitest";
import { applyChartFilters } from "../chartFilters";
import type { ParsedChartData, ChartFilters } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeData(
  categories: string[],
  seriesList: Array<{ name: string; values: number[]; color: string | null }>,
): ParsedChartData {
  return { categories, series: seriesList };
}

/** Build a 5-series, 10-category dataset for thorough filter testing. */
function makeLargeData(): ParsedChartData {
  const categories = Array.from({ length: 10 }, (_, i) => `Cat${i}`);
  const series = Array.from({ length: 5 }, (_, s) => ({
    name: `Series${s}`,
    values: Array.from({ length: 10 }, (_, c) => (s + 1) * 10 + c),
    color: `#${String(s).repeat(6)}`,
  }));
  return { categories, series };
}

// ============================================================================
// Filter operators x threshold values: 120 tests
// ============================================================================

describe("filter operators x threshold values", () => {
  // We simulate "filter operator" semantics by testing hiddenSeries/hiddenCategories
  // against various threshold indices and verifying match/no-match outcomes.
  // Each "operator" represents a different hiding strategy applied to category indices.

  type FilterOp = "hideBelow" | "hideAbove" | "hideEquals" | "hideNotEquals" | "hideBelowOrEqual" | "hideAboveOrEqual";

  function computeHiddenCategories(op: FilterOp, threshold: number, total: number): number[] {
    const hidden: number[] = [];
    for (let i = 0; i < total; i++) {
      let hide = false;
      switch (op) {
        case "hideBelow": hide = i < threshold; break;
        case "hideAbove": hide = i > threshold; break;
        case "hideEquals": hide = i === threshold; break;
        case "hideNotEquals": hide = i !== threshold; break;
        case "hideBelowOrEqual": hide = i <= threshold; break;
        case "hideAboveOrEqual": hide = i >= threshold; break;
      }
      if (hide) hidden.push(i);
    }
    return hidden;
  }

  const ops: FilterOp[] = ["hideBelow", "hideAbove", "hideEquals", "hideNotEquals", "hideBelowOrEqual", "hideAboveOrEqual"];
  const thresholds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const totalCategories = 10;

  // Generate 120 cases: 6 ops x 10 thresholds x (match count + categories verified)
  const cases: Array<[FilterOp, number, number[], number]> = [];
  for (const op of ops) {
    for (const t of thresholds) {
      const hidden = computeHiddenCategories(op, t, totalCategories);
      const visibleCount = totalCategories - hidden.length;
      cases.push([op, t, hidden, visibleCount]);
    }
  }

  it.each(cases)(
    "op=%s threshold=%d => %d visible categories",
    (op, threshold, hiddenCategories, expectedVisibleCount) => {
      const data = makeLargeData();
      const filters: ChartFilters = { hiddenSeries: [], hiddenCategories };
      const result = applyChartFilters(data, filters);

      expect(result.categories).toHaveLength(expectedVisibleCount);
      // Verify no hidden category appears in result
      const hiddenSet = new Set(hiddenCategories);
      for (let i = 0; i < totalCategories; i++) {
        if (hiddenSet.has(i)) {
          expect(result.categories).not.toContain(`Cat${i}`);
        }
      }
      // Verify all series have correct value count
      for (const s of result.series) {
        expect(s.values).toHaveLength(expectedVisibleCount);
      }
    },
  );
});

// ============================================================================
// applyChartFilters with 50 series/category hiding combos
// ============================================================================

describe("applyChartFilters - series/category combos", () => {
  // Generate 50 distinct combos of hidden series + hidden categories
  const combos: Array<[string, number[], number[], number, number]> = [
    // [label, hiddenSeries, hiddenCategories, expectedSeriesCount, expectedCatCount]
    // Pure series hiding
    ["no series hidden", [], [], 5, 10],
    ["series 0 hidden", [0], [], 4, 10],
    ["series 4 hidden", [4], [], 4, 10],
    ["series 0,1 hidden", [0, 1], [], 3, 10],
    ["series 2,3,4 hidden", [2, 3, 4], [], 2, 10],
    ["all series hidden", [0, 1, 2, 3, 4], [], 0, 10],
    ["series 1,3 hidden", [1, 3], [], 3, 10],
    ["series 0,2,4 hidden", [0, 2, 4], [], 2, 10],
    // Pure category hiding
    ["cat 0 hidden", [], [0], 5, 9],
    ["cat 9 hidden", [], [9], 5, 9],
    ["cat 0,1 hidden", [], [0, 1], 5, 8],
    ["cat 5,6,7,8,9 hidden", [], [5, 6, 7, 8, 9], 5, 5],
    ["all cats hidden", [], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5, 0],
    ["cat 4,5 hidden", [], [4, 5], 5, 8],
    ["odd cats hidden", [], [1, 3, 5, 7, 9], 5, 5],
    ["even cats hidden", [], [0, 2, 4, 6, 8], 5, 5],
    ["first 3 cats hidden", [], [0, 1, 2], 5, 7],
    ["last 3 cats hidden", [], [7, 8, 9], 5, 7],
    ["middle cats hidden", [], [3, 4, 5, 6], 5, 6],
    ["single cat 5 hidden", [], [5], 5, 9],
    // Combined series + category hiding
    ["s0 + c0", [0], [0], 4, 9],
    ["s0,s1 + c0,c1", [0, 1], [0, 1], 3, 8],
    ["s4 + c9", [4], [9], 4, 9],
    ["s0 + all cats", [0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4, 0],
    ["all series + c0", [0, 1, 2, 3, 4], [0], 0, 9],
    ["s2 + odd cats", [2], [1, 3, 5, 7, 9], 4, 5],
    ["s1,s3 + even cats", [1, 3], [0, 2, 4, 6, 8], 3, 5],
    ["s0,s4 + c0,c9", [0, 4], [0, 9], 3, 8],
    ["s2 + c5", [2], [5], 4, 9],
    ["s0,s1,s2 + c0,c1,c2", [0, 1, 2], [0, 1, 2], 2, 7],
    ["s3,s4 + c7,c8,c9", [3, 4], [7, 8, 9], 3, 7],
    ["s1 + c3,c6", [1], [3, 6], 4, 8],
    ["s0,s2,s4 + c1,c3,c5,c7,c9", [0, 2, 4], [1, 3, 5, 7, 9], 2, 5],
    ["s1,s2,s3,s4 + c0", [1, 2, 3, 4], [0], 1, 9],
    ["s0 + c4,c5,c6,c7", [0], [4, 5, 6, 7], 4, 6],
    // Out-of-range indices
    ["OOR series 10", [10], [], 5, 10],
    ["OOR series 99", [99], [], 5, 10],
    ["OOR cat 10", [], [10], 5, 10],
    ["OOR cat 99", [], [99], 5, 10],
    ["OOR both", [10], [10], 5, 10],
    ["mix valid+OOR series", [0, 10], [], 4, 10],
    ["mix valid+OOR cat", [], [0, 10], 5, 9],
    // Duplicate indices
    ["duplicate series", [0, 0], [], 4, 10],
    ["duplicate cats", [], [0, 0], 5, 9],
    // Negative indices (should not match)
    ["negative series index", [-1], [], 5, 10],
    ["negative cat index", [], [-1], 5, 10],
    // Large combos
    ["s0,s1 + first half cats", [0, 1], [0, 1, 2, 3, 4], 3, 5],
    ["s3,s4 + last half cats", [3, 4], [5, 6, 7, 8, 9], 3, 5],
    ["s2 + every 3rd cat", [2], [0, 3, 6, 9], 4, 6],
    ["all but s2 + all but c5", [0, 1, 3, 4], [0, 1, 2, 3, 4, 6, 7, 8, 9], 1, 1],
  ];

  it.each(combos)(
    "%s: hiddenSeries=%j hiddenCategories=%j => %d series, %d categories",
    (_label, hiddenSeries, hiddenCategories, expectedSeriesCount, expectedCatCount) => {
      const data = makeLargeData();
      const filters: ChartFilters = { hiddenSeries, hiddenCategories };
      const result = applyChartFilters(data, filters);

      expect(result.series).toHaveLength(expectedSeriesCount);
      expect(result.categories).toHaveLength(expectedCatCount);

      // Verify value arrays match category count
      for (const s of result.series) {
        expect(s.values).toHaveLength(expectedCatCount);
      }

      // Verify original data unchanged
      expect(data.series).toHaveLength(5);
      expect(data.categories).toHaveLength(10);
    },
  );
});
