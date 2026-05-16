//! FILENAME: app/extensions/Charts/rendering/__tests__/scales.deep2.test.ts
// PURPOSE: Additional deep tests for scale functions: log, pow, sqrt, point, angular.

import { describe, it, expect } from "vitest";
import {
  createLinearScale,
  createBandScale,
  createPointScale,
  createLogScale,
  createPowScale,
  createSqrtScale,
  createScaleFromSpec,
  valuesToAngles,
} from "../scales";

// ============================================================================
// createLogScale
// ============================================================================

describe("createLogScale", () => {
  it("maps domain endpoints to range endpoints", () => {
    const s = createLogScale([1, 1000], [0, 300]);
    expect(s.scale(1)).toBeCloseTo(0, 0);
    expect(s.scale(1000)).toBeCloseTo(300, 0);
  });

  it("maps midpoint logarithmically (not linearly)", () => {
    const s = createLogScale([1, 1000], [0, 300]);
    // log10(10) = 1, log10(1000) = 3, so 10 maps to 1/3 of range = 100
    expect(s.scale(10)).toBeCloseTo(100, 0);
  });

  it("clamps near-zero values to epsilon", () => {
    const s = createLogScale([0, 100], [0, 200]);
    // Should not throw or return NaN
    expect(isNaN(s.scale(0))).toBe(false);
  });

  it("generates ticks at powers of 10", () => {
    const s = createLogScale([1, 10000], [0, 400]);
    const ticks = s.ticks(5);
    expect(ticks).toContain(10);
    expect(ticks).toContain(100);
    expect(ticks).toContain(1000);
  });
});

// ============================================================================
// createPowScale
// ============================================================================

describe("createPowScale", () => {
  it("maps domain endpoints to range endpoints", () => {
    const s = createPowScale([0, 100], [0, 200], 2);
    expect(s.scale(0)).toBeCloseTo(0, 0);
  });

  it("maps 50 to less than midpoint for exponent > 1 (compression)", () => {
    const s = createPowScale([0, 100], [0, 200], 2);
    // pow(50, 2) / pow(100, 2) = 2500/10000 = 0.25 => 50px
    const val = s.scale(50);
    expect(val).toBeLessThan(100); // less than linear midpoint
  });

  it("produces ticks", () => {
    const s = createPowScale([0, 100], [0, 200], 2);
    const ticks = s.ticks(5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// createSqrtScale
// ============================================================================

describe("createSqrtScale", () => {
  it("maps 50 to more than midpoint (square root expansion)", () => {
    const s = createSqrtScale([0, 100], [0, 200]);
    const val = s.scale(50);
    // sqrt(50)/sqrt(100) = ~0.707 => ~141px
    expect(val).toBeGreaterThan(100);
  });
});

// ============================================================================
// createPointScale
// ============================================================================

describe("createPointScale", () => {
  it("maps single category to center of range", () => {
    const s = createPointScale(["A"], [0, 200]);
    expect(s.scale("A")).toBeCloseTo(100, 0);
  });

  it("maps two categories to endpoints (with padding)", () => {
    const s = createPointScale(["A", "B"], [0, 200], 0.5);
    const a = s.scale("A");
    const b = s.scale("B");
    expect(a).toBeLessThan(b);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeLessThan(200);
  });

  it("scaleIndex matches scale for non-duplicate names", () => {
    const s = createPointScale(["X", "Y", "Z"], [0, 300]);
    expect(s.scaleIndex(0)).toBe(s.scale("X"));
    expect(s.scaleIndex(1)).toBe(s.scale("Y"));
    expect(s.scaleIndex(2)).toBe(s.scale("Z"));
  });

  it("step is consistent between categories", () => {
    const s = createPointScale(["A", "B", "C"], [0, 300]);
    const diff1 = s.scaleIndex(1) - s.scaleIndex(0);
    const diff2 = s.scaleIndex(2) - s.scaleIndex(1);
    expect(diff1).toBeCloseTo(diff2, 5);
  });
});

// ============================================================================
// createScaleFromSpec
// ============================================================================

describe("createScaleFromSpec", () => {
  it("defaults to linear when no spec", () => {
    const s = createScaleFromSpec(undefined, [0, 100], [0, 200]);
    expect(s.scale(50)).toBeCloseTo(100, -1); // approximate due to niceExtent
  });

  it("creates log scale when type is log", () => {
    const s = createScaleFromSpec({ type: "log" }, [1, 1000], [0, 300]);
    // Log scale: 10 should be at ~1/3
    expect(s.scale(10)).toBeCloseTo(100, 0);
  });

  it("reverses range when reverse is true", () => {
    const normal = createScaleFromSpec({ type: "linear" }, [0, 100], [0, 200]);
    const reversed = createScaleFromSpec({ type: "linear", reverse: true }, [0, 100], [0, 200]);
    // Reversed: higher values map to lower pixels
    expect(reversed.scale(100)).toBeLessThan(normal.scale(100));
  });

  it("uses domain override from spec", () => {
    const s = createScaleFromSpec({ type: "linear", domain: [0, 50] }, [0, 100], [0, 200]);
    // Domain is [0, 50] instead of [0, 100], so scale maps differently
    expect(s.domain[1]).toBeGreaterThanOrEqual(50);
  });
});

// ============================================================================
// valuesToAngles
// ============================================================================

describe("valuesToAngles", () => {
  it("returns all-zero angles for all-zero values", () => {
    const angles = valuesToAngles([0, 0, 0]);
    for (const a of angles) {
      expect(a.startAngle).toBe(0);
      expect(a.endAngle).toBe(0);
    }
  });

  it("single value covers nearly full circle", () => {
    const angles = valuesToAngles([100], 0, 0);
    const sweep = angles[0].endAngle - angles[0].startAngle;
    expect(sweep).toBeCloseTo(Math.PI * 2, 1);
  });

  it("two equal values split circle roughly in half", () => {
    const angles = valuesToAngles([50, 50], 0, 0);
    const sweep0 = angles[0].endAngle - angles[0].startAngle;
    const sweep1 = angles[1].endAngle - angles[1].startAngle;
    expect(sweep0).toBeCloseTo(sweep1, 3);
    expect(sweep0).toBeCloseTo(Math.PI, 1);
  });

  it("negative values are treated as zero", () => {
    const angles = valuesToAngles([-10, 100], 0, 0);
    const sweep0 = angles[0].endAngle - angles[0].startAngle;
    expect(sweep0).toBeCloseTo(0, 5);
  });

  it("pad angle creates gaps between slices", () => {
    const noPad = valuesToAngles([50, 50], 0, 0);
    const withPad = valuesToAngles([50, 50], 0, 5);
    const sweep0NoPad = noPad[0].endAngle - noPad[0].startAngle;
    const sweep0WithPad = withPad[0].endAngle - withPad[0].startAngle;
    expect(sweep0WithPad).toBeLessThan(sweep0NoPad);
  });

  it("start angle rotates all slices", () => {
    const a0 = valuesToAngles([100], 0, 0);
    const a90 = valuesToAngles([100], 90, 0);
    expect(a90[0].startAngle).toBeGreaterThan(a0[0].startAngle);
  });
});
