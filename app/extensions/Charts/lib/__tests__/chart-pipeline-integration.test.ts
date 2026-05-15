//! FILENAME: app/extensions/Charts/lib/__tests__/chart-pipeline-integration.test.ts
// PURPOSE: Integration tests for the full chart data pipeline:
//          raw data -> transforms -> filters -> output verification.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { applyChartFilters } from "../chartFilters";
import type {
  ParsedChartData,
  TransformSpec,
  ChartFilters,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

/** Build a simple ParsedChartData for testing. */
function makeData(
  categories: string[],
  ...seriesDefs: Array<{ name: string; values: number[] }>
): ParsedChartData {
  return {
    categories,
    series: seriesDefs.map((s) => ({
      name: s.name,
      values: s.values,
      color: null,
    })),
  };
}

/** Monthly sales data for realistic scenarios. */
function monthlySalesData(): ParsedChartData {
  return makeData(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    { name: "Revenue", values: [100, 120, 90, 150, 200, 180, 220, 210, 190, 250, 300, 280] },
    { name: "Cost", values: [60, 70, 55, 80, 110, 100, 120, 115, 105, 130, 160, 150] },
  );
}

// ============================================================================
// Filter -> Transform Chains
// ============================================================================

describe("filter then transform pipeline", () => {
  it("filters out low-value categories then sorts remaining", () => {
    const data = monthlySalesData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Revenue", predicate: ">= 200" },
      { type: "sort", field: "Revenue", order: "desc" },
    ];
    const result = applyTransforms(data, transforms);

    // Only months with Revenue >= 200: May(200), Jul(220), Aug(210), Oct(250), Nov(300), Dec(280)
    expect(result.categories).toHaveLength(6);
    // Sorted desc by Revenue
    expect(result.categories[0]).toBe("Nov");  // 300
    expect(result.categories[1]).toBe("Dec");  // 280
    expect(result.categories[2]).toBe("Oct");  // 250
    // All Revenue values should be >= 200
    for (const v of result.series[0].values) {
      expect(v).toBeGreaterThanOrEqual(200);
    }
  });

  it("filters categories by name then calculates profit margin", () => {
    const data = monthlySalesData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "$category", predicate: "!= Jan" },
      { type: "calculate", expr: "Revenue - Cost", as: "Profit" },
    ];
    const result = applyTransforms(data, transforms);

    expect(result.categories).not.toContain("Jan");
    expect(result.categories).toHaveLength(11);

    const profitSeries = result.series.find((s) => s.name === "Profit");
    expect(profitSeries).toBeDefined();
    // Feb profit: 120 - 70 = 50
    expect(profitSeries!.values[0]).toBe(50);
  });

  it("applies chart filters after transforms", () => {
    const data = monthlySalesData();
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Revenue", order: "asc" },
    ];
    const transformed = applyTransforms(data, transforms);

    // Hide the first series (Revenue) and first 3 categories
    const filters: ChartFilters = {
      hiddenSeries: [0],
      hiddenCategories: [0, 1, 2],
    };
    const filtered = applyChartFilters(transformed, filters);

    // Only Cost series should remain
    expect(filtered.series).toHaveLength(1);
    expect(filtered.series[0].name).toBe("Cost");
    // 12 - 3 hidden = 9 categories
    expect(filtered.categories).toHaveLength(9);
  });
});

// ============================================================================
// Transform -> Filter -> Transform Chains
// ============================================================================

