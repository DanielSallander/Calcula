//! FILENAME: app/extensions/Charts/rendering/__tests__/axisFormatting.test.ts
// PURPOSE: Tests for axis hit-testing, selection, and formatting rendering.

import { describe, it, expect } from "vitest";
import { hitTestGeometry } from "../chartHitTesting";
import type { ChartLayout, HitGeometry, ChartHitResult, AxisSpec } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeLayout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 30, right: 16, bottom: 50, left: 60 },
    plotArea: { x: 60, y: 30, width: 524, height: 320 },
  };
}

function makeEmptyGeometry(): HitGeometry {
  return { type: "bars", rects: [] };
}

// ============================================================================
// Axis Hit Testing
// ============================================================================

describe("axis hit testing", () => {
  const layout = makeLayout();
  const geometry = makeEmptyGeometry();

  it("detects X axis region (below plot area)", () => {
    // X axis: below plotArea, within horizontal bounds
    const result = hitTestGeometry(300, 360, geometry, layout);
    expect(result.type).toBe("axis");
    expect(result.axisType).toBe("x");
  });

  it("detects Y axis region (left of plot area)", () => {
    // Y axis: left of plotArea, within vertical bounds
    const result = hitTestGeometry(30, 200, geometry, layout);
    expect(result.type).toBe("axis");
    expect(result.axisType).toBe("y");
  });

  it("returns plotArea for points inside plot area", () => {
    const result = hitTestGeometry(300, 200, geometry, layout);
    expect(result.type).toBe("plotArea");
  });

  it("returns none for points outside all regions", () => {
    // Top-right corner (above plot, right of y-axis)
    const result = hitTestGeometry(500, 10, geometry, layout);
    expect(result.type).toBe("none");
  });

  it("X axis at left edge of plot area", () => {
    const result = hitTestGeometry(60, 355, geometry, layout);
    expect(result.type).toBe("axis");
    expect(result.axisType).toBe("x");
  });

  it("X axis at right edge of plot area", () => {
    const result = hitTestGeometry(580, 355, geometry, layout);
    expect(result.type).toBe("axis");
    expect(result.axisType).toBe("x");
  });

  it("Y axis at top of plot area", () => {
    const result = hitTestGeometry(30, 30, geometry, layout);
    expect(result.type).toBe("axis");
    expect(result.axisType).toBe("y");
  });

  it("Y axis at bottom of plot area", () => {
    const result = hitTestGeometry(30, 350, geometry, layout);
    expect(result.type).toBe("axis");
    expect(result.axisType).toBe("y");
  });

  it("does not detect axis when clicking on data elements", () => {
    const geoWithBars: HitGeometry = {
      type: "bars",
      rects: [{
        x: 100, y: 100, width: 40, height: 200,
        seriesIndex: 0, categoryIndex: 0,
        value: 50, seriesName: "A", categoryName: "Q1",
      }],
    };
    const result = hitTestGeometry(120, 200, geoWithBars, layout);
    expect(result.type).toBe("bar");
  });
});

// ============================================================================
// AxisSpec type validation
// ============================================================================

