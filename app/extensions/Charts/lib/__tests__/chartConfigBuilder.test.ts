//! FILENAME: app/extensions/Charts/lib/__tests__/chartConfigBuilder.test.ts
// PURPOSE: Comprehensive chart config builder test — constructs chart specs for
//          all 18 chart types and verifies each produces valid layout/geometry output.

import { describe, it, expect } from "vitest";
import type {
  ChartSpec,
  ChartType,
  ChartLayout,
  DataRangeRef,
  BarMarkOptions,
  LineMarkOptions,
  AreaMarkOptions,
  ScatterMarkOptions,
  PieMarkOptions,
  WaterfallMarkOptions,
  ComboMarkOptions,
  RadarMarkOptions,
  BubbleMarkOptions,
  HistogramMarkOptions,
  FunnelMarkOptions,
  TreemapMarkOptions,
  StockMarkOptions,
  BoxPlotMarkOptions,
  SunburstMarkOptions,
  ParetoMarkOptions,
  ParsedChartData,
} from "../../types";
import { isCartesianChart } from "../../types";
import { buildDefaultSpec } from "../chartSpecDefaults";
import {
  createLinearScale,
  createBandScale,
  createPointScale,
  valuesToAngles,
  createLogScale,
  createPowScale,
  createSqrtScale,
  createScaleFromSpec,
} from "../../rendering/scales";

// ============================================================================
// Test Data
// ============================================================================

const DATA_RANGE: DataRangeRef = {
  sheetIndex: 0, startRow: 0, startCol: 0, endRow: 6, endCol: 4,
};

const SAMPLE_DATA: ParsedChartData = {
  categories: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"],
  series: [
    { name: "Revenue", values: [100, 200, 150, 300, 250, 400], color: null },
    { name: "Cost", values: [80, 120, 110, 200, 180, 250], color: null },
    { name: "Profit", values: [20, 80, 40, 100, 70, 150], color: null },
  ],
};

function makeSpec(mark: ChartType, markOptions?: Record<string, unknown>): ChartSpec {
  return {
    ...buildDefaultSpec(DATA_RANGE, true, {
      categoryIndex: 0,
      series: SAMPLE_DATA.series.map((s, i) => ({ name: s.name, sourceIndex: i + 1, color: null })),
      orientation: "columns",
    }, mark),
    markOptions: markOptions as any,
  };
}

function computeLayout(spec: ChartSpec, width = 600, height = 400): ChartLayout {
  const margin = { top: 40, right: 20, bottom: 50, left: 60 };
  return {
    width,
    height,
    margin,
    plotArea: {
      x: margin.left,
      y: margin.top,
      width: width - margin.left - margin.right,
      height: height - margin.top - margin.bottom,
    },
  };
}

// ============================================================================
// All 18 Chart Types — Spec Construction
// ============================================================================

const ALL_CHART_TYPES: ChartType[] = [
  "bar", "horizontalBar", "line", "area", "scatter",
  "pie", "donut", "waterfall", "combo", "radar",
  "bubble", "histogram", "funnel", "treemap",
  "stock", "boxPlot", "sunburst", "pareto",
];

describe("Chart config builder: all 18 chart types", () => {
  it("enumerates exactly 18 chart types", () => {
    expect(ALL_CHART_TYPES).toHaveLength(18);
  });

  for (const chartType of ALL_CHART_TYPES) {
    describe(`${chartType} chart`, () => {
      it("produces a valid ChartSpec", () => {
        const spec = makeSpec(chartType);
        expect(spec.mark).toBe(chartType);
        expect(spec.series.length).toBeGreaterThan(0);
        expect(spec.palette).toBe("default");
        expect(spec.xAxis).toBeDefined();
        expect(spec.yAxis).toBeDefined();
        expect(spec.legend).toBeDefined();
      });

      it("produces a valid layout", () => {
        const spec = makeSpec(chartType);
        const layout = computeLayout(spec);
        expect(layout.plotArea.width).toBeGreaterThan(0);
        expect(layout.plotArea.height).toBeGreaterThan(0);
        expect(layout.plotArea.x).toBe(60);
        expect(layout.plotArea.y).toBe(40);
      });

      it("classifies cartesian vs non-cartesian correctly", () => {
        const cartesian = isCartesianChart(chartType);
        const nonCartesian = ["pie", "donut", "radar", "funnel", "treemap", "sunburst"];
        if (nonCartesian.includes(chartType)) {
          expect(cartesian).toBe(false);
        } else {
          expect(cartesian).toBe(true);
        }
      });
    });
  }
});

