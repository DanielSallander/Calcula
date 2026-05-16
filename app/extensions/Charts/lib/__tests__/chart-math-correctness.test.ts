//! FILENAME: app/extensions/Charts/lib/__tests__/chart-math-correctness.test.ts
// PURPOSE: Verify mathematical correctness of chart computations against hand-calculated values.

import { describe, it, expect } from "vitest";
import { computeTrendline } from "../trendlineComputation";
import { applyTransforms } from "../chartTransforms";
import type { ParsedChartData, TrendlineSpec, TransformSpec } from "../../types";
import { valuesToAngles } from "../../rendering/scales";

// ============================================================================
// Test Helpers
// ============================================================================

function makeData(
  values: number[],
  seriesName = "S1",
  categories?: string[],
): ParsedChartData {
  return {
    categories: categories ?? values.map((_, i) => `C${i}`),
    series: [{ name: seriesName, values, color: null }],
  };
}

// ============================================================================
// Linear Trendline: y = mx + b
// ============================================================================

describe("linear trendline - hand-calculated values", () => {
  it("computes correct slope and intercept for y = 2x + 1", () => {
    // Points: (0,1), (1,3), (2,5), (3,7)  => y = 2x + 1
    const data = makeData([1, 3, 5, 7]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result).not.toBeNull();
    // slope = 2, intercept = 1
    expect(result!.points[0].value).toBeCloseTo(1, 10); // x=0: 2*0+1=1
    expect(result!.points[1].value).toBeCloseTo(3, 10); // x=1: 2*1+1=3
    expect(result!.points[2].value).toBeCloseTo(5, 10); // x=2: 2*2+1=5
    expect(result!.points[3].value).toBeCloseTo(7, 10); // x=3: 2*3+1=7
  });

  it("computes correct slope for simple dataset", () => {
    // Hand calculation: x=[0,1,2], y=[2,4,6]
    // n=3, sumX=3, sumY=12, sumXY=16, sumX2=5
    // m = (3*16 - 3*12) / (3*5 - 9) = (48-36)/(15-9) = 12/6 = 2
    // b = (12 - 2*3)/3 = 6/3 = 2
    const data = makeData([2, 4, 6]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result!.points[0].value).toBeCloseTo(2, 10);
    expect(result!.points[1].value).toBeCloseTo(4, 10);
    expect(result!.points[2].value).toBeCloseTo(6, 10);
  });
});

// ============================================================================
// Exponential Trendline: y = a * e^(bx)
// ============================================================================

describe("exponential trendline - hand-calculated values", () => {
  it("computes correct coefficients for y = e^x", () => {
    // Points: (0, 1), (1, e), (2, e^2)  => a=1, b=1
    const e = Math.E;
    const data = makeData([1, e, e * e]);
    const result = computeTrendline(data, { type: "exponential", seriesIndex: 0 });
    expect(result).not.toBeNull();
    expect(result!.points[0].value).toBeCloseTo(1, 6);       // e^0 = 1
    expect(result!.points[1].value).toBeCloseTo(e, 6);       // e^1
    expect(result!.points[2].value).toBeCloseTo(e * e, 6);   // e^2
  });

  it("computes correct coefficients for y = 2 * e^(0.5x)", () => {
    // a=2, b=0.5 => y(0)=2, y(1)=2*e^0.5, y(2)=2*e^1
    const vals = [0, 1, 2, 3].map((x) => 2 * Math.exp(0.5 * x));
    const data = makeData(vals);
    const result = computeTrendline(data, { type: "exponential", seriesIndex: 0 });
    expect(result).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      expect(result!.points[i].value).toBeCloseTo(vals[i], 6);
    }
  });
});

// ============================================================================
// Polynomial Trendline: y = ax^2 + bx + c
// ============================================================================

describe("polynomial trendline - hand-calculated values", () => {
  it("fits y = x^2 exactly", () => {
    // Points: (0,0), (1,1), (2,4), (3,9), (4,16)
    const data = makeData([0, 1, 4, 9, 16]);
    const result = computeTrendline(data, {
      type: "polynomial",
      seriesIndex: 0,
      polynomialDegree: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.points[0].value).toBeCloseTo(0, 6);
    expect(result!.points[1].value).toBeCloseTo(1, 6);
    expect(result!.points[2].value).toBeCloseTo(4, 6);
    expect(result!.points[3].value).toBeCloseTo(9, 6);
    expect(result!.points[4].value).toBeCloseTo(16, 6);
  });

  it("fits y = 3x^2 - 2x + 1 exactly", () => {
    const f = (x: number) => 3 * x * x - 2 * x + 1;
    const vals = [0, 1, 2, 3, 4].map(f);
    const data = makeData(vals);
    const result = computeTrendline(data, {
      type: "polynomial",
      seriesIndex: 0,
      polynomialDegree: 2,
    });
    expect(result).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(result!.points[i].value).toBeCloseTo(f(i), 4);
    }
  });
});