describe("AxisSpec extended properties", () => {
  it("supports all new properties", () => {
    const axis: AxisSpec = {
      title: "Revenue",
      gridLines: true,
      showLabels: true,
      labelAngle: 45,
      min: 0,
      max: 1000,
      majorUnit: 200,
      minorUnit: 50,
      displayUnit: "thousands",
      showDisplayUnitLabel: true,
      majorTickMark: "outside",
      minorTickMark: "inside",
      labelPosition: "nextToAxis",
      crossesAt: "value",
      crossesAtValue: 0,
      lineColor: "#333333",
      lineWidth: 2,
      lineDash: [4, 2],
      showLine: true,
      tickFormat: "$,.0f",
      scale: { type: "linear", reverse: false },
    };

    expect(axis.majorUnit).toBe(200);
    expect(axis.displayUnit).toBe("thousands");
    expect(axis.majorTickMark).toBe("outside");
    expect(axis.lineColor).toBe("#333333");
    expect(axis.crossesAt).toBe("value");
  });

  it("all new properties are optional (backward compatible)", () => {
    const minimalAxis: AxisSpec = {
      title: null,
      gridLines: false,
      showLabels: true,
      labelAngle: 0,
      min: null,
      max: null,
    };

    expect(minimalAxis.majorUnit).toBeUndefined();
    expect(minimalAxis.displayUnit).toBeUndefined();
    expect(minimalAxis.majorTickMark).toBeUndefined();
    expect(minimalAxis.lineColor).toBeUndefined();
    expect(minimalAxis.showLine).toBeUndefined();
  });

  it("JSON serialization roundtrip preserves all fields", () => {
    const axis: AxisSpec = {
      title: "Cost",
      gridLines: true,
      showLabels: true,
      labelAngle: 30,
      min: -100,
      max: 500,
      majorUnit: 100,
      minorUnit: 25,
      displayUnit: "millions",
      showDisplayUnitLabel: true,
      majorTickMark: "cross",
      minorTickMark: "outside",
      labelPosition: "high",
      crossesAt: "max",
      lineColor: "#FF0000",
      lineWidth: 3,
      lineDash: [6, 3],
      showLine: false,
      tickFormat: ".2f",
      scale: { type: "log", reverse: true },
    };

    const json = JSON.stringify(axis);
    const parsed: AxisSpec = JSON.parse(json);

    expect(parsed.majorUnit).toBe(100);
    expect(parsed.minorUnit).toBe(25);
    expect(parsed.displayUnit).toBe("millions");
    expect(parsed.showDisplayUnitLabel).toBe(true);
    expect(parsed.majorTickMark).toBe("cross");
    expect(parsed.minorTickMark).toBe("outside");
    expect(parsed.labelPosition).toBe("high");
    expect(parsed.crossesAt).toBe("max");
    expect(parsed.lineColor).toBe("#FF0000");
    expect(parsed.lineWidth).toBe(3);
    expect(parsed.lineDash).toEqual([6, 3]);
    expect(parsed.showLine).toBe(false);
    expect(parsed.tickFormat).toBe(".2f");
    expect(parsed.scale?.type).toBe("log");
    expect(parsed.scale?.reverse).toBe(true);
    expect(parsed.labelAngle).toBe(30);
  });
});

// ============================================================================
// Display Unit Factor
// ============================================================================

describe("display unit factors", () => {
  // Test indirectly by checking the type allows all expected values
  it("DisplayUnit type accepts all Excel-compatible units", () => {
    const units: import("../../types").DisplayUnit[] = [
      "none", "hundreds", "thousands", "tenThousands",
      "hundredThousands", "millions", "tenMillions",
      "hundredMillions", "billions", "trillions",
    ];
    expect(units).toHaveLength(10);
  });

  it("TickMarkType accepts all standard types", () => {
    const types: import("../../types").TickMarkType[] = [
      "none", "inside", "outside", "cross",
    ];
    expect(types).toHaveLength(4);
  });

  it("AxisLabelPosition accepts all positions", () => {
    const positions: import("../../types").AxisLabelPosition[] = [
      "nextToAxis", "high", "low", "none",
    ];
    expect(positions).toHaveLength(4);
  });

  it("AxisCrossesAt accepts all options", () => {
    const options: import("../../types").AxisCrossesAt[] = [
      "auto", "min", "max", "value",
    ];
    expect(options).toHaveLength(4);
  });
});

// ============================================================================
// ChartSubSelection with axis
// ============================================================================

describe("ChartSubSelection axis support", () => {
  it("supports axis selection level", () => {
    const sel: import("../../types").ChartSubSelection = {
      level: "axis",
      axisType: "x",
    };
    expect(sel.level).toBe("axis");
    expect(sel.axisType).toBe("x");
  });

  it("supports both x and y axis types", () => {
    const xSel: import("../../types").ChartSubSelection = { level: "axis", axisType: "x" };
    const ySel: import("../../types").ChartSubSelection = { level: "axis", axisType: "y" };
    expect(xSel.axisType).toBe("x");
    expect(ySel.axisType).toBe("y");
  });
});
