//! FILENAME: app/extensions/Charts/lib/__tests__/chart-property-tests.test.ts
// PURPOSE: Property-based/fuzz-style tests for chart utilities.
// CONTEXT: Verifies invariants hold across random inputs without external libraries.

import { describe, it, expect } from "vitest";
import { applyChartFilters } from "../chartFilters";
import { computeTrendline } from "../trendlineComputation";
import { createLinearScale, valuesToAngles } from "../../rendering/scales";
import type { ParsedChartData, ChartFilters, TrendlineSpec } from "../../types";

// ============================================================================
// Seeded PRNG for reproducibility
// ============================================================================

function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Helpers
// ============================================================================

function randomChartData(rng: () => number, maxSeries = 10, maxCategories = 20): ParsedChartData {
  const numSeries = Math.floor(rng() * maxSeries) + 1;
  const numCategories = Math.floor(rng() * maxCategories) + 1;
  const categories = Array.from({ length: numCategories }, (_, i) => `Cat${i}`);
  const series = Array.from({ length: numSeries }, (_, si) => ({
    name: `Series${si}`,
    values: Array.from({ length: numCategories }, () => rng() * 200 - 50),
    color: null,
  }));
  return { categories, series };
}

// ============================================================================
// applyChartFilters: output series count <= input series count
// ============================================================================

describe("applyChartFilters invariants", () => {
  it("output series count <= input series count for random filters", () => {
    const rng = createRng(42);

    for (let i = 0; i < 300; i++) {
      const data = randomChartData(rng);
      const numHidden = Math.floor(rng() * (data.series.length + 2));
      const hiddenSeries: number[] = [];
      for (let j = 0; j < numHidden; j++) {
        hiddenSeries.push(Math.floor(rng() * (data.series.length + 5)));
      }
      const hiddenCategories: number[] = [];
      const numHiddenCats = Math.floor(rng() * (data.categories.length + 2));
      for (let j = 0; j < numHiddenCats; j++) {
        hiddenCategories.push(Math.floor(rng() * (data.categories.length + 5)));
      }

      const filters: ChartFilters = { hiddenSeries, hiddenCategories };
      const result = applyChartFilters(data, filters);

      expect(result.series.length).toBeLessThanOrEqual(data.series.length);
      expect(result.categories.length).toBeLessThanOrEqual(data.categories.length);

      // All series should have values matching filtered category count
      for (const s of result.series) {
        expect(s.values.length).toBe(result.categories.length);
      }
    }
  });

  it("undefined filters return data unchanged", () => {
    const rng = createRng(100);
    for (let i = 0; i < 50; i++) {
      const data = randomChartData(rng);
      const result = applyChartFilters(data, undefined);
      expect(result).toBe(data); // same reference
    }
  });
});

// ============================================================================
// trendline R-squared always between 0 and 1 for random data
// ============================================================================

describe("trendline R-squared invariants", () => {
  it("R-squared is between 0 and 1 for random linear trendlines", () => {
    const rng = createRng(77);
    const types: TrendlineSpec["type"][] = ["linear", "exponential", "logarithmic", "polynomial"];

    for (let i = 0; i < 200; i++) {
      const numPoints = Math.floor(rng() * 20) + 3;
      const data: ParsedChartData = {
        categories: Array.from({ length: numPoints }, (_, j) => `C${j}`),
        series: [{
          name: "S1",
          // Use positive values to keep exponential regression happy
          values: Array.from({ length: numPoints }, () => rng() * 100 + 0.1),
          color: null,
        }],
      };

      const trendType = types[Math.floor(rng() * types.length)];
      const spec: TrendlineSpec = { type: trendType, seriesIndex: 0 };
      if (trendType === "polynomial") {
        spec.polynomialDegree = Math.floor(rng() * 4) + 2;
      }

      const result = computeTrendline(data, spec);
      if (result && isFinite(result.rSquared)) {
        expect(result.rSquared).toBeGreaterThanOrEqual(0);
        expect(result.rSquared).toBeLessThanOrEqual(1.0001); // tiny epsilon for float
      }
    }
  });

  it("movingAverage always returns NaN for rSquared", () => {
    const rng = createRng(88);
    for (let i = 0; i < 50; i++) {
      const numPoints = Math.floor(rng() * 15) + 3;
      const data: ParsedChartData = {
        categories: Array.from({ length: numPoints }, (_, j) => `C${j}`),
        series: [{
          name: "S1",
          values: Array.from({ length: numPoints }, () => rng() * 100),
          color: null,
        }],
      };
      const result = computeTrendline(data, { type: "movingAverage", seriesIndex: 0, movingAveragePeriod: 3 });
      if (result) {
        expect(isNaN(result.rSquared)).toBe(true);
      }
    }
  });
});

