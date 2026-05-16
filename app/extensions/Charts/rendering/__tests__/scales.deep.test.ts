//! FILENAME: app/extensions/Charts/rendering/__tests__/scales.deep.test.ts
// PURPOSE: Deep tests for scale edge cases: extreme values, large domains, reversed scales.

import { describe, it, expect } from "vitest";
import {
  createLinearScale,
  createBandScale,
  createLogScale,
  createPowScale,
  createSqrtScale,
  createScaleFromSpec,
} from "../scales";

// ============================================================================
// Log Scale with Very Small/Large Values
// ============================================================================

describe("log scale with extreme values", () => {
  it("handles domain from 1e-10 to 1e10", () => {
    const s = createLogScale([1e-10, 1e10], [0, 1000]);
    expect(s.domain[0]).toBeCloseTo(1e-10);
    expect(s.domain[1]).toBeCloseTo(1e10);
    // Midpoint in log space: 10^0 = 1
    expect(s.scale(1)).toBeCloseTo(500);
  });

  it("maps 1e-5 correctly in a 1e-10 to 1e10 range", () => {
    const s = createLogScale([1e-10, 1e10], [0, 1000]);
    // log10(1e-5) = -5, which is 25% from log10(1e-10)=-10 to log10(1e10)=10
    expect(s.scale(1e-5)).toBeCloseTo(250);
  });

  it("maps 1e5 correctly in a 1e-10 to 1e10 range", () => {
    const s = createLogScale([1e-10, 1e10], [0, 1000]);
    // log10(1e5) = 5, which is 75% of [-10, 10]
    expect(s.scale(1e5)).toBeCloseTo(750);
  });

  it("generates ticks spanning many orders of magnitude", () => {
    const s = createLogScale([1e-6, 1e6], [0, 600]);
    const ticks = s.ticks(15);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    // Should contain several powers of 10
    const powersOf10 = ticks.filter((t) => {
      const log = Math.log10(t);
      return Math.abs(log - Math.round(log)) < 0.001;
    });
    expect(powersOf10.length).toBeGreaterThanOrEqual(3);
  });

  it("clamps domain when min is zero", () => {
    const s = createLogScale([0, 1e6], [0, 300]);
    expect(s.domain[0]).toBeGreaterThan(0);
    expect(s.domain[0]).toBeLessThanOrEqual(1e-10);
  });

  it("clamps domain when both values are zero", () => {
    const s = createLogScale([0, 0], [0, 200]);
    expect(s.domain[0]).toBeGreaterThan(0);
    expect(s.domain[1]).toBeGreaterThan(0);
  });

  it("handles domain with very close values (1e-10 to 1e-9)", () => {
    const s = createLogScale([1e-10, 1e-9], [0, 200]);
    expect(s.scale(1e-10)).toBeCloseTo(0);
    expect(s.scale(1e-9)).toBeCloseTo(200);
  });

  it("does not produce NaN for negative input values", () => {
    const s = createLogScale([1, 1000], [0, 300]);
    const result = s.scale(-100);
    expect(Number.isNaN(result)).toBe(false);
    expect(Number.isFinite(result)).toBe(true);
  });
});

// ============================================================================
// Power/Sqrt Scales with Negative Values
// ============================================================================

