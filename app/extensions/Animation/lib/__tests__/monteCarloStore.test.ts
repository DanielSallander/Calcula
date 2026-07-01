import { describe, it, expect } from "vitest";
import { computeStats, computeHistogram } from "../monteCarloStore";

describe("computeStats", () => {
  it("is null for an empty sample set", () => {
    expect(computeStats([])).toBeNull();
  });

  it("computes count / mean / std / min / max / percentiles", () => {
    const s = computeStats([1, 2, 3, 4, 5])!;
    expect(s.count).toBe(5);
    expect(s.mean).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.std).toBeCloseTo(Math.sqrt(2), 6); // population std of 1..5
    expect(s.p5).toBe(1); // floor(0.05*4)=0 -> sorted[0]
    expect(s.p95).toBe(4); // floor(0.95*4)=3 -> sorted[3]
  });
});

describe("computeHistogram", () => {
  it("is null for an empty sample set", () => {
    expect(computeHistogram([])).toBeNull();
  });

  it("collapses a single distinct value into one bin", () => {
    expect(computeHistogram([5, 5, 5])).toEqual({ edges: [5, 5], counts: [3] });
  });

  it("bins values across the range (last value lands in the final bin)", () => {
    const h = computeHistogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2)!;
    expect(h.counts.length).toBe(2);
    expect(h.edges.length).toBe(3);
    expect(h.counts[0] + h.counts[1]).toBe(11);
    expect(h.counts[1]).toBeGreaterThan(0); // 10 falls in the top bin
  });
});
