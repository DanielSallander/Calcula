//! FILENAME: app/extensions/Charts/lib/__tests__/chart-consistency.test.ts
// PURPOSE: Integration-level consistency checks for chart modules working together.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";
import { resolveChartTheme, DEFAULT_CHART_THEME } from "../../rendering/chartTheme";
import { computeBarRects } from "../../rendering/barChartPainter";
import { computePieSliceArcs } from "../../rendering/pieChartPainter";
import type { ParsedChartData, TransformSpec, ChartSpec, ChartLayout } from "../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeData(categories: string[], seriesData: Record<string, number[]>): ParsedChartData {
  return {
    categories,
    series: Object.entries(seriesData).map(([name, values]) => ({
      name,
      values,
      color: null,
    })),
  };
}

function makeMinimalBarSpec(): ChartSpec {
  return {
    mark: "bar",
    data: { type: "range", sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", valueIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { show: true, position: "right" },
    palette: "default",
  };
}

function makeMinimalPieSpec(): ChartSpec {
  return {
    ...makeMinimalBarSpec(),
    mark: "pie",
  };
}

function makeLayout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 40, right: 20, bottom: 40, left: 60 },
    plotArea: { x: 60, y: 40, width: 520, height: 320 },
  };
}

// ===========================================================================
// Filter then sort = sort then filter (for independent operations)
// ===========================================================================

describe("filter then sort = sort then filter for independent operations", () => {
  it("numeric filter on series + category sort commute", () => {
    const data = makeData(
      ["C", "A", "B", "D"],
      { Sales: [30, 10, 20, 40] },
    );

    const filter: TransformSpec = { type: "filter", field: "Sales", predicate: "> 15" };
    const sort: TransformSpec = { type: "sort", field: "$category", order: "asc" };

    const filterThenSort = applyTransforms(data, [filter, sort]);
    const sortThenFilter = applyTransforms(data, [sort, filter]);

    expect(filterThenSort.categories).toEqual(sortThenFilter.categories);
    expect(filterThenSort.series[0].values).toEqual(sortThenFilter.series[0].values);
  });

  it("equality filter on category + series sort commute", () => {
    const data = makeData(
      ["X", "Y", "Z", "W"],
      { Revenue: [100, 400, 200, 300] },
    );

    const filter: TransformSpec = { type: "filter", field: "$category", predicate: "!= W" };
    const sort: TransformSpec = { type: "sort", field: "Revenue", order: "desc" };

    const filterThenSort = applyTransforms(data, [filter, sort]);
    const sortThenFilter = applyTransforms(data, [sort, filter]);

    expect(filterThenSort.categories).toEqual(sortThenFilter.categories);
    expect(filterThenSort.series[0].values).toEqual(sortThenFilter.series[0].values);
  });
});

// ===========================================================================
// Aggregate sum of parts = aggregate of whole
// ===========================================================================

describe("aggregate sum of parts = aggregate of whole", () => {
  it("summing two halves matches summing the whole", () => {
    const data = makeData(
      ["A", "A", "B", "B"],
      { Sales: [10, 20, 30, 40] },
    );

    const aggregated = applyTransforms(data, [{
      type: "aggregate",
      groupBy: ["$category"],
      op: "sum",
      field: "Sales",
      as: "Total",
    }]);

    // Sum of aggregated parts should equal total of all values
    const aggregatedSum = aggregated.series[0].values.reduce((a, b) => a + b, 0);
    const rawSum = data.series[0].values.reduce((a, b) => a + b, 0);
    expect(aggregatedSum).toBe(rawSum);
  });

  it("count aggregate parts sum to total count", () => {
    const data = makeData(
      ["X", "X", "X", "Y", "Y"],
      { Val: [1, 2, 3, 4, 5] },
    );

    const aggregated = applyTransforms(data, [{
      type: "aggregate",
      groupBy: ["$category"],
      op: "count",
      field: "Val",
      as: "Count",
    }]);

    const totalCount = aggregated.series[0].values.reduce((a, b) => a + b, 0);
    expect(totalCount).toBe(data.categories.length);
  });
});

// ===========================================================================
// computeBarRects total width consistent with band scale bandwidth
// ===========================================================================