describe("power scale with negative values", () => {
  it("maps negative domain correctly with exponent 2", () => {
    const s = createPowScale([-100, 100], [0, 400]);
    // Domain gets niced, but should include negative range
    expect(s.domain[0]).toBeLessThanOrEqual(-100);
    expect(s.domain[1]).toBeGreaterThanOrEqual(100);
  });

  it("preserves sign for negative values (signed pow)", () => {
    const s = createPowScale([-10, 10], [0, 400]);
    const negVal = s.scale(-5);
    const posVal = s.scale(5);
    // Negative should map to lower range, positive to higher range
    expect(negVal).toBeLessThan(posVal);
  });

  it("zero maps between negative and positive extremes", () => {
    const s = createPowScale([-10, 10], [0, 400]);
    const zeroPixel = s.scale(0);
    expect(zeroPixel).toBeGreaterThan(s.scale(s.domain[0]));
    expect(zeroPixel).toBeLessThan(s.scale(s.domain[1]));
  });

  it("pow scale with exponent 3 handles negatives", () => {
    const s = createPowScale([-10, 10], [0, 200], 3);
    expect(s.scale(-10)).toBeCloseTo(0, 0);
    expect(s.scale(10)).toBeCloseTo(200, 0);
  });

  it("sqrt scale maps zero to range start for non-negative domain", () => {
    const s = createSqrtScale([0, 100], [0, 400]);
    expect(s.scale(0)).toBeCloseTo(0);
  });

  it("sqrt scale with negative domain still nices to include zero", () => {
    const s = createSqrtScale([-10, 100], [0, 400]);
    // niceExtent includes zero if lo > 0, but here lo is already negative
    expect(s.domain[0]).toBeLessThanOrEqual(-10);
  });
});

// ============================================================================
// Band Scale with 1000+ Categories
// ============================================================================

describe("band scale with many categories", () => {
  const categories = Array.from({ length: 1000 }, (_, i) => `Cat${i}`);

  it("handles 1000 categories without error", () => {
    const s = createBandScale(categories, [0, 2000]);
    expect(s.bandwidth).toBeGreaterThan(0);
  });

  it("bandwidth shrinks proportionally with category count", () => {
    const s10 = createBandScale(categories.slice(0, 10), [0, 1000]);
    const s100 = createBandScale(categories.slice(0, 100), [0, 1000]);
    const s1000 = createBandScale(categories, [0, 1000]);
    expect(s100.bandwidth).toBeLessThan(s10.bandwidth);
    expect(s1000.bandwidth).toBeLessThan(s100.bandwidth);
  });

  it("first category starts near range start", () => {
    const s = createBandScale(categories, [0, 2000]);
    expect(s.scaleIndex(0)).toBeGreaterThanOrEqual(0);
    expect(s.scaleIndex(0)).toBeLessThan(10);
  });

  it("last category ends near range end", () => {
    const s = createBandScale(categories, [0, 2000]);
    const lastStart = s.scaleIndex(999);
    expect(lastStart + s.bandwidth).toBeLessThanOrEqual(2001);
    expect(lastStart + s.bandwidth).toBeGreaterThan(1990);
  });

  it("all band positions are monotonically increasing", () => {
    const s = createBandScale(categories.slice(0, 50), [0, 500]);
    for (let i = 1; i < 50; i++) {
      expect(s.scaleIndex(i)).toBeGreaterThan(s.scaleIndex(i - 1));
    }
  });

  it("scale by name works for category at index 500", () => {
    const s = createBandScale(categories, [0, 2000]);
    expect(s.scale("Cat500")).toBe(s.scaleIndex(500));
  });
});

// ============================================================================
// Time Scale Calculations
// ============================================================================

describe("time scale calculations (using linear scale with timestamps)", () => {
  // We use epoch milliseconds on a linear scale to simulate time scales

  const jan1 = new Date(2024, 0, 1).getTime();
  const dec31 = new Date(2024, 11, 31).getTime();

  it("maps full year range to pixel range", () => {
    const s = createLinearScale([jan1, dec31], [0, 800]);
    // Domain gets niced, so endpoints map within the niced domain
    expect(s.scale(s.domain[0])).toBeCloseTo(0);
    expect(s.scale(s.domain[1])).toBeCloseTo(800);
    // Original values should map somewhere inside
    expect(s.scale(jan1)).toBeGreaterThanOrEqual(0);
    expect(s.scale(dec31)).toBeLessThanOrEqual(800);
  });

  it("midpoint of year maps to midpoint of range", () => {
    const s = createLinearScale([jan1, dec31], [0, 800]);
    const mid = (s.domain[0] + s.domain[1]) / 2;
    expect(s.scale(mid)).toBeCloseTo(400, -1);
  });

  it("generates ticks for a year-long timestamp range", () => {
    const s = createLinearScale([jan1, dec31], [0, 800]);
    const ticks = s.ticks(6);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(s.domain[0]);
      expect(t).toBeLessThanOrEqual(s.domain[1] + 1);
    }
  });
});

