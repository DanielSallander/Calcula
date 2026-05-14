//! FILENAME: app/extensions/DefinedNames/lib/lambdaUtils.test.ts
// PURPOSE: Tests for LAMBDA utility functions (building, parsing, identification).

import { describe, it, expect } from "vitest";
import {
  FUNCTION_FOLDER_NAME,
  buildLambdaRefersTo,
  parseLambdaRefersTo,
  isCustomFunction,
  formatFunctionSignature,
} from "./lambdaUtils";
import type { NamedRange } from "@api/lib";

// ============================================================================
// Constants
// ============================================================================

describe("FUNCTION_FOLDER_NAME", () => {
  it("should equal '_Functions'", () => {
    expect(FUNCTION_FOLDER_NAME).toBe("_Functions");
  });
});

// ============================================================================
// buildLambdaRefersTo
// ============================================================================

describe("buildLambdaRefersTo", () => {
  it("should build a single-parameter LAMBDA", () => {
    expect(buildLambdaRefersTo(["x"], "x * 2")).toBe("=LAMBDA(x, x * 2)");
  });

  it("should build a two-parameter LAMBDA", () => {
    expect(buildLambdaRefersTo(["x", "y"], "x + y")).toBe(
      "=LAMBDA(x, y, x + y)"
    );
  });

  it("should build a many-parameter LAMBDA", () => {
    const params = ["a", "b", "c", "d", "e"];
    const result = buildLambdaRefersTo(params, "a+b+c+d+e");
    expect(result).toBe("=LAMBDA(a, b, c, d, e, a+b+c+d+e)");
  });

  it("should handle body with nested function calls", () => {
    expect(buildLambdaRefersTo(["x"], "IF(x>0, x, -x)")).toBe(
      "=LAMBDA(x, IF(x>0, x, -x))"
    );
  });

  it("should handle body containing string literals", () => {
    expect(buildLambdaRefersTo(["x"], 'IF(x>0, "positive", "negative")')).toBe(
      '=LAMBDA(x, IF(x>0, "positive", "negative"))'
    );
  });

  it("should handle empty params array with just a body", () => {
    // Edge case: no params, just body. Technically LAMBDA needs at least 1 param,
    // but the builder should still produce valid syntax.
    expect(buildLambdaRefersTo([], "42")).toBe("=LAMBDA(42)");
  });
});

// ============================================================================
// parseLambdaRefersTo
// ============================================================================

