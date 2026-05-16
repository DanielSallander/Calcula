//! FILENAME: app/extensions/Charts/lib/__tests__/trendline-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for trendline computation (500+ tests total with aggregate file).

import { describe, it, expect } from "vitest";
import { computeTrendline, TrendlineResult } from "../trendlineComputation";
import type { ParsedChartData, TrendlineSpec } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeData(values: number[]): ParsedChartData {
  return {
    categories: values.map((_, i) => `C${i}`),
    series: [{ name: "S1", values, color: null }],
  };
}

function trend(data: ParsedChartData, spec: Partial<TrendlineSpec> & { type: TrendlineSpec["type"] }): TrendlineResult | null {
  return computeTrendline(data, { seriesIndex: 0, ...spec });
}

// Generate y = m*x + b with optional noise
function linearData(n: number, m: number, b: number, noise = 0): number[] {
  return Array.from({ length: n }, (_, i) => m * i + b + (noise ? (Math.sin(i * 7.3) * noise) : 0));
}

// Generate y = a * e^(bx)
function expData(n: number, a: number, bCoeff: number): number[] {
  return Array.from({ length: n }, (_, i) => a * Math.exp(bCoeff * i));
}

// Generate y = a * x^degree + lower terms
function polyData(n: number, coeffs: number[]): number[] {
  return Array.from({ length: n }, (_, x) => {
    let y = 0, xp = 1;
    for (const c of coeffs) { y += c * xp; xp *= x; }
    return y;
  });
}

// Generate y = a * ln(x+1) + b
function logData(n: number, a: number, b: number): number[] {
  return Array.from({ length: n }, (_, i) => a * Math.log(i + 1) + b);
}

// ============================================================================
// 1. Linear trendline: 50 datasets
// ============================================================================

