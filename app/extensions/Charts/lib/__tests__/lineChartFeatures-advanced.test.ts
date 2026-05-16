//! FILENAME: app/extensions/Charts/lib/__tests__/lineChartFeatures-advanced.test.ts
// PURPOSE: Advanced tests for line chart feature types — interpolation, gaps, markers, styling.

import { describe, it, expect } from "vitest";
import type { LineMarkOptions, AreaMarkOptions, LineInterpolation, PointShape } from "../../types";

// ============================================================================
// Interpolation types
// ============================================================================

describe("LineMarkOptions — interpolation types", () => {
  it("linear interpolation (default)", () => {
    const opts: LineMarkOptions = { interpolation: "linear" };
    expect(opts.interpolation).toBe("linear");
  });

  it("step interpolation", () => {
    const opts: LineMarkOptions = { interpolation: "step" };
    expect(opts.interpolation).toBe("step");
  });

  it("smooth interpolation", () => {
    const opts: LineMarkOptions = { interpolation: "smooth" };
    expect(opts.interpolation).toBe("smooth");
  });

  it("undefined interpolation defaults to undefined (painter applies default)", () => {
    const opts: LineMarkOptions = {};
    expect(opts.interpolation).toBeUndefined();
  });

  it("JSON roundtrip preserves interpolation", () => {
    const types: LineInterpolation[] = ["linear", "step", "smooth"];
    for (const t of types) {
      const parsed: LineMarkOptions = JSON.parse(JSON.stringify({ interpolation: t }));
      expect(parsed.interpolation).toBe(t);
    }
  });
});

// ============================================================================
// Null/gap handling simulation
// ============================================================================

describe("LineMarkOptions — null/gap handling via data patterns", () => {
  /**
   * The chart engine represents gaps as NaN in the values array.
   * These tests verify that typical gap-handling strategies produce
   * the expected data patterns.
   */

  function applyGapStrategy(
    values: (number | null)[],
    strategy: "zero" | "connect" | "skip",
  ): (number | null)[] {
    switch (strategy) {
      case "zero":
        return values.map((v) => (v === null ? 0 : v));
      case "connect":
        // Keep nulls — painter draws line segments skipping nulls
        return values;
      case "skip":
        // Replace nulls with NaN — painter leaves gaps
        return values.map((v) => (v === null ? NaN : v));
    }
  }

  it("zero strategy replaces nulls with 0", () => {
    const data = [10, null, 30, null, 50];
    const result = applyGapStrategy(data, "zero");
    expect(result).toEqual([10, 0, 30, 0, 50]);
  });

  it("connect strategy keeps nulls intact", () => {
    const data = [10, null, 30, null, 50];
    const result = applyGapStrategy(data, "connect");
    expect(result).toEqual([10, null, 30, null, 50]);
  });

  it("skip strategy replaces nulls with NaN", () => {
    const data = [10, null, 30, null, 50];
    const result = applyGapStrategy(data, "skip");
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(10);
    expect(result[1]).toBeNaN();
    expect(result[2]).toBe(30);
    expect(result[3]).toBeNaN();
    expect(result[4]).toBe(50);
  });

  it("all nulls with zero strategy produces all zeros", () => {
    const data = [null, null, null];
    expect(applyGapStrategy(data, "zero")).toEqual([0, 0, 0]);
  });

  it("no nulls — all strategies return same values", () => {
    const data = [1, 2, 3];
    expect(applyGapStrategy(data, "zero")).toEqual([1, 2, 3]);
    expect(applyGapStrategy(data, "connect")).toEqual([1, 2, 3]);
    expect(applyGapStrategy(data, "skip")).toEqual([1, 2, 3]);
  });
});

// ============================================================================
// Marker shapes and sizes
// ============================================================================

describe("LineMarkOptions — marker configuration", () => {
  it("markers enabled with default radius", () => {
    const opts: LineMarkOptions = { showMarkers: true };
    expect(opts.showMarkers).toBe(true);
    expect(opts.markerRadius).toBeUndefined(); // painter uses default 4
  });

  it("markers with custom radius", () => {
    const opts: LineMarkOptions = { showMarkers: true, markerRadius: 8 };
    expect(opts.markerRadius).toBe(8);
  });

  it("markers with zero radius (effectively invisible)", () => {
    const opts: LineMarkOptions = { showMarkers: true, markerRadius: 0 };
    expect(opts.markerRadius).toBe(0);
  });

  it("markers with very large radius", () => {
    const opts: LineMarkOptions = { showMarkers: true, markerRadius: 50 };
    expect(opts.markerRadius).toBe(50);
  });

  it("markers disabled", () => {
    const opts: LineMarkOptions = { showMarkers: false };
    expect(opts.showMarkers).toBe(false);
  });

  it("scatter chart point shapes are valid PointShape values", () => {
    const shapes: PointShape[] = ["circle", "square", "diamond", "triangle"];
    for (const shape of shapes) {
      expect(shape).toBeTruthy();
    }
    expect(shapes).toHaveLength(4);
  });
});

// ============================================================================
// Line width variations
// ============================================================================

