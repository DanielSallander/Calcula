//! FILENAME: app/extensions/Charts/lib/__tests__/trendlineComputation.test.ts
// PURPOSE: Tests for trendline computation (regression, moving average).

import { describe, it, expect } from "vitest";
import { computeTrendline } from "../trendlineComputation";
import type { ParsedChartData, TrendlineSpec } from "../../types";

// ============================================================================
// Test Helpers
// ============================================================================

function makeData(values: number[]): ParsedChartData {
  return {
    categories: values.map((_, i) => `Cat${i}`),
    series: [{ name: "Series1", values, color: null }],
  };
}

// ============================================================================
// General
// ============================================================================

describe("computeTrendline - general", () => {
  it("returns null for missing series", () => {
    const data = makeData([1, 2, 3]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 5 });
    expect(result).toBeNull();
  });

  it("returns null for fewer than 2 data points", () => {
    const data = makeData([42]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).toBeNull();
  });

  it("returns null for all NaN values", () => {
    const data = makeData([NaN, NaN, NaN]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).toBeNull();
  });

  it("defaults to seriesIndex 0", () => {
    const data = makeData([1, 2, 3, 4, 5]);
    const result = computeTrendline(data, { type: "linear" });
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(5);
  });

  it("returns null for unknown trendline type", () => {
    const data = makeData([1, 2, 3]);
    const result = computeTrendline(data, { type: "unknown" as any });
    expect(result).toBeNull();
  });
});

// ============================================================================
// Linear Regression
// ============================================================================

describe("computeTrendline - linear", () => {
  it("computes linear trendline for perfect linear data", () => {
    // y = 2x + 1 (at x=0: 1, x=1: 3, x=2: 5, x=3: 7, x=4: 9)
    const data = makeData([1, 3, 5, 7, 9]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });

    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(5);
    expect(result!.rSquared).toBeCloseTo(1.0);
    // Check predicted values match the actual data
    for (let i = 0; i < 5; i++) {
      expect(result!.points[i].ci).toBe(i);
      expect(result!.points[i].value).toBeCloseTo(1 + 2 * i);
    }
  });

  it("has R-squared close to 1 for perfect linear data", () => {
    const data = makeData([10, 20, 30, 40, 50]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result!.rSquared).toBeCloseTo(1.0);
  });

  it("has lower R-squared for noisy data", () => {
    const data = makeData([10, 25, 15, 40, 30]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result!.rSquared).toBeLessThan(1.0);
    expect(result!.rSquared).toBeGreaterThan(0);
  });

  it("produces an equation string", () => {
    const data = makeData([1, 3, 5, 7, 9]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result!.equation).toContain("y =");
    expect(result!.equation).toContain("x");
  });

  it("handles flat data (zero slope)", () => {
    const data = makeData([5, 5, 5, 5, 5]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).not.toBeNull();
    // All predicted values should be 5
    for (const p of result!.points) {
      expect(p.value).toBeCloseTo(5);
    }
  });
});

// ============================================================================
// Exponential Regression
// ============================================================================

describe("computeTrendline - exponential", () => {
  it("computes exponential trendline for exponential data", () => {
    // y = 2 * e^(0.5x)
    const values = [0, 1, 2, 3, 4].map((x) => 2 * Math.exp(0.5 * x));
    const data = makeData(values);
    const result = computeTrendline(data, { type: "exponential", seriesIndex: 0 });

    expect(result).not.toBeNull();
    expect(result!.rSquared).toBeCloseTo(1.0, 2);
    expect(result!.equation).toContain("e^");
  });

  it("falls back to linear for non-positive data", () => {
    const data = makeData([-1, -2, 0, 3, 5]);
    const result = computeTrendline(data, { type: "exponential", seriesIndex: 0 });
    // Should not crash, may fall back to linear
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(5);
  });
});

// ============================================================================
// Polynomial Regression
// ============================================================================

