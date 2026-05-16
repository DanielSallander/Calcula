//! FILENAME: app/extensions/Charts/lib/__tests__/chart-serialization.test.ts
// PURPOSE: Round-trip serialization tests for chart specifications.

import { describe, it, expect } from "vitest";
import type {
  ChartSpec,
  ChartDefinition,
  ThemeOverrides,
  TransformSpec,
  DataPointOverride,
  TrendlineSpec,
  DataLabelSpec,
  ChartFilters,
  LayerSpec,
  GradientFill,
} from "../../types";

/** JSON round-trip helper */
function roundTrip<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ============================================================================
// Helpers
// ============================================================================

function makeMinimalSpec(): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 10, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
  };
}

function makeFullSpec(): ChartSpec {
  return {
    mark: "combo",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 50, endCol: 5 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: "#4472C4", encoding: { color: "#4472C4", opacity: 0.8 } },
      { name: "Cost", sourceIndex: 2, color: "#ED7D31" },
      { name: "Profit", sourceIndex: 3, color: null },
    ],
    title: "Financial Overview",
    xAxis: {
      title: "Quarter", gridLines: false, showLabels: true, labelAngle: -45,
      min: null, max: null, majorUnit: 1, minorUnit: null,
      majorTickMark: "outside", minorTickMark: "none",
      labelPosition: "nextToAxis", displayUnit: "none",
      lineColor: "#333333", lineWidth: 1.5, lineDash: [4, 2], showLine: true,
    },
    yAxis: {
      title: "Amount ($)", gridLines: true, showLabels: true, labelAngle: 0,
      min: 0, max: 1000000, tickFormat: "$,.0f",
      scale: { type: "linear", domain: [0, 1000000], zero: true, nice: true },
    },
    legend: { visible: true, position: "right" },
    palette: "professional",
    markOptions: {
      seriesMarks: { 0: "bar", 1: "bar", 2: "line" },
      secondaryYAxis: true,
      secondaryAxisSeries: [2],
    },
    layers: [
      {
        mark: "rule",
        markOptions: { y: 500000, color: "#FF0000", strokeWidth: 2, strokeDash: [6, 3], label: "Target" },
      },
      {
        mark: "text",
        markOptions: { x: 2, y: 750000, text: "Peak", fontSize: 14, color: "#333", anchor: "middle" } as any,
      },
    ],
    transform: [
      { type: "filter", field: "Revenue", predicate: "> 0" },
      { type: "sort", field: "$category", order: "asc" },
      { type: "calculate", expr: "Revenue - Cost", as: "Margin" },
      { type: "window", op: "running_sum", field: "Revenue", as: "CumulativeRevenue" },
    ],
    config: {
      theme: {
        background: "#FFFFFF",
        plotBackground: "#F5F5F5",
        gridLineColor: "#E0E0E0",
        gridLineWidth: 0.5,
        fontFamily: "Segoe UI",
        titleFontSize: 16,
      },
    },
    tooltip: { enabled: true, fields: ["series", "category", "value"], format: { value: "$,.2f" } },
    trendlines: [
      { type: "linear", seriesIndex: 0, color: "#888888", lineWidth: 1.5, strokeDash: [6, 3], showEquation: true, showRSquared: true },
      { type: "movingAverage", seriesIndex: 1, movingAveragePeriod: 4 },
    ],
    dataLabels: {
      enabled: true,
      content: ["value"],
      position: "above",
      fontSize: 10,
      format: "$,.0f",
    },
    dataTable: { enabled: true, showLegendKeys: true, showHorizontalBorder: true },
    filters: { hiddenSeries: [1], hiddenCategories: [] },
    dataPointOverrides: [
      { seriesIndex: 0, categoryIndex: 3, color: "#FF0000", opacity: 1, exploded: 0 },
      {
        seriesIndex: 1, categoryIndex: 0, borderColor: "#000",
        borderWidth: 2,
        gradientFill: { type: "linear", direction: "topToBottom", stops: [{ offset: 0, color: "#FFF" }, { offset: 1, color: "#000" }] },
      },
    ],
    seriesRefs: [
      { nameRef: "Sheet1!$B$1", catRef: "Sheet1!$A$2:$A$10", valRef: "Sheet1!$B$2:$B$10" },
    ],
  };
}

// ============================================================================
// ChartSpec Round-Trip
// ============================================================================