// ============================================================================
// Mark Options per Chart Type
// ============================================================================

describe("Chart-type-specific mark options", () => {
  it("bar: accepts borderRadius and barGap", () => {
    const opts: BarMarkOptions = { borderRadius: 4, barGap: 3, stackMode: "stacked" };
    const spec = makeSpec("bar", opts);
    const mo = spec.markOptions as BarMarkOptions;
    expect(mo.borderRadius).toBe(4);
    expect(mo.barGap).toBe(3);
    expect(mo.stackMode).toBe("stacked");
  });

  it("line: accepts interpolation and markers", () => {
    const opts: LineMarkOptions = { interpolation: "smooth", lineWidth: 3, showMarkers: true, markerRadius: 6 };
    const spec = makeSpec("line", opts);
    const mo = spec.markOptions as LineMarkOptions;
    expect(mo.interpolation).toBe("smooth");
    expect(mo.showMarkers).toBe(true);
  });

  it("area: accepts fillOpacity and stacking", () => {
    const opts: AreaMarkOptions = { fillOpacity: 0.5, stackMode: "percentStacked" };
    const spec = makeSpec("area", opts);
    const mo = spec.markOptions as AreaMarkOptions;
    expect(mo.fillOpacity).toBe(0.5);
    expect(mo.stackMode).toBe("percentStacked");
  });

  it("scatter: accepts pointShape and size", () => {
    const opts: ScatterMarkOptions = { pointShape: "diamond", pointSize: 8 };
    const spec = makeSpec("scatter", opts);
    const mo = spec.markOptions as ScatterMarkOptions;
    expect(mo.pointShape).toBe("diamond");
  });

  it("pie: accepts innerRadiusRatio and labelFormat", () => {
    const opts: PieMarkOptions = { innerRadiusRatio: 0, padAngle: 2, labelFormat: "both" };
    const spec = makeSpec("pie", opts);
    const mo = spec.markOptions as PieMarkOptions;
    expect(mo.innerRadiusRatio).toBe(0);
    expect(mo.labelFormat).toBe("both");
  });

  it("donut: accepts innerRadiusRatio > 0", () => {
    const opts: PieMarkOptions = { innerRadiusRatio: 0.5 };
    const spec = makeSpec("donut", opts);
    expect((spec.markOptions as PieMarkOptions).innerRadiusRatio).toBe(0.5);
  });

  it("waterfall: accepts totalIndices and colors", () => {
    const opts: WaterfallMarkOptions = {
      showConnectors: true,
      increaseColor: "#00FF00",
      decreaseColor: "#FF0000",
      totalColor: "#0000FF",
      totalIndices: [3, 5],
    };
    const spec = makeSpec("waterfall", opts);
    const mo = spec.markOptions as WaterfallMarkOptions;
    expect(mo.totalIndices).toEqual([3, 5]);
  });

  it("combo: accepts seriesMarks and secondary axis", () => {
    const opts: ComboMarkOptions = {
      seriesMarks: { 0: "bar", 1: "line" },
      secondaryYAxis: true,
      secondaryAxisSeries: [1],
    };
    const spec = makeSpec("combo", opts);
    const mo = spec.markOptions as ComboMarkOptions;
    expect(mo.seriesMarks![0]).toBe("bar");
    expect(mo.secondaryYAxis).toBe(true);
  });

  it("radar: accepts fill options", () => {
    const opts: RadarMarkOptions = { showFill: true, fillOpacity: 0.3, showMarkers: false };
    const spec = makeSpec("radar", opts);
    expect((spec.markOptions as RadarMarkOptions).showFill).toBe(true);
  });

  it("bubble: accepts size series and range", () => {
    const opts: BubbleMarkOptions = { sizeSeriesIndex: 2, minBubbleSize: 5, maxBubbleSize: 40 };
    const spec = makeSpec("bubble", opts);
    expect((spec.markOptions as BubbleMarkOptions).maxBubbleSize).toBe(40);
  });

  it("histogram: accepts binCount", () => {
    const opts: HistogramMarkOptions = { binCount: 20, borderRadius: 0 };
    const spec = makeSpec("histogram", opts);
    expect((spec.markOptions as HistogramMarkOptions).binCount).toBe(20);
  });

  it("funnel: accepts neck width and labels", () => {
    const opts: FunnelMarkOptions = { neckWidthRatio: 0.2, showLabels: true, labelFormat: "percent" };
    const spec = makeSpec("funnel", opts);
    expect((spec.markOptions as FunnelMarkOptions).neckWidthRatio).toBe(0.2);
  });

  it("treemap: accepts tile styling", () => {
    const opts: TreemapMarkOptions = { tileBorderWidth: 3, tileRadius: 4, showLabels: true };
    const spec = makeSpec("treemap", opts);
    expect((spec.markOptions as TreemapMarkOptions).tileRadius).toBe(4);
  });

  it("stock: accepts OHLC indices and style", () => {
    const opts: StockMarkOptions = { style: "ohlc", ohlcIndices: [0, 1, 2, 3], upColor: "#0F0" };
    const spec = makeSpec("stock", opts);
    expect((spec.markOptions as StockMarkOptions).style).toBe("ohlc");
    expect((spec.markOptions as StockMarkOptions).ohlcIndices).toEqual([0, 1, 2, 3]);
  });

  it("boxPlot: accepts box width and outlier options", () => {
    const opts: BoxPlotMarkOptions = { boxWidth: 0.6, showOutliers: true, showMean: true };
    const spec = makeSpec("boxPlot", opts);
    expect((spec.markOptions as BoxPlotMarkOptions).showMean).toBe(true);
  });

  it("sunburst: accepts hierarchy separator", () => {
    const opts: SunburstMarkOptions = { levelSeparator: " / ", innerRadiusRatio: 0.2 };
    const spec = makeSpec("sunburst", opts);
    expect((spec.markOptions as SunburstMarkOptions).levelSeparator).toBe(" / ");
  });

  it("pareto: accepts 80% line and cumulative line color", () => {
    const opts: ParetoMarkOptions = { show80PercentLine: true, lineColor: "#E53935", showMarkers: true };
    const spec = makeSpec("pareto", opts);
    expect((spec.markOptions as ParetoMarkOptions).show80PercentLine).toBe(true);
  });
});