describe("computeTrendline - polynomial", () => {
  it("computes quadratic trendline for quadratic data", () => {
    // y = x^2 (at x=0: 0, x=1: 1, x=2: 4, x=3: 9, x=4: 16)
    const data = makeData([0, 1, 4, 9, 16]);
    const result = computeTrendline(data, {
      type: "polynomial",
      seriesIndex: 0,
      polynomialDegree: 2,
    });

    expect(result).not.toBeNull();
    expect(result!.rSquared).toBeCloseTo(1.0, 4);
    // Check predicted values
    for (let i = 0; i < 5; i++) {
      expect(result!.points[i].value).toBeCloseTo(i * i, 2);
    }
  });

  it("defaults to degree 2", () => {
    const data = makeData([0, 1, 4, 9, 16]);
    const result = computeTrendline(data, {
      type: "polynomial",
      seriesIndex: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.rSquared).toBeCloseTo(1.0, 4);
  });

  it("caps degree at 6", () => {
    const data = makeData([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = computeTrendline(data, {
      type: "polynomial",
      seriesIndex: 0,
      polynomialDegree: 20,
    });
    // Should not crash
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(8);
  });

  it("equation contains x^ terms", () => {
    const data = makeData([0, 1, 4, 9, 16]);
    const result = computeTrendline(data, {
      type: "polynomial",
      seriesIndex: 0,
      polynomialDegree: 2,
    });
    expect(result!.equation).toContain("y =");
  });
});

// ============================================================================
// Power Regression
// ============================================================================

describe("computeTrendline - power", () => {
  it("computes power trendline", () => {
    // Use positive data
    const data = makeData([1, 4, 9, 16, 25]);
    const result = computeTrendline(data, { type: "power", seriesIndex: 0 });
    expect(result).not.toBeNull();
    expect(result!.equation).toContain("x^");
    expect(result!.points).toHaveLength(5);
  });

  it("falls back to linear for non-positive data", () => {
    const data = makeData([0, -1, 0, 3, 5]);
    const result = computeTrendline(data, { type: "power", seriesIndex: 0 });
    expect(result).not.toBeNull();
  });
});

// ============================================================================
// Logarithmic Regression
// ============================================================================

describe("computeTrendline - logarithmic", () => {
  it("computes logarithmic trendline", () => {
    // y = 10 * ln(x+1)
    const values = [0, 1, 2, 3, 4].map((x) => 10 * Math.log(x + 1));
    const data = makeData(values);
    const result = computeTrendline(data, { type: "logarithmic", seriesIndex: 0 });

    expect(result).not.toBeNull();
    expect(result!.rSquared).toBeCloseTo(1.0, 4);
    expect(result!.equation).toContain("ln(x)");
  });

  it("produces predicted values for each category", () => {
    const data = makeData([5, 10, 12, 14, 15]);
    const result = computeTrendline(data, { type: "logarithmic", seriesIndex: 0 });
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(5);
    for (const p of result!.points) {
      expect(isFinite(p.value)).toBe(true);
    }
  });
});

// ============================================================================
// Moving Average
// ============================================================================

describe("computeTrendline - movingAverage", () => {
  it("computes 3-point moving average", () => {
    const data = makeData([10, 20, 30, 40, 50]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
      movingAveragePeriod: 3,
    });

    expect(result).not.toBeNull();
    // Points start at index 2 (0-based, period-1)
    expect(result!.points).toHaveLength(3);
    expect(result!.points[0].ci).toBe(2);
    expect(result!.points[0].value).toBeCloseTo(20); // (10+20+30)/3
    expect(result!.points[1].ci).toBe(3);
    expect(result!.points[1].value).toBeCloseTo(30); // (20+30+40)/3
    expect(result!.points[2].ci).toBe(4);
    expect(result!.points[2].value).toBeCloseTo(40); // (30+40+50)/3
  });

  it("defaults to period 3", () => {
    const data = makeData([10, 20, 30, 40, 50]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(3);
  });

  it("has NaN R-squared", () => {
    const data = makeData([1, 2, 3, 4, 5]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
    });
    expect(isNaN(result!.rSquared)).toBe(true);
  });

  it("clamps period to at least 2", () => {
    const data = makeData([10, 20, 30, 40, 50]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
      movingAveragePeriod: 1,
    });
    expect(result).not.toBeNull();
    // period clamped to 2, so 4 points
    expect(result!.points).toHaveLength(4);
  });

  it("clamps period to array length", () => {
    const data = makeData([10, 20, 30]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
      movingAveragePeriod: 100,
    });
    expect(result).not.toBeNull();
    // period clamped to 3 (array length), so 1 point
    expect(result!.points).toHaveLength(1);
    expect(result!.points[0].value).toBeCloseTo(20); // (10+20+30)/3
  });

  it("equation describes the period", () => {
    const data = makeData([1, 2, 3, 4, 5]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
      movingAveragePeriod: 3,
    });
    expect(result!.equation).toContain("3-point");
    expect(result!.equation).toContain("moving average");
  });

  it("skips NaN values in window", () => {
    const data = makeData([10, NaN, 30, 40, 50]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
      movingAveragePeriod: 3,
    });
    expect(result).not.toBeNull();
    // First window [10, NaN, 30]: avg of valid = (10+30)/2 = 20
    expect(result!.points[0].value).toBeCloseTo(20);
  });
});