describe("LineMarkOptions — line width", () => {
  it("default line width is undefined (painter uses 2)", () => {
    const opts: LineMarkOptions = {};
    expect(opts.lineWidth).toBeUndefined();
  });

  it("thin line (hairline)", () => {
    const opts: LineMarkOptions = { lineWidth: 0.5 };
    expect(opts.lineWidth).toBe(0.5);
  });

  it("standard line width", () => {
    const opts: LineMarkOptions = { lineWidth: 2 };
    expect(opts.lineWidth).toBe(2);
  });

  it("thick line", () => {
    const opts: LineMarkOptions = { lineWidth: 6 };
    expect(opts.lineWidth).toBe(6);
  });

  it("zero width line", () => {
    const opts: LineMarkOptions = { lineWidth: 0 };
    expect(opts.lineWidth).toBe(0);
  });

  it("JSON roundtrip preserves fractional line width", () => {
    const opts: LineMarkOptions = { lineWidth: 1.5 };
    const parsed: LineMarkOptions = JSON.parse(JSON.stringify(opts));
    expect(parsed.lineWidth).toBe(1.5);
  });
});

// ============================================================================
// Dash patterns
// ============================================================================

describe("LineMarkOptions — drop line dash patterns", () => {
  it("solid line (empty or no dash)", () => {
    const opts: LineMarkOptions = { showDropLines: true };
    expect(opts.dropLineDash).toBeUndefined();
  });

  it("basic dash pattern [5, 5]", () => {
    const opts: LineMarkOptions = { showDropLines: true, dropLineDash: [5, 5] };
    expect(opts.dropLineDash).toEqual([5, 5]);
  });

  it("dotted pattern [1, 3]", () => {
    const opts: LineMarkOptions = { showDropLines: true, dropLineDash: [1, 3] };
    expect(opts.dropLineDash).toEqual([1, 3]);
  });

  it("dash-dot pattern [10, 3, 2, 3]", () => {
    const opts: LineMarkOptions = { showDropLines: true, dropLineDash: [10, 3, 2, 3] };
    expect(opts.dropLineDash).toEqual([10, 3, 2, 3]);
  });

  it("empty dash array = solid", () => {
    const opts: LineMarkOptions = { showDropLines: true, dropLineDash: [] };
    expect(opts.dropLineDash).toEqual([]);
  });

  it("JSON roundtrip preserves complex dash pattern", () => {
    const opts: LineMarkOptions = { dropLineDash: [8, 4, 2, 4] };
    const parsed: LineMarkOptions = JSON.parse(JSON.stringify(opts));
    expect(parsed.dropLineDash).toEqual([8, 4, 2, 4]);
  });
});

// ============================================================================
// Area fill under line (AreaMarkOptions)
// ============================================================================

describe("AreaMarkOptions — fill configuration", () => {
  it("default fill opacity is undefined (painter uses 0.3)", () => {
    const opts: AreaMarkOptions = {};
    expect(opts.fillOpacity).toBeUndefined();
  });

  it("zero fill opacity (transparent area, line only)", () => {
    const opts: AreaMarkOptions = { fillOpacity: 0 };
    expect(opts.fillOpacity).toBe(0);
  });

  it("full fill opacity (solid area)", () => {
    const opts: AreaMarkOptions = { fillOpacity: 1.0 };
    expect(opts.fillOpacity).toBe(1.0);
  });

  it("custom fill opacity", () => {
    const opts: AreaMarkOptions = { fillOpacity: 0.15 };
    expect(opts.fillOpacity).toBe(0.15);
  });

  it("gradient fill on area", () => {
    const opts: AreaMarkOptions = {
      fill: {
        type: "linear",
        direction: "topToBottom",
        stops: [
          { offset: 0, color: "#4472C4" },
          { offset: 1, color: "#4472C400" },
        ],
      },
    };
    expect(opts.fill).toBeDefined();
    expect(opts.fill!.stops).toHaveLength(2);
    expect(opts.fill!.direction).toBe("topToBottom");
  });

  it("stacked area mode", () => {
    const opts: AreaMarkOptions = { stackMode: "stacked", fillOpacity: 0.5 };
    expect(opts.stackMode).toBe("stacked");
  });

  it("percent stacked area mode", () => {
    const opts: AreaMarkOptions = { stackMode: "percentStacked" };
    expect(opts.stackMode).toBe("percentStacked");
  });

  it("area with markers and line width", () => {
    const opts: AreaMarkOptions = {
      showMarkers: true,
      markerRadius: 3,
      lineWidth: 1,
      fillOpacity: 0.25,
    };
    expect(opts.showMarkers).toBe(true);
    expect(opts.markerRadius).toBe(3);
    expect(opts.lineWidth).toBe(1);
    expect(opts.fillOpacity).toBe(0.25);
  });

  it("JSON roundtrip preserves full area config", () => {
    const opts: AreaMarkOptions = {
      interpolation: "smooth",
      lineWidth: 2,
      fillOpacity: 0.4,
      showMarkers: true,
      markerRadius: 5,
      stackMode: "stacked",
      showDropLines: true,
      dropLineColor: "#CCCCCC",
    };
    const parsed: AreaMarkOptions = JSON.parse(JSON.stringify(opts));
    expect(parsed).toEqual(opts);
  });
});
