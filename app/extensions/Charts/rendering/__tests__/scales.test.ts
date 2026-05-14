//! FILENAME: app/extensions/Charts/rendering/__tests__/scales.test.ts
// PURPOSE: Tests for scale computations (linear, band, point, log, pow, sqrt, angles).

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
// createLinearScale
// ============================================================================

describe("createLinearScale", () => {
  it("maps domain endpoints to range endpoints", () => {
    const s = createLinearScale([0, 100], [0, 500]);
    expect(s.scale(s.domain[0])).toBeCloseTo(0);
    expect(s.scale(s.domain[1])).toBeCloseTo(500);
  });

  it("maps midpoint correctly", () => {
    const s = createLinearScale([0, 100], [0, 200]);
    // Domain is "niced" so the exact midpoint depends on nicing,
    // but linear interpolation should hold
    const mid = (s.domain[0] + s.domain[1]) / 2;
    expect(s.scale(mid)).toBeCloseTo(100);
  });

  it("handles negative domain values", () => {
    const s = createLinearScale([-50, 50], [0, 400]);
    // niceExtent should include zero, domain should be something like [-50, 50]
    expect(s.domain[0]).toBeLessThanOrEqual(-50);
    expect(s.domain[1]).toBeGreaterThanOrEqual(50);
  });

  it("handles equal domain values (both zero)", () => {
    const s = createLinearScale([0, 0], [0, 200]);
    // niceExtent returns [0, 1] for this case
    expect(s.domain[0]).toBe(0);
    expect(s.domain[1]).toBeGreaterThan(0);
  });

  it("handles equal domain values (both positive)", () => {
    const s = createLinearScale([50, 50], [0, 200]);
    expect(s.domain[0]).toBeLessThanOrEqual(0);
    expect(s.domain[1]).toBeGreaterThanOrEqual(50);
  });

  it("inverted range works (top to bottom on screen)", () => {
    const s = createLinearScale([0, 100], [400, 0]);
    expect(s.scale(s.domain[0])).toBeCloseTo(400);
    expect(s.scale(s.domain[1])).toBeCloseTo(0);
  });

  describe("ticks", () => {
    it("generates tick values within domain", () => {
      const s = createLinearScale([0, 100], [0, 500]);
      const ticks = s.ticks(5);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      for (const t of ticks) {
        expect(t).toBeGreaterThanOrEqual(s.domain[0]);
        expect(t).toBeLessThanOrEqual(s.domain[1] + 0.01);
      }
    });

    it("generates approximately the requested number of ticks", () => {
      const s = createLinearScale([0, 1000], [0, 500]);
      const ticks = s.ticks(5);
      // Should be somewhere between 3 and 12 ticks
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(12);
    });

    it("generates nicely-rounded tick values", () => {
      const s = createLinearScale([0, 100], [0, 500]);
      const ticks = s.ticks(5);
      for (const t of ticks) {
        // Ticks should be round numbers
        expect(Number.isInteger(t) || t === Math.round(t * 10) / 10).toBe(true);
      }
    });
  });
});

// ============================================================================
// createBandScale
// ============================================================================