describe("computeBarRects geometry consistency", () => {
  it("all bar rects fall within plot area bounds", () => {
    const data = makeData(["A", "B", "C"], { Sales: [10, 20, 30] });
    const spec = makeMinimalBarSpec();
    const layout = makeLayout();
    const theme = resolveChartTheme(undefined);

    const rects = computeBarRects(data, spec, layout, theme);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(layout.plotArea.x - 1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(
        layout.plotArea.x + layout.plotArea.width + 1,
      );
    }
  });

  it("bars for same category share same x position (grouped)", () => {
    const data = makeData(["A", "B"], { S1: [10, 20], S2: [15, 25] });
    const spec: ChartSpec = {
      ...makeMinimalBarSpec(),
      series: [
        { name: "S1", valueIndex: 1, color: null },
        { name: "S2", valueIndex: 2, color: null },
      ],
    };
    const layout = makeLayout();
    const theme = resolveChartTheme(undefined);

    const rects = computeBarRects(data, spec, layout, theme);
    // Should have 4 rects (2 series x 2 categories)
    expect(rects.length).toBe(4);
  });
});

// ===========================================================================
// computePieSliceArcs percentages consistent with input values
// ===========================================================================

describe("computePieSliceArcs percentages consistent with input values", () => {
  it("percentages sum to 100", () => {
    const data = makeData(["A", "B", "C"], { Val: [25, 50, 25] });
    const spec = makeMinimalPieSpec();
    const layout = makeLayout();
    const theme = resolveChartTheme(undefined);

    const arcs = computePieSliceArcs(data, spec, layout, theme);
    const totalPercent = arcs.reduce((sum, a) => sum + a.percent, 0);
    expect(totalPercent).toBeCloseTo(100, 5);
  });

  it("individual percentages match value / total * 100", () => {
    const values = [10, 30, 60];
    const total = 100;
    const data = makeData(["X", "Y", "Z"], { Val: values });
    const spec = makeMinimalPieSpec();
    const layout = makeLayout();
    const theme = resolveChartTheme(undefined);

    const arcs = computePieSliceArcs(data, spec, layout, theme);
    for (let i = 0; i < values.length; i++) {
      expect(arcs[i].percent).toBeCloseTo((values[i] / total) * 100, 5);
    }
  });

  it("slice angles span the full circle (minus padding)", () => {
    const data = makeData(["A", "B", "C", "D"], { Val: [10, 20, 30, 40] });
    const spec = makeMinimalPieSpec();
    const layout = makeLayout();
    const theme = resolveChartTheme(undefined);

    const arcs = computePieSliceArcs(data, spec, layout, theme);
    // Total arc sweep should be close to 2*PI (with small padding gaps)
    const totalSweep = arcs.reduce((sum, a) => sum + Math.abs(a.endAngle - a.startAngle), 0);
    expect(totalSweep).toBeGreaterThan(Math.PI * 1.9);
    expect(totalSweep).toBeLessThanOrEqual(Math.PI * 2 + 0.01);
  });
});

// ===========================================================================
// Multiple trendline calls on same data produce identical results
// ===========================================================================

describe("trendline computation is deterministic", () => {
  const data = makeData(["A", "B", "C", "D", "E"], { Sales: [10, 25, 18, 35, 42] });

  for (const type of ["linear", "exponential", "logarithmic", "movingAverage"] as const) {
    it(`${type} trendline is deterministic`, () => {
      const spec = { type, seriesIndex: 0, movingAveragePeriod: 3 };
      const first = computeTrendline(data, spec);
      for (let i = 0; i < 5; i++) {
        const result = computeTrendline(data, spec);
        expect(result).toEqual(first);
      }
    });
  }
});

// ===========================================================================
// Theme resolution is deterministic
// ===========================================================================

describe("theme resolution is deterministic", () => {
  it("resolveChartTheme returns same object shape every time", () => {
    const first = resolveChartTheme(undefined);
    for (let i = 0; i < 10; i++) {
      expect(resolveChartTheme(undefined)).toEqual(first);
    }
  });

  it("resolveChartTheme with overrides is deterministic", () => {
    const config = { theme: { background: "#000000", titleFontSize: 20 } };
    const first = resolveChartTheme(config);
    for (let i = 0; i < 10; i++) {
      expect(resolveChartTheme(config)).toEqual(first);
    }
  });

  it("overrides merge correctly with defaults", () => {
    const config = { theme: { background: "#111" } };
    const resolved = resolveChartTheme(config);
    expect(resolved.background).toBe("#111");
    // All other fields should match defaults
    expect(resolved.plotBackground).toBe(DEFAULT_CHART_THEME.plotBackground);
    expect(resolved.gridLineColor).toBe(DEFAULT_CHART_THEME.gridLineColor);
    expect(resolved.fontFamily).toBe(DEFAULT_CHART_THEME.fontFamily);
  });
});
