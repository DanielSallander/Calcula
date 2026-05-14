//! FILENAME: app/extensions/Charts/lib/__tests__/lineChartFeatures.test.ts
// PURPOSE: Tests for drop lines, high-low lines, up/down bars, and series overlap types.

import { describe, it, expect } from "vitest";
import type { LineMarkOptions, BarMarkOptions, AreaMarkOptions } from "../../types";

// ============================================================================
// LineMarkOptions — New Features
// ============================================================================

describe("LineMarkOptions extended features", () => {
  it("supports drop lines configuration", () => {
    const opts: LineMarkOptions = {
      showDropLines: true,
      dropLineColor: "#999999",
      dropLineDash: [5, 3],
    };
    expect(opts.showDropLines).toBe(true);
    expect(opts.dropLineColor).toBe("#999999");
    expect(opts.dropLineDash).toEqual([5, 3]);
  });

  it("supports high-low lines configuration", () => {
    const opts: LineMarkOptions = {
      showHighLowLines: true,
      highLowLineColor: "#333333",
    };
    expect(opts.showHighLowLines).toBe(true);
    expect(opts.highLowLineColor).toBe("#333333");
  });

  it("supports up/down bars configuration", () => {
    const opts: LineMarkOptions = {
      showUpDownBars: true,
      upBarColor: "#00FF00",
      downBarColor: "#FF0000",
      upDownBarWidth: 12,
    };
    expect(opts.showUpDownBars).toBe(true);
    expect(opts.upBarColor).toBe("#00FF00");
    expect(opts.downBarColor).toBe("#FF0000");
    expect(opts.upDownBarWidth).toBe(12);
  });

  it("all new properties are optional (backward compatible)", () => {
    const opts: LineMarkOptions = {};
    expect(opts.showDropLines).toBeUndefined();
    expect(opts.showHighLowLines).toBeUndefined();
    expect(opts.showUpDownBars).toBeUndefined();
  });

  it("JSON roundtrip preserves all new fields", () => {
    const opts: LineMarkOptions = {
      interpolation: "smooth",
      lineWidth: 3,
      showMarkers: true,
      markerRadius: 5,
      showDropLines: true,
      dropLineColor: "#AABBCC",
      dropLineDash: [4, 2],
      showHighLowLines: true,
      highLowLineColor: "#112233",
      showUpDownBars: true,
      upBarColor: "#22CC22",
      downBarColor: "#CC2222",
      upDownBarWidth: 10,
    };

    const parsed: LineMarkOptions = JSON.parse(JSON.stringify(opts));
    expect(parsed.showDropLines).toBe(true);
    expect(parsed.dropLineColor).toBe("#AABBCC");
    expect(parsed.dropLineDash).toEqual([4, 2]);
    expect(parsed.showHighLowLines).toBe(true);
    expect(parsed.highLowLineColor).toBe("#112233");
    expect(parsed.showUpDownBars).toBe(true);
    expect(parsed.upBarColor).toBe("#22CC22");
    expect(parsed.downBarColor).toBe("#CC2222");
    expect(parsed.upDownBarWidth).toBe(10);
  });
});

// ============================================================================
// BarMarkOptions — Series Overlap & Gap Width
// ============================================================================

describe("BarMarkOptions series overlap and gap width", () => {
  it("supports seriesOverlap configuration", () => {
    const opts: BarMarkOptions = {
      seriesOverlap: 50, // 50% overlap
    };
    expect(opts.seriesOverlap).toBe(50);
  });

  it("supports negative overlap (extra gap)", () => {
    const opts: BarMarkOptions = {
      seriesOverlap: -50,
    };
    expect(opts.seriesOverlap).toBe(-50);
  });

  it("supports gapWidth configuration", () => {
    const opts: BarMarkOptions = {
      gapWidth: 200,
    };
    expect(opts.gapWidth).toBe(200);
  });

  it("all new properties are optional", () => {
    const opts: BarMarkOptions = {};
    expect(opts.seriesOverlap).toBeUndefined();
    expect(opts.gapWidth).toBeUndefined();
  });

  it("JSON roundtrip preserves fields", () => {
    const opts: BarMarkOptions = {
      borderRadius: 4,
      seriesOverlap: 25,
      gapWidth: 180,
    };

    const parsed: BarMarkOptions = JSON.parse(JSON.stringify(opts));
    expect(parsed.seriesOverlap).toBe(25);
    expect(parsed.gapWidth).toBe(180);
  });
});

// ============================================================================
// AreaMarkOptions — Drop Lines
// ============================================================================

describe("AreaMarkOptions drop lines", () => {
  it("supports drop lines configuration", () => {
    const opts: AreaMarkOptions = {
      showDropLines: true,
      dropLineColor: "#888888",
    };
    expect(opts.showDropLines).toBe(true);
    expect(opts.dropLineColor).toBe("#888888");
  });

  it("drop line properties are optional", () => {
    const opts: AreaMarkOptions = {};
    expect(opts.showDropLines).toBeUndefined();
    expect(opts.dropLineColor).toBeUndefined();
  });
});

// ============================================================================
// Chart Delete Undo (type compatibility)
// ============================================================================

describe("chart delete undo types", () => {
  it("ChartDefinition can be stored and restored", () => {
    // Simulate a chart definition that would be put in the trash
    const chart = {
      chartId: 42,
      name: "Chart 1",
      sheetIndex: 0,
      x: 100,
      y: 200,
      width: 400,
      height: 300,
      spec: {
        mark: "bar" as const,
        data: { startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
        hasHeaders: true,
        seriesOrientation: "columns" as const,
        categoryIndex: 0,
        series: [{ name: "Revenue", sourceIndex: 1, color: null }],
        title: "Sales",
        xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
        yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
        legend: { visible: true, position: "bottom" as const },
        palette: "default",
      },
    };

    // Deep copy simulates trash storage
    const copy = JSON.parse(JSON.stringify(chart));
    expect(copy.chartId).toBe(42);
    expect(copy.spec.title).toBe("Sales");
    expect(copy.spec.mark).toBe("bar");
  });
});