describe("createBandScale", () => {
  it("distributes bands across the range", () => {
    const s = createBandScale(["A", "B", "C"], [0, 300]);
    expect(s.bandwidth).toBeGreaterThan(0);
    // All band starts should be within range
    for (let i = 0; i < 3; i++) {
      const start = s.scaleIndex(i);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + s.bandwidth).toBeLessThanOrEqual(300 + 1);
    }
  });

  it("provides consistent results for scale by name vs scaleIndex", () => {
    const s = createBandScale(["X", "Y", "Z"], [0, 300]);
    expect(s.scale("X")).toBe(s.scaleIndex(0));
    expect(s.scale("Y")).toBe(s.scaleIndex(1));
    expect(s.scale("Z")).toBe(s.scaleIndex(2));
  });

  it("defaults to index 0 for unknown categories", () => {
    const s = createBandScale(["A", "B"], [0, 200]);
    expect(s.scale("UNKNOWN")).toBe(s.scaleIndex(0));
  });

  it("handles single category", () => {
    const s = createBandScale(["Only"], [0, 200]);
    expect(s.bandwidth).toBeGreaterThan(0);
    expect(s.scaleIndex(0)).toBeGreaterThanOrEqual(0);
  });

  it("handles empty domain", () => {
    const s = createBandScale([], [0, 200]);
    expect(s.bandwidth).toBeGreaterThan(0);
  });

  it("respects custom padding", () => {
    const tight = createBandScale(["A", "B", "C"], [0, 300], 0);
    const loose = createBandScale(["A", "B", "C"], [0, 300], 0.5);
    expect(tight.bandwidth).toBeGreaterThan(loose.bandwidth);
  });

  it("handles duplicate category names (Map keeps last index)", () => {
    const s = createBandScale(["A", "A", "B"], [0, 300]);
    // Map.set overwrites, so scale("A") returns the LAST occurrence (index 1)
    expect(s.scale("A")).toBe(s.scaleIndex(1));
  });

  it("stores domain and range", () => {
    const s = createBandScale(["A", "B"], [10, 210]);
    expect(s.domain).toEqual(["A", "B"]);
    expect(s.range).toEqual([10, 210]);
  });
});

// ============================================================================
// createPointScale
// ============================================================================

describe("createPointScale", () => {
  it("distributes points evenly across the range", () => {
    const s = createPointScale(["A", "B", "C"], [0, 300]);
    const a = s.scaleIndex(0);
    const b = s.scaleIndex(1);
    const c = s.scaleIndex(2);
    // Equal spacing
    expect(b - a).toBeCloseTo(c - b);
  });

  it("centers a single category", () => {
    const s = createPointScale(["Only"], [0, 200]);
    expect(s.scaleIndex(0)).toBeCloseTo(100);
  });

  it("scale by name matches scaleIndex", () => {
    const s = createPointScale(["X", "Y", "Z"], [0, 300]);
    expect(s.scale("X")).toBe(s.scaleIndex(0));
    expect(s.scale("Y")).toBe(s.scaleIndex(1));
    expect(s.scale("Z")).toBe(s.scaleIndex(2));
  });

  it("returns index 0 position for unknown categories", () => {
    const s = createPointScale(["A", "B"], [0, 200]);
    expect(s.scale("UNKNOWN")).toBe(s.scaleIndex(0));
  });

  it("has a positive step for multiple categories", () => {
    const s = createPointScale(["A", "B", "C"], [0, 300]);
    expect(s.step).toBeGreaterThan(0);
  });

  it("stores domain and range", () => {
    const s = createPointScale(["A", "B"], [10, 210]);
    expect(s.domain).toEqual(["A", "B"]);
    expect(s.range).toEqual([10, 210]);
  });
});

// ============================================================================
// createLogScale
// ============================================================================

