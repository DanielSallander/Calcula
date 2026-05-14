import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateCondition,
  buildRangeContext,
  clearRangeContextCache,
  generateRuleId,
} from "../ruleEvaluator";
import type {
  CellValueCondition,
  TextCondition,
  Top10Condition,
  AboveAverageCondition,
  DuplicatesCondition,
  RangeContext,
} from "../types";

const coords = { row: 0, col: 0 };

describe("ruleEvaluator", () => {
  beforeEach(() => {
    clearRangeContextCache();
  });

  // =========================================================================
  // Cell Value Conditions
  // =========================================================================

  describe("cellValue conditions", () => {
    const cond = (operator: CellValueCondition["operator"], v1: number, v2?: number): CellValueCondition => ({
      type: "cellValue",
      operator,
      value1: v1,
      value2: v2,
    });

    it("greaterThan", () => {
      expect(evaluateCondition(cond("greaterThan", 10), "15", coords)).toBe(true);
      expect(evaluateCondition(cond("greaterThan", 10), "10", coords)).toBe(false);
      expect(evaluateCondition(cond("greaterThan", 10), "5", coords)).toBe(false);
    });

    it("lessThan", () => {
      expect(evaluateCondition(cond("lessThan", 10), "5", coords)).toBe(true);
      expect(evaluateCondition(cond("lessThan", 10), "10", coords)).toBe(false);
    });

    it("greaterThanOrEqual", () => {
      expect(evaluateCondition(cond("greaterThanOrEqual", 10), "10", coords)).toBe(true);
      expect(evaluateCondition(cond("greaterThanOrEqual", 10), "9", coords)).toBe(false);
    });

    it("lessThanOrEqual", () => {
      expect(evaluateCondition(cond("lessThanOrEqual", 10), "10", coords)).toBe(true);
      expect(evaluateCondition(cond("lessThanOrEqual", 10), "11", coords)).toBe(false);
    });

    it("equal (numeric)", () => {
      expect(evaluateCondition(cond("equal", 42), "42", coords)).toBe(true);
      expect(evaluateCondition(cond("equal", 42), "43", coords)).toBe(false);
    });

    it("notEqual", () => {
      expect(evaluateCondition(cond("notEqual", 42), "43", coords)).toBe(true);
      expect(evaluateCondition(cond("notEqual", 42), "42", coords)).toBe(false);
    });

    it("between", () => {
      expect(evaluateCondition(cond("between", 10, 20), "15", coords)).toBe(true);
      expect(evaluateCondition(cond("between", 10, 20), "10", coords)).toBe(true);
      expect(evaluateCondition(cond("between", 10, 20), "20", coords)).toBe(true);
      expect(evaluateCondition(cond("between", 10, 20), "5", coords)).toBe(false);
      expect(evaluateCondition(cond("between", 10, 20), "25", coords)).toBe(false);
    });

    it("between handles reversed bounds", () => {
      expect(evaluateCondition(cond("between", 20, 10), "15", coords)).toBe(true);
    });

    it("notBetween", () => {
      expect(evaluateCondition(cond("notBetween", 10, 20), "5", coords)).toBe(true);
      expect(evaluateCondition(cond("notBetween", 10, 20), "15", coords)).toBe(false);
    });

    it("returns false for non-numeric cell values", () => {
      expect(evaluateCondition(cond("greaterThan", 10), "abc", coords)).toBe(false);
    });

    it("falls back to string comparison for equal with non-numeric", () => {
      const condition: CellValueCondition = { type: "cellValue", operator: "equal", value1: "hello" };
      expect(evaluateCondition(condition, "hello", coords)).toBe(true);
      expect(evaluateCondition(condition, "world", coords)).toBe(false);
    });

    it("notEqual falls back to string for non-numeric", () => {
      const condition: CellValueCondition = { type: "cellValue", operator: "notEqual", value1: "hello" };
      expect(evaluateCondition(condition, "world", coords)).toBe(true);
      expect(evaluateCondition(condition, "hello", coords)).toBe(false);
    });
  });

  // =========================================================================
  // Text Conditions
  // =========================================================================

  describe("text conditions", () => {
    it("contains (case insensitive)", () => {
      const cond: TextCondition = { type: "text", operator: "contains", value: "hello" };
      expect(evaluateCondition(cond, "say Hello world", coords)).toBe(true);
      expect(evaluateCondition(cond, "goodbye", coords)).toBe(false);
    });

    it("contains (case sensitive)", () => {
      const cond: TextCondition = { type: "text", operator: "contains", value: "Hello", caseSensitive: true };
      expect(evaluateCondition(cond, "say Hello world", coords)).toBe(true);
      expect(evaluateCondition(cond, "say hello world", coords)).toBe(false);
    });

    it("notContains", () => {
      const cond: TextCondition = { type: "text", operator: "notContains", value: "x" };
      expect(evaluateCondition(cond, "abc", coords)).toBe(true);
      expect(evaluateCondition(cond, "xyz", coords)).toBe(false);
    });

    it("beginsWith", () => {
      const cond: TextCondition = { type: "text", operator: "beginsWith", value: "pre" };
      expect(evaluateCondition(cond, "prefix", coords)).toBe(true);
      expect(evaluateCondition(cond, "suffix", coords)).toBe(false);
    });

    it("endsWith", () => {
      const cond: TextCondition = { type: "text", operator: "endsWith", value: "ing" };
      expect(evaluateCondition(cond, "testing", coords)).toBe(true);
      expect(evaluateCondition(cond, "tested", coords)).toBe(false);
    });

    it("equals", () => {
      const cond: TextCondition = { type: "text", operator: "equals", value: "exact" };
      expect(evaluateCondition(cond, "exact", coords)).toBe(true);
      expect(evaluateCondition(cond, "Exact", coords)).toBe(true); // case insensitive
      expect(evaluateCondition(cond, "other", coords)).toBe(false);
    });

    it("notEquals", () => {
      const cond: TextCondition = { type: "text", operator: "notEquals", value: "exact" };
      expect(evaluateCondition(cond, "other", coords)).toBe(true);
      expect(evaluateCondition(cond, "exact", coords)).toBe(false);
    });
  });

  // =========================================================================
  // Top10 Conditions
  // =========================================================================

  describe("top10 conditions", () => {
    const context = buildRangeContext(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

    it("top 3 items", () => {
      const cond: Top10Condition = { type: "top10", direction: "top", count: 3 };
      expect(evaluateCondition(cond, "10", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "8", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "5", coords, context)).toBe(false);
    });

    it("bottom 2 items", () => {
      const cond: Top10Condition = { type: "top10", direction: "bottom", count: 2 };
      expect(evaluateCondition(cond, "1", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "2", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "3", coords, context)).toBe(false);
    });

    it("top 50 percent", () => {
      const cond: Top10Condition = { type: "top10", direction: "top", count: 50, percent: true };
      expect(evaluateCondition(cond, "10", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "6", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "1", coords, context)).toBe(false);
    });

    it("returns false for non-numeric cell value", () => {
      const cond: Top10Condition = { type: "top10", direction: "top", count: 3 };
      expect(evaluateCondition(cond, "abc", coords, context)).toBe(false);
    });

    it("returns false without context", () => {
      const cond: Top10Condition = { type: "top10", direction: "top", count: 3 };
      expect(evaluateCondition(cond, "10", coords)).toBe(false);
    });
  });

  // =========================================================================
  // Above Average Conditions
  // =========================================================================

  describe("aboveAverage conditions", () => {
    // Average of 1..10 = 5.5
    const context = buildRangeContext(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

    it("above average", () => {
      const cond: AboveAverageCondition = { type: "aboveAverage", direction: "above" };
      expect(evaluateCondition(cond, "6", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "5", coords, context)).toBe(false);
    });

    it("below average", () => {
      const cond: AboveAverageCondition = { type: "aboveAverage", direction: "below" };
      expect(evaluateCondition(cond, "5", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "6", coords, context)).toBe(false);
    });

    it("equalOrAbove", () => {
      const cond: AboveAverageCondition = { type: "aboveAverage", direction: "equalOrAbove" };
      // 5.5 is the average; no integer equals it
      expect(evaluateCondition(cond, "6", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "5", coords, context)).toBe(false);
    });

    it("equalOrBelow", () => {
      const cond: AboveAverageCondition = { type: "aboveAverage", direction: "equalOrBelow" };
      expect(evaluateCondition(cond, "5", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "6", coords, context)).toBe(false);
    });

    it("returns false for non-numeric", () => {
      const cond: AboveAverageCondition = { type: "aboveAverage", direction: "above" };
      expect(evaluateCondition(cond, "abc", coords, context)).toBe(false);
    });
  });

  // =========================================================================
  // Duplicates Conditions
  // =========================================================================

  describe("duplicates conditions", () => {
    const context = buildRangeContext(["apple", "banana", "apple", "cherry"]);

    it("highlights duplicates", () => {
      const cond: DuplicatesCondition = { type: "duplicates", unique: false };
      expect(evaluateCondition(cond, "apple", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "banana", coords, context)).toBe(false);
    });

    it("highlights unique values", () => {
      const cond: DuplicatesCondition = { type: "duplicates", unique: true };
      expect(evaluateCondition(cond, "banana", coords, context)).toBe(true);
      expect(evaluateCondition(cond, "apple", coords, context)).toBe(false);
    });

    it("skips empty cells", () => {
      const cond: DuplicatesCondition = { type: "duplicates", unique: false };
      expect(evaluateCondition(cond, "", coords, context)).toBe(false);
    });
  });

  // =========================================================================
  // buildRangeContext
  // =========================================================================

  describe("buildRangeContext", () => {
    it("computes correct stats", () => {
      const ctx = buildRangeContext(["10", "20", "30"]);
      expect(ctx.stats.count).toBe(3);
      expect(ctx.stats.sum).toBe(60);
      expect(ctx.stats.average).toBe(20);
      expect(ctx.stats.min).toBe(10);
      expect(ctx.stats.max).toBe(30);
    });

    it("ignores non-numeric values in stats", () => {
      const ctx = buildRangeContext(["10", "abc", "20"]);
      expect(ctx.stats.count).toBe(2);
      expect(ctx.stats.average).toBe(15);
      expect(ctx.numericValues).toEqual([10, 20]);
    });

    it("sorts values ascending", () => {
      const ctx = buildRangeContext(["30", "10", "20"]);
      expect(ctx.sortedValues).toEqual([10, 20, 30]);
    });

    it("counts duplicates", () => {
      const ctx = buildRangeContext(["a", "b", "a", "A"]);
      expect(ctx.valueCounts.get("a")).toBe(3); // "a" + "A" (case insensitive)
      expect(ctx.valueCounts.get("b")).toBe(1);
    });

    it("handles empty input", () => {
      const ctx = buildRangeContext([]);
      expect(ctx.stats.count).toBe(0);
      expect(ctx.stats.average).toBe(0);
      expect(ctx.stats.min).toBe(0);
      expect(ctx.stats.max).toBe(0);
    });
  });

  // =========================================================================
  // generateRuleId
  // =========================================================================

  describe("generateRuleId", () => {
    it("produces unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateRuleId());
      }
      expect(ids.size).toBe(100);
    });

    it("starts with 'cf-'", () => {
      expect(generateRuleId()).toMatch(/^cf-/);
    });
  });

  // =========================================================================
  // Formula condition (placeholder)
  // =========================================================================

  describe("formula condition", () => {
    it("returns false (not implemented)", () => {
      expect(
        evaluateCondition({ type: "formula", formula: "=A1>0" }, "5", coords)
      ).toBe(false);
    });
  });

  // =========================================================================
  // Unknown condition type
  // =========================================================================

  describe("unknown condition type", () => {
    it("returns false", () => {
      expect(
        evaluateCondition({ type: "unknown" } as any, "5", coords)
      ).toBe(false);
    });
  });
});
