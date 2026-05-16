//! FILENAME: app/extensions/Charts/lib/__tests__/chart-determinism.test.ts
// PURPOSE: Verify output determinism for chart computation functions.
//          Each function is called 50 times with identical input; all outputs
//          must be identical.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";
import { applyChartFilters } from "../chartFilters";
import type { ParsedChartData, TransformSpec, ChartFilters, TrendlineSpec, ChartSpec, ChartLayout } from "../../types";
import { resolveChartTheme, DEFAULT_CHART_THEME } from "../../rendering/chartTheme";
import { createLinearScale, createBandScale } from "../../rendering/scales";
import { computeBarRects } from "../../rendering/barChartPainter";
import { computePieSliceArcs } from "../../rendering/pieChartPainter";

// ============================================================================
// Helpers
// ============================================================================

const ITERATIONS = 50;

function makeData(
  categories: string[] = ["Jan", "Feb", "Mar", "Apr", "May"],
  seriesMap: Record<string, number[]> = { Sales: [100, 200, 300, 150, 250], Cost: [80, 120, 180, 90, 150] },
): ParsedChartData {
  return {
    categories,
    series: Object.entries(seriesMap).map(([name, values]) => ({ name, values, color: null })),
  };
}

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    stacking: "none",
    transforms: [],
    encodings: {},
    annotations: [],
    dataPointOverrides: [],
    filters: [],
    gradientFill: null,
    stylePreset: null,
    ...overrides,
  } as ChartSpec;
}

function makeLayout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 40, right: 20, bottom: 40, left: 60 },
    plotArea: { x: 60, y: 40, width: 520, height: 320 },
  };
}

/** Run fn N times and assert all outputs are identical via JSON.stringify. */
function assertDeterministic<T>(fn: () => T, n = ITERATIONS): T {
  const first = fn();
  const firstJson = JSON.stringify(first);
  for (let i = 1; i < n; i++) {
    expect(JSON.stringify(fn())).toBe(firstJson);
  }
  return first;
}

// ===========================================================================
// applyTransforms
// ===========================================================================

describe("determinism: applyTransforms", () => {
  it("sort transform produces same output 50 times", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "sort", field: "Sales", direction: "ascending" },
    ];
    assertDeterministic(() => applyTransforms(data, transforms));
  });

  it("filter transform produces same output 50 times", () => {
    const data = makeData();
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Sales", predicate: "> 100" },
    ];
    assertDeterministic(() => applyTransforms(data, transforms));
  });

  it("multiple chained transforms are deterministic", () => {
    const data = makeData(
      ["D", "B", "A", "C", "E"],
      { Revenue: [500, 100, 300, 200, 400] },
    );
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Revenue", predicate: "> 150" },
      { type: "sort", field: "Revenue", direction: "descending" },
    ];
    assertDeterministic(() => applyTransforms(data, transforms));
  });
});

// ===========================================================================
// computeTrendline
// ===========================================================================

describe("determinism: computeTrendline", () => {
  const data = makeData(["A", "B", "C", "D", "E"], { Values: [10, 25, 18, 35, 42] });

  it("linear trendline is deterministic", () => {
    const spec: TrendlineSpec = { type: "linear", seriesIndex: 0 };
    assertDeterministic(() => computeTrendline(data, spec));
  });

  it("exponential trendline is deterministic", () => {
    const spec: TrendlineSpec = { type: "exponential", seriesIndex: 0 };
    assertDeterministic(() => computeTrendline(data, spec));
  });

  it("polynomial trendline is deterministic", () => {
    const spec: TrendlineSpec = { type: "polynomial", seriesIndex: 0, polynomialDegree: 3 };
    assertDeterministic(() => computeTrendline(data, spec));
  });

  it("logarithmic trendline is deterministic", () => {
    const spec: TrendlineSpec = { type: "logarithmic", seriesIndex: 0 };
    assertDeterministic(() => computeTrendline(data, spec));
  });

  it("moving average trendline is deterministic", () => {
    const spec: TrendlineSpec = { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 2 };
    assertDeterministic(() => computeTrendline(data, spec));
  });
});

// ===========================================================================
// applyChartFilters
// ===========================================================================