// ============================================================================
// Scale Domain Auto-Adjustment (Nicing)
// ============================================================================

describe("scale domain nicing", () => {
  it("nices [3, 97] to include 0 and extend to 100", () => {
    const s = createLinearScale([3, 97], [0, 400]);
    expect(s.domain[0]).toBe(0);
    expect(s.domain[1]).toBe(100);
  });

  it("nices [0.1, 0.9] to clean boundaries", () => {
    const s = createLinearScale([0.1, 0.9], [0, 400]);
    expect(s.domain[0]).toBeLessThanOrEqual(0);
    expect(s.domain[1]).toBeGreaterThanOrEqual(0.9);
  });

  it("nices [-45, 45] symmetrically around zero", () => {
    const s = createLinearScale([-45, 45], [0, 400]);
    expect(s.domain[0]).toBeLessThanOrEqual(-45);
    expect(s.domain[1]).toBeGreaterThanOrEqual(45);
  });

  it("nices [0, 7] to [0, 8] or [0, 10]", () => {
    const s = createLinearScale([0, 7], [0, 400]);
    expect(s.domain[0]).toBe(0);
    expect([8, 10]).toContain(s.domain[1]);
  });

  it("nicing does not collapse tiny positive ranges to zero", () => {
    const s = createLinearScale([0.001, 0.002], [0, 400]);
    expect(s.domain[1]).toBeGreaterThan(s.domain[0]);
  });

  it("nicing extends negative-only domain to include zero on the high end", () => {
    const s = createLinearScale([-100, -10], [0, 400]);
    expect(s.domain[1]).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Scale with Reversed Domain
// ============================================================================

describe("scale with reversed domain via ScaleSpec", () => {
  it("reverse=true flips range endpoints", () => {
    const normal = createScaleFromSpec({ type: "linear" }, [0, 100], [0, 400]);
    const reversed = createScaleFromSpec({ type: "linear", reverse: true }, [0, 100], [0, 400]);
    expect(normal.scale(normal.domain[0])).toBeCloseTo(0);
    expect(reversed.scale(reversed.domain[0])).toBeCloseTo(400);
  });

  it("reversed pow scale inverts mapping", () => {
    const reversed = createScaleFromSpec({ type: "pow", exponent: 2, reverse: true }, [0, 10], [0, 200]);
    expect(reversed.scale(reversed.domain[0])).toBeCloseTo(200);
    expect(reversed.scale(reversed.domain[1])).toBeCloseTo(0);
  });

  it("reversed sqrt scale inverts mapping", () => {
    const reversed = createScaleFromSpec({ type: "sqrt", reverse: true }, [0, 100], [0, 400]);
    expect(reversed.scale(reversed.domain[0])).toBeCloseTo(400);
    expect(reversed.scale(reversed.domain[1])).toBeCloseTo(0);
  });

  it("reversed log scale inverts mapping", () => {
    const reversed = createScaleFromSpec({ type: "log", reverse: true }, [1, 1000], [0, 300]);
    expect(reversed.scale(1)).toBeCloseTo(300);
    expect(reversed.scale(1000)).toBeCloseTo(0);
  });

  it("domain override combined with reverse works correctly", () => {
    const s = createScaleFromSpec(
      { type: "linear", domain: [0, 50], reverse: true },
      [0, 100],
      [0, 400],
    );
    // Domain should be niced from [0, 50], and range reversed
    expect(s.domain[1]).toBeLessThanOrEqual(60);
    expect(s.scale(s.domain[0])).toBeCloseTo(400);
    expect(s.scale(s.domain[1])).toBeCloseTo(0);
  });
});