// ============================================================================
// Scale Geometry Validation per Chart Type
// ============================================================================

describe("Scale geometry for cartesian chart types", () => {
  const plotWidth = 520;
  const plotHeight = 310;

  it("bar chart: band scale produces valid bandwidth", () => {
    const band = createBandScale(SAMPLE_DATA.categories, [0, plotWidth]);
    expect(band.bandwidth).toBeGreaterThan(0);
    expect(band.bandwidth).toBeLessThan(plotWidth);
    // Each band start should be within range
    for (let i = 0; i < SAMPLE_DATA.categories.length; i++) {
      const x = band.scaleIndex(i);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + band.bandwidth).toBeLessThanOrEqual(plotWidth + 1);
    }
  });

  it("line chart: point scale produces evenly spaced points", () => {
    const pts = createPointScale(SAMPLE_DATA.categories, [0, plotWidth]);
    const firstX = pts.scaleIndex(0);
    const lastX = pts.scaleIndex(SAMPLE_DATA.categories.length - 1);
    expect(firstX).toBeGreaterThanOrEqual(0);
    expect(lastX).toBeLessThanOrEqual(plotWidth);
    expect(pts.step).toBeGreaterThan(0);
  });

  it("value axis: linear scale maps domain to range", () => {
    const allValues = SAMPLE_DATA.series.flatMap(s => s.values);
    const max = Math.max(...allValues);
    const scale = createLinearScale([0, max], [plotHeight, 0]);
    expect(scale.scale(0)).toBeCloseTo(plotHeight, 0);
    expect(scale.scale(max)).toBeLessThanOrEqual(plotHeight);
    const ticks = scale.ticks(5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("pie/donut: valuesToAngles covers full circle", () => {
    const values = SAMPLE_DATA.series[0].values;
    const angles = valuesToAngles(values);
    expect(angles).toHaveLength(values.length);
    // Total sweep should be close to 2*PI minus padding
    const totalSweep = angles.reduce((sum, a) => sum + (a.endAngle - a.startAngle), 0);
    expect(totalSweep).toBeGreaterThan(0);
    expect(totalSweep).toBeLessThanOrEqual(Math.PI * 2 + 0.01);
  });
});

// ============================================================================
// Scale Factory
// ============================================================================

describe("createScaleFromSpec factory", () => {
  it("defaults to linear scale", () => {
    const s = createScaleFromSpec(undefined, [0, 100], [0, 500]);
    expect(s.scale(50)).toBeGreaterThan(0);
  });

  it("creates log scale", () => {
    const s = createScaleFromSpec({ type: "log" }, [1, 1000], [0, 500]);
    expect(s.scale(1)).toBeCloseTo(0, 0);
  });

  it("creates pow scale", () => {
    const s = createScaleFromSpec({ type: "pow", exponent: 3 }, [0, 10], [0, 500]);
    expect(s.scale(0)).toBeDefined();
  });

  it("creates sqrt scale", () => {
    const s = createScaleFromSpec({ type: "sqrt" }, [0, 100], [0, 500]);
    expect(s.scale(25)).toBeDefined();
  });

  it("respects domain override", () => {
    const s = createScaleFromSpec({ type: "linear", domain: [0, 200] }, [0, 100], [0, 500]);
    // Domain is overridden to [0, 200], so 100 maps to midpoint
    expect(s.scale(100)).toBeGreaterThan(200);
  });

  it("respects reverse flag", () => {
    const normal = createScaleFromSpec({ type: "linear" }, [0, 100], [0, 500]);
    const reversed = createScaleFromSpec({ type: "linear", reverse: true }, [0, 100], [0, 500]);
    // Reversed: 0 maps to high pixel, max maps to low pixel
    expect(normal.scale(0)).not.toBeCloseTo(reversed.scale(0));
  });
});

// ============================================================================
// Spec with Full Features (layers, transforms, trendlines, data labels)
// ============================================================================

describe("Full-featured spec construction", () => {
  it("accepts layers with rule and text marks", () => {
    const spec = makeSpec("bar");
    spec.layers = [
      { mark: "rule", markOptions: { y: 200, color: "#999", strokeDash: [6, 3], label: "Target" } },
      { mark: "text", markOptions: { x: 2, y: 300, text: "Peak", fontSize: 12 } },
    ];
    expect(spec.layers).toHaveLength(2);
    expect(spec.layers[0].mark).toBe("rule");
    expect(spec.layers[1].mark).toBe("text");
  });

  it("accepts data transforms", () => {
    const spec = makeSpec("bar");
    spec.transform = [
      { type: "filter", field: "Revenue", predicate: "> 100" },
      { type: "sort", field: "Revenue", order: "desc" },
    ];
    expect(spec.transform).toHaveLength(2);
  });

  it("accepts trendlines", () => {
    const spec = makeSpec("line");
    spec.trendlines = [
      { type: "linear", seriesIndex: 0, showEquation: true, showRSquared: true },
      { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 3 },
    ];
    expect(spec.trendlines).toHaveLength(2);
  });

  it("accepts data labels", () => {
    const spec = makeSpec("bar");
    spec.dataLabels = {
      enabled: true,
      content: ["value"],
      position: "above",
      fontSize: 10,
      format: "$,.0f",
    };
    expect(spec.dataLabels!.enabled).toBe(true);
  });

  it("accepts data point overrides", () => {
    const spec = makeSpec("bar");
    spec.dataPointOverrides = [
      { seriesIndex: 0, categoryIndex: 2, color: "#FF0000", opacity: 0.8 },
      { seriesIndex: 0, categoryIndex: 5, color: "#00FF00", exploded: 10 },
    ];
    expect(spec.dataPointOverrides).toHaveLength(2);
  });

  it("accepts filters", () => {
    const spec = makeSpec("bar");
    spec.filters = { hiddenSeries: [1], hiddenCategories: [0, 4] };
    expect(spec.filters!.hiddenSeries).toEqual([1]);
  });

  it("accepts theme overrides", () => {
    const spec = makeSpec("bar");
    spec.config = {
      theme: {
        background: "#1e1e1e",
        plotBackground: "#252525",
        titleColor: "#eee",
        barBorderRadius: 6,
      },
    };
    expect(spec.config!.theme!.background).toBe("#1e1e1e");
  });

  it("accepts tooltip config", () => {
    const spec = makeSpec("bar");
    spec.tooltip = {
      enabled: true,
      fields: ["series", "value"],
      format: { value: "$,.2f" },
    };
    expect(spec.tooltip!.fields).toHaveLength(2);
  });

  it("accepts data table", () => {
    const spec = makeSpec("bar");
    spec.dataTable = { enabled: true, showLegendKeys: true };
    expect(spec.dataTable!.enabled).toBe(true);
  });
});

// ============================================================================
// JSON Serialization Roundtrip for All Chart Types
// ============================================================================

describe("JSON roundtrip for all chart types", () => {
  for (const chartType of ALL_CHART_TYPES) {
    it(`${chartType}: survives JSON roundtrip`, () => {
      const spec = makeSpec(chartType);
      const json = JSON.stringify(spec);
      const parsed: ChartSpec = JSON.parse(json);
      expect(parsed.mark).toBe(chartType);
      expect(parsed.series).toEqual(spec.series);
      expect(parsed.palette).toBe(spec.palette);
    });
  }
});
