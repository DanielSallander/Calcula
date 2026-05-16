//! FILENAME: app/extensions/_standard/conditional-formatting/__tests__/ruleEvaluatorDeep.test.ts
// PURPOSE: Deep tests for rule evaluator: color scales, data bars, icon sets,
//          overlapping rules, blank cells, negatives, percentiles, formula rules.

import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateRule,
  evaluateCondition,
  buildRangeContext,
  clearRangeContextCache,
  setRangeContext,
} from "../ruleEvaluator";
import type {
  CellValueCondition,
  TextCondition,
  Top10Condition,
  AboveAverageCondition,
  DuplicatesCondition,
  FormulaCondition,
  ConditionalRule,
  RangeContext,
} from "../types";

const coords = { row: 0, col: 0 };

// ============================================================================
// Helper: create a ConditionalRule
// ============================================================================

function makeRule(
  id: string,
  condition: ConditionalRule["condition"],
  overrides: Partial<ConditionalRule> = {}
): ConditionalRule {
  return {
    id,
    enabled: true,
    condition,
    style: {},
    range: { startRow: 0, startCol: 0, endRow: 99, endCol: 9 },
    ...overrides,
  };
}

// ============================================================================
// Color Scale Calculations
// ============================================================================

describe("color scale helpers via buildRangeContext", () => {
  describe("2-color scale (min/max) position calculations", () => {
    const ctx = buildRangeContext(["0", "25", "50", "75", "100"]);

    it("min value is at position 0%", () => {
      const { min, max } = ctx.stats;
      const t = (0 - min) / (max - min);
      expect(t).toBe(0);
    });

    it("max value is at position 100%", () => {
      const { min, max } = ctx.stats;
      const t = (100 - min) / (max - min);
      expect(t).toBe(1);
    });

    it("midpoint value is at position 50%", () => {
      const { min, max } = ctx.stats;
      const t = (50 - min) / (max - min);
      expect(t).toBe(0.5);
    });

    it("quarter value is at position 25%", () => {
      const { min, max } = ctx.stats;
      const t = (25 - min) / (max - min);
      expect(t).toBe(0.25);
    });
  });

  describe("3-color scale (min/mid/max) position calculations", () => {
    const ctx = buildRangeContext(["0", "50", "100"]);

    it("values below midpoint map to lower half [0, 0.5]", () => {
      const { min, max } = ctx.stats;
      const mid = (min + max) / 2;
      // Value 25: in lower half
      const t = 25 < mid ? (25 - min) / (mid - min) * 0.5 : 0.5 + (25 - mid) / (max - mid) * 0.5;
      expect(t).toBe(0.25);
    });

    it("midpoint maps to 0.5", () => {
      const { min, max } = ctx.stats;
      const mid = (min + max) / 2;
      const t = 50 < mid ? (50 - min) / (mid - min) * 0.5 : 0.5 + (50 - mid) / (max - mid) * 0.5;
      expect(t).toBe(0.5);
    });

    it("values above midpoint map to upper half [0.5, 1]", () => {
      const { min, max } = ctx.stats;
      const mid = (min + max) / 2;
      const t = 75 < mid ? (75 - min) / (mid - min) * 0.5 : 0.5 + (75 - mid) / (max - mid) * 0.5;
      expect(t).toBe(0.75);
    });
  });
});

// ============================================================================
// Color Interpolation
// ============================================================================

