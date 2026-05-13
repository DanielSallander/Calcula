//! FILENAME: app/extensions/Charts/lib/__tests__/chartFilters.test.ts
// PURPOSE: Tests for the chart filter data pipeline.

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

function makeSampleData(): ParsedChartData {
  return makeData(
    ["Q1", "Q2", "Q3", "Q4"],
    [
      { name: "Revenue", values: [100, 200, 300, 400], color: "#FF0000" },
      { name: "Costs", values: [80, 150, 250, 350], color: "#00FF00" },
      { name: "Profit", values: [20, 50, 50, 50], color: "#0000FF" },
    ],
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("applyChartFilters", () => {
  describe("no filters", () => {
    it("returns data unchanged when filters is undefined", () => {
      const data = makeSampleData();
      const result = applyChartFilters(data, undefined);
      expect(result).toBe(data); // Same reference
    });

    it("returns data unchanged when both arrays are empty", () => {
      const data = makeSampleData();
      const result = applyChartFilters(data, { hiddenSeries: [], hiddenCategories: [] });
      expect(result).toBe(data);
    });
  });

  describe("series filtering", () => {
    it("hides a single series", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [1], hiddenCategories: [] };

      const result = applyChartFilters(data, filters);

      expect(result.series).toHaveLength(2);
      expect(result.series[0].name).toBe("Revenue");
      expect(result.series[1].name).toBe("Profit");
      // Categories unchanged
      expect(result.categories).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    });

    it("hides multiple series", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [0, 2], hiddenCategories: [] };

      const result = applyChartFilters(data, filters);

      expect(result.series).toHaveLength(1);
      expect(result.series[0].name).toBe("Costs");
    });

    it("hides all series (returns empty)", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [0, 1, 2], hiddenCategories: [] };

      const result = applyChartFilters(data, filters);

      expect(result.series).toHaveLength(0);
      expect(result.categories).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    });

    it("ignores out-of-range hidden indices", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [5, 10], hiddenCategories: [] };

      const result = applyChartFilters(data, filters);

      expect(result.series).toHaveLength(3); // All still visible
    });

    it("preserves series colors after filtering", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [0], hiddenCategories: [] };

      const result = applyChartFilters(data, filters);

      expect(result.series[0].color).toBe("#00FF00");
      expect(result.series[1].color).toBe("#0000FF");
    });
  });

  describe("category filtering", () => {
    it("hides a single category", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [1] };

      const result = applyChartFilters(data, filters);

      expect(result.categories).toEqual(["Q1", "Q3", "Q4"]);
      expect(result.series[0].values).toEqual([100, 300, 400]);
      expect(result.series[1].values).toEqual([80, 250, 350]);
      expect(result.series[2].values).toEqual([20, 50, 50]);
    });

    it("hides multiple categories", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [0, 3] };

      const result = applyChartFilters(data, filters);

      expect(result.categories).toEqual(["Q2", "Q3"]);
      expect(result.series[0].values).toEqual([200, 300]);
    });

    it("hides all categories", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [0, 1, 2, 3] };

      const result = applyChartFilters(data, filters);

      expect(result.categories).toHaveLength(0);
      expect(result.series[0].values).toHaveLength(0);
    });
  });

  describe("combined series + category filtering", () => {
    it("hides both series and categories simultaneously", () => {
      const data = makeSampleData();
      const filters: ChartFilters = { hiddenSeries: [2], hiddenCategories: [0, 3] };

      const result = applyChartFilters(data, filters);

      expect(result.series).toHaveLength(2);
      expect(result.series[0].name).toBe("Revenue");
      expect(result.series[1].name).toBe("Costs");

      expect(result.categories).toEqual(["Q2", "Q3"]);
      expect(result.series[0].values).toEqual([200, 300]);
      expect(result.series[1].values).toEqual([150, 250]);
    });
  });

  describe("edge cases", () => {
    it("handles empty data", () => {
      const data = makeData([], []);
      const filters: ChartFilters = { hiddenSeries: [0], hiddenCategories: [0] };

      const result = applyChartFilters(data, filters);

      expect(result.categories).toHaveLength(0);
      expect(result.series).toHaveLength(0);
    });

    it("handles single-series single-category data", () => {
      const data = makeData(
        ["Only"],
        [{ name: "Only Series", values: [42], color: null }],
      );
      const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [] };

      const result = applyChartFilters(data, filters);

      expect(result.categories).toEqual(["Only"]);
      expect(result.series[0].values).toEqual([42]);
    });

    it("does not mutate original data", () => {
      const data = makeSampleData();
      const originalSeriesLength = data.series.length;
      const originalCategoriesLength = data.categories.length;

      applyChartFilters(data, { hiddenSeries: [0, 1], hiddenCategories: [0, 1] });

      expect(data.series).toHaveLength(originalSeriesLength);
      expect(data.categories).toHaveLength(originalCategoriesLength);
    });
  });
});