describe("createLogScale", () => {
  it("maps domain endpoints to range endpoints", () => {
    const s = createLogScale([1, 1000], [0, 300]);
    expect(s.scale(1)).toBeCloseTo(0);
    expect(s.scale(1000)).toBeCloseTo(300);
  });

  it("maps logarithmically (midpoint in log space)", () => {
    const s = createLogScale([1, 10000], [0, 400]);
    // log10(100) = 2, which is halfway between log10(1)=0 and log10(10000)=4
    expect(s.scale(100)).toBeCloseTo(200);
  });

  it("clamps very small values to epsilon", () => {
    const s = createLogScale([0, 100], [0, 200]);
    // Domain should be clamped to positive
    expect(s.domain[0]).toBeGreaterThan(0);
    // Should not throw for zero or negative
    expect(() => s.scale(0)).not.toThrow();
    expect(() => s.scale(-5)).not.toThrow();
  });

  it("generates tick values at powers of 10", () => {
    const s = createLogScale([1, 10000], [0, 400]);
    const ticks = s.ticks(5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    // Check that power-of-10 ticks are present
    expect(ticks).toContain(1);
    expect(ticks).toContain(10);
    expect(ticks).toContain(100);
    expect(ticks).toContain(1000);
    expect(ticks).toContain(10000);
  });

  it("adds intermediate ticks when few powers of 10", () => {
    const s = createLogScale([1, 100], [0, 200]);
    const ticks = s.ticks(5);
    // Should have 1, 10, 100 at minimum, plus maybe 2, 5, 20, 50
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });

  it("returns at least 1 tick for narrow ranges", () => {
    const s = createLogScale([3, 7], [0, 100]);
    const ticks = s.ticks(5);
    // Range [3,7] contains 5 (via 5*10^0), so at least 1 tick
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// createPowScale
// ============================================================================

describe("createPowScale", () => {
  it("maps domain endpoints to range endpoints", () => {
    const s = createPowScale([0, 10], [0, 200]);
    expect(s.scale(s.domain[0])).toBeCloseTo(0);
    expect(s.scale(s.domain[1])).toBeCloseTo(200);
  });

  it("is non-linear for exponent 2", () => {
    const s = createPowScale([0, 10], [0, 200]);
    const mid = (s.domain[0] + s.domain[1]) / 2;
    const scaledMid = s.scale(mid);
    // For pow(2), midpoint should be at 25% of range, not 50%
    expect(scaledMid).toBeLessThan(100);
  });

  it("generates tick values", () => {
    const s = createPowScale([0, 100], [0, 400]);
    const ticks = s.ticks(5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("supports custom exponent", () => {
    const s2 = createPowScale([0, 10], [0, 200], 2);
    const s3 = createPowScale([0, 10], [0, 200], 3);
    // With higher exponent, midpoint should map to a smaller pixel position
    const mid = (s2.domain[0] + s2.domain[1]) / 2;
    expect(s3.scale(mid)).toBeLessThan(s2.scale(mid));
  });
});

// ============================================================================
// createSqrtScale
// ============================================================================

describe("createSqrtScale", () => {
  it("is a power scale with exponent 0.5", () => {
    const s = createSqrtScale([0, 100], [0, 400]);
    expect(s.scale(s.domain[0])).toBeCloseTo(0);
    expect(s.scale(s.domain[1])).toBeCloseTo(400);
  });

  it("midpoint maps above 50% of range (concave curve)", () => {
    const s = createSqrtScale([0, 100], [0, 400]);
    const mid = (s.domain[0] + s.domain[1]) / 2;
    const scaledMid = s.scale(mid);
    expect(scaledMid).toBeGreaterThan(200);
  });
});

// ============================================================================
// createScaleFromSpec
// ============================================================================

describe("createScaleFromSpec", () => {
  it("creates linear scale by default", () => {
    const s = createScaleFromSpec(undefined, [0, 100], [0, 400]);
    // Should be a valid linear scale
    expect(s.scale(s.domain[0])).toBeCloseTo(0);
    expect(s.scale(s.domain[1])).toBeCloseTo(400);
  });

  it("creates log scale when specified", () => {
    const s = createScaleFromSpec({ type: "log" }, [1, 1000], [0, 300]);
    // log10(10) is 1/3 of the way from log10(1)=0 to log10(1000)=3
    expect(s.scale(10)).toBeCloseTo(100, 0);
  });

  it("creates pow scale when specified", () => {
    const s = createScaleFromSpec({ type: "pow", exponent: 3 }, [0, 10], [0, 200]);
    expect(s.scale(s.domain[0])).toBeCloseTo(0);
    expect(s.scale(s.domain[1])).toBeCloseTo(200);
  });

  it("creates sqrt scale when specified", () => {
    const s = createScaleFromSpec({ type: "sqrt" }, [0, 100], [0, 400]);
    expect(s.scale(s.domain[0])).toBeCloseTo(0);
  });

  it("uses domain override from spec", () => {
    const s = createScaleFromSpec({ type: "linear", domain: [0, 50] }, [0, 100], [0, 200]);
    // The scale domain should be based on [0, 50], not [0, 100]
    expect(s.domain[1]).toBeLessThanOrEqual(60); // niced from 50
  });

  it("reverses range when spec says reverse", () => {
    const normal = createScaleFromSpec({ type: "linear" }, [0, 100], [0, 400]);
    const reversed = createScaleFromSpec({ type: "linear", reverse: true }, [0, 100], [0, 400]);
    // In reversed scale, domain min maps to range max
    expect(reversed.scale(reversed.domain[0])).toBeCloseTo(400);
    expect(reversed.scale(reversed.domain[1])).toBeCloseTo(0);
  });
});

// ============================================================================
// valuesToAngles
// ============================================================================

describe("valuesToAngles", () => {
  it("distributes angles proportionally to values", () => {
    const result = valuesToAngles([50, 50], 0, 0);
    // Two equal values should get equal sweep
    const sweep0 = result[0].endAngle - result[0].startAngle;
    const sweep1 = result[1].endAngle - result[1].startAngle;
    expect(sweep0).toBeCloseTo(sweep1);
  });

  it("total sweep equals 2*PI (with no padding)", () => {
    const result = valuesToAngles([30, 70], 0, 0);
    const totalSweep = result.reduce(
      (sum, a) => sum + (a.endAngle - a.startAngle),
      0,
    );
    expect(totalSweep).toBeCloseTo(Math.PI * 2);
  });

  it("handles single value", () => {
    const result = valuesToAngles([100], 0, 0);
    expect(result).toHaveLength(1);
    const sweep = result[0].endAngle - result[0].startAngle;
    expect(sweep).toBeCloseTo(Math.PI * 2);
  });

  it("handles all zeros gracefully", () => {
    const result = valuesToAngles([0, 0, 0]);
    expect(result).toHaveLength(3);
    for (const angle of result) {
      expect(angle.startAngle).toBe(0);
      expect(angle.endAngle).toBe(0);
    }
  });

  it("ignores negative values (treats as 0)", () => {
    const result = valuesToAngles([-10, 100], 0, 0);
    // Negative should get 0 sweep, positive gets full sweep
    const sweep0 = result[0].endAngle - result[0].startAngle;
    const sweep1 = result[1].endAngle - result[1].startAngle;
    expect(sweep0).toBeCloseTo(0);
    expect(sweep1).toBeCloseTo(Math.PI * 2);
  });

  it("starts at -90 degrees (12 o'clock) by default", () => {
    const result = valuesToAngles([100], 0, 0);
    expect(result[0].startAngle).toBeCloseTo(-Math.PI / 2);
  });

  it("applies custom start angle offset", () => {
    const result = valuesToAngles([100], 90, 0);
    // Start should be at -90 + 90 = 0 degrees (3 o'clock)
    expect(result[0].startAngle).toBeCloseTo(0);
  });

  it("reduces available sweep by pad angle", () => {
    const noPad = valuesToAngles([50, 50], 0, 0);
    const withPad = valuesToAngles([50, 50], 0, 5);
    const sweepNoPad = noPad[0].endAngle - noPad[0].startAngle;
    const sweepWithPad = withPad[0].endAngle - withPad[0].startAngle;
    expect(sweepWithPad).toBeLessThan(sweepNoPad);
  });

  it("angles are ordered sequentially", () => {
    const result = valuesToAngles([25, 25, 25, 25], 0, 1);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].endAngle).toBeLessThanOrEqual(result[i + 1].startAngle + 0.01);
    }
  });
});
