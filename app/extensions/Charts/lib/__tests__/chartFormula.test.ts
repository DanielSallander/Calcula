//! FILENAME: app/extensions/Charts/lib/__tests__/chartFormula.test.ts
// PURPOSE: Tests for the chart formula evaluator (chartFormula.ts).

import { describe, it, expect } from "vitest";
import {
  compileFormula,
  evaluateFormula,
  toNumber,
  toText,
  toBoolean,
  FormulaError,
  type FormulaScope,
} from "../chartFormula";

function scope(entries: Record<string, number | string | boolean> = {}): FormulaScope {
  return new Map(Object.entries(entries));
}

const evalIn = (expr: string, vars: Record<string, number | string | boolean> = {}) =>
  evaluateFormula(expr, scope(vars));

// ============================================================================
// Arithmetic
// ============================================================================

describe("chartFormula: arithmetic", () => {
  it("evaluates numbers and decimals", () => {
    expect(evalIn("42")).toBe(42);
    expect(evalIn("1.5")).toBe(1.5);
    expect(evalIn(".5")).toBe(0.5);
    expect(evalIn("1.5e-3")).toBe(0.0015);
  });

  it("respects precedence and parentheses", () => {
    expect(evalIn("2 + 3 * 4")).toBe(14);
    expect(evalIn("(2 + 3) * 4")).toBe(20);
    expect(evalIn("2 * (3 + 4)")).toBe(14);
  });

  it("handles unary minus/plus", () => {
    expect(evalIn("-5")).toBe(-5);
    expect(evalIn("10 * -2")).toBe(-20);
    expect(evalIn("--5")).toBe(5);
    expect(evalIn("-(2 + 3)")).toBe(-5);
  });

  it("supports exponentiation (right-associative)", () => {
    expect(evalIn("2 ^ 3")).toBe(8);
    expect(evalIn("2 ^ 3 ^ 2")).toBe(512); // 2^(3^2)
    expect(evalIn("2 ^ -1")).toBe(0.5);
    expect(evalIn("-2 ^ 2")).toBe(-4); // -(2^2)
  });

  it("is left-associative for - and /", () => {
    expect(evalIn("10 - 3 - 2")).toBe(5);
    expect(evalIn("16 / 2 / 2")).toBe(4);
  });
});

// ============================================================================
// Comparisons & logical
// ============================================================================

describe("chartFormula: comparisons and logic", () => {
  it("numeric comparisons return booleans", () => {
    expect(evalIn("5 > 3")).toBe(true);
    expect(evalIn("5 < 3")).toBe(false);
    expect(evalIn("5 >= 5")).toBe(true);
    expect(evalIn("5 <= 4")).toBe(false);
    expect(evalIn("5 = 5")).toBe(true);
    expect(evalIn("5 <> 5")).toBe(false);
  });

  it("string comparison is case-insensitive for equality", () => {
    expect(evalIn('"Mar" = "mar"')).toBe(true);
    expect(evalIn('"Mar" <> "Apr"')).toBe(true);
  });

  it("supports != as an alias for <>", () => {
    expect(evalIn("3 != 4")).toBe(true);
  });

  it("AND/OR/NOT and boolean literals", () => {
    expect(evalIn("AND(1 > 0, 2 > 1)")).toBe(true);
    expect(evalIn("AND(1 > 0, 2 < 1)")).toBe(false);
    expect(evalIn("OR(1 < 0, 2 > 1)")).toBe(true);
    expect(evalIn("NOT(1 > 0)")).toBe(false);
    expect(evalIn("TRUE")).toBe(true);
    expect(evalIn("FALSE")).toBe(false);
    expect(evalIn("TRUE()")).toBe(true);
  });
});

// ============================================================================
// IF / IFS / IFERROR (lazy)
// ============================================================================

describe("chartFormula: conditionals", () => {
  it("IF returns the taken branch", () => {
    expect(evalIn("IF(1 > 0, 10, 20)")).toBe(10);
    expect(evalIn("IF(1 < 0, 10, 20)")).toBe(20);
    expect(evalIn("IF(1 < 0, 10)")).toBe(false); // omitted else → false
  });

  it("IF does not evaluate the untaken branch (no div-by-zero error)", () => {
    expect(evalIn("IF(x = 0, 0, 1 / x)", { x: 0 })).toBe(0);
  });

  it("IFS picks the first matching pair", () => {
    expect(evalIn("IFS(FALSE, 1, TRUE, 2)")).toBe(2);
    expect(() => evalIn("IFS(FALSE, 1, FALSE, 2)")).toThrow(FormulaError);
  });

  it("IFERROR catches evaluation errors", () => {
    expect(evalIn("IFERROR(SQRT(-1), -99)")).toBe(-99);
    expect(evalIn("IFERROR(SQRT(4), -99)")).toBe(2);
  });
});

// ============================================================================
// Math functions
// ============================================================================

