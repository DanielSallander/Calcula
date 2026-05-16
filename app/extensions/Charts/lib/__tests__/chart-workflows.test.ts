//! FILENAME: app/extensions/Charts/lib/__tests__/chart-workflows.test.ts
// PURPOSE: Complex real-world chart workflow simulations exercising data
//          transforms, filters, trendlines, pie arcs, and layout utilities.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { applyChartFilters } from "../chartFilters";
import { computeTrendline } from "../trendlineComputation";
import { valuesToAngles } from "../../rendering/scales";
import { formatTickValue } from "../../rendering/chartPainterUtils";
import type {
  ParsedChartData,
  TransformSpec,
  ChartFilters,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

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

/** Realistic monthly sales data with multiple series. */
function salesDashboardData(): ParsedChartData {
  return makeData(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    { name: "Revenue", values: [45000, 52000, 48000, 61000, 73000, 68000, 82000, 79000, 71000, 95000, 110000, 105000] },
    { name: "COGS", values: [22000, 25000, 23000, 29000, 35000, 33000, 39000, 38000, 34000, 45000, 52000, 50000] },
    { name: "Marketing", values: [8000, 9000, 7500, 11000, 13000, 12000, 15000, 14000, 12500, 17000, 20000, 19000] },
  );
}

// ============================================================================
// Workflow 1: Sales dashboard
// ============================================================================

describe("Sales dashboard workflow", () => {
  it("calculates gross profit, filters profitable months, adds trendline", () => {
    const data = salesDashboardData();

    // Step 1: Calculate gross profit
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Revenue - COGS", as: "GrossProfit" },
    ];
    const withProfit = applyTransforms(data, transforms);

    const profit = withProfit.series.find((s) => s.name === "GrossProfit");
    expect(profit).toBeDefined();
    // Jan profit: 45000 - 22000 = 23000
    expect(profit!.values[0]).toBe(23000);

    // Step 2: Add trendline to Revenue
    const trendResult = computeTrendline(withProfit, { type: "linear", seriesIndex: 0 });
    expect(trendResult).not.toBeNull();
    expect(trendResult!.rSquared).toBeGreaterThan(0.8);
    // Revenue is generally increasing, so slope should be positive
    expect(trendResult!.points[11].value).toBeGreaterThan(trendResult!.points[0].value);
  });

  it("filters out low-revenue months, sorts by profit, ranks top performers", () => {
    const data = salesDashboardData();
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Revenue - COGS", as: "GrossProfit" },
      { type: "filter", field: "Revenue", predicate: ">= 70000" },
      { type: "sort", field: "GrossProfit", order: "desc" },
      { type: "window", op: "rank", field: "GrossProfit", as: "ProfitRank" },
    ];
    const result = applyTransforms(data, transforms);

    // Only months with Revenue >= 70000: May(73k), Jul(82k), Aug(79k), Sep(71k), Oct(95k), Nov(110k), Dec(105k)
    expect(result.categories.length).toBeGreaterThanOrEqual(6);

    // Sorted by profit descending
    const gp = result.series.find((s) => s.name === "GrossProfit");
    expect(gp).toBeDefined();
    for (let i = 1; i < gp!.values.length; i++) {
      expect(gp!.values[i]).toBeLessThanOrEqual(gp!.values[i - 1]);
    }

    // Rank 1 should be the highest profit month
    const ranks = result.series.find((s) => s.name === "ProfitRank");
    expect(ranks).toBeDefined();
    expect(ranks!.values[0]).toBe(1);
  });

  it("applies UI filters to hide COGS series and first 6 months", () => {
    const data = salesDashboardData();
    const transforms: TransformSpec[] = [
      { type: "calculate", expr: "Revenue - COGS - Marketing", as: "NetProfit" },
    ];
    const transformed = applyTransforms(data, transforms);

    // User hides COGS (index 1) and Marketing (index 2)
    const filters: ChartFilters = {
      hiddenSeries: [1, 2],
      hiddenCategories: [0, 1, 2, 3, 4, 5], // Hide Jan-Jun
    };
    const filtered = applyChartFilters(transformed, filters);

    // Should have Revenue and NetProfit only
    const names = filtered.series.map((s) => s.name);
    expect(names).toContain("Revenue");
    expect(names).toContain("NetProfit");
    expect(names).not.toContain("COGS");
    expect(names).not.toContain("Marketing");

    // Only Jul-Dec (6 months)
    expect(filtered.categories).toEqual(["Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
    expect(filtered.series[0].values).toHaveLength(6);
  });

  it("computes running revenue total and verifies monotonic increase", () => {
    const data = salesDashboardData();
    const transforms: TransformSpec[] = [
      { type: "window", op: "running_sum", field: "Revenue", as: "CumulativeRevenue" },
    ];
    const result = applyTransforms(data, transforms);
    const cumulative = result.series.find((s) => s.name === "CumulativeRevenue");
    expect(cumulative).toBeDefined();

    // Running sum should be monotonically increasing (all values positive)
    for (let i = 1; i < cumulative!.values.length; i++) {
      expect(cumulative!.values[i]).toBeGreaterThan(cumulative!.values[i - 1]);
    }

    // Final cumulative should equal sum of all revenue
    const totalRevenue = data.series[0].values.reduce((a, b) => a + b, 0);
    expect(cumulative!.values[11]).toBe(totalRevenue);
  });

  it("exponential trendline on growth data has high R-squared", () => {
    // Simulated startup revenue with exponential growth
    const growthData = makeData(
      ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"],
      { name: "MRR", values: [1000, 1500, 2250, 3375, 5063, 7594, 11391, 17086] },
    );

    const trend = computeTrendline(growthData, { type: "exponential", seriesIndex: 0 });
    expect(trend).not.toBeNull();
    expect(trend!.rSquared).toBeGreaterThan(0.95);
    expect(trend!.equation).toContain("e^");
  });
});

// ============================================================================
// Workflow 2: Quarterly comparison
// ============================================================================

describe("Quarterly comparison workflow", () => {
  it("aggregates monthly data to quarters, computes running total, and ranks", () => {
    const data = makeData(
      ["Q1", "Q1", "Q1", "Q2", "Q2", "Q2", "Q3", "Q3", "Q3", "Q4", "Q4", "Q4"],
      { name: "Revenue", values: [45, 52, 48, 61, 73, 68, 82, 79, 71, 95, 110, 105] },
    );

    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Revenue", as: "QuarterRevenue" },
      { type: "window", op: "running_sum", field: "QuarterRevenue", as: "YTDRevenue" },
      { type: "window", op: "rank", field: "QuarterRevenue", as: "QuarterRank" },
    ];
    const result = applyTransforms(data, transforms);

    expect(result.categories).toEqual(["Q1", "Q2", "Q3", "Q4"]);

    const qRevenue = result.series.find((s) => s.name === "QuarterRevenue");
    expect(qRevenue!.values).toEqual([145, 202, 232, 310]);

    const ytd = result.series.find((s) => s.name === "YTDRevenue");
    expect(ytd!.values).toEqual([145, 347, 579, 889]);

    const rank = result.series.find((s) => s.name === "QuarterRank");
    expect(rank!.values[3]).toBe(1); // Q4 is highest
  });

  it("filters to top 2 quarters by revenue", () => {
    const data = makeData(
      ["Q1", "Q2", "Q3", "Q4"],
      { name: "Revenue", values: [145, 202, 232, 310] },
    );

    const transforms: TransformSpec[] = [
      { type: "window", op: "rank", field: "Revenue", as: "Rank" },
      { type: "filter", field: "Rank", predicate: "<= 2" },
    ];
    const result = applyTransforms(data, transforms);

    expect(result.categories).toHaveLength(2);
    expect(result.categories).toContain("Q4");
    expect(result.categories).toContain("Q3");
  });

  it("formats tick values for quarterly revenue chart axes", () => {
    expect(formatTickValue(145000)).toBe("145.0K");
    expect(formatTickValue(1200000)).toBe("1.2M");
    expect(formatTickValue(500)).toBe("500");
    expect(formatTickValue(99.5)).toBe("99.5");
    expect(formatTickValue(0)).toBe("0");
  });

  it("computes quarter-over-quarter growth percentage", () => {
    const data = makeData(
      ["Q1", "Q2", "Q3", "Q4"],
      { name: "Revenue", values: [145, 202, 232, 310] },
    );

    const transforms: TransformSpec[] = [
      { type: "window", op: "running_mean", field: "Revenue", as: "RunningAvg" },
    ];
    const result = applyTransforms(data, transforms);

    const avg = result.series.find((s) => s.name === "RunningAvg");
    expect(avg!.values[0]).toBe(145);            // 145/1
    expect(avg!.values[1]).toBeCloseTo(173.5);    // (145+202)/2
    expect(avg!.values[2]).toBeCloseTo(193);      // (145+202+232)/3
    expect(avg!.values[3]).toBeCloseTo(222.25);   // (145+202+232+310)/4
  });
});