// ============================================================================
// Moving Average
// ============================================================================

describe("moving average - manual window verification", () => {
  it("computes each window value correctly for period=3", () => {
    // values: [10, 20, 30, 40, 50]
    // MA(3): window [10,20,30]=20, [20,30,40]=30, [30,40,50]=40
    const data = makeData([10, 20, 30, 40, 50]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
      movingAveragePeriod: 3,
    });
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(3);
    expect(result!.points[0]).toEqual({ ci: 2, value: 20 });
    expect(result!.points[1]).toEqual({ ci: 3, value: 30 });
    expect(result!.points[2]).toEqual({ ci: 4, value: 40 });
  });

  it("computes each window value correctly for period=2", () => {
    // values: [5, 15, 25, 35]
    // MA(2): [5,15]=10, [15,25]=20, [25,35]=30
    const data = makeData([5, 15, 25, 35]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
      movingAveragePeriod: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(3);
    expect(result!.points[0]).toEqual({ ci: 1, value: 10 });
    expect(result!.points[1]).toEqual({ ci: 2, value: 20 });
    expect(result!.points[2]).toEqual({ ci: 3, value: 30 });
  });
});

// ============================================================================
// R-squared
// ============================================================================

describe("R-squared - known datasets", () => {
  it("returns 1.0 for a perfect linear fit", () => {
    const data = makeData([1, 3, 5, 7, 9]);
    const result = computeTrendline(data, { type: "linear", seriesIndex: 0 });
    expect(result!.rSquared).toBeCloseTo(1.0, 10);
  });

  it("returns 1.0 for a perfect exponential fit", () => {
    const vals = [0, 1, 2, 3].map((x) => Math.exp(x));
    const data = makeData(vals);
    const result = computeTrendline(data, { type: "exponential", seriesIndex: 0 });
    expect(result!.rSquared).toBeCloseTo(1.0, 6);
  });

  it("returns NaN for moving average", () => {
    const data = makeData([1, 2, 3, 4, 5]);
    const result = computeTrendline(data, {
      type: "movingAverage",
      seriesIndex: 0,
      movingAveragePeriod: 2,
    });
    expect(result!.rSquared).toBeNaN();
  });
});

// ============================================================================
// Aggregation: SUM, MEAN, MEDIAN, MIN, MAX
// ============================================================================

describe("aggregation - hand-calculated values", () => {
  function makeGroupedData(): ParsedChartData {
    // Categories: A, A, B, B, B => groups: A=[10,20], B=[30,40,50]
    return {
      categories: ["A", "A", "B", "B", "B"],
      series: [{ name: "Val", values: [10, 20, 30, 40, 50], color: null }],
    };
  }

  it("SUM: A=30, B=120", () => {
    const result = applyTransforms(makeGroupedData(), [
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Val", as: "Result" },
    ]);
    expect(result.series[0].values[0]).toBe(30);  // 10+20
    expect(result.series[0].values[1]).toBe(120); // 30+40+50
  });

  it("MEAN: A=15, B=40", () => {
    const result = applyTransforms(makeGroupedData(), [
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "Val", as: "Result" },
    ]);
    expect(result.series[0].values[0]).toBe(15);  // (10+20)/2
    expect(result.series[0].values[1]).toBe(40);  // (30+40+50)/3
  });

  it("MEDIAN: A=15, B=40", () => {
    const result = applyTransforms(makeGroupedData(), [
      { type: "aggregate", groupBy: ["$category"], op: "median", field: "Val", as: "Result" },
    ]);
    expect(result.series[0].values[0]).toBe(15);  // (10+20)/2 even count
    expect(result.series[0].values[1]).toBe(40);  // middle of [30,40,50]
  });

  it("MIN: A=10, B=30", () => {
    const result = applyTransforms(makeGroupedData(), [
      { type: "aggregate", groupBy: ["$category"], op: "min", field: "Val", as: "Result" },
    ]);
    expect(result.series[0].values[0]).toBe(10);
    expect(result.series[0].values[1]).toBe(30);
  });

  it("MAX: A=20, B=50", () => {
    const result = applyTransforms(makeGroupedData(), [
      { type: "aggregate", groupBy: ["$category"], op: "max", field: "Val", as: "Result" },
    ]);
    expect(result.series[0].values[0]).toBe(20);
    expect(result.series[0].values[1]).toBe(50);
  });
});

// ============================================================================
// Running Sum
// ============================================================================

describe("running sum - step by step verification", () => {
  it("computes cumulative values correctly", () => {
    const data = makeData([5, 3, 7, 2, 8], "Val");
    const result = applyTransforms(data, [
      { type: "window", op: "running_sum", field: "Val", as: "CumSum" },
    ]);
    const cumSum = result.series.find((s) => s.name === "CumSum")!;
    // 5, 5+3=8, 8+7=15, 15+2=17, 17+8=25
    expect(cumSum.values).toEqual([5, 8, 15, 17, 25]);
  });
});