describe("parseLambdaRefersTo", () => {
  describe("valid LAMBDA formulas", () => {
    it("should parse a single-parameter LAMBDA", () => {
      const result = parseLambdaRefersTo("=LAMBDA(x, x * 2)");
      expect(result).toEqual({ params: ["x"], body: "x * 2" });
    });

    it("should parse a two-parameter LAMBDA", () => {
      const result = parseLambdaRefersTo("=LAMBDA(x, y, x + y)");
      expect(result).toEqual({ params: ["x", "y"], body: "x + y" });
    });

    it("should parse case-insensitively", () => {
      const result = parseLambdaRefersTo("=lambda(x, x + 1)");
      expect(result).toEqual({ params: ["x"], body: "x + 1" });
    });

    it("should parse without leading equals sign", () => {
      const result = parseLambdaRefersTo("LAMBDA(x, x + 1)");
      expect(result).toEqual({ params: ["x"], body: "x + 1" });
    });

    it("should handle leading/trailing whitespace", () => {
      const result = parseLambdaRefersTo("  =LAMBDA(x, x + 1)  ");
      expect(result).toEqual({ params: ["x"], body: "x + 1" });
    });

    it("should handle body with nested parentheses", () => {
      const result = parseLambdaRefersTo("=LAMBDA(x, IF(x>0, x, -x))");
      expect(result).toEqual({ params: ["x"], body: "IF(x>0, x, -x)" });
    });

    it("should handle body with deeply nested parentheses", () => {
      const result = parseLambdaRefersTo(
        "=LAMBDA(x, IF(x>0, SUM(x, ABS(x)), 0))"
      );
      expect(result).toEqual({
        params: ["x"],
        body: "IF(x>0, SUM(x, ABS(x)), 0)",
      });
    });

    it("should handle body containing string literals with commas", () => {
      const result = parseLambdaRefersTo(
        '=LAMBDA(x, IF(x>0, "yes,positive", "no,negative"))'
      );
      expect(result).toEqual({
        params: ["x"],
        body: 'IF(x>0, "yes,positive", "no,negative")',
      });
    });

    it("should handle params with underscores and dots", () => {
      const result = parseLambdaRefersTo(
        "=LAMBDA(tax_rate, base.amount, base.amount * tax_rate)"
      );
      expect(result).toEqual({
        params: ["tax_rate", "base.amount"],
        body: "base.amount * tax_rate",
      });
    });

    it("should handle many parameters", () => {
      const result = parseLambdaRefersTo(
        "=LAMBDA(a, b, c, d, e, f, a+b+c+d+e+f)"
      );
      expect(result).toEqual({
        params: ["a", "b", "c", "d", "e", "f"],
        body: "a+b+c+d+e+f",
      });
    });

    it("should handle nested LAMBDA in body", () => {
      const result = parseLambdaRefersTo(
        "=LAMBDA(f, x, f(x))"
      );
      expect(result).toEqual({
        params: ["f", "x"],
        body: "f(x)",
      });
    });
  });

  describe("invalid LAMBDA formulas", () => {
    it("should return null for non-LAMBDA formula", () => {
      expect(parseLambdaRefersTo("=SUM(A1:A10)")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parseLambdaRefersTo("")).toBeNull();
    });

    it("should return null for LAMBDA with no content", () => {
      expect(parseLambdaRefersTo("=LAMBDA()")).toBeNull();
    });

    it("should return null for LAMBDA with only body (no params)", () => {
      // parseLambdaRefersTo requires at least 2 segments (params + body)
      expect(parseLambdaRefersTo("=LAMBDA(42)")).toBeNull();
    });

    it("should return null for unmatched parentheses", () => {
      expect(parseLambdaRefersTo("=LAMBDA(x, x + 1")).toBeNull();
    });

    it("should return null when param is not a valid identifier", () => {
      expect(parseLambdaRefersTo("=LAMBDA(123, 456)")).toBeNull();
    });

    it("should return null when param contains spaces", () => {
      expect(parseLambdaRefersTo("=LAMBDA(my param, 1)")).toBeNull();
    });

    it("should return null for plain text", () => {
      expect(parseLambdaRefersTo("hello world")).toBeNull();
    });
  });

  describe("round-trip with buildLambdaRefersTo", () => {
    it("should round-trip a simple function", () => {
      const original = { params: ["x", "y"], body: "x + y" };
      const built = buildLambdaRefersTo(original.params, original.body);
      const parsed = parseLambdaRefersTo(built);
      expect(parsed).toEqual(original);
    });

    it("should round-trip a function with nested calls", () => {
      const original = {
        params: ["rate", "amount"],
        body: "ROUND(amount * rate, 2)",
      };
      const built = buildLambdaRefersTo(original.params, original.body);
      const parsed = parseLambdaRefersTo(built);
      expect(parsed).toEqual(original);
    });

    it("should round-trip a function with many params", () => {
      const original = {
        params: ["a", "b", "c", "d"],
        body: "a * b + c * d",
      };
      const built = buildLambdaRefersTo(original.params, original.body);
      const parsed = parseLambdaRefersTo(built);
      expect(parsed).toEqual(original);
    });

    it("should round-trip a function with deeply nested expressions", () => {
      const original = {
        params: ["x"],
        body: "IF(x>0, SQRT(ABS(x)), LN(ABS(x)+1))",
      };
      const built = buildLambdaRefersTo(original.params, original.body);
      const parsed = parseLambdaRefersTo(built);
      expect(parsed).toEqual(original);
    });
  });
});

// ============================================================================
// isCustomFunction
// ============================================================================

describe("isCustomFunction", () => {
  const baseNamedRange: NamedRange = {
    name: "TestFunc",
    sheetIndex: null,
    refersTo: "=LAMBDA(x, x+1)",
  };

  it("should return true when folder is _Functions", () => {
    expect(
      isCustomFunction({ ...baseNamedRange, folder: "_Functions" })
    ).toBe(true);
  });

  it("should return false when folder is undefined", () => {
    expect(isCustomFunction({ ...baseNamedRange })).toBe(false);
  });

  it("should return false when folder is a different value", () => {
    expect(
      isCustomFunction({ ...baseNamedRange, folder: "MyFolder" })
    ).toBe(false);
  });

  it("should return false when folder is empty string", () => {
    expect(
      isCustomFunction({ ...baseNamedRange, folder: "" })
    ).toBe(false);
  });
});

// ============================================================================
// formatFunctionSignature
// ============================================================================

describe("formatFunctionSignature", () => {
  it("should format a two-param function signature", () => {
    const nr: NamedRange = {
      name: "ADD",
      sheetIndex: null,
      refersTo: "=LAMBDA(x, y, x + y)",
      folder: "_Functions",
    };
    expect(formatFunctionSignature(nr)).toBe("(x, y)");
  });

  it("should format a single-param function signature", () => {
    const nr: NamedRange = {
      name: "DOUBLE",
      sheetIndex: null,
      refersTo: "=LAMBDA(x, x * 2)",
      folder: "_Functions",
    };
    expect(formatFunctionSignature(nr)).toBe("(x)");
  });

  it("should return raw refersTo when formula is not a LAMBDA", () => {
    const nr: NamedRange = {
      name: "Constant",
      sheetIndex: null,
      refersTo: "=42",
      folder: "_Functions",
    };
    expect(formatFunctionSignature(nr)).toBe("=42");
  });

  it("should handle complex parameter names", () => {
    const nr: NamedRange = {
      name: "TAX",
      sheetIndex: null,
      refersTo: "=LAMBDA(tax_rate, base_amount, base_amount * tax_rate)",
      folder: "_Functions",
    };
    expect(formatFunctionSignature(nr)).toBe("(tax_rate, base_amount)");
  });
});