describe("determinism: applyChartFilters", () => {
  it("hiding series is deterministic", () => {
    const data = makeData();
    const filters: ChartFilters = { hiddenSeries: [1], hiddenCategories: [] };
    assertDeterministic(() => applyChartFilters(data, filters));
  });

  it("hiding categories is deterministic", () => {
    const data = makeData();
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [0, 2, 4] };
    assertDeterministic(() => applyChartFilters(data, filters));
  });

  it("hiding both series and categories is deterministic", () => {
    const data = makeData();
    const filters: ChartFilters = { hiddenSeries: [0], hiddenCategories: [1, 3] };
    assertDeterministic(() => applyChartFilters(data, filters));
  });
});

// ===========================================================================
// resolveChartTheme
// ===========================================================================

describe("determinism: resolveChartTheme", () => {
  it("default theme (no overrides) is deterministic", () => {
    assertDeterministic(() => resolveChartTheme(undefined));
  });

  it("partial overrides are deterministic", () => {
    const config = { theme: { background: "#000", titleFontSize: 20 } };
    assertDeterministic(() => resolveChartTheme(config));
  });
});

// ===========================================================================
// createLinearScale
// ===========================================================================

describe("determinism: createLinearScale", () => {
  it("standard domain is deterministic", () => {
    assertDeterministic(() => {
      const scale = createLinearScale([0, 100], [0, 500]);
      return {
        domain: scale.domain,
        range: scale.range,
        mapped50: scale.scale(50),
        ticks: scale.ticks(5),
      };
    });
  });

  it("negative domain is deterministic", () => {
    assertDeterministic(() => {
      const scale = createLinearScale([-50, 200], [400, 0]);
      return {
        domain: scale.domain,
        mapped0: scale.scale(0),
        mapped100: scale.scale(100),
        ticks: scale.ticks(8),
      };
    });
  });
});

// ===========================================================================
// createBandScale
// ===========================================================================

describe("determinism: createBandScale", () => {
  it("standard categories are deterministic", () => {
    const categories = ["Jan", "Feb", "Mar", "Apr", "May"];
    assertDeterministic(() => {
      const scale = createBandScale(categories, [0, 500], 0.2);
      return {
        bandwidth: scale.bandwidth,
        positions: categories.map((c) => scale.scale(c)),
        indexPositions: categories.map((_, i) => scale.scaleIndex(i)),
      };
    });
  });

  it("single category is deterministic", () => {
    assertDeterministic(() => {
      const scale = createBandScale(["Only"], [0, 300], 0.1);
      return { bandwidth: scale.bandwidth, pos: scale.scale("Only") };
    });
  });
});

// ===========================================================================
// computeBarRects
// ===========================================================================

describe("determinism: computeBarRects", () => {
  it("grouped bars are deterministic", () => {
    const data = makeData();
    const spec = makeSpec({ mark: "bar", stacking: "none" });
    const layout = makeLayout();
    const theme = DEFAULT_CHART_THEME;
    assertDeterministic(() => computeBarRects(data, spec, layout, theme));
  });

  it("stacked bars are deterministic", () => {
    const data = makeData();
    const spec = makeSpec({ mark: "bar", stacking: "stacked" });
    const layout = makeLayout();
    const theme = DEFAULT_CHART_THEME;
    assertDeterministic(() => computeBarRects(data, spec, layout, theme));
  });
});

// ===========================================================================
// computePieSliceArcs
// ===========================================================================

describe("determinism: computePieSliceArcs", () => {
  it("standard pie is deterministic", () => {
    const data = makeData(["A", "B", "C", "D"], { Slice: [30, 20, 25, 25] });
    const spec = makeSpec({ mark: "pie" });
    const layout = makeLayout();
    const theme = DEFAULT_CHART_THEME;
    assertDeterministic(() => computePieSliceArcs(data, spec, layout, theme));
  });

  it("donut chart is deterministic", () => {
    const data = makeData(["X", "Y", "Z"], { Val: [10, 50, 40] });
    const spec = makeSpec({ mark: "donut" });
    const layout = makeLayout();
    const theme = DEFAULT_CHART_THEME;
    assertDeterministic(() => computePieSliceArcs(data, spec, layout, theme));
  });
});