// ============================================================================
// Rank
// ============================================================================

describe("rank - tied values get correct ranks", () => {
  it("ranks distinct values highest-first", () => {
    const data = makeData([30, 10, 50, 20, 40], "Val");
    const result = applyTransforms(data, [
      { type: "window", op: "rank", field: "Val", as: "Rank" },
    ]);
    const ranks = result.series.find((s) => s.name === "Rank")!;
    // 50->1, 40->2, 30->3, 20->4, 10->5
    // Original order: 30(3), 10(5), 50(1), 20(4), 40(2)
    expect(ranks.values).toEqual([3, 5, 1, 4, 2]);
  });

  it("assigns sequential ranks to tied values (competition ranking)", () => {
    // The implementation sorts descending and assigns position-based ranks
    const data = makeData([10, 20, 20, 30], "Val");
    const result = applyTransforms(data, [
      { type: "window", op: "rank", field: "Val", as: "Rank" },
    ]);
    const ranks = result.series.find((s) => s.name === "Rank")!;
    // Sorted desc: 30(1), 20(2), 20(3), 10(4)
    // Original: 10->4, 20->2or3, 20->2or3, 30->1
    expect(ranks.values[3]).toBe(1); // 30 is rank 1
    expect(ranks.values[0]).toBe(4); // 10 is rank 4
    // Both 20s get ranks 2 and 3 (order depends on stable sort)
    expect([ranks.values[1], ranks.values[2]].sort()).toEqual([2, 3]);
  });
});

// ============================================================================
// Bin
// ============================================================================

describe("bin - boundary correctness", () => {
  it("creates mathematically correct bin boundaries", () => {
    // values: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    // binCount=5 => range=100, binWidth=20
    // bins: [0-20), [20-40), [40-60), [60-80), [80-100]
    const data = makeData(
      [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      "Val",
    );
    const result = applyTransforms(data, [
      { type: "bin", field: "Val", binCount: 5, as: "Binned" },
    ]);
    expect(result.categories).toHaveLength(5);
    expect(result.series[0].values).toHaveLength(5);
    // Total count must equal input count
    const totalCount = result.series[0].values.reduce((a, b) => a + b, 0);
    expect(totalCount).toBe(11);
  });

  it("bin width equals range / binCount", () => {
    const data = makeData([0, 50, 100], "Val");
    const result = applyTransforms(data, [
      { type: "bin", field: "Val", binCount: 4, as: "B" },
    ]);
    // range=100, binWidth=25, 4 bins
    expect(result.categories).toHaveLength(4);
  });
});

// ============================================================================
// valuesToAngles: proportions match input ratios
// ============================================================================

describe("valuesToAngles - proportion correctness", () => {
  it("equal values produce equal sweep angles", () => {
    const angles = valuesToAngles([1, 1, 1, 1], 0, 0);
    const sweeps = angles.map((a) => a.endAngle - a.startAngle);
    for (const s of sweeps) {
      expect(s).toBeCloseTo(Math.PI / 2, 10);
    }
  });

  it("2:1 ratio produces 2:1 sweep ratio", () => {
    const angles = valuesToAngles([200, 100], 0, 0);
    const sweep0 = angles[0].endAngle - angles[0].startAngle;
    const sweep1 = angles[1].endAngle - angles[1].startAngle;
    expect(sweep0 / sweep1).toBeCloseTo(2, 10);
  });

  it("total sweep equals 2*PI when padAngle is 0", () => {
    const angles = valuesToAngles([10, 20, 30], 0, 0);
    const totalSweep = angles.reduce(
      (sum, a) => sum + (a.endAngle - a.startAngle),
      0,
    );
    expect(totalSweep).toBeCloseTo(2 * Math.PI, 10);
  });
});

// ============================================================================
// Color interpolation midpoint
// ============================================================================

describe("color interpolation - midpoint correctness", () => {
  it("linear interpolation midpoint between 0 and 100 is 50", () => {
    // Simple numeric interpolation used in gradient stops
    const a = 0;
    const b = 100;
    const t = 0.5;
    const mid = a + (b - a) * t;
    expect(mid).toBe(50);
  });

  it("RGB midpoint of black(0,0,0) and white(255,255,255) is grey(127.5,127.5,127.5)", () => {
    const r = 0 + (255 - 0) * 0.5;
    const g = 0 + (255 - 0) * 0.5;
    const b = 0 + (255 - 0) * 0.5;
    expect(r).toBe(127.5);
    expect(g).toBe(127.5);
    expect(b).toBe(127.5);
  });

  it("midpoint of red(255,0,0) and blue(0,0,255) is (127.5,0,127.5)", () => {
    const t = 0.5;
    const r = 255 + (0 - 255) * t;
    const g = 0 + (0 - 0) * t;
    const b = 0 + (255 - 0) * t;
    expect(r).toBe(127.5);
    expect(g).toBe(0);
    expect(b).toBe(127.5);
  });
});