describe("color interpolation", () => {
  // Utility matching the pattern used in color scale rendering
  function interpolateColor(c1: [number, number, number], c2: [number, number, number], t: number): string {
    const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  const red: [number, number, number] = [255, 0, 0];
  const green: [number, number, number] = [0, 255, 0];

  it("0% returns first color", () => {
    expect(interpolateColor(red, green, 0)).toBe("#ff0000");
  });

  it("100% returns second color", () => {
    expect(interpolateColor(red, green, 1)).toBe("#00ff00");
  });

  it("50% returns midpoint", () => {
    expect(interpolateColor(red, green, 0.5)).toBe("#808000");
  });

  it("25% is closer to first color", () => {
    const result = interpolateColor(red, green, 0.25);
    expect(result).toBe("#bf4000");
  });

  it("75% is closer to second color", () => {
    const result = interpolateColor(red, green, 0.75);
    expect(result).toBe("#40bf00");
  });
});

// ============================================================================
// Data Bar Width Calculations
// ============================================================================

describe("data bar width calculations", () => {
  function dataBarPercent(value: number, min: number, max: number): number {
    if (max === min) return value >= 0 ? 100 : 0;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  }

  it("max value gets 100% width", () => {
    expect(dataBarPercent(100, 0, 100)).toBe(100);
  });

  it("min value gets 0% width", () => {
    expect(dataBarPercent(0, 0, 100)).toBe(0);
  });

  it("midpoint value gets 50% width", () => {
    expect(dataBarPercent(50, 0, 100)).toBe(50);
  });

  it("proportional width for arbitrary value", () => {
    expect(dataBarPercent(30, 10, 90)).toBe(25);
  });

  it("all equal values get 100%", () => {
    expect(dataBarPercent(5, 5, 5)).toBe(100);
  });

  it("negative min with positive max", () => {
    // -50 in range [-50, 50]: (0/100)*100 = 0%
    expect(dataBarPercent(-50, -50, 50)).toBe(0);
    expect(dataBarPercent(0, -50, 50)).toBe(50);
    expect(dataBarPercent(50, -50, 50)).toBe(100);
  });

  it("clamps below min to 0%", () => {
    expect(dataBarPercent(-10, 0, 100)).toBe(0);
  });

  it("clamps above max to 100%", () => {
    expect(dataBarPercent(200, 0, 100)).toBe(100);
  });
});

// ============================================================================
// Icon Set Threshold Calculations
// ============================================================================

describe("icon set threshold calculations", () => {
  // Simulates the icon index assignment logic
  // Icon 0 = below all thresholds, icon N = above all thresholds
  function getIconIndex(value: number, thresholds: number[]): number {
    // thresholds sorted ascending; count how many thresholds the value meets
    let bucket = 0;
    for (const t of thresholds) {
      if (value >= t) bucket++;
    }
    return bucket;
  }

  describe("3-icon set", () => {
    // Thresholds at 33% and 67% of [0..100] => [33, 67]
    const thresholds = [33, 67];

    it("value below first threshold gets icon 0", () => {
      expect(getIconIndex(10, thresholds)).toBe(0);
    });

    it("value between thresholds gets icon 1", () => {
      expect(getIconIndex(50, thresholds)).toBe(1);
    });

    it("value above second threshold gets icon 2", () => {
      expect(getIconIndex(80, thresholds)).toBe(2);
    });

    it("value exactly at first threshold gets icon 1", () => {
      expect(getIconIndex(33, thresholds)).toBe(1);
    });
  });

  describe("4-icon set", () => {
    const thresholds = [25, 50, 75];

    it("distributes into 4 buckets", () => {
      expect(getIconIndex(10, thresholds)).toBe(0);
      expect(getIconIndex(30, thresholds)).toBe(1);
      expect(getIconIndex(60, thresholds)).toBe(2);
      expect(getIconIndex(90, thresholds)).toBe(3);
    });
  });

  describe("5-icon set", () => {
    const thresholds = [20, 40, 60, 80];

    it("distributes into 5 buckets", () => {
      expect(getIconIndex(10, thresholds)).toBe(0);
      expect(getIconIndex(30, thresholds)).toBe(1);
      expect(getIconIndex(50, thresholds)).toBe(2);
      expect(getIconIndex(70, thresholds)).toBe(3);
      expect(getIconIndex(90, thresholds)).toBe(4);
    });
  });
});

// ============================================================================
// Multiple Overlapping Rules with Priority and stopIfTrue
// ============================================================================

describe("multiple overlapping rules with priority/stopIfTrue", () => {
  function evaluateRulesForCell(
    rules: ConditionalRule[],
    cellValue: string,
    cellCoords: { row: number; col: number },
    sheetIndex: number
  ): ConditionalRule[] {
    // Sort by priority (lower = first)
    const sorted = [...rules]
      .filter((r) => r.enabled)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    const matched: ConditionalRule[] = [];
    for (const rule of sorted) {
      const ctx = buildRangeContext(["10", "20", "30", "40", "50"]);
      setRangeContext(rule, sheetIndex, ctx);
      if (evaluateRule(rule, cellValue, { ...cellCoords, sheetIndex })) {
        matched.push(rule);
        if (rule.stopIfTrue) break;
      }
    }
    return matched;
  }

  beforeEach(() => {
    clearRangeContextCache();
  });

  it("evaluates all matching rules when no stopIfTrue", () => {
    const rules = [
      makeRule("r1", { type: "cellValue", operator: "greaterThan", value1: 5 }, { priority: 1 }),
      makeRule("r2", { type: "cellValue", operator: "greaterThan", value1: 10 }, { priority: 2 }),
    ];
    const matched = evaluateRulesForCell(rules, "20", { row: 0, col: 0 }, 0);
    expect(matched).toHaveLength(2);
  });

  it("stops after first match when stopIfTrue is set", () => {
    const rules = [
      makeRule("r1", { type: "cellValue", operator: "greaterThan", value1: 5 }, { priority: 1, stopIfTrue: true }),
      makeRule("r2", { type: "cellValue", operator: "greaterThan", value1: 10 }, { priority: 2 }),
    ];
    const matched = evaluateRulesForCell(rules, "20", { row: 0, col: 0 }, 0);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("r1");
  });

  it("respects priority ordering (lower number first)", () => {
    const rules = [
      makeRule("r2", { type: "cellValue", operator: "greaterThan", value1: 10 }, { priority: 2 }),
      makeRule("r1", { type: "cellValue", operator: "greaterThan", value1: 5 }, { priority: 1, stopIfTrue: true }),
    ];
    const matched = evaluateRulesForCell(rules, "20", { row: 0, col: 0 }, 0);
    expect(matched[0].id).toBe("r1");
  });

  it("skips disabled rules", () => {
    const rules = [
      makeRule("r1", { type: "cellValue", operator: "greaterThan", value1: 5 }, { priority: 1, enabled: false }),
      makeRule("r2", { type: "cellValue", operator: "greaterThan", value1: 10 }, { priority: 2 }),
    ];
    const matched = evaluateRulesForCell(rules, "20", { row: 0, col: 0 }, 0);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("r2");
  });

  it("stopIfTrue only triggers on matching rule, not non-matching", () => {
    const rules = [
      makeRule("r1", { type: "cellValue", operator: "greaterThan", value1: 100 }, { priority: 1, stopIfTrue: true }),
      makeRule("r2", { type: "cellValue", operator: "greaterThan", value1: 5 }, { priority: 2 }),
    ];
    // r1 does not match (20 < 100), so stopIfTrue is not triggered
    const matched = evaluateRulesForCell(rules, "20", { row: 0, col: 0 }, 0);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("r2");
  });
});

// ============================================================================
// Blank Cell Handling
// ============================================================================

describe("blank cell handling", () => {
  it("cellValue: blank cell returns false for numeric comparison", () => {
    const cond: CellValueCondition = { type: "cellValue", operator: "greaterThan", value1: 0 };
    expect(evaluateCondition(cond, "", coords)).toBe(false);
  });

  it("cellValue equal: blank matches empty string threshold", () => {
    const cond: CellValueCondition = { type: "cellValue", operator: "equal", value1: "" };
    expect(evaluateCondition(cond, "", coords)).toBe(true);
  });

  it("text contains: blank cell with empty search always matches", () => {
    const cond: TextCondition = { type: "text", operator: "contains", value: "" };
    expect(evaluateCondition(cond, "", coords)).toBe(true);
  });

  it("text beginsWith: blank cell with non-empty search returns false", () => {
    const cond: TextCondition = { type: "text", operator: "beginsWith", value: "abc" };
    expect(evaluateCondition(cond, "", coords)).toBe(false);
  });

  it("duplicates: blank cell is skipped", () => {
    const ctx = buildRangeContext(["", "", "a"]);
    const cond: DuplicatesCondition = { type: "duplicates", unique: false };
    expect(evaluateCondition(cond, "", coords, ctx)).toBe(false);
  });

  it("top10: blank cell returns false", () => {
    const ctx = buildRangeContext(["1", "2", "3", "", ""]);
    const cond: Top10Condition = { type: "top10", direction: "top", count: 1 };
    expect(evaluateCondition(cond, "", coords, ctx)).toBe(false);
  });

  it("aboveAverage: blank cell returns false", () => {
    const ctx = buildRangeContext(["10", "20", "", ""]);
    const cond: AboveAverageCondition = { type: "aboveAverage", direction: "above" };
    expect(evaluateCondition(cond, "", coords, ctx)).toBe(false);
  });
});

// ============================================================================
// Negative Values
// ============================================================================

describe("negative values", () => {
  it("buildRangeContext computes correct stats with negatives", () => {
    const ctx = buildRangeContext(["-10", "-5", "0", "5", "10"]);
    expect(ctx.stats.min).toBe(-10);
    expect(ctx.stats.max).toBe(10);
    expect(ctx.stats.average).toBe(0);
    expect(ctx.stats.sum).toBe(0);
  });

  it("cellValue greaterThan works with negative threshold", () => {
    const cond: CellValueCondition = { type: "cellValue", operator: "greaterThan", value1: -5 };
    expect(evaluateCondition(cond, "-3", coords)).toBe(true);
    expect(evaluateCondition(cond, "-5", coords)).toBe(false);
    expect(evaluateCondition(cond, "-10", coords)).toBe(false);
  });

  it("between works with negative range", () => {
    const cond: CellValueCondition = { type: "cellValue", operator: "between", value1: -20, value2: -10 };
    expect(evaluateCondition(cond, "-15", coords)).toBe(true);
    expect(evaluateCondition(cond, "-5", coords)).toBe(false);
  });

  it("top10 with negative values", () => {
    const ctx = buildRangeContext(["-10", "-5", "0", "5", "10"]);
    const cond: Top10Condition = { type: "top10", direction: "bottom", count: 2 };
    expect(evaluateCondition(cond, "-10", coords, ctx)).toBe(true);
    expect(evaluateCondition(cond, "-5", coords, ctx)).toBe(true);
    expect(evaluateCondition(cond, "0", coords, ctx)).toBe(false);
  });

  it("aboveAverage with all negatives", () => {
    const ctx = buildRangeContext(["-10", "-8", "-6", "-4", "-2"]);
    // average = -6
    const cond: AboveAverageCondition = { type: "aboveAverage", direction: "above" };
    expect(evaluateCondition(cond, "-4", coords, ctx)).toBe(true);
    expect(evaluateCondition(cond, "-8", coords, ctx)).toBe(false);
  });
});

// ============================================================================
// Percentile-Based Thresholds
// ============================================================================

describe("percentile-based thresholds via sortedValues", () => {
  it("sortedValues enables percentile lookup", () => {
    const ctx = buildRangeContext(["10", "20", "30", "40", "50", "60", "70", "80", "90", "100"]);
    expect(ctx.sortedValues).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

    // P25 = value at index floor(0.25 * 9) = index 2 = 30
    const p25Index = Math.floor(0.25 * (ctx.sortedValues.length - 1));
    expect(ctx.sortedValues[p25Index]).toBe(30);

    // P50 = value at index floor(0.50 * 9) = index 4 = 50
    const p50Index = Math.floor(0.50 * (ctx.sortedValues.length - 1));
    expect(ctx.sortedValues[p50Index]).toBe(50);

    // P75 = value at index floor(0.75 * 9) = index 6 = 70
    const p75Index = Math.floor(0.75 * (ctx.sortedValues.length - 1));
    expect(ctx.sortedValues[p75Index]).toBe(70);
  });

  it("top 10 percent of 20 values selects top 2", () => {
    const values = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const ctx = buildRangeContext(values);
    const cond: Top10Condition = { type: "top10", direction: "top", count: 10, percent: true };
    // 10% of 20 = 2 items => top 2 are 19, 20
    expect(evaluateCondition(cond, "20", coords, ctx)).toBe(true);
    expect(evaluateCondition(cond, "19", coords, ctx)).toBe(true);
    expect(evaluateCondition(cond, "18", coords, ctx)).toBe(false);
  });

  it("bottom 25 percent of 8 values selects bottom 2", () => {
    const values = ["10", "20", "30", "40", "50", "60", "70", "80"];
    const ctx = buildRangeContext(values);
    const cond: Top10Condition = { type: "top10", direction: "bottom", count: 25, percent: true };
    // 25% of 8 = ceil(2) = 2 items => bottom 2 are 10, 20
    expect(evaluateCondition(cond, "10", coords, ctx)).toBe(true);
    expect(evaluateCondition(cond, "20", coords, ctx)).toBe(true);
    expect(evaluateCondition(cond, "30", coords, ctx)).toBe(false);
  });
});

// ============================================================================
// Formula-Based Rules
// ============================================================================

describe("formula-based rules", () => {
  it("formula condition returns false (not yet implemented)", () => {
    const cond: FormulaCondition = { type: "formula", formula: "=A1>0" };
    expect(evaluateCondition(cond, "5", coords)).toBe(false);
  });

  it("formula condition with complex expression returns false", () => {
    const cond: FormulaCondition = { type: "formula", formula: "=AND(A1>0, B1<100)" };
    expect(evaluateCondition(cond, "50", coords)).toBe(false);
  });

  it("formula condition with empty formula returns false", () => {
    const cond: FormulaCondition = { type: "formula", formula: "" };
    expect(evaluateCondition(cond, "10", coords)).toBe(false);
  });
});

// ============================================================================
// Range Context Edge Cases
// ============================================================================

describe("buildRangeContext edge cases", () => {
  it("handles all non-numeric values", () => {
    const ctx = buildRangeContext(["abc", "def", "ghi"]);
    expect(ctx.stats.count).toBe(0);
    expect(ctx.stats.average).toBe(0);
    expect(ctx.stats.min).toBe(0);
    expect(ctx.stats.max).toBe(0);
    expect(ctx.numericValues).toEqual([]);
    expect(ctx.sortedValues).toEqual([]);
  });

  it("handles mixed numeric and non-numeric", () => {
    const ctx = buildRangeContext(["10", "abc", "20", "def", "30"]);
    expect(ctx.stats.count).toBe(3);
    expect(ctx.stats.average).toBe(20);
    expect(ctx.numericValues).toEqual([10, 20, 30]);
    expect(ctx.allValues).toHaveLength(5);
  });

  it("handles single value", () => {
    const ctx = buildRangeContext(["42"]);
    expect(ctx.stats.min).toBe(42);
    expect(ctx.stats.max).toBe(42);
    expect(ctx.stats.average).toBe(42);
    expect(ctx.stats.count).toBe(1);
  });

  it("handles Infinity and NaN strings", () => {
    const ctx = buildRangeContext(["Infinity", "NaN", "10"]);
    // parseFloat("Infinity") = Infinity, isFinite(Infinity) = false => skipped
    // parseFloat("NaN") = NaN => skipped
    expect(ctx.stats.count).toBe(1);
    expect(ctx.numericValues).toEqual([10]);
  });

  it("handles negative zero", () => {
    const ctx = buildRangeContext(["-0", "0"]);
    expect(ctx.stats.count).toBe(2);
    expect(ctx.stats.sum).toBe(0);
  });
});

// ============================================================================
// evaluateRule with setRangeContext
// ============================================================================

describe("evaluateRule integration", () => {
  beforeEach(() => {
    clearRangeContextCache();
  });

  it("uses cached range context for top10 evaluation", () => {
    const rule = makeRule("test-rule", { type: "top10", direction: "top", count: 2 });
    const ctx = buildRangeContext(["1", "2", "3", "4", "5"]);
    setRangeContext(rule, 0, ctx);

    expect(evaluateRule(rule, "5", { row: 0, col: 0, sheetIndex: 0 })).toBe(true);
    expect(evaluateRule(rule, "4", { row: 0, col: 0, sheetIndex: 0 })).toBe(true);
    expect(evaluateRule(rule, "3", { row: 0, col: 0, sheetIndex: 0 })).toBe(false);
  });

  it("defaults to sheetIndex 0 when not provided", () => {
    const rule = makeRule("test-rule", { type: "cellValue", operator: "greaterThan", value1: 10 });
    expect(evaluateRule(rule, "20", { row: 0, col: 0 })).toBe(true);
  });
});
