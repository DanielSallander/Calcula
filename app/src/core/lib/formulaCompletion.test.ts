import { describe, it, expect } from "vitest";
import { autoCompleteFormula, isIncompleteFormula } from "./formulaCompletion";

// ============================================================================
// autoCompleteFormula
// ============================================================================

describe("autoCompleteFormula", () => {
  describe("non-formula input (no leading =)", () => {
    it("returns empty string unchanged", () => {
      expect(autoCompleteFormula("")).toBe("");
    });

    it("returns plain text unchanged", () => {
      expect(autoCompleteFormula("Hello world")).toBe("Hello world");
    });

    it("returns number unchanged", () => {
      expect(autoCompleteFormula("42")).toBe("42");
    });

    it("does not complete parentheses in non-formula text", () => {
      expect(autoCompleteFormula("SUM(A1:B2")).toBe("SUM(A1:B2");
    });
  });

  describe("already complete formulas", () => {
    it("returns simple complete formula unchanged", () => {
      expect(autoCompleteFormula("=A1")).toBe("=A1");
    });

    it("returns complete function call unchanged", () => {
      expect(autoCompleteFormula("=SUM(A1:B2)")).toBe("=SUM(A1:B2)");
    });

    it("returns complete nested formula unchanged", () => {
      expect(autoCompleteFormula("=IF(A1>0,SUM(B1:B10),0)")).toBe(
        "=IF(A1>0,SUM(B1:B10),0)"
      );
    });

    it("returns complete formula with quoted string unchanged", () => {
      expect(autoCompleteFormula('=IF(A1>0,"Yes","No")')).toBe(
        '=IF(A1>0,"Yes","No")'
      );
    });

    it("returns bare equals sign unchanged", () => {
      expect(autoCompleteFormula("=")).toBe("=");
    });
  });

  describe("missing closing parentheses", () => {
    it("adds single missing closing paren", () => {
      expect(autoCompleteFormula("=SUM(A1:B2")).toBe("=SUM(A1:B2)");
    });

    it("adds missing paren for nested functions - one level", () => {
      expect(autoCompleteFormula("=SUM(IF(A1>0,1,0)")).toBe(
        "=SUM(IF(A1>0,1,0))"
      );
    });

    it("adds missing parens for nested functions - two levels", () => {
      expect(autoCompleteFormula("=SUM(IF(A1>0,1,0")).toBe(
        "=SUM(IF(A1>0,1,0))"
      );
    });

    it("adds missing parens for deeply nested functions - three levels", () => {
      expect(autoCompleteFormula("=IF(SUM(AVERAGE(A1:A10")).toBe(
        "=IF(SUM(AVERAGE(A1:A10)))"
      );
    });

    it("handles multiple unrelated open parens", () => {
      expect(autoCompleteFormula("=SUM(A1)+MAX(B1")).toBe(
        "=SUM(A1)+MAX(B1)"
      );
    });

    it("handles open paren immediately after equals", () => {
      expect(autoCompleteFormula("=(A1+B1")).toBe("=(A1+B1)");
    });
  });

  describe("missing closing quotes", () => {
    it("closes unclosed double quote", () => {
      expect(autoCompleteFormula('="Hello')).toBe('="Hello"');
    });

    it("closes unclosed single quote", () => {
      expect(autoCompleteFormula("='Sheet Name")).toBe("='Sheet Name'");
    });

    it("does not double-close already closed double quote", () => {
      expect(autoCompleteFormula('="Hello"')).toBe('="Hello"');
    });

    it("does not double-close already closed single quote", () => {
      expect(autoCompleteFormula("='Done'")).toBe("='Done'");
    });

    it("handles empty unclosed string", () => {
      expect(autoCompleteFormula('="')).toBe('=""');
    });
  });

  describe("mixed incomplete elements (unclosed string + parentheses)", () => {
    it("closes unclosed string inside a function, then closes paren", () => {
      expect(autoCompleteFormula('=CONCAT("Hello')).toBe(
        '=CONCAT("Hello")'
      );
    });

    it("closes unclosed string and multiple parens", () => {
      expect(autoCompleteFormula('=IF(A1="Yes')).toBe('=IF(A1="Yes")');
    });

    it("handles completed string but missing paren", () => {
      expect(autoCompleteFormula('=IF(A1="Yes"')).toBe('=IF(A1="Yes")');
    });
  });

  describe("parentheses inside strings (should be ignored)", () => {
    it("ignores open parens inside double-quoted strings", () => {
      expect(autoCompleteFormula('=CONCAT("(hello)")')).toBe(
        '=CONCAT("(hello)")'
      );
    });

    it("ignores unmatched paren inside string when outer paren is complete", () => {
      const input = '=LEN("(((")'
      const expected = '=LEN("(((")'
      expect(autoCompleteFormula(input)).toBe(expected);
    });

    it("ignores parens inside string but still completes missing outer paren", () => {
      const input = '=LEN("((("'
      const expected = '=LEN("(((")'
      expect(autoCompleteFormula(input)).toBe(expected);
    });
  });

  describe("formulas with operators only", () => {
    it("returns simple addition unchanged", () => {
      expect(autoCompleteFormula("=A1+B1")).toBe("=A1+B1");
    });

    it("returns chained operators unchanged", () => {
      expect(autoCompleteFormula("=A1+B1*C1-D1/E1")).toBe(
        "=A1+B1*C1-D1/E1"
      );
    });
  });

  describe("sheet references", () => {
    it("handles complete formula with sheet reference", () => {
      expect(autoCompleteFormula("=Sheet1!A1")).toBe("=Sheet1!A1");
    });

    it("completes paren with sheet reference argument", () => {
      expect(autoCompleteFormula("=SUM(Sheet1!A1:A10")).toBe(
        "=SUM(Sheet1!A1:A10)"
      );
    });

    it("handles quoted sheet name reference", () => {
      expect(autoCompleteFormula("=SUM('My Sheet'!A1:A10)")).toBe(
        "=SUM('My Sheet'!A1:A10)"
      );
    });

    it("completes paren with quoted sheet name reference", () => {
      expect(autoCompleteFormula("=SUM('My Sheet'!A1:A10")).toBe(
        "=SUM('My Sheet'!A1:A10)"
      );
    });
  });

  describe("special characters and edge cases", () => {
    it("handles formula with escaped quote inside string", () => {
      expect(autoCompleteFormula('=CONCAT("He said \\"hi")')).toBe(
        '=CONCAT("He said \\"hi")'
      );
    });

    it("handles single character formula", () => {
      expect(autoCompleteFormula("=A")).toBe("=A");
    });

    it("handles formula with only equals sign and open paren", () => {
      expect(autoCompleteFormula("=(")).toBe("=()");
    });

    it("handles very long formula", () => {
      const longArgs = Array.from({ length: 50 }, (_, i) => `A${i + 1}`).join(
        ","
      );
      expect(autoCompleteFormula(`=SUM(${longArgs}`)).toBe(
        `=SUM(${longArgs})`
      );
    });

    it("handles formula with comparison operators", () => {
      expect(autoCompleteFormula("=IF(A1>=100")).toBe("=IF(A1>=100)");
    });

    it("handles formula with ampersand concatenation", () => {
      expect(autoCompleteFormula('=A1&" "&B1')).toBe('=A1&" "&B1');
    });

    it("does not add parens when parens are balanced even with extra close", () => {
      // Extra closing parens result in negative depth; function only adds when depth > 0
      expect(autoCompleteFormula("=SUM(A1))")).toBe("=SUM(A1))");
    });
  });
});