describe("ChartSpec round-trip", () => {
  it("minimal spec survives round-trip", () => {
    const spec = makeMinimalSpec();
    expect(roundTrip(spec)).toEqual(spec);
  });

  it("full spec with all fields survives round-trip", () => {
    const spec = makeFullSpec();
    expect(roundTrip(spec)).toEqual(spec);
  });

  it("empty/minimal chart spec with no optional fields", () => {
    const spec: ChartSpec = {
      mark: "line",
      data: "Sheet1!A1:B10",
      hasHeaders: false,
      seriesOrientation: "rows",
      categoryIndex: 0,
      series: [],
      title: null,
      xAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
      yAxis: { title: null, gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
      legend: { visible: false, position: "top" },
      palette: "default",
    };
    expect(roundTrip(spec)).toEqual(spec);
  });

  it("spec with string data source (A1 notation)", () => {
    const spec = makeMinimalSpec();
    spec.data = "Sheet1!A1:D10";
    expect(roundTrip(spec)).toEqual(spec);
  });

  it("spec with pivot data source", () => {
    const spec = makeMinimalSpec();
    spec.data = { type: "pivot", pivotId: 42, includeSubtotals: true, includeGrandTotal: false };
    expect(roundTrip(spec)).toEqual(spec);
  });
});

// ============================================================================
// Theme Overrides
// ============================================================================

describe("ThemeOverrides round-trip", () => {
  it("full theme overrides survive round-trip", () => {
    const theme: ThemeOverrides = {
      background: "#FAFAFA",
      plotBackground: "#FFFFFF",
      gridLineColor: "#DDD",
      gridLineWidth: 1,
      axisColor: "#333",
      axisLabelColor: "#555",
      axisTitleColor: "#222",
      titleColor: "#000",
      legendTextColor: "#444",
      fontFamily: "Arial",
      titleFontSize: 18,
      axisTitleFontSize: 12,
      labelFontSize: 10,
      legendFontSize: 11,
      barBorderRadius: 4,
      barGap: 3,
    };
    expect(roundTrip(theme)).toEqual(theme);
  });

  it("partial theme overrides survive round-trip", () => {
    const theme: ThemeOverrides = { background: "#000", fontFamily: "Courier" };
    expect(roundTrip(theme)).toEqual(theme);
  });
});

// ============================================================================
// Transform Pipeline
// ============================================================================

describe("transform pipeline round-trip", () => {
  it("all transform types survive round-trip", () => {
    const transforms: TransformSpec[] = [
      { type: "filter", field: "Revenue", predicate: "> 100" },
      { type: "sort", field: "$category", order: "desc" },
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales", as: "TotalSales" },
      { type: "calculate", expr: "Revenue * 1.1", as: "Adjusted" },
      { type: "window", op: "running_sum", field: "Sales", as: "CumSales" },
      { type: "bin", field: "Price", binCount: 20, as: "PriceBin" },
    ];
    expect(roundTrip(transforms)).toEqual(transforms);
  });

  it("transform order is preserved", () => {
    const transforms: TransformSpec[] = [
      { type: "sort", field: "A", order: "asc" },
      { type: "filter", field: "B", predicate: "!= 0" },
      { type: "sort", field: "C", order: "desc" },
    ];
    const result = roundTrip(transforms);
    expect(result[0].type).toBe("sort");
    expect(result[1].type).toBe("filter");
    expect(result[2].type).toBe("sort");
  });
});

// ============================================================================
// DataPointOverride
// ============================================================================

describe("DataPointOverride round-trip", () => {
  it("override with all fields survives round-trip", () => {
    const override: DataPointOverride = {
      seriesIndex: 2,
      categoryIndex: 5,
      color: "#FF0000",
      opacity: 0.5,
      borderColor: "#000000",
      borderWidth: 3,
      exploded: 15,
      gradientFill: {
        type: "radial",
        stops: [{ offset: 0, color: "#FFF" }, { offset: 0.5, color: "#888" }, { offset: 1, color: "#000" }],
      },
    };
    expect(roundTrip(override)).toEqual(override);
  });

  it("override with minimal fields survives round-trip", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0 };
    expect(roundTrip(override)).toEqual(override);
  });
});

// ============================================================================
// GradientFill
// ============================================================================

describe("GradientFill round-trip", () => {
  it("linear gradient with direction survives round-trip", () => {
    const gradient: GradientFill = {
      type: "linear",
      direction: "topLeftToBottomRight",
      stops: [{ offset: 0, color: "#FF0000" }, { offset: 1, color: "#0000FF" }],
    };
    expect(roundTrip(gradient)).toEqual(gradient);
  });

  it("radial gradient survives round-trip", () => {
    const gradient: GradientFill = {
      type: "radial",
      stops: [{ offset: 0, color: "#FFFFFF" }, { offset: 0.5, color: "#888888" }, { offset: 1, color: "#000000" }],
    };
    expect(roundTrip(gradient)).toEqual(gradient);
  });
});

// ============================================================================
// Trendlines
// ============================================================================

describe("trendline round-trip", () => {
  it("polynomial trendline with all options", () => {
    const t: TrendlineSpec = {
      type: "polynomial",
      seriesIndex: 1,
      color: "#123456",
      lineWidth: 3,
      strokeDash: [8, 4],
      polynomialDegree: 3,
      showEquation: true,
      showRSquared: true,
      label: "Trend",
    };
    expect(roundTrip(t)).toEqual(t);
  });
});

// ============================================================================
// ChartDefinition
// ============================================================================

describe("ChartDefinition round-trip", () => {
  it("full definition with placement survives round-trip", () => {
    const def: ChartDefinition = {
      chartId: 42,
      name: "Chart 1",
      sheetIndex: 0,
      x: 150.5,
      y: 200.75,
      width: 600,
      height: 400,
      spec: makeFullSpec(),
    };
    expect(roundTrip(def)).toEqual(def);
  });
});

// ============================================================================
// Conditional Encoding
// ============================================================================

describe("conditional encoding round-trip", () => {
  it("conditional color encoding survives round-trip", () => {
    const spec = makeMinimalSpec();
    spec.series[0].encoding = {
      color: {
        condition: { field: "value", gt: 100 },
        value: "#00FF00",
        otherwise: "#FF0000",
      },
      opacity: {
        condition: { field: "category", oneOf: ["Q1", "Q4"] },
        value: 1,
        otherwise: 0.5,
      },
    };
    expect(roundTrip(spec)).toEqual(spec);
  });
});

// ============================================================================
// Filters
// ============================================================================

describe("ChartFilters round-trip", () => {
  it("filters with hidden series and categories survive round-trip", () => {
    const filters: ChartFilters = {
      hiddenSeries: [0, 2, 5],
      hiddenCategories: [1, 3, 7, 9],
    };
    expect(roundTrip(filters)).toEqual(filters);
  });

  it("empty filters survive round-trip", () => {
    const filters: ChartFilters = { hiddenSeries: [], hiddenCategories: [] };
    expect(roundTrip(filters)).toEqual(filters);
  });
});
