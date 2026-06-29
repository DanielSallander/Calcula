//! FILENAME: app/extensions/Charts/lib/__tests__/chartFormula.test.ts
// PURPOSE: Unit tests for the chart-expression → engine translator + value
//          coercion (chartFormula.ts after A6). The hand-rolled EVALUATOR was
//          retired — chart expressions now evaluate via the real Rust engine
//          (@api evaluateScoped), whose semantics are covered by the engine's
//          own Rust tests. These tests cover the TS adapter logic only: lexing/
//          translation (variable refs → engine-legal aliases), scope mapping,
//          result coercion, and the shared coercion helpers.

import { describe, it, expect } from "vitest";
import {
  toNumber,
  toText,
  toBoolean,
  FormulaError,
  aliasName,
  translateChartExpr,
  toEngineScope,
  isEngineError,
  resultToBoolean,
  resultToNumber,
  type FormulaScope,
} from "../chartFormula";

// ============================================================================
// Coercion helpers (kept from the original evaluator; used by chart params /
// widget-value formatting too)
// ============================================================================

describe("coercion: toNumber", () => {
  it("passes numbers, parses numeric strings, maps booleans, empty→0", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber(true)).toBe(1);
    expect(toNumber(false)).toBe(0);
    expect(toNumber("")).toBe(0);
    expect(toNumber("  3 ")).toBe(3);
  });
  it("throws on a non-numeric string", () => {
    expect(() => toNumber("abc")).toThrow(FormulaError);
  });
});

describe("coercion: toText / toBoolean", () => {
  it("toText canonicalizes", () => {
    expect(toText("a")).toBe("a");
    expect(toText(1.5)).toBe("1.5");
    expect(toText(true)).toBe("TRUE");
    expect(toText(false)).toBe("FALSE");
  });
  it("toBoolean reads numbers/strings", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(3)).toBe(true);
    expect(toBoolean("TRUE")).toBe(true);
    expect(toBoolean("false")).toBe(false);
    expect(toBoolean("")).toBe(false);
    expect(() => toBoolean("nope")).toThrow(FormulaError);
  });
});

// ============================================================================
// aliasName — canonical engine-legal identifier
// ============================================================================

describe("aliasName", () => {
  it("prefixes and sanitizes", () => {
    expect(aliasName("value")).toBe("v_value");
    expect(aliasName("Revenue Total")).toBe("v_Revenue_Total");
    expect(aliasName("Revenue_Total")).toBe("v_Revenue_Total"); // exact + underscore form collapse
    expect(aliasName("$category")).toBe("v__category");
    expect(aliasName("$index")).toBe("v__index");
  });
});

// ============================================================================
// translateChartExpr — rewrite variable refs to engine aliases
// ============================================================================

describe("translateChartExpr", () => {
  it("aliases bare variable references", () => {
    expect(translateChartExpr("value > 100")).toBe("v_value > 100");
    expect(translateChartExpr("Revenue - Cost")).toBe("v_Revenue - v_Cost");
  });

  it("aliases $-prefixed built-ins and bracketed names", () => {
    expect(translateChartExpr('$category = "North"')).toBe('v__category = "North"');
    expect(translateChartExpr("[Revenue Total] * 2")).toBe("v_Revenue_Total * 2");
    // bracketed and underscore forms produce the SAME alias
    expect(translateChartExpr("[Revenue Total]")).toBe(translateChartExpr("Revenue_Total"));
  });

  it("preserves function names and aliases their arguments", () => {
    expect(translateChartExpr("SUM(a, b)")).toBe("SUM ( v_a , v_b )");
    expect(translateChartExpr("IF(value > 0, value, 0)")).toBe("IF ( v_value > 0 , v_value , 0 )");
  });

  it("preserves TRUE/FALSE literals (not treated as variables)", () => {
    expect(translateChartExpr("IF(TRUE, 1, 2)")).toBe("IF ( TRUE , 1 , 2 )");
    expect(translateChartExpr("false")).toBe("FALSE");
  });

  it("passes through string literals (with escaped quotes) and operators", () => {
    expect(translateChartExpr('"a""b" & x')).toBe('"a""b" & v_x');
    expect(translateChartExpr("a <> b")).toBe("v_a <> v_b");
    expect(translateChartExpr("a != b")).toBe("v_a <> v_b"); // != normalized to <>
  });

  it("throws FormulaError on a lex failure (caller treats as compile failure)", () => {
    expect(() => translateChartExpr('"unterminated')).toThrow(FormulaError);
    expect(() => translateChartExpr("[unterminated")).toThrow(FormulaError);
    expect(() => translateChartExpr("alert('x')")).toThrow(FormulaError); // single quotes invalid
  });
});

// ============================================================================
// toEngineScope — map a row scope to engine bindings
// ============================================================================

describe("toEngineScope", () => {
  it("aliases every key; exact + underscore series forms map to one binding", () => {
    const scope: FormulaScope = new Map<string, number | string | boolean>([
      ["Revenue Total", 50],
      ["Revenue_Total", 50],
      ["$category", "North"],
      ["value", 150],
    ]);
    expect(toEngineScope(scope)).toEqual({
      v_Revenue_Total: 50,
      v__category: "North",
      v_value: 150,
    });
  });
});

// ============================================================================
// Result coercion (mirrors the old keep-on-error / 0-fallback semantics)
// ============================================================================

describe("isEngineError", () => {
  it("detects #… error strings only", () => {
    expect(isEngineError("#NAME?")).toBe(true);
    expect(isEngineError("#DIV/0!")).toBe(true);
    expect(isEngineError("North")).toBe(false);
    expect(isEngineError(5)).toBe(false);
    expect(isEngineError(true)).toBe(false);
    expect(isEngineError(null)).toBe(false);
  });
});

describe("resultToBoolean", () => {
  it("reads bool/number/string/null", () => {
    expect(resultToBoolean(true)).toBe(true);
    expect(resultToBoolean(false)).toBe(false);
    expect(resultToBoolean(5)).toBe(true);
    expect(resultToBoolean(0)).toBe(false);
    expect(resultToBoolean("TRUE")).toBe(true);
    expect(resultToBoolean(null)).toBe(false);
  });
  it("throws on a non-boolean string or array (caller keeps the row)", () => {
    expect(() => resultToBoolean("North")).toThrow(FormulaError);
    expect(() => resultToBoolean([1, 2])).toThrow(FormulaError);
  });
});

describe("resultToNumber", () => {
  it("reads number/bool/string/null; non-finite → 0", () => {
    expect(resultToNumber(42)).toBe(42);
    expect(resultToNumber(true)).toBe(1);
    expect(resultToNumber("3.5")).toBe(3.5);
    expect(resultToNumber(null)).toBe(0);
    expect(resultToNumber(Infinity)).toBe(0);
    expect(resultToNumber(NaN)).toBe(0);
  });
  it("throws on a non-numeric string or array (caller falls back to 0)", () => {
    expect(() => resultToNumber("abc")).toThrow(FormulaError);
    expect(() => resultToNumber([1])).toThrow(FormulaError);
  });
});
