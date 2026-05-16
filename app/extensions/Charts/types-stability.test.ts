//! FILENAME: app/extensions/Charts/types-stability.test.ts
// PURPOSE: Verify Charts type surface stability — catch accidental breaking changes.

import { describe, it, expect } from "vitest";
import type {
  ChartSpec,
  ChartType,
  ParsedChartData,
  ChartDefinition,
  ChartHitResult,
  ChartLayout,
  AxisSpec,
  LegendSpec,
  DataLabelSpec,
  TrendlineSpec,
  ChartFilters,
  DataPointOverride,
  DataTableOptions,
} from "./types";
import { isCartesianChart, isDataRangeRef, isPivotDataSource } from "./types";

// ============================================================================
// ChartSpec interface fields
// ============================================================================

describe("ChartSpec interface stability", () => {
  it("has all expected top-level fields", () => {
    // Construct a minimal valid ChartSpec to verify the shape compiles
    const spec: ChartSpec = {
      mark: "bar",
      data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 10, endCol: 3 },
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Sales", sourceIndex: 1, color: null }],
      title: "Test Chart",
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
      yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
      legend: { visible: true, position: "bottom" },
      palette: "default",
    };

    expect(spec.mark).toBe("bar");
    expect(spec.hasHeaders).toBe(true);
    expect(spec.seriesOrientation).toBe("columns");
    expect(spec.categoryIndex).toBe(0);
    expect(spec.series).toHaveLength(1);
    expect(spec.title).toBe("Test Chart");
    expect(spec.palette).toBe("default");
  });

  it("accepts all optional fields", () => {
    const spec: ChartSpec = {
      mark: "line",
      data: "Sheet1!A1:D10",
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [],
      title: null,
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
      yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
      legend: { visible: true, position: "bottom" },
      palette: "default",
      markOptions: { interpolation: "smooth" },
      layers: [],
      transform: [],
      config: { theme: { background: "#fff" } },
      tooltip: { enabled: true },
      trendlines: [],
      dataLabels: { enabled: false },
      dataTable: { enabled: false },
      seriesRefs: [],
      filters: { hiddenSeries: [], hiddenCategories: [] },
      dataPointOverrides: [],
    };

    expect(spec.markOptions).toBeDefined();
    expect(spec.layers).toBeDefined();
    expect(spec.transform).toBeDefined();
    expect(spec.config).toBeDefined();
    expect(spec.tooltip).toBeDefined();
    expect(spec.trendlines).toBeDefined();
    expect(spec.dataLabels).toBeDefined();
    expect(spec.dataTable).toBeDefined();
    expect(spec.seriesRefs).toBeDefined();
    expect(spec.filters).toBeDefined();
    expect(spec.dataPointOverrides).toBeDefined();
  });
});

// ============================================================================
// Chart type strings
// ============================================================================

describe("ChartType recognized values", () => {
  it("all expected chart types are valid ChartType values", () => {
    const allTypes: ChartType[] = [
      "bar", "horizontalBar", "line", "area", "scatter",
      "pie", "donut", "waterfall", "combo", "radar",
      "bubble", "histogram", "funnel", "treemap",
      "stock", "boxPlot", "sunburst", "pareto",
    ];

    expect(allTypes).toHaveLength(18);
    // Verify the type guard works for cartesian vs radial
    for (const t of allTypes) {
      expect(typeof isCartesianChart(t)).toBe("boolean");
    }
  });

  it("isCartesianChart returns true for cartesian types", () => {
    const cartesian: ChartType[] = ["bar", "horizontalBar", "line", "area", "scatter", "waterfall", "combo", "bubble", "histogram", "stock", "boxPlot", "pareto"];
    for (const t of cartesian) {
      expect(isCartesianChart(t)).toBe(true);
    }
  });

  it("isCartesianChart returns false for non-cartesian types", () => {
    const nonCartesian: ChartType[] = ["pie", "donut", "radar", "funnel", "treemap", "sunburst"];
    for (const t of nonCartesian) {
      expect(isCartesianChart(t)).toBe(false);
    }
  });
});

// ============================================================================
// ParsedChartData structure
// ============================================================================

describe("ParsedChartData structure contract", () => {
  it("has categories and series arrays", () => {
    const data: ParsedChartData = {
      categories: ["Q1", "Q2", "Q3"],
      series: [
        { name: "Revenue", values: [100, 200, 300], color: "#FF0000" },
        { name: "Costs", values: [80, 150, 250], color: null },
      ],
    };

    expect(data.categories).toHaveLength(3);
    expect(data.series).toHaveLength(2);
    expect(data.series[0].name).toBe("Revenue");
    expect(data.series[0].values).toEqual([100, 200, 300]);
    expect(data.series[0].color).toBe("#FF0000");
    expect(data.series[1].color).toBeNull();
  });
});

// ============================================================================
// ChartDefinition structure
// ============================================================================

describe("ChartDefinition structure contract", () => {
  it("has all placement fields", () => {
    const def: ChartDefinition = {
      chartId: 1,
      name: "Chart 1",
      sheetIndex: 0,
      x: 100,
      y: 200,
      width: 400,
      height: 300,
      spec: {
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
        palette: "default",
      },
    };

    expect(def.chartId).toBe(1);
    expect(def.name).toBe("Chart 1");
    expect(def.sheetIndex).toBe(0);
    expect(typeof def.x).toBe("number");
    expect(typeof def.y).toBe("number");
    expect(typeof def.width).toBe("number");
    expect(typeof def.height).toBe("number");
    expect(def.spec).toBeDefined();
  });
});

// ============================================================================
// Type guard functions
// ============================================================================

describe("DataSource type guards", () => {
  it("isDataRangeRef identifies DataRangeRef objects", () => {
    expect(isDataRangeRef({ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 5 })).toBe(true);
    expect(isDataRangeRef("Sheet1!A1:B5")).toBe(false);
  });

  it("isPivotDataSource identifies PivotDataSource objects", () => {
    expect(isPivotDataSource({ type: "pivot", pivotId: 1 })).toBe(true);
    expect(isPivotDataSource({ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 5 })).toBe(false);
    expect(isPivotDataSource("Sheet1!A1:B5")).toBe(false);
  });
});

// ============================================================================
// ChartHitResult type values
// ============================================================================

describe("ChartHitResult type values", () => {
  it("accepts all expected hit types", () => {
    const hitTypes: ChartHitResult["type"][] = [
      "bar", "point", "slice", "plotArea", "title", "legend", "axis", "filterButton", "none",
    ];
    expect(hitTypes).toHaveLength(9);
  });
});