// ============================================================================
// computePieSliceArcs: angles sum to ~2*PI for any positive values
// ============================================================================

describe("valuesToAngles invariants", () => {
  it("angle spans sum to approximately 2*PI for any positive values", () => {
    const rng = createRng(55);

    for (let i = 0; i < 300; i++) {
      const numSlices = Math.floor(rng() * 10) + 1;
      const values = Array.from({ length: numSlices }, () => rng() * 1000 + 0.01);
      const padAngle = rng() * 5; // 0-5 degrees
      const startAngle = rng() * 360;

      const angles = valuesToAngles(values, startAngle, padAngle);

      expect(angles.length).toBe(numSlices);

      // Total sweep + total padding should equal 2*PI
      let totalSweep = 0;
      for (const a of angles) {
        const sweep = a.endAngle - a.startAngle;
        expect(sweep).toBeGreaterThanOrEqual(0);
        totalSweep += sweep;
      }

      const padRad = (padAngle * Math.PI) / 180;
      const totalPad = padRad * numSlices;
      const expectedSweep = Math.PI * 2 - totalPad;

      expect(totalSweep).toBeCloseTo(expectedSweep, 6);
    }
  });

  it("all-zero values produce zero-sweep angles", () => {
    const values = [0, 0, 0, 0];
    const angles = valuesToAngles(values, 0, 1);
    for (const a of angles) {
      expect(a.startAngle).toBe(0);
      expect(a.endAngle).toBe(0);
    }
  });
});

// ============================================================================
// createLinearScale: output is monotonic for monotonic input
// ============================================================================

describe("createLinearScale monotonicity", () => {
  it("scale output is monotonically non-decreasing for increasing input", () => {
    const rng = createRng(33);

    for (let i = 0; i < 200; i++) {
      const d0 = rng() * 100 - 50;
      const d1 = d0 + rng() * 1000 + 1;
      const r0 = rng() * 500;
      const r1 = r0 + rng() * 500 + 1;

      const scale = createLinearScale([d0, d1], [r0, r1]);

      // Generate monotonically increasing input values
      let prev = -Infinity;
      let prevOut = -Infinity;
      for (let j = 0; j < 20; j++) {
        const value = d0 + (d1 - d0) * (j / 19);
        const out = scale.scale(value);
        if (value >= prev) {
          expect(out).toBeGreaterThanOrEqual(prevOut - 1e-9);
        }
        prev = value;
        prevOut = out;
      }
    }
  });

  it("scale output is monotonically non-increasing for reversed range", () => {
    const rng = createRng(44);

    for (let i = 0; i < 100; i++) {
      const d0 = rng() * 50;
      const d1 = d0 + rng() * 500 + 1;
      const r0 = rng() * 500 + 200;
      const r1 = rng() * 200; // r1 < r0 = reversed

      const scale = createLinearScale([d0, d1], [r0, r1]);

      let prevOut = Infinity;
      for (let j = 0; j < 20; j++) {
        const value = d0 + (d1 - d0) * (j / 19);
        const out = scale.scale(value);
        expect(out).toBeLessThanOrEqual(prevOut + 1e-9);
        prevOut = out;
      }
    }
  });

  it("never produces NaN or Infinity for finite inputs", () => {
    const rng = createRng(66);

    for (let i = 0; i < 200; i++) {
      const d0 = rng() * 200 - 100;
      const d1 = d0 + rng() * 1000 + 0.001;
      const r0 = rng() * 1000 - 500;
      const r1 = rng() * 1000 - 500;

      const scale = createLinearScale([d0, d1], [r0, r1]);

      for (let j = 0; j < 10; j++) {
        const value = d0 + (d1 - d0) * rng();
        const out = scale.scale(value);
        expect(isFinite(out)).toBe(true);
      }
    }
  });
});
