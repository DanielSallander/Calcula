//! FILENAME: app/extensions/Charts/lib/__tests__/chart-format-stability.test.ts
// PURPOSE: Verify backward-compatible behavior for chart data formats and APIs.

import { describe, it, expect } from "vitest";
import type {
  ChartSpec,
  ChartType,
  ChartSeries,
  AxisSpec,
  LegendSpec,
  TransformSpec,
  TrendlineType,
  DataLabelPosition,
  DataLabelContent,
  StackMode,
  LineInterpolation,
  PointShape,
  ScaleType,
  GradientDirection,
  SeriesOrientation,
  TickMarkType,
  AxisLabelPosition,
  DisplayUnit,
  AxisCrossesAt,
  StockStyle,
  WaterfallBarType,
  ComboSeriesMark,
  AggregateOp,
  WindowOp,
} from "../../types";
import { isCartesianChart } from "../../types";
import { PALETTES, PALETTE_NAMES, DEFAULT_CHART_THEME } from "../../rendering/chartTheme";

// ============================================================================
// Helper: minimal valid ChartSpec
// ============================================================================

function minimalAxis(): AxisSpec {
  return {
    title: null,
    gridLines: true,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
  };
}

function minimalSpec(): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: minimalAxis(),
    yAxis: minimalAxis(),
    legend: { visible: true, position: "bottom" },
    palette: "default",
  };
}

// ============================================================================
// ChartSpec Construction
// ============================================================================

describe("ChartSpec format stability", () => {
  it("can be constructed with only required fields", () => {
    const spec = minimalSpec();
    expect(spec.mark).toBe("bar");
    expect(spec.series).toHaveLength(1);
    // Optional fields should be undefined
    expect(spec.markOptions).toBeUndefined();
    expect(spec.layers).toBeUndefined();
    expect(spec.transform).toBeUndefined();
    expect(spec.config).toBeUndefined();
    expect(spec.tooltip).toBeUndefined();
    expect(spec.trendlines).toBeUndefined();
    expect(spec.dataLabels).toBeUndefined();
    expect(spec.dataTable).toBeUndefined();
    expect(spec.seriesRefs).toBeUndefined();
    expect(spec.filters).toBeUndefined();
    expect(spec.dataPointOverrides).toBeUndefined();
  });

  it("adding new optional fields does not break existing specs", () => {
    const spec = minimalSpec();
    // Extend with optional fields
    const extended: ChartSpec = {
      ...spec,
      tooltip: { enabled: true },
      trendlines: [{ type: "linear" }],
      dataLabels: { enabled: true },
      dataTable: { enabled: false },
      filters: { hiddenSeries: [], hiddenCategories: [] },
      dataPointOverrides: [],
    };
    // Original required fields are preserved
    expect(extended.mark).toBe("bar");
    expect(extended.series[0].name).toBe("Sales");
    expect(extended.hasHeaders).toBe(true);
  });

  it("default values for optional ChartSpec fields are stable", () => {
    // These are the documented defaults that consumers rely on
    expect(minimalSpec().palette).toBe("default");
    expect(minimalSpec().seriesOrientation).toBe("columns");
    expect(minimalSpec().categoryIndex).toBe(0);
    expect(minimalSpec().title).toBeNull();
    expect(minimalSpec().xAxis.gridLines).toBe(true);
    expect(minimalSpec().yAxis.min).toBeNull();
    expect(minimalSpec().legend.visible).toBe(true);
    expect(minimalSpec().legend.position).toBe("bottom");
  });
});

// ============================================================================
// Chart Type Strings
// ============================================================================

describe("ChartType string stability", () => {
  it("all chart type strings are stable (snapshot)", () => {
    const allChartTypes: ChartType[] = [
      "bar", "horizontalBar", "line", "area", "scatter",
      "pie", "donut", "waterfall", "combo", "radar",
      "bubble", "histogram", "funnel", "treemap", "stock",
      "boxPlot", "sunburst", "pareto",
    ];
    expect(allChartTypes).toMatchInlineSnapshot(`
      [
        "bar",
        "horizontalBar",
        "line",
        "area",
        "scatter",
        "pie",
        "donut",
        "waterfall",
        "combo",
        "radar",
        "bubble",
        "histogram",
        "funnel",
        "treemap",
        "stock",
        "boxPlot",
        "sunburst",
        "pareto",
      ]
    `);
  });

  it("isCartesianChart correctly categorizes all types", () => {
    const cartesian: ChartType[] = [
      "bar", "horizontalBar", "line", "area", "scatter",
      "waterfall", "combo", "bubble", "histogram", "stock",
      "boxPlot", "pareto",
    ];
    const radial: ChartType[] = ["pie", "donut", "radar", "funnel", "treemap", "sunburst"];

    for (const t of cartesian) {
      expect(isCartesianChart(t)).toBe(true);
    }
    for (const t of radial) {
      expect(isCartesianChart(t)).toBe(false);
    }
  });
});

