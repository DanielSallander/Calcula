//! FILENAME: app/src/core/lib/gridRenderer/styles/cellFormatting.deeptest.ts
// PURPOSE: Deep tests for cell value type detection with Excel-compatible edge cases

import { describe, it, expect } from "vitest";
import { isNumericValue, isErrorValue } from "./cellFormatting";

// ============================================================================
// isNumericValue - comprehensive edge cases
// ============================================================================

describe("isNumericValue - number format patterns", () => {
  describe("integer formats (0, #,##0)", () => {
    it("detects simple integers", () => {
      expect(isNumericValue("0")).toBe(true);
      expect(isNumericValue("1")).toBe(true);
      expect(isNumericValue("999999")).toBe(true);
      expect(isNumericValue("-1")).toBe(true);
    });

    it("detects thousands-separated integers", () => {
      expect(isNumericValue("1,000")).toBe(true);
      expect(isNumericValue("1,000,000")).toBe(true);
      expect(isNumericValue("999,999,999")).toBe(true);
    });
  });

  describe("decimal formats (0.00, #,##0.00)", () => {
    it("detects simple decimals", () => {
      expect(isNumericValue("0.00")).toBe(true);
      expect(isNumericValue("3.14")).toBe(true);
      expect(isNumericValue("0.1")).toBe(true);
      expect(isNumericValue(".5")).toBe(true);
    });

    it("detects thousands-separated decimals", () => {
      expect(isNumericValue("1,234.56")).toBe(true);
      expect(isNumericValue("1,234,567.89")).toBe(true);
    });

    it("detects negative decimals", () => {
      expect(isNumericValue("-3.14")).toBe(true);
      expect(isNumericValue("-0.001")).toBe(true);
    });
  });

  describe("percentage formats (0%)", () => {
    it("detects integer percentages", () => {
      expect(isNumericValue("0%")).toBe(true);
      expect(isNumericValue("50%")).toBe(true);
      expect(isNumericValue("100%")).toBe(true);
    });

    it("detects decimal percentages", () => {
      expect(isNumericValue("12.5%")).toBe(true);
      expect(isNumericValue("0.1%")).toBe(true);
      expect(isNumericValue("99.99%")).toBe(true);
    });

    it("detects negative percentages", () => {
      expect(isNumericValue("-5%")).toBe(true);
    });
  });

  describe("currency formats ($#,##0.00)", () => {
    it("detects dollar amounts", () => {
      expect(isNumericValue("$0")).toBe(true);
      expect(isNumericValue("$100")).toBe(true);
      expect(isNumericValue("$1,000")).toBe(true);
      expect(isNumericValue("$1,000.50")).toBe(true);
      expect(isNumericValue("$1,234,567.89")).toBe(true);
    });

    it("detects negative dollar amounts", () => {
      expect(isNumericValue("-$100")).toBe(true);
      expect(isNumericValue("$-100")).toBe(true);
    });

    it("detects accounting-style negatives (parentheses)", () => {
      expect(isNumericValue("(100)")).toBe(true);
      expect(isNumericValue("(1,500.75)")).toBe(true);
      expect(isNumericValue("($1,500.75)")).toBe(true);
    });
  });

  describe("scientific notation (0.00E+00)", () => {
    it("detects scientific notation", () => {
      expect(isNumericValue("1e5")).toBe(true);
      expect(isNumericValue("1E5")).toBe(true);
      expect(isNumericValue("1.5e10")).toBe(true);
      expect(isNumericValue("2.99e-8")).toBe(true);
      expect(isNumericValue("-1.5E+3")).toBe(true);
    });
  });

  describe("whitespace handling", () => {
    it("handles leading/trailing spaces", () => {
      expect(isNumericValue("  42  ")).toBe(true);
      expect(isNumericValue(" 3.14 ")).toBe(true);
      expect(isNumericValue("  $100  ")).toBe(true);
    });

    it("handles tabs", () => {
      expect(isNumericValue("\t42\t")).toBe(true);
    });
  });

  describe("non-numeric rejection", () => {
    it("rejects empty string", () => {
      expect(isNumericValue("")).toBe(false);
    });

    it("rejects pure text", () => {
      expect(isNumericValue("hello")).toBe(false);
      expect(isNumericValue("abc")).toBe(false);
      expect(isNumericValue("true")).toBe(false);
      expect(isNumericValue("false")).toBe(false);
    });

    it("rejects alphanumeric mixtures", () => {
      expect(isNumericValue("abc123")).toBe(false);
      expect(isNumericValue("12abc")).toBe(false);
      expect(isNumericValue("12.3.4")).toBe(false);
    });

    it("rejects Infinity and NaN", () => {
      expect(isNumericValue("Infinity")).toBe(false);
      expect(isNumericValue("-Infinity")).toBe(false);
      expect(isNumericValue("NaN")).toBe(false);
    });

    it("rejects date-like strings", () => {
      // These contain characters that survive the cleaning regex
      expect(isNumericValue("2024-01-15")).toBe(false);
      expect(isNumericValue("01/15/2024")).toBe(false);
    });

    it("rejects error values", () => {
      expect(isNumericValue("#VALUE!")).toBe(false);
      expect(isNumericValue("#REF!")).toBe(false);
    });

    it("rejects whitespace-only strings", () => {
      expect(isNumericValue("   ")).toBe(false);
    });
  });
});

// ============================================================================
// isErrorValue - comprehensive edge cases
// ============================================================================

describe("isErrorValue - comprehensive", () => {
  describe("all standard Excel error types", () => {
    const errors = [
      "#VALUE!",
      "#REF!",
      "#NAME?",
      "#DIV/0!",
      "#NULL!",
      "#N/A",
      "#NUM!",
      "#ERROR",
    ];

    for (const err of errors) {
      it(`detects ${err}`, () => {
        expect(isErrorValue(err)).toBe(true);
      });
    }
  });

  describe("case insensitivity", () => {
    it("detects lowercase errors", () => {
      expect(isErrorValue("#value!")).toBe(true);
      expect(isErrorValue("#ref!")).toBe(true);
      expect(isErrorValue("#div/0!")).toBe(true);
      expect(isErrorValue("#n/a")).toBe(true);
      expect(isErrorValue("#num!")).toBe(true);
      expect(isErrorValue("#error")).toBe(true);
    });

    it("detects mixed-case errors", () => {
      expect(isErrorValue("#Value!")).toBe(true);
      expect(isErrorValue("#Ref!")).toBe(true);
      expect(isErrorValue("#Div/0!")).toBe(true);
    });
  });

  describe("error values with trailing text", () => {
    // The implementation uses startsWith, so errors with extra text should still match
    it("detects errors with trailing content", () => {
      expect(isErrorValue("#VALUE! in cell A1")).toBe(true);
      expect(isErrorValue("#REF! reference")).toBe(true);
    });
  });

  describe("non-error rejection", () => {
    it("rejects normal text", () => {
      expect(isErrorValue("hello")).toBe(false);
      expect(isErrorValue("123")).toBe(false);
    });

    it("rejects hashtag text", () => {
      expect(isErrorValue("#hashtag")).toBe(false);
      expect(isErrorValue("#color")).toBe(false);
      expect(isErrorValue("#ff0000")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isErrorValue("")).toBe(false);
    });

    it("rejects partial matches", () => {
      expect(isErrorValue("#VAL")).toBe(false);
      expect(isErrorValue("#RE")).toBe(false);
    });
  });
});