// ============================================================================
// isIncompleteFormula
// ============================================================================

describe("isIncompleteFormula", () => {
  describe("non-formula input", () => {
    it("returns false for empty string", () => {
      expect(isIncompleteFormula("")).toBe(false);
    });

    it("returns false for plain text", () => {
      expect(isIncompleteFormula("Hello")).toBe(false);
    });

    it("returns false for text with unclosed paren (not a formula)", () => {
      expect(isIncompleteFormula("SUM(A1")).toBe(false);
    });
  });

  describe("complete formulas", () => {
    it("returns false for simple cell reference", () => {
      expect(isIncompleteFormula("=A1")).toBe(false);
    });

    it("returns false for complete function call", () => {
      expect(isIncompleteFormula("=SUM(A1:B2)")).toBe(false);
    });

    it("returns false for complete nested formula", () => {
      expect(isIncompleteFormula("=IF(A1>0,SUM(B1:B10),0)")).toBe(false);
    });

    it("returns false for formula with balanced quotes", () => {
      expect(isIncompleteFormula('=IF(A1,"Yes","No")')).toBe(false);
    });

    it("returns false for bare equals sign", () => {
      expect(isIncompleteFormula("=")).toBe(false);
    });
  });

  describe("incomplete formulas", () => {
    it("returns true for missing closing paren", () => {
      expect(isIncompleteFormula("=SUM(A1:B2")).toBe(true);
    });

    it("returns true for deeply nested missing parens", () => {
      expect(isIncompleteFormula("=IF(SUM(AVERAGE(A1:A10")).toBe(true);
    });

    it("returns true for unclosed double quote", () => {
      expect(isIncompleteFormula('="Hello')).toBe(true);
    });

    it("returns true for unclosed single quote", () => {
      expect(isIncompleteFormula("='Sheet")).toBe(true);
    });

    it("returns true for unclosed string inside function", () => {
      expect(isIncompleteFormula('=CONCAT("Hello')).toBe(true);
    });

    it("returns true for both unclosed string and paren", () => {
      expect(isIncompleteFormula('=IF(A1="Yes')).toBe(true);
    });
  });

  describe("consistency with autoCompleteFormula", () => {
    it("returns false for formulas that autoComplete does not change", () => {
      const completeFormulas = [
        "=A1",
        "=SUM(A1)",
        '=IF(A1,"Y","N")',
        "=A1+B1",
      ];
      for (const f of completeFormulas) {
        expect(isIncompleteFormula(f)).toBe(false);
        expect(autoCompleteFormula(f)).toBe(f);
      }
    });

    it("returns true for formulas that autoComplete does change", () => {
      const incompleteFormulas = [
        "=SUM(A1",
        '="Hello',
        "=IF(SUM(A1",
        '=CONCAT("Hi',
      ];
      for (const f of incompleteFormulas) {
        expect(isIncompleteFormula(f)).toBe(true);
        expect(autoCompleteFormula(f)).not.toBe(f);
      }
    });
  });
});