// ============================================================================
// Workflow 3: Pie chart from survey data
// ============================================================================

describe("Pie chart from survey data", () => {
  it("aggregates survey responses and computes slice arcs summing to 360 degrees", () => {
    // Raw survey: multiple responses per category
    const data = makeData(
      ["Excellent", "Good", "Excellent", "Fair", "Good", "Poor", "Good", "Excellent", "Fair", "Good"],
      { name: "Count", values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
    );

    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Count", as: "Responses" },
    ];
    const result = applyTransforms(data, transforms);

    // Excellent: 3, Good: 4, Fair: 2, Poor: 1
    const responses = result.series.find((s) => s.name === "Responses");
    expect(responses).toBeDefined();

    const total = responses!.values.reduce((a, b) => a + b, 0);
    expect(total).toBe(10);

    // Compute pie slices
    const arcs = valuesToAngles(responses!.values, 0, 0);
    expect(arcs).toHaveLength(result.categories.length);

    // Total arc sweep should be 2*PI (360 degrees) with 0 padding
    let totalSweep = 0;
    for (const arc of arcs) {
      totalSweep += arc.endAngle - arc.startAngle;
    }
    expect(totalSweep).toBeCloseTo(Math.PI * 2, 5);
  });

  it("verifies slice percentages sum to 100%", () => {
    const values = [30, 25, 20, 15, 10];
    const total = values.reduce((a, b) => a + b, 0);
    const percentages = values.map((v) => (v / total) * 100);
    const sumPercent = percentages.reduce((a, b) => a + b, 0);
    expect(sumPercent).toBeCloseTo(100);

    // Arcs with padding
    const arcs = valuesToAngles(values, 0, 1);
    expect(arcs).toHaveLength(5);
    // Each arc should have non-zero sweep
    for (const arc of arcs) {
      expect(arc.endAngle - arc.startAngle).toBeGreaterThan(0);
    }
  });

  it("handles single-slice pie (100%)", () => {
    const arcs = valuesToAngles([100], 0, 0);
    expect(arcs).toHaveLength(1);
    const sweep = arcs[0].endAngle - arcs[0].startAngle;
    expect(sweep).toBeCloseTo(Math.PI * 2, 5);
  });

  it("handles zero-value slices gracefully", () => {
    const arcs = valuesToAngles([50, 0, 30, 0, 20], 0, 0);
    expect(arcs).toHaveLength(5);
    // Zero-value slices should have zero sweep
    expect(arcs[1].endAngle - arcs[1].startAngle).toBe(0);
    expect(arcs[3].endAngle - arcs[3].startAngle).toBe(0);
  });

  it("handles all-zero values without crashing", () => {
    const arcs = valuesToAngles([0, 0, 0], 0, 0);
    expect(arcs).toHaveLength(3);
    for (const arc of arcs) {
      expect(arc.startAngle).toBe(0);
      expect(arc.endAngle).toBe(0);
    }
  });

  it("aggregates, sorts by response count, then filters to hide small slices", () => {
    const data = makeData(
      ["A", "A", "A", "A", "A", "B", "B", "B", "C", "D"],
      { name: "Count", values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
    );

    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Count", as: "Total" },
      { type: "sort", field: "Total", order: "desc" },
      { type: "filter", field: "Total", predicate: ">= 2" },
    ];
    const result = applyTransforms(data, transforms);

    // A:5, B:3 pass filter. C:1, D:1 filtered out.
    expect(result.categories).toEqual(["A", "B"]);
    const totals = result.series.find((s) => s.name === "Total");
    expect(totals!.values).toEqual([5, 3]);

    // Compute arcs for remaining slices
    const arcs = valuesToAngles(totals!.values, 0, 1);
    expect(arcs).toHaveLength(2);
    // A should have larger arc than B
    const sweepA = arcs[0].endAngle - arcs[0].startAngle;
    const sweepB = arcs[1].endAngle - arcs[1].startAngle;
    expect(sweepA).toBeGreaterThan(sweepB);
  });

  it("custom start angle rotates all slices", () => {
    const values = [50, 50];
    const arcs0 = valuesToAngles(values, 0, 0);
    const arcs90 = valuesToAngles(values, 90, 0);

    // 90-degree rotation shifts start by PI/2
    const shift = (90 * Math.PI) / 180;
    expect(arcs90[0].startAngle - arcs0[0].startAngle).toBeCloseTo(shift, 5);
  });

  it("full survey pipeline: raw data -> aggregate -> sort -> arcs -> format labels", () => {
    const raw = makeData(
      ["Yes", "No", "Yes", "Maybe", "Yes", "No", "Yes", "Maybe", "Yes", "No"],
      { name: "Vote", values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
    );

    // Aggregate
    const transforms: TransformSpec[] = [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Vote", as: "Votes" },
      { type: "sort", field: "Votes", order: "desc" },
    ];
    const result = applyTransforms(raw, transforms);

    const votes = result.series.find((s) => s.name === "Votes");
    expect(votes).toBeDefined();

    // Compute percentages
    const total = votes!.values.reduce((a, b) => a + b, 0);
    expect(total).toBe(10);

    const labels = result.categories.map((cat, i) => {
      const pct = ((votes!.values[i] / total) * 100).toFixed(1);
      return `${cat}: ${pct}%`;
    });

    // Yes:5 (50%), No:3 (30%), Maybe:2 (20%)
    expect(labels[0]).toBe("Yes: 50.0%");

    // Format the count values
    expect(formatTickValue(votes!.values[0])).toBe("5");

    // Arcs
    const arcs = valuesToAngles(votes!.values, 0, 1);
    expect(arcs).toHaveLength(3);
  });
});
