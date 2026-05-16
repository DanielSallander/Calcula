//! FILENAME: app/extensions/Charts/rendering/__tests__/histogramBinning.test.ts
// PURPOSE: Tests for histogram binning logic.

import { describe, it, expect } from "vitest";
import { computeBins } from "../histogramChartPainter";

// ============================================================================
// computeBins
// ============================================================================

describe("computeBins", () => {
  it("returns empty array for empty values", () => {
    expect(computeBins([], 5)).toEqual([]);
  });

  it("creates the requested number of bins", () => {
    const bins = computeBins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(bins).toHaveLength(5);
  });

  it("total count across bins equals input length", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const bins = computeBins(values, 4);
    const totalCount = bins.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBe(values.length);
  });

  it("bins cover the full range of values", () => {
    const values = [10, 20, 30, 40, 50];
    const bins = computeBins(values, 4);
    expect(bins[0].low).toBe(10);
    expect(bins[bins.length - 1].high).toBe(50);
  });

  it("assigns maximum value to last bin", () => {
    const values = [0, 10, 20, 30];
    const bins = computeBins(values, 3);
    // max=30 should be in the last bin
    const lastBin = bins[bins.length - 1];
    expect(lastBin.count).toBeGreaterThanOrEqual(1);
  });

  it("handles single value (all in one bin)", () => {
    const values = [5, 5, 5, 5];
    const bins = computeBins(values, 3);
    // With range=0, binWidth=1/3, all values map to bin 0
    const totalCount = bins.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBe(4);
  });

  it("handles negative values", () => {
    const values = [-10, -5, 0, 5, 10];
    const bins = computeBins(values, 4);
    expect(bins[0].low).toBe(-10);
    expect(bins[bins.length - 1].high).toBe(10);
    const totalCount = bins.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBe(5);
  });

  it("each bin has correct low and high boundaries", () => {
    const bins = computeBins([0, 100], 4);
    for (let i = 0; i < bins.length; i++) {
      expect(bins[i].low).toBeLessThan(bins[i].high);
      if (i > 0) {
        expect(bins[i].low).toBeCloseTo(bins[i - 1].high);
      }
    }
  });

  it("generates labels from low-high", () => {
    const bins = computeBins([0, 10], 2);
    expect(bins[0].label).toContain("-");
    expect(bins[1].label).toContain("-");
  });
});