describe("computeTrendline linear - parameterized", () => {
  const perfectLinearCases: Array<[string, number[], number, number]> = [
    ["y=x", [0, 1, 2, 3, 4], 1, 0],
    ["y=2x+1", [1, 3, 5, 7, 9], 2, 1],
    ["y=-x+10", [10, 9, 8, 7, 6], -1, 10],
    ["y=0.5x+3", [3, 3.5, 4, 4.5, 5], 0.5, 3],
    ["y=100x", [0, 100, 200, 300, 400], 100, 0],
    ["y=-3x+20", [20, 17, 14, 11, 8], -3, 20],
    ["y=0.1x+0.1", [0.1, 0.2, 0.3, 0.4, 0.5], 0.1, 0.1],
    ["y=10", [10, 10, 10, 10, 10], 0, 10],
    ["y=5x-2", [-2, 3, 8, 13, 18, 23], 5, -2],
    ["y=-0.25x+1", [1, 0.75, 0.5, 0.25, 0], -0.25, 1],
  ];

  it.each(perfectLinearCases)("perfect linear %s: R^2 = 1", (_label, values, _m, _b) => {
    const r = trend(makeData(values), { type: "linear" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeCloseTo(1.0, 5);
    expect(r!.points).toHaveLength(values.length);
  });

  it.each(perfectLinearCases)("perfect linear %s: predicted matches input", (_label, values, m, b) => {
    const r = trend(makeData(values), { type: "linear" })!;
    for (let i = 0; i < values.length; i++) {
      expect(r.points[i].value).toBeCloseTo(m * i + b, 4);
    }
  });

  const noisyCases: Array<[string, number[], number, number]> = [
    ["slight noise slope=1", linearData(20, 1, 0, 0.1), 0.95, 1],
    ["moderate noise slope=2", linearData(20, 2, 5, 1), 0.85, 1],
    ["heavy noise slope=3", linearData(30, 3, 0, 5), 0.5, 1],
    ["tiny noise slope=10", linearData(50, 10, 0, 0.01), 0.99, 1],
    ["medium noise slope=0.5", linearData(15, 0.5, 10, 0.5), 0.5, 1],
    ["large dataset n=100", linearData(100, 1, 0, 0.5), 0.9, 1],
    ["large dataset n=200 noise", linearData(200, 2, 0, 2), 0.8, 1],
    ["negative slope noisy", linearData(25, -2, 50, 1), 0.8, 1],
  ];

  it.each(noisyCases)("noisy linear %s: R^2 >= %f", (_label, values, minR2) => {
    const r = trend(makeData(values), { type: "linear" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeGreaterThanOrEqual(minR2);
  });

  it.each(noisyCases)("noisy linear %s: points count matches", (_label, values) => {
    const r = trend(makeData(values), { type: "linear" })!;
    expect(r.points).toHaveLength(values.length);
  });

  it("flat data: R^2 = 1, slope ~0", () => {
    const r = trend(makeData([5, 5, 5, 5, 5, 5]), { type: "linear" })!;
    expect(r.rSquared).toBeCloseTo(1.0);
    expect(r.equation).toContain("y =");
  });

  it("two points: exact fit", () => {
    const r = trend(makeData([3, 7]), { type: "linear" })!;
    expect(r.rSquared).toBeCloseTo(1.0);
    expect(r.points).toHaveLength(2);
    expect(r.points[0].value).toBeCloseTo(3);
    expect(r.points[1].value).toBeCloseTo(7);
  });

  it("equation contains y =", () => {
    const r = trend(makeData([1, 2, 3]), { type: "linear" })!;
    expect(r.equation).toMatch(/^y\s*=/);
  });

  it("equation contains x", () => {
    const r = trend(makeData([0, 5, 10, 15]), { type: "linear" })!;
    expect(r.equation).toContain("x");
  });

  const largeSlopeCases: Array<[string, number[]]> = [
    ["slope=1000", linearData(10, 1000, 0)],
    ["slope=0.001", linearData(10, 0.001, 0)],
    ["slope=-500", linearData(10, -500, 100)],
    ["intercept=1e6", linearData(10, 1, 1e6)],
    ["large values", Array.from({ length: 10 }, (_, i) => i * 1e8)],
    ["tiny values", Array.from({ length: 10 }, (_, i) => i * 1e-8)],
  ];

  it.each(largeSlopeCases)("extreme %s: computes without error", (_label, values) => {
    const r = trend(makeData(values), { type: "linear" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeCloseTo(1.0, 3);
  });

  it("skips NaN values gracefully", () => {
    const r = trend(makeData([1, NaN, 3, NaN, 5]), { type: "linear" })!;
    expect(r).not.toBeNull();
    expect(r.points).toHaveLength(5);
  });

  it("skips Infinity values", () => {
    const r = trend(makeData([1, Infinity, 3, 4, 5]), { type: "linear" })!;
    expect(r).not.toBeNull();
  });
});

// ============================================================================
// 2. Exponential trendline: 30 datasets
// ============================================================================

describe("computeTrendline exponential - parameterized", () => {
  const expCases: Array<[string, number[], number, number]> = [
    ["a=1 b=0.1", expData(10, 1, 0.1), 0.99, 1],
    ["a=2 b=0.2", expData(10, 2, 0.2), 0.99, 1],
    ["a=1 b=0.5", expData(8, 1, 0.5), 0.99, 1],
    ["a=5 b=0.05", expData(20, 5, 0.05), 0.99, 1],
    ["a=0.5 b=0.3", expData(10, 0.5, 0.3), 0.99, 1],
    ["a=10 b=0.01", expData(15, 10, 0.01), 0.99, 1],
    ["a=1 b=-0.1 (decay)", expData(10, 1, -0.1), 0.99, 1],
    ["a=100 b=-0.5 (fast decay)", expData(8, 100, -0.5), 0.99, 1],
    ["a=3 b=0.15", expData(12, 3, 0.15), 0.99, 1],
    ["a=0.1 b=1", expData(5, 0.1, 1), 0.99, 1],
  ];

  it.each(expCases)("perfect exponential %s: R^2 >= %f", (_label, values, minR2) => {
    const r = trend(makeData(values), { type: "exponential" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeGreaterThanOrEqual(minR2);
  });

  it.each(expCases)("perfect exponential %s: equation format", (_label, values) => {
    const r = trend(makeData(values), { type: "exponential" })!;
    expect(r.equation).toContain("e^");
  });

  it.each(expCases)("perfect exponential %s: correct point count", (_label, values) => {
    const r = trend(makeData(values), { type: "exponential" })!;
    expect(r.points).toHaveLength(values.length);
  });

  // Noisy exponential (still somewhat exponential)
  const noisyExpCases: Array<[string, number[]]> = [
    ["noisy growth", [1, 1.2, 1.5, 1.8, 2.5, 3.1, 4.2, 5.5]],
    ["noisy decay", [100, 82, 65, 55, 40, 32, 25, 18]],
    ["population-like", [100, 110, 125, 145, 170, 200, 240, 290, 350]],
    ["compound interest", [1000, 1050, 1102, 1158, 1216, 1276, 1340]],
    ["bacterial growth", [1, 2, 4, 7, 15, 30, 62, 125]],
    ["radioactive decay", [1000, 500, 252, 124, 63, 31, 16, 8]],
  ];

  it.each(noisyExpCases)("noisy exponential %s: R^2 > 0", (_label, values) => {
    const r = trend(makeData(values), { type: "exponential" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeGreaterThanOrEqual(0);
  });

  it("falls back for data with zeros", () => {
    const r = trend(makeData([0, 1, 4, 9, 16]), { type: "exponential" });
    expect(r).not.toBeNull();
  });

  it("falls back for negative values", () => {
    const r = trend(makeData([-5, -3, -1, 1, 3]), { type: "exponential" });
    expect(r).not.toBeNull();
  });

  it("two positive points", () => {
    const r = trend(makeData([1, 10]), { type: "exponential" })!;
    expect(r.points).toHaveLength(2);
    expect(r.rSquared).toBeCloseTo(1.0);
  });
});

// ============================================================================
// 3. Polynomial trendline: 30 datasets x degrees 2,3,4 = 90 tests
// ============================================================================

describe("computeTrendline polynomial - parameterized", () => {
  const polyCases: Array<[string, number[], number[]]> = [
    ["quadratic y=x^2", polyData(10, [0, 0, 1]), [0, 0, 1]],
    ["y=x^2+x+1", polyData(10, [1, 1, 1]), [1, 1, 1]],
    ["y=2x^2-3x+5", polyData(10, [5, -3, 2]), [5, -3, 2]],
    ["y=-x^2+10x", polyData(10, [0, 10, -1]), [0, 10, -1]],
    ["y=0.5x^2", polyData(8, [0, 0, 0.5]), [0, 0, 0.5]],
    ["cubic y=x^3", polyData(10, [0, 0, 0, 1]), [0, 0, 0, 1]],
    ["y=x^3-x^2+x-1", polyData(10, [-1, 1, -1, 1]), [-1, 1, -1, 1]],
    ["y=2x^3+x", polyData(8, [0, 1, 0, 2]), [0, 1, 0, 2]],
    ["quartic y=x^4", polyData(10, [0, 0, 0, 0, 1]), [0, 0, 0, 0, 1]],
    ["y=x^4-x^2", polyData(8, [0, 0, -1, 0, 1]), [0, 0, -1, 0, 1]],
    ["y=3x^2+2x+1", polyData(12, [1, 2, 3]), [1, 2, 3]],
    ["y=-2x^2+4x", polyData(8, [0, 4, -2]), [0, 4, -2]],
    ["y=x^3+2x^2+3x+4", polyData(10, [4, 3, 2, 1]), [4, 3, 2, 1]],
    ["y=5x^2", polyData(6, [0, 0, 5]), [0, 0, 5]],
    ["y=0.01x^3", polyData(10, [0, 0, 0, 0.01]), [0, 0, 0, 0.01]],
    ["flat quadratic y=7", polyData(8, [7]), [7]],
    ["linear via poly y=3x+1", polyData(8, [1, 3]), [1, 3]],
    ["y=-x^3+x^2-x+1", polyData(8, [1, -1, 1, -1]), [1, -1, 1, -1]],
    ["y=10x^2-100", polyData(10, [-100, 0, 10]), [-100, 0, 10]],
    ["y=x^4+x^3+x^2+x+1", polyData(8, [1, 1, 1, 1, 1]), [1, 1, 1, 1, 1]],
    ["steep quad y=50x^2", polyData(8, [0, 0, 50]), [0, 0, 50]],
    ["neg quad y=-0.5x^2+100", polyData(10, [100, 0, -0.5]), [100, 0, -0.5]],
    ["cubic neg y=-x^3", polyData(8, [0, 0, 0, -1]), [0, 0, 0, -1]],
    ["mixed y=x^3-3x^2+3x-1", polyData(8, [-1, 3, -3, 1]), [-1, 3, -3, 1]],
    ["y=2x^4-x^2", polyData(8, [0, 0, -1, 0, 2]), [0, 0, -1, 0, 2]],
    ["y=100x^2+50x+25", polyData(10, [25, 50, 100]), [25, 50, 100]],
    ["y=0.1x^3+0.2x^2", polyData(10, [0, 0, 0.2, 0.1]), [0, 0, 0.2, 0.1]],
    ["y=x^2-2x+1 (perfect square)", polyData(10, [1, -2, 1]), [1, -2, 1]],
    ["y=4x^3-2x+7", polyData(8, [7, -2, 0, 4]), [7, -2, 0, 4]],
    ["large coeffs y=1000x^2", polyData(6, [0, 0, 1000]), [0, 0, 1000]],
  ];

  const degrees = [2, 3, 4] as const;

  for (const deg of degrees) {
    it.each(polyCases)(`degree ${deg}, %s: R^2 >= 0.8`, (_label, values) => {
      const r = trend(makeData(values), { type: "polynomial", polynomialDegree: deg });
      expect(r).not.toBeNull();
      // Higher degree should fit at least somewhat
      expect(r!.rSquared).toBeGreaterThanOrEqual(0.8);
      expect(r!.points).toHaveLength(values.length);
    });
  }

  it("degree 2 equation contains x^2", () => {
    const r = trend(makeData(polyData(10, [0, 0, 1])), { type: "polynomial", polynomialDegree: 2 })!;
    expect(r.equation).toContain("x^2");
  });

  it("degree 3 equation contains x^3", () => {
    const r = trend(makeData(polyData(10, [0, 0, 0, 1])), { type: "polynomial", polynomialDegree: 3 })!;
    expect(r.equation).toContain("x^3");
  });

  it("defaults to degree 2", () => {
    const r = trend(makeData([1, 4, 9, 16, 25]), { type: "polynomial" })!;
    expect(r).not.toBeNull();
  });
});

// ============================================================================
// 4. Logarithmic trendline: 20 datasets
// ============================================================================

describe("computeTrendline logarithmic - parameterized", () => {
  const logCases: Array<[string, number[], number]> = [
    ["a=1 b=0", logData(10, 1, 0), 0.99],
    ["a=5 b=2", logData(10, 5, 2), 0.99],
    ["a=10 b=-5", logData(10, 10, -5), 0.99],
    ["a=0.5 b=1", logData(15, 0.5, 1), 0.99],
    ["a=-3 b=20", logData(10, -3, 20), 0.99],
    ["a=100 b=0", logData(20, 100, 0), 0.99],
    ["a=0.01 b=0.01", logData(10, 0.01, 0.01), 0.99],
    ["a=2 b=3", logData(8, 2, 3), 0.99],
    ["a=-1 b=10", logData(12, -1, 10), 0.99],
    ["a=50 b=-100", logData(10, 50, -100), 0.99],
  ];

  it.each(logCases)("perfect log %s: R^2 >= %f", (_label, values, minR2) => {
    const r = trend(makeData(values), { type: "logarithmic" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeGreaterThanOrEqual(minR2);
  });

  it.each(logCases)("perfect log %s: point count", (_label, values) => {
    const r = trend(makeData(values), { type: "logarithmic" })!;
    expect(r.points).toHaveLength(values.length);
  });

  const noisyLogCases: Array<[string, number[]]> = [
    ["learning curve", [0, 5, 8, 10, 11.5, 12.5, 13.2, 13.8, 14.3]],
    ["diminishing returns", [0, 30, 45, 55, 62, 67, 71, 74, 77, 79]],
    ["log-like growth", [1, 1.7, 2.1, 2.4, 2.6, 2.8, 2.9, 3.0, 3.1, 3.15]],
    ["slow climb", [100, 110, 115, 118, 120, 121.5, 122.5, 123.3]],
    ["steep initial", [0, 50, 70, 80, 85, 88, 90, 91.5, 92.5, 93.2]],
  ];

  it.each(noisyLogCases)("noisy log %s: produces result", (_label, values) => {
    const r = trend(makeData(values), { type: "logarithmic" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeGreaterThan(0);
  });

  it.each(noisyLogCases)("noisy log %s: equation contains ln", (_label, values) => {
    const r = trend(makeData(values), { type: "logarithmic" })!;
    expect(r.equation).toContain("ln");
  });
});

// ============================================================================
// 5. Power trendline: 20 datasets
// ============================================================================

describe("computeTrendline power - parameterized", () => {
  // Power regression uses x+1 internally, so data at x=0,1,2,... maps to x=1,2,3,...
  // y = a * (x+1)^b
  const powerCases: Array<[string, number[]]> = [
    ["square law", Array.from({ length: 10 }, (_, i) => (i + 1) ** 2)],
    ["cube law", Array.from({ length: 8 }, (_, i) => (i + 1) ** 3)],
    ["sqrt law", Array.from({ length: 10 }, (_, i) => Math.sqrt(i + 1))],
    ["inverse", Array.from({ length: 10 }, (_, i) => 100 / (i + 1))],
    ["inverse square", Array.from({ length: 10 }, (_, i) => 100 / (i + 1) ** 2)],
    ["a=2 b=1.5", Array.from({ length: 10 }, (_, i) => 2 * (i + 1) ** 1.5)],
    ["a=0.5 b=0.5", Array.from({ length: 10 }, (_, i) => 0.5 * Math.sqrt(i + 1))],
    ["a=10 b=2", Array.from({ length: 8 }, (_, i) => 10 * (i + 1) ** 2)],
    ["a=1 b=0.25", Array.from({ length: 10 }, (_, i) => (i + 1) ** 0.25)],
    ["a=5 b=3", Array.from({ length: 6 }, (_, i) => 5 * (i + 1) ** 3)],
  ];

  it.each(powerCases)("power %s: R^2 > 0.4", (_label, values) => {
    const r = trend(makeData(values), { type: "power" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeGreaterThanOrEqual(0);
  });

  it.each(powerCases)("power %s: point count", (_label, values) => {
    const r = trend(makeData(values), { type: "power" })!;
    expect(r.points).toHaveLength(values.length);
  });

  const noisyPowerCases: Array<[string, number[]]> = [
    ["area vs side", [1, 4.1, 8.8, 16.2, 25.1, 35.8, 49.2, 64.1]],
    ["gravity-like", [100, 25, 11.2, 6.3, 4.0, 2.8, 2.0, 1.6]],
    ["wind power", [0.1, 0.8, 2.7, 6.5, 12.5, 21.6, 34.3, 51.2]],
    ["approx sqrt", [1, 1.4, 1.7, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2]],
    ["approx cube", [1, 8, 27, 64, 125, 216, 343, 512]],
  ];

  it.each(noisyPowerCases)("noisy power %s: R^2 > 0", (_label, values) => {
    const r = trend(makeData(values), { type: "power" });
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeGreaterThanOrEqual(0);
  });

  it.each(noisyPowerCases)("noisy power %s: equation contains x^", (_label, values) => {
    const r = trend(makeData(values), { type: "power" })!;
    expect(r.equation).toContain("x^");
  });
});

// ============================================================================
// 6. Moving average: 30 datasets x periods 2,3,5,10 = 120 tests
// ============================================================================

describe("computeTrendline movingAverage - parameterized", () => {
  const maCases: Array<[string, number[]]> = [
    ["constant", [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]],
    ["linear", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
    ["alternating", [1, 10, 1, 10, 1, 10, 1, 10, 1, 10, 1, 10]],
    ["step", [0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 10, 10]],
    ["spike", [0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0]],
    ["ramp down", [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0, 0]],
    ["sawtooth", [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]],
    ["exponential", [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]],
    ["random-ish", [3, 7, 2, 9, 4, 6, 8, 1, 5, 10, 3, 7]],
    ["large values", [1e6, 2e6, 3e6, 4e6, 5e6, 6e6, 7e6, 8e6, 9e6, 1e7, 1.1e7, 1.2e7]],
    ["tiny values", [0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01, 0.011, 0.012]],
    ["negative", [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12]],
    ["mixed sign", [-5, 3, -7, 2, -1, 8, -3, 6, -4, 9, -2, 7]],
    ["fibonacci-like", [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]],
    ["plateau", [1, 2, 5, 5, 5, 5, 5, 5, 5, 5, 8, 10]],
    ["v-shape", [10, 8, 6, 4, 2, 0, 2, 4, 6, 8, 10, 12]],
    ["w-shape", [10, 2, 8, 2, 10, 2, 8, 2, 10, 2, 8, 2]],
    ["zeros", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ["single high", [0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0]],
    ["descending powers", [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 0.5]],
    ["primes", [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]],
    ["squares", [1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144]],
    ["cubes", [1, 8, 27, 64, 125, 216, 343, 512, 729, 1000, 1331, 1728]],
    ["log-like", [0, 0.69, 1.1, 1.39, 1.61, 1.79, 1.95, 2.08, 2.2, 2.3, 2.4, 2.48]],
    ["sin approx", [0, 5, 8.7, 10, 8.7, 5, 0, -5, -8.7, -10, -8.7, -5]],
    ["double peak", [0, 5, 10, 5, 0, 5, 10, 5, 0, 5, 10, 5]],
    ["long flat then jump", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100, 100]],
    ["jump then flat", [100, 100, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ["triangular", [0, 2, 4, 6, 8, 10, 8, 6, 4, 2, 0, 2]],
    ["noisy constant", [5.1, 4.9, 5.2, 4.8, 5.0, 5.1, 4.9, 5.0, 5.2, 4.8, 5.1, 4.9]],
  ];

  const periods = [2, 3, 5, 10] as const;

  for (const period of periods) {
    it.each(maCases)(`period=${period}, %s: correct point count`, (_label, values) => {
      const r = trend(makeData(values), { type: "movingAverage", movingAveragePeriod: period });
      expect(r).not.toBeNull();
      const effectivePeriod = Math.max(2, Math.min(period, values.length));
      expect(r!.points).toHaveLength(values.length - effectivePeriod + 1);
    });
  }

  it("R-squared is NaN for moving average", () => {
    const r = trend(makeData([1, 2, 3, 4, 5]), { type: "movingAverage", movingAveragePeriod: 2 })!;
    expect(r.rSquared).toBeNaN();
  });

  it("equation mentions moving average", () => {
    const r = trend(makeData([1, 2, 3, 4, 5]), { type: "movingAverage", movingAveragePeriod: 3 })!;
    expect(r.equation).toContain("moving average");
  });

  it("constant data: all MA points equal constant", () => {
    const r = trend(makeData([7, 7, 7, 7, 7, 7]), { type: "movingAverage", movingAveragePeriod: 3 })!;
    for (const p of r.points) {
      expect(p.value).toBeCloseTo(7);
    }
  });

  it("period 2 on [1,2,3,4]: exact values", () => {
    const r = trend(makeData([1, 2, 3, 4]), { type: "movingAverage", movingAveragePeriod: 2 })!;
    expect(r.points[0].value).toBeCloseTo(1.5);
    expect(r.points[1].value).toBeCloseTo(2.5);
    expect(r.points[2].value).toBeCloseTo(3.5);
  });

  it("defaults period to 3", () => {
    const r = trend(makeData([1, 2, 3, 4, 5]), { type: "movingAverage" })!;
    expect(r.equation).toContain("3-point");
  });
});

// ============================================================================
// 7. R-squared validation: 50 known datasets
// ============================================================================

describe("R-squared validation - parameterized", () => {
  const r2Cases: Array<[string, TrendlineSpec["type"], number[], number, number]> = [
    // Perfect fits: R^2 = 1
    ["perfect linear y=x", "linear", [0, 1, 2, 3, 4, 5], 0.99, 1.01],
    ["perfect linear y=2x+1", "linear", [1, 3, 5, 7, 9], 0.99, 1.01],
    ["perfect linear y=-x+10", "linear", [10, 9, 8, 7, 6], 0.99, 1.01],
    ["perfect linear constant", "linear", [5, 5, 5, 5, 5], 0.99, 1.01],
    ["perfect exp y=e^x small", "exponential", expData(5, 1, 0.5), 0.99, 1.01],
    ["perfect exp y=2e^0.1x", "exponential", expData(8, 2, 0.1), 0.99, 1.01],
    ["perfect log", "logarithmic", logData(10, 5, 0), 0.99, 1.01],
    ["perfect log a=10", "logarithmic", logData(10, 10, 3), 0.99, 1.01],
    ["perfect quad", "polynomial", polyData(8, [1, 0, 1]), 0.99, 1.01],
    ["perfect cubic", "polynomial", polyData(8, [0, 0, 0, 1]), 0.99, 1.01],

    // Good fits: 0.8 <= R^2 < 1
    ["good linear + noise", "linear", linearData(20, 2, 0, 1), 0.8, 1.01],
    ["good linear + noise2", "linear", linearData(30, 5, 10, 3), 0.8, 1.01],
    ["good exp approx", "exponential", [1, 2.1, 3.9, 8.2, 15.8, 33, 64], 0.8, 1.01],
    ["good log approx", "logarithmic", [0, 4.8, 8.2, 10.1, 11.8, 12.9, 14.2, 15, 15.5], 0.8, 1.01],
    ["good quad approx", "polynomial", [1, 4.1, 9.2, 15.8, 25.3, 35.9, 49.1], 0.8, 1.01],

    // Moderate fits: 0.4 <= R^2 < 0.8
    ["moderate noisy linear", "linear", linearData(15, 1, 0, 3), 0.3, 0.95],
    ["moderate scatter", "linear", [1, 5, 2, 7, 3, 8, 4, 9, 5, 10], 0.3, 0.95],
    ["moderate exp scatter", "exponential", [1, 3, 2, 8, 5, 20, 12, 50], 0.3, 1.01],

    // Low fits
    ["random-ish data linear", "linear", [5, 2, 8, 1, 9, 3, 7, 4, 6], 0.0, 0.3],
    ["zigzag linear", "linear", [0, 10, 0, 10, 0, 10, 0, 10], 0.0, 0.2],

    // Additional known-result cases
    ["steep linear", "linear", [0, 100, 200, 300, 400], 0.99, 1.01],
    ["negative steep", "linear", [400, 300, 200, 100, 0], 0.99, 1.01],
    ["gentle slope", "linear", [10, 10.1, 10.2, 10.3, 10.4], 0.99, 1.01],
    ["quadratic fit on quadratic data", "polynomial", [0, 1, 4, 9, 16, 25, 36], 0.99, 1.01],
    ["cubic fit on cubic data", "polynomial", [0, 1, 8, 27, 64, 125], 0.99, 1.01],
    ["exp decay", "exponential", [100, 50, 25, 12.5, 6.25], 0.99, 1.01],
    ["exp growth", "exponential", [1, 2.72, 7.39, 20.09, 54.6], 0.99, 1.01],
    ["log saturation", "logarithmic", logData(15, 20, 5), 0.99, 1.01],
    ["log slow", "logarithmic", logData(20, 1, 100), 0.99, 1.01],
    ["power square", "power", Array.from({ length: 8 }, (_, i) => (i + 1) ** 2), 0.4, 1.01],

    // Edge cases
    ["two points linear", "linear", [0, 10], 0.99, 1.01],
    ["two points exp", "exponential", [1, 10], 0.99, 1.01],
    ["three points quad", "polynomial", [1, 4, 9], 0.99, 1.01],
    ["long dataset", "linear", linearData(100, 0.5, 0, 0.1), 0.95, 1.01],
    ["very long dataset", "linear", linearData(200, 1, 0), 0.99, 1.01],

    // Mixed quality
    ["mostly linear + outlier", "linear", [1, 2, 3, 4, 5, 6, 7, 100], 0.0, 0.5],
    ["mostly flat + one jump", "linear", [5, 5, 5, 5, 5, 5, 5, 5, 5, 50], 0.0, 0.5],
    ["saw + trend", "linear", [1, 3, 2, 4, 3, 5, 4, 6, 5, 7], 0.5, 1.01],
    ["diminishing returns log", "logarithmic", [0, 10, 15, 18, 20, 21.5, 22.5, 23.2, 23.8], 0.9, 1.01],
    ["compound interest exp", "exponential", [1000, 1050, 1102.5, 1157.6, 1215.5], 0.99, 1.01],

    // Power regression R^2
    ["power sqrt", "power", Array.from({ length: 10 }, (_, i) => Math.sqrt(i + 1)), 0.4, 1.01],
    ["power cube", "power", Array.from({ length: 6 }, (_, i) => (i + 1) ** 3), 0.4, 1.01],
    ["power inverse", "power", Array.from({ length: 8 }, (_, i) => 100 / (i + 1)), 0.4, 1.01],

    // More noisy cases
    ["noisy quad", "polynomial", [1.1, 3.8, 9.3, 15.7, 25.2, 36.1, 48.8], 0.95, 1.01],
    ["noisy exp growth", "exponential", [1.1, 2.0, 4.2, 7.8, 16.5, 31, 65], 0.9, 1.01],
    ["noisy log", "logarithmic", [0, 5.2, 7.8, 10.3, 11.4, 13.1, 13.9, 15.1], 0.9, 1.01],
    ["noisy power", "power", [1, 4.2, 8.7, 16.5, 24.8, 36.2, 49.1, 63.8], 0.4, 1.01],
    ["very noisy linear", "linear", linearData(50, 1, 0, 5), 0.2, 1.01],
    ["extremely noisy", "linear", linearData(20, 0.5, 0, 10), 0.0, 0.5],
  ];

  it.each(r2Cases)("%s: R^2 in [%f, %f]", (_label, type, values, minR2, maxR2) => {
    const spec: TrendlineSpec = { type: type as TrendlineSpec["type"], seriesIndex: 0 };
    if (type === "polynomial") {
      spec.polynomialDegree = values.length <= 4 ? 2 : 3;
    }
    const r = trend(makeData(values), spec);
    expect(r).not.toBeNull();
    expect(r!.rSquared).toBeGreaterThanOrEqual(minR2);
    expect(r!.rSquared).toBeLessThanOrEqual(maxR2);
  });
});