// ============================================================================
// Transform Type Strings
// ============================================================================

describe("Transform type string stability", () => {
  it("all transform type strings are stable", () => {
    const transformTypes: TransformSpec["type"][] = [
      "filter", "sort", "aggregate", "calculate", "window", "bin",
    ];
    expect(transformTypes).toMatchInlineSnapshot(`
      [
        "filter",
        "sort",
        "aggregate",
        "calculate",
        "window",
        "bin",
      ]
    `);
  });

  it("aggregate operation strings are stable", () => {
    const ops: AggregateOp[] = ["sum", "mean", "median", "min", "max", "count"];
    expect(ops).toMatchInlineSnapshot(`
      [
        "sum",
        "mean",
        "median",
        "min",
        "max",
        "count",
      ]
    `);
  });

  it("window operation strings are stable", () => {
    const ops: WindowOp[] = ["running_sum", "running_mean", "rank"];
    expect(ops).toMatchInlineSnapshot(`
      [
        "running_sum",
        "running_mean",
        "rank",
      ]
    `);
  });
});

// ============================================================================
// Palette Color Values
// ============================================================================

describe("Palette color values stability", () => {
  it("default palette colors are stable (snapshot)", () => {
    expect(PALETTES.default).toMatchInlineSnapshot(`
      [
        "#4E79A7",
        "#F28E2B",
        "#E15759",
        "#76B7B2",
        "#59A14F",
        "#EDC948",
        "#B07AA1",
        "#FF9DA7",
      ]
    `);
  });

  it("vivid palette colors are stable (snapshot)", () => {
    expect(PALETTES.vivid).toMatchInlineSnapshot(`
      [
        "#E64B35",
        "#4DBBD5",
        "#00A087",
        "#3C5488",
        "#F39B7F",
        "#8491B4",
        "#91D1C2",
        "#DC0000",
      ]
    `);
  });

  it("palette names are stable", () => {
    expect(PALETTE_NAMES).toMatchInlineSnapshot(`
      [
        "default",
        "vivid",
        "pastel",
        "ocean",
      ]
    `);
  });

  it("DEFAULT_CHART_THEME values are stable", () => {
    expect(DEFAULT_CHART_THEME.background).toBe("#ffffff");
    expect(DEFAULT_CHART_THEME.plotBackground).toBe("#fafafa");
    expect(DEFAULT_CHART_THEME.gridLineColor).toBe("#e8e8e8");
    expect(DEFAULT_CHART_THEME.gridLineWidth).toBe(1);
    expect(DEFAULT_CHART_THEME.fontFamily).toBe("'Segoe UI', system-ui, -apple-system, sans-serif");
    expect(DEFAULT_CHART_THEME.titleFontSize).toBe(14);
    expect(DEFAULT_CHART_THEME.labelFontSize).toBe(10);
    expect(DEFAULT_CHART_THEME.barBorderRadius).toBe(2);
    expect(DEFAULT_CHART_THEME.barGap).toBe(2);
  });
});

// ============================================================================
// Enum-like String Union Stability
// ============================================================================

describe("String union type stability", () => {
  it("TrendlineType strings are stable", () => {
    const types: TrendlineType[] = [
      "linear", "exponential", "polynomial", "power", "logarithmic", "movingAverage",
    ];
    expect(types).toMatchInlineSnapshot(`
      [
        "linear",
        "exponential",
        "polynomial",
        "power",
        "logarithmic",
        "movingAverage",
      ]
    `);
  });

  it("StackMode strings are stable", () => {
    const modes: StackMode[] = ["none", "stacked", "percentStacked"];
    expect(modes).toMatchInlineSnapshot(`
      [
        "none",
        "stacked",
        "percentStacked",
      ]
    `);
  });

  it("GradientDirection strings are stable", () => {
    const dirs: GradientDirection[] = [
      "topToBottom", "bottomToTop", "leftToRight", "rightToLeft",
      "topLeftToBottomRight", "bottomRightToTopLeft",
      "topRightToBottomLeft", "bottomLeftToTopRight",
    ];
    expect(dirs).toMatchInlineSnapshot(`
      [
        "topToBottom",
        "bottomToTop",
        "leftToRight",
        "rightToLeft",
        "topLeftToBottomRight",
        "bottomRightToTopLeft",
        "topRightToBottomLeft",
        "bottomLeftToTopRight",
      ]
    `);
  });
});