describe("chartFormula: math functions", () => {
  it("basic math", () => {
    expect(evalIn("ABS(-7)")).toBe(7);
    expect(evalIn("SQRT(9)")).toBe(3);
    expect(evalIn("MIN(3, 1, 2)")).toBe(1);
    expect(evalIn("MAX(3, 1, 2)")).toBe(3);
    expect(evalIn("SUM(1, 2, 3, 4)")).toBe(10);
    expect(evalIn("PRODUCT(2, 3, 4)")).toBe(24);
    expect(evalIn("AVERAGE(2, 4, 6)")).toBe(4);
    expect(evalIn("POWER(2, 10)")).toBe(1024);
    expect(evalIn("INT(3.9)")).toBe(3);
    expect(evalIn("SIGN(-4)")).toBe(-1);
  });

  it("ROUND uses round-half-away-from-zero", () => {
    expect(evalIn("ROUND(2.5, 0)")).toBe(3);
    expect(evalIn("ROUND(-2.5, 0)")).toBe(-3);
    expect(evalIn("ROUND(3.14159, 2)")).toBe(3.14);
    expect(evalIn("ROUNDUP(2.1, 0)")).toBe(3);
    expect(evalIn("ROUNDDOWN(2.9, 0)")).toBe(2);
  });

  it("MOD matches Excel (sign of divisor)", () => {
    expect(evalIn("MOD(10, 3)")).toBe(1);
    expect(evalIn("MOD(-10, 3)")).toBe(2);
  });

  it("throws on domain errors", () => {
    expect(() => evalIn("SQRT(-1)")).toThrow(FormulaError);
    expect(() => evalIn("LN(0)")).toThrow(FormulaError);
    expect(() => evalIn("MOD(5, 0)")).toThrow(FormulaError);
  });
});

// ============================================================================
// Text functions & concatenation
// ============================================================================

describe("chartFormula: text", () => {
  it("string concatenation with &", () => {
    expect(evalIn('"a" & "b" & "c"')).toBe("abc");
    expect(evalIn('"x" & 1')).toBe("x1");
  });

  it("text functions", () => {
    expect(evalIn('LEFT("Hello", 2)')).toBe("He");
    expect(evalIn('RIGHT("Hello", 2)')).toBe("lo");
    expect(evalIn('MID("Hello", 2, 3)')).toBe("ell");
    expect(evalIn('LEN("Hello")')).toBe(5);
    expect(evalIn('UPPER("abc")')).toBe("ABC");
    expect(evalIn('LOWER("ABC")')).toBe("abc");
    expect(evalIn('TRIM("  a  b  ")')).toBe("a b");
    expect(evalIn('CONCAT("a", 1, "b")')).toBe("a1b");
    expect(evalIn('EXACT("a", "A")')).toBe(false);
    expect(evalIn('VALUE("12.5")')).toBe(12.5);
  });

  it('supports escaped quotes ("") in string literals', () => {
    expect(evalIn('"a""b"')).toBe('a"b');
  });
});

// ============================================================================
// Variables (scope)
// ============================================================================

describe("chartFormula: variables", () => {
  it("resolves bare identifiers from scope", () => {
    expect(evalIn("Revenue - Cost", { Revenue: 100, Cost: 30 })).toBe(70);
  });

  it("resolves bracketed names with spaces", () => {
    expect(evalIn("[Revenue Total] * 2", { "Revenue Total": 50 })).toBe(100);
  });

  it("resolves $category and value", () => {
    expect(evalIn('$category = "North"', { $category: "North" })).toBe(true);
    expect(evalIn("value > 100", { value: 150 })).toBe(true);
  });

  it("throws on unknown names", () => {
    expect(() => evalIn("Missing + 1")).toThrow(FormulaError);
  });
});

// ============================================================================
// Errors & compile reuse
// ============================================================================

describe("chartFormula: errors and compilation", () => {
  it("throws on syntax errors", () => {
    expect(() => compileFormula("1 +")).toThrow(FormulaError);
    expect(() => compileFormula("(1 + 2")).toThrow(FormulaError);
    expect(() => compileFormula("1 2")).toThrow(FormulaError);
    expect(() => compileFormula('"unterminated')).toThrow(FormulaError);
    expect(() => compileFormula("alert('x')")).toThrow(FormulaError); // single quotes are invalid
  });

  it("throws on unknown functions", () => {
    expect(() => evalIn("BOGUS(1)")).toThrow(FormulaError);
  });

  it("a compiled formula can be reused across scopes", () => {
    const fn = compileFormula("a + b");
    expect(fn(scope({ a: 1, b: 2 }))).toBe(3);
    expect(fn(scope({ a: 10, b: 20 }))).toBe(30);
  });
});

// ============================================================================
// Coercion helpers
// ============================================================================

describe("chartFormula: coercion", () => {
  it("toNumber", () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber(true)).toBe(1);
    expect(toNumber(false)).toBe(0);
    expect(toNumber("3.5")).toBe(3.5);
    expect(toNumber("")).toBe(0);
    expect(() => toNumber("abc")).toThrow(FormulaError);
  });

  it("toText", () => {
    expect(toText(5)).toBe("5");
    expect(toText(true)).toBe("TRUE");
    expect(toText("x")).toBe("x");
  });

  it("toBoolean", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean("TRUE")).toBe(true);
    expect(toBoolean("false")).toBe(false);
    expect(() => toBoolean("maybe")).toThrow(FormulaError);
  });
});
