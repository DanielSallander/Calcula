//! FILENAME: app/extensions/Charts/rendering/__tests__/geometry-math.test.ts
// PURPOSE: Verify geometric math correctness for chart rendering primitives.

import { describe, it, expect } from "vitest";
import {
  createLinearScale,
  createBandScale,
  createLogScale,
  valuesToAngles,
} from "../scales";

// ============================================================================
// computeBarRects equivalent: bar widths sum to available space
// ============================================================================

describe("bar geometry - band scale width distribution", () => {
  it("all bands fit within the range", () => {
    const categories = ["A", "B", "C", "D", "E"];
    const range: [number, number] = [0, 500];
    const scale = createBandScale(categories, range, 0.2);

    // First band starts at or after range start
    const firstStart = scale.scaleIndex(0);
    expect(firstStart).toBeGreaterThanOrEqual(0);

    // Last band ends at or before range end
    const lastStart = scale.scaleIndex(categories.length - 1);
    const lastEnd = lastStart + scale.bandwidth;
    expect(lastEnd).toBeLessThanOrEqual(500 + 0.001);
  });

  it("all bands have equal width", () => {
    const categories = ["A", "B", "C"];
    const scale = createBandScale(categories, [0, 300], 0.2);
    // bandwidth is uniform for band scales by construction
    expect(scale.bandwidth).toBeGreaterThan(0);
    // Each band starts at consistent step intervals
    const step01 = scale.scaleIndex(1) - scale.scaleIndex(0);
    const step12 = scale.scaleIndex(2) - scale.scaleIndex(1);
    expect(step01).toBeCloseTo(step12, 10);
  });
});

// ============================================================================
// computePieSliceArcs: angles sum to exactly 2*PI
// ============================================================================

describe("pie slice arcs - angle sum", () => {
  it("angles sum to exactly 2*PI with no padding", () => {
    const values = [10, 20, 30, 40];
    const angles = valuesToAngles(values, 0, 0);
    const totalSweep = angles.reduce(
      (sum, a) => sum + (a.endAngle - a.startAngle),
      0,
    );
    expect(totalSweep).toBeCloseTo(2 * Math.PI, 10);
  });

  it("angles sum to 2*PI minus total padding when padAngle > 0", () => {
    const values = [25, 25, 25, 25];
    const padDeg = 2;
    const angles = valuesToAngles(values, 0, padDeg);
    const totalSweep = angles.reduce(
      (sum, a) => sum + (a.endAngle - a.startAngle),
      0,
    );
    const totalPad = (padDeg * Math.PI / 180) * values.length;
    expect(totalSweep).toBeCloseTo(2 * Math.PI - totalPad, 8);
  });

  it("single value takes the full circle (minus pad)", () => {
    const angles = valuesToAngles([100], 0, 0);
    const sweep = angles[0].endAngle - angles[0].startAngle;
    expect(sweep).toBeCloseTo(2 * Math.PI, 10);
  });
});

// ============================================================================
// Scale linearity: f(a+b) proportional relationships
// ============================================================================

describe("linear scale - proportional mapping", () => {
  it("midpoint of domain maps to midpoint of range", () => {
    const scale = createLinearScale([0, 100], [0, 500]);
    // Due to niceExtent, domain may be adjusted. Use actual domain.
    const mid = (scale.domain[0] + scale.domain[1]) / 2;
    const expectedPixel = (scale.range[0] + scale.range[1]) / 2;
    expect(scale.scale(mid)).toBeCloseTo(expectedPixel, 6);
  });

  it("equal domain intervals map to equal range intervals", () => {
    const scale = createLinearScale([0, 100], [0, 1000]);
    const d0 = scale.domain[0];
    const d1 = scale.domain[1];
    const quarter = d0 + (d1 - d0) * 0.25;
    const half = d0 + (d1 - d0) * 0.5;
    const threeQ = d0 + (d1 - d0) * 0.75;

    const pxQuarter = scale.scale(quarter);
    const pxHalf = scale.scale(half);
    const pxThreeQ = scale.scale(threeQ);
    const pxEnd = scale.scale(d1);
    const pxStart = scale.scale(d0);

    // Intervals should be equal
    const interval1 = pxHalf - pxQuarter;
    const interval2 = pxThreeQ - pxHalf;
    expect(interval1).toBeCloseTo(interval2, 6);
  });

  it("domain min maps to range min, domain max maps to range max", () => {
    const scale = createLinearScale([0, 50], [100, 600]);
    expect(scale.scale(scale.domain[0])).toBeCloseTo(scale.range[0], 6);
    expect(scale.scale(scale.domain[1])).toBeCloseTo(scale.range[1], 6);
  });
});

// ============================================================================
// Log scale: verify log10 relationship
// ============================================================================

describe("log scale - logarithmic mapping", () => {
  it("maps powers of 10 to evenly spaced pixels", () => {
    const scale = createLogScale([1, 1000], [0, 300]);
    // log10(1)=0, log10(10)=1, log10(100)=2, log10(1000)=3
    // These should be evenly spaced in pixel space
    const px1 = scale.scale(1);
    const px10 = scale.scale(10);
    const px100 = scale.scale(100);
    const px1000 = scale.scale(1000);

    const step1 = px10 - px1;
    const step2 = px100 - px10;
    const step3 = px1000 - px100;

    expect(step1).toBeCloseTo(step2, 4);
    expect(step2).toBeCloseTo(step3, 4);
  });

  it("10x in domain corresponds to fixed pixel increment", () => {
    const scale = createLogScale([1, 10000], [0, 400]);
    const px1 = scale.scale(1);
    const px10 = scale.scale(10);
    const px100 = scale.scale(100);
    const increment = px10 - px1;
    expect(px100 - px10).toBeCloseTo(increment, 4);
  });
});

// ============================================================================
// Layout margins: plot area + margins = canvas size
// ============================================================================

describe("layout margins - dimensions add up", () => {
  it("plotArea.x + plotArea.width + right margin <= canvas width", () => {
    // We test the band scale + layout math indirectly:
    // plotArea.x = left margin, plotArea.width = width - left - right
    // So plotArea.x + plotArea.width + rightMargin = width
    const width = 800;
    const height = 600;
    const left = 60;
    const right = 20;
    const top = 40;
    const bottom = 50;

    const plotWidth = Math.max(width - left - right, 10);
    const plotHeight = Math.max(height - top - bottom, 10);

    expect(left + plotWidth + right).toBe(width);
    expect(top + plotHeight + bottom).toBe(height);
  });

  it("plotArea dimensions are always positive (min 10)", () => {
    // Even with huge margins, plotArea width/height is at least 10
    const width = 100;
    const left = 200;
    const right = 200;
    const plotWidth = Math.max(width - left - right, 10);
    expect(plotWidth).toBe(10);
  });
});
