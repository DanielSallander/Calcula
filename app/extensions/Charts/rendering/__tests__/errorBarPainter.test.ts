//! FILENAME: app/extensions/Charts/rendering/__tests__/errorBarPainter.test.ts
// PURPOSE: Tests for error bar extent computation logic.

import { describe, it, expect } from "vitest";
import { computeErrorExtent } from "../errorBarPainter";
import type { ErrorBarOptions } from "../../types";

// ============================================================================
// computeErrorExtent
// ============================================================================

describe("computeErrorExtent", () => {
  const seriesValues = [10, 20, 30, 40, 50];

  describe("percentage type", () => {
    it("computes 10% of absolute value by default", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "percentage", direction: "both" };
      const result = computeErrorExtent(100, seriesValues, opts);
      expect(result.plus).toBeCloseTo(10);
      expect(result.minus).toBeCloseTo(10);
    });

    it("uses custom percentage value", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "percentage", value: 25, direction: "both" };
      const result = computeErrorExtent(200, seriesValues, opts);
      expect(result.plus).toBeCloseTo(50);
      expect(result.minus).toBeCloseTo(50);
    });

    it("handles negative values (uses absolute)", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "percentage", value: 10, direction: "both" };
      const result = computeErrorExtent(-80, seriesValues, opts);
      expect(result.plus).toBeCloseTo(8);
      expect(result.minus).toBeCloseTo(8);
    });

    it("returns 0 for value of 0", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "percentage", value: 10, direction: "both" };
      const result = computeErrorExtent(0, seriesValues, opts);
      expect(result.plus).toBe(0);
      expect(result.minus).toBe(0);
    });
  });

  describe("custom type", () => {
    it("uses the fixed value", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "custom", value: 5, direction: "both" };
      const result = computeErrorExtent(100, seriesValues, opts);
      expect(result.plus).toBe(5);
      expect(result.minus).toBe(5);
    });

    it("defaults to 0 when value is undefined", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "custom", direction: "both" };
      const result = computeErrorExtent(100, seriesValues, opts);
      expect(result.plus).toBe(0);
      expect(result.minus).toBe(0);
    });
  });

  describe("standardError type", () => {
    it("computes standard error of the series", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "standardError", direction: "both" };
      const values = [10, 20, 30, 40, 50];
      const result = computeErrorExtent(30, values, opts);
      // mean = 30, variance = 250, stddev ~= 15.81, SE = 15.81/sqrt(5) ~= 7.07
      expect(result.plus).toBeCloseTo(7.07, 1);
      expect(result.minus).toBeCloseTo(7.07, 1);
    });

    it("returns 0 for single-element series", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "standardError", direction: "both" };
      const result = computeErrorExtent(10, [10], opts);
      expect(result.plus).toBe(0);
      expect(result.minus).toBe(0);
    });
  });

  describe("standardDeviation type", () => {
    it("computes 1x standard deviation by default", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "standardDeviation", direction: "both" };
      const values = [10, 20, 30, 40, 50];
      const result = computeErrorExtent(30, values, opts);
      // stddev ~= 15.81
      expect(result.plus).toBeCloseTo(15.81, 1);
      expect(result.minus).toBeCloseTo(15.81, 1);
    });

    it("uses custom multiplier", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "standardDeviation", value: 2, direction: "both" };
      const values = [10, 20, 30, 40, 50];
      const result = computeErrorExtent(30, values, opts);
      expect(result.plus).toBeCloseTo(31.62, 1);
      expect(result.minus).toBeCloseTo(31.62, 1);
    });
  });

  describe("direction filtering", () => {
    it("sets minus to 0 when direction is 'plus'", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "custom", value: 10, direction: "plus" };
      const result = computeErrorExtent(100, seriesValues, opts);
      expect(result.plus).toBe(10);
      expect(result.minus).toBe(0);
    });

    it("sets plus to 0 when direction is 'minus'", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "custom", value: 10, direction: "minus" };
      const result = computeErrorExtent(100, seriesValues, opts);
      expect(result.plus).toBe(0);
      expect(result.minus).toBe(10);
    });

    it("keeps both when direction is 'both'", () => {
      const opts: ErrorBarOptions = { enabled: true, type: "custom", value: 7, direction: "both" };
      const result = computeErrorExtent(100, seriesValues, opts);
      expect(result.plus).toBe(7);
      expect(result.minus).toBe(7);
    });
  });
});