describe("multi-step transform chains", () => {
  it("calculate -> filter -> sort pipeline", () => {
    const data = monthlySalesData();
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Revenue - Cost", as: "Profit" },
      { type: "filter", field: "Profit", predicate: "> 100" },
      { type: "sort", field: "Profit", order: "desc" },
    ];
    const result = applyTransforms(data, transforms);

    const profit = result.series.find((s) => s.name === "Profit");
    expect(profit).toBeDefined();
    // All profit values should be > 100
    for (const v of profit!.values) {
      expect(v).toBeGreaterThan(100);
    }
    // Should be sorted descending
    for (let i = 1; i < profit!.values.length; i++) {
      expect(profit!.values[i]).toBeLessThanOrEqual(profit!.values[i - 1]);
    }
  });

  it("aggregate -> window (running sum) pipeline", () => {
    const data = makeData(
      ["East", "East", "West", "West", "North"],
      { name: "Sales", values: [10, 20, 30, 40, 50] },
    );
    const transforms: TransformSpec[] = [
      {
        type: "aggregate",
        groupBy: ["$category"],
        op: "sum",
        field: "Sales",
        as: "TotalSales",
      },
      {
        type: "window",
        op: "running_sum",
        field: "TotalSales",
        as: "CumulativeSales",
      },
    ];
    const result = applyTransforms(data, transforms);

    expect(result.categories).toEqual(["East", "West", "North"]);
    const totals = result.series.find((s) => s.name === "TotalSales");
    expect(totals!.values).toEqual([30, 70, 50]);

    const cumulative = result.series.find((s) => s.name === "CumulativeSales");
    expect(cumulative!.values).toEqual([30, 100, 150]);
  });

  it("sort -> bin pipeline", () => {
    const data = makeData(
      ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
      { name: "Score", values: [10, 25, 35, 45, 55, 65, 75, 85, 90, 100] },
    );
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Score", order: "asc" },
      { type: "bin", field: "Score", binCount: 5, as: "ScoreBin" },
    ];
    const result = applyTransforms(data, transforms);

    expect(result.categories).toHaveLength(5);
    const bins = result.series.find((s) => s.name === "ScoreBin");
    expect(bins).toBeDefined();
    // Total count should be 10
    expect(bins!.values.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("window rank -> filter top 3 pipeline", () => {
    const data = makeData(
      ["Alice", "Bob", "Carol", "Dave", "Eve"],
      { name: "Sales", values: [300, 100, 500, 200, 400] },
    );
    const transforms: TransformSpec[] = [
      { type: "window", op: "rank", field: "Sales", as: "Rank" },
      { type: "filter", field: "Rank", predicate: "<= 3" },
    ];
    const result = applyTransforms(data, transforms);

    // Top 3 by Sales: Carol(500,rank1), Eve(400,rank2), Alice(300,rank3)
    expect(result.categories).toHaveLength(3);
    expect(result.categories).toContain("Carol");
    expect(result.categories).toContain("Eve");
    expect(result.categories).toContain("Alice");
  });
});

// ============================================================================
// Chart Filters Edge Cases
// ============================================================================

describe("chart filters edge cases", () => {
  it("returns same data when filters is undefined", () => {
    const data = monthlySalesData();
    const result = applyChartFilters(data, undefined);
    expect(result).toBe(data); // Same reference
  });

  it("returns same data when filters are empty arrays", () => {
    const data = monthlySalesData();
    const result = applyChartFilters(data, { hiddenSeries: [], hiddenCategories: [] });
    expect(result).toBe(data);
  });

  it("hiding all series leaves empty series array", () => {
    const data = monthlySalesData();
    const result = applyChartFilters(data, {
      hiddenSeries: [0, 1],
      hiddenCategories: [],
    });
    expect(result.series).toHaveLength(0);
    expect(result.categories).toHaveLength(12);
  });

  it("hiding all categories leaves empty categories and values", () => {
    const data = makeData(
      ["A", "B", "C"],
      { name: "X", values: [1, 2, 3] },
    );
    const result = applyChartFilters(data, {
      hiddenSeries: [],
      hiddenCategories: [0, 1, 2],
    });
    expect(result.categories).toHaveLength(0);
    expect(result.series[0].values).toHaveLength(0);
  });

  it("category filter correctly aligns values with remaining categories", () => {
    const data = makeData(
      ["A", "B", "C", "D", "E"],
      { name: "Values", values: [10, 20, 30, 40, 50] },
    );
    // Hide B(1) and D(3)
    const result = applyChartFilters(data, {
      hiddenSeries: [],
      hiddenCategories: [1, 3],
    });
    expect(result.categories).toEqual(["A", "C", "E"]);
    expect(result.series[0].values).toEqual([10, 30, 50]);
  });
});

// ============================================================================
// Full Realistic Pipeline Scenarios
// ============================================================================

describe("full realistic pipeline scenarios", () => {
  it("sales dashboard: calculate profit, filter profitable months, sort, then apply UI filters", () => {
    const data = monthlySalesData();

    // Step 1: Transform pipeline
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Revenue - Cost", as: "Profit" },
      { type: "filter", field: "Profit", predicate: "> 50" },
      { type: "sort", field: "Revenue", order: "desc" },
      { type: "window", op: "running_sum", field: "Revenue", as: "CumulativeRevenue" },
    ];
    const transformed = applyTransforms(data, transforms);

    // Step 2: User hides some series via UI
    const filters: ChartFilters = {
      hiddenSeries: [1], // Hide Cost
      hiddenCategories: [],
    };
    const final = applyChartFilters(transformed, filters);

    // Revenue, Profit, CumulativeRevenue should remain (Cost hidden)
    const seriesNames = final.series.map((s) => s.name);
    expect(seriesNames).toContain("Revenue");
    expect(seriesNames).toContain("Profit");
    expect(seriesNames).toContain("CumulativeRevenue");
    expect(seriesNames).not.toContain("Cost");

    // Cumulative should be monotonically increasing
    const cumulative = final.series.find((s) => s.name === "CumulativeRevenue");
    for (let i = 1; i < cumulative!.values.length; i++) {
      expect(cumulative!.values[i]).toBeGreaterThanOrEqual(cumulative!.values[i - 1]);
    }
  });

  it("aggregate duplicate categories then compute running mean", () => {
    const data = makeData(
      ["Q1", "Q1", "Q2", "Q2", "Q3", "Q3", "Q4", "Q4"],
      { name: "Revenue", values: [100, 150, 200, 250, 300, 350, 400, 450] },
    );
    const transforms: TransformSpec[] = [
      {
        type: "aggregate",
        groupBy: ["$category"],
        op: "sum",
        field: "Revenue",
        as: "QuarterlyRevenue",
      },
      {
        type: "window",
        op: "running_mean",
        field: "QuarterlyRevenue",
        as: "RunningAvgRevenue",
      },
    ];
    const result = applyTransforms(data, transforms);

    expect(result.categories).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    const quarterly = result.series.find((s) => s.name === "QuarterlyRevenue");
    expect(quarterly!.values).toEqual([250, 450, 650, 850]);

    const runningAvg = result.series.find((s) => s.name === "RunningAvgRevenue");
    expect(runningAvg!.values[0]).toBe(250); // 250/1
    expect(runningAvg!.values[1]).toBe(350); // (250+450)/2
    expect(runningAvg!.values[2]).toBeCloseTo(450); // (250+450+650)/3
  });

  it("empty data passes through transform pipeline safely", () => {
    const data = makeData([], { name: "Sales", values: [] });
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 0" },
      { type: "sort", field: "Sales", order: "asc" },
      { type: "calculate", expr: "Sales * 2", as: "Double" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toHaveLength(0);
  });

  it("unknown transform type is ignored gracefully", () => {
    const data = makeData(["A"], { name: "X", values: [1] });
    const transforms = [
      { type: "nonexistent" as any, field: "X" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(["A"]);
  });

  it("filter with nonexistent field returns data unchanged", () => {
    const data = makeData(["A", "B"], { name: "X", values: [1, 2] });
    const transforms: TransformSpec[] = [
      { type: "filter", field: "NoSuchField", predicate: "> 0" },
    ];
    const result = applyTransforms(data, transforms);
    expect(result.categories).toEqual(["A", "B"]);
  });

  it("calculate with multiple series references", () => {
    const data = makeData(
      ["Jan", "Feb", "Mar"],
      { name: "Revenue", values: [100, 200, 300] },
      { name: "Cost", values: [40, 80, 120] },
      { name: "Tax", values: [10, 20, 30] },
    );
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Revenue - Cost - Tax", as: "NetProfit" },
    ];
    const result = applyTransforms(data, transforms);
    const net = result.series.find((s) => s.name === "NetProfit");
    expect(net!.values).toEqual([50, 100, 150]);
  });

  it("median aggregation works correctly", () => {
    const data = makeData(
      ["A", "A", "A", "B", "B"],
      { name: "Score", values: [10, 30, 20, 40, 50] },
    );
    const transforms: TransformSpec[] = [
      {
        type: "aggregate",
        groupBy: ["$category"],
        op: "median",
        field: "Score",
        as: "MedianScore",
      },
    ];
    const result = applyTransforms(data, transforms);
    const median = result.series.find((s) => s.name === "MedianScore");
    expect(median!.values[0]).toBe(20); // median of [10,30,20] = 20
    expect(median!.values[1]).toBe(45); // median of [40,50] = 45
  });

  it("calculate replaces existing series with same name", () => {
    const data = makeData(
      ["A", "B"],
      { name: "X", values: [10, 20] },
    );
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "X * 2", as: "X" },
    ];
    const result = applyTransforms(data, transforms);
    // Should still have 1 series, not 2
    expect(result.series).toHaveLength(1);
    expect(result.series[0].values).toEqual([20, 40]);
  });
});
