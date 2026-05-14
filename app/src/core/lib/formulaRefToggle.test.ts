import { describe, it, expect } from "vitest";
import { toggleReferenceAtCursor, getReferenceAtCursor } from "./formulaRefToggle";

// ============================================================================
// toggleReferenceAtCursor
// ============================================================================

describe("toggleReferenceAtCursor", () => {
  // --------------------------------------------------------------------------
  // Full cycle: relative -> absolute -> row-abs -> col-abs -> relative
  // --------------------------------------------------------------------------
  describe("full toggle cycle (F4 behavior)", () => {
    it("cycles B2 -> $B$2 -> B$2 -> $B2 -> B2", () => {
      const f0 = "=B2";
      const r1 = toggleReferenceAtCursor(f0, 1); // cursor on B
      expect(r1.formula).toBe("=$B$2");

      const r2 = toggleReferenceAtCursor(r1.formula, 1);
      expect(r2.formula).toBe("=B$2");

      const r3 = toggleReferenceAtCursor(r2.formula, 1);
      expect(r3.formula).toBe("=$B2");

      const r4 = toggleReferenceAtCursor(r3.formula, 1);
      expect(r4.formula).toBe("=B2");
    });

    it("cycles multi-letter column AA10 correctly", () => {
      const r1 = toggleReferenceAtCursor("=AA10", 1);
      expect(r1.formula).toBe("=$AA$10");

      const r2 = toggleReferenceAtCursor(r1.formula, 1);
      expect(r2.formula).toBe("=AA$10");

      const r3 = toggleReferenceAtCursor(r2.formula, 1);
      expect(r3.formula).toBe("=$AA10");

      const r4 = toggleReferenceAtCursor(r3.formula, 1);
      expect(r4.formula).toBe("=AA10");
    });
  });

  // --------------------------------------------------------------------------
  // Relative references
  // --------------------------------------------------------------------------
  describe("relative references", () => {
    it("toggles a simple relative reference to absolute", () => {
      const result = toggleReferenceAtCursor("=A1", 1);
      expect(result.formula).toBe("=$A$1");
    });

    it("toggles relative reference with cursor at end of ref", () => {
      const result = toggleReferenceAtCursor("=B2", 3); // cursor right after "2"
      expect(result.formula).toBe("=$B$2");
    });

    it("toggles relative reference with cursor at start of ref", () => {
      const result = toggleReferenceAtCursor("=B2", 1); // cursor on "B"
      expect(result.formula).toBe("=$B$2");
    });
  });

  // --------------------------------------------------------------------------
  // Absolute references
  // --------------------------------------------------------------------------
  describe("absolute references", () => {
    it("toggles $B$2 to B$2", () => {
      const result = toggleReferenceAtCursor("=$B$2", 1);
      expect(result.formula).toBe("=B$2");
    });

    it("toggles $AA$100 to AA$100", () => {
      const result = toggleReferenceAtCursor("=$AA$100", 1);
      expect(result.formula).toBe("=AA$100");
    });
  });

  // --------------------------------------------------------------------------
  // Mixed references
  // --------------------------------------------------------------------------
  describe("mixed references", () => {
    it("toggles B$2 to $B2 (row-abs to col-abs)", () => {
      const result = toggleReferenceAtCursor("=B$2", 1);
      expect(result.formula).toBe("=$B2");
    });

    it("toggles $B2 to B2 (col-abs to relative)", () => {
      const result = toggleReferenceAtCursor("=$B2", 1);
      expect(result.formula).toBe("=B2");
    });
  });

  // --------------------------------------------------------------------------
  // Cursor position handling
  // --------------------------------------------------------------------------
  describe("cursor position", () => {
    it("updates cursor position to end of new reference", () => {
      // =B2 -> =$B$2, cursor should be at end of $B$2 (pos 5)
      const result = toggleReferenceAtCursor("=B2", 1);
      expect(result.cursorPos).toBe(5); // "=$B$2" -> cursor after "2"
    });

    it("updates cursor when ref shrinks", () => {
      // =$B$2 -> =B$2, cursor at end of B$2 (pos 4)
      const result = toggleReferenceAtCursor("=$B$2", 1);
      expect(result.cursorPos).toBe(4);
    });

    it("cursor at position 0 (before =) finds no ref, returns unchanged", () => {
      const result = toggleReferenceAtCursor("=B2", 0);
      // pos 0 is the "=" sign, not on a ref and nothing before cursor
      expect(result.formula).toBe("=B2");
      expect(result.cursorPos).toBe(0);
    });

    it("cursor in the middle of a reference toggles it", () => {
      // =AB12 has length 4 chars at positions 1..4; cursor at 2 (on "B") is inside
      const result = toggleReferenceAtCursor("=AB12", 2);
      expect(result.formula).toBe("=$AB$12");
    });
  });

  // --------------------------------------------------------------------------
  // Multi-reference formulas
  // --------------------------------------------------------------------------
  describe("multi-reference formulas", () => {
    it("toggles the first ref when cursor is on it", () => {
      const result = toggleReferenceAtCursor("=A1+B2", 1);
      expect(result.formula).toBe("=$A$1+B2");
    });

    it("toggles the second ref when cursor is on it", () => {
      // "=A1+B2" -> B2 starts at index 4
      const result = toggleReferenceAtCursor("=A1+B2", 4);
      expect(result.formula).toBe("=A1+$B$2");
    });

    it("does not affect other references when toggling one", () => {
      const result = toggleReferenceAtCursor("=$A$1+B2+C3", 6);
      // B2 is at index 6..7, toggle to $B$2
      expect(result.formula).toBe("=$A$1+$B$2+C3");
    });

    it("toggles within SUM with multiple args", () => {
      // =SUM(A1,B2,C3) -> A1 starts at 5
      const result = toggleReferenceAtCursor("=SUM(A1,B2,C3)", 5);
      expect(result.formula).toBe("=SUM($A$1,B2,C3)");
    });
  });

  // --------------------------------------------------------------------------
  // Range references (A1:B5)
  // --------------------------------------------------------------------------
  describe("range references", () => {
    it("toggles the start of a range when cursor is on it", () => {
      // =A1:B5 -> cursor on A1 (pos 1)
      const result = toggleReferenceAtCursor("=A1:B5", 1);
      expect(result.formula).toBe("=$A$1:B5");
    });

    it("toggles the end of a range when cursor is on it", () => {
      // =A1:B5 -> B5 starts at index 4
      const result = toggleReferenceAtCursor("=A1:B5", 4);
      expect(result.formula).toBe("=A1:$B$5");
    });

    it("toggles absolute range start $A$1:B5 -> A$1:B5", () => {
      const result = toggleReferenceAtCursor("=$A$1:B5", 1);
      expect(result.formula).toBe("=A$1:B5");
    });
  });

  // --------------------------------------------------------------------------
  // Cross-sheet references
  // --------------------------------------------------------------------------
  describe("cross-sheet references", () => {
    it("toggles reference after sheet prefix Sheet1!B2", () => {
      // The regex matches B2 starting after "Sheet1!"
      const formula = "=Sheet1!B2";
      // B2 starts at index 8
      const result = toggleReferenceAtCursor(formula, 8);
      expect(result.formula).toBe("=Sheet1!$B$2");
    });

    it("toggles reference in quoted sheet name", () => {
      const formula = "='My Sheet'!C3";
      // C3 starts at index 12
      const result = toggleReferenceAtCursor(formula, 12);
      expect(result.formula).toBe("='My Sheet'!$C$3");
    });

    it("toggles only the targeted ref in cross-sheet formula with multiple refs", () => {
      const formula = "=Sheet1!A1+Sheet2!B2";
      // Sheet2!B2 -> B2 starts at index 18
      const result = toggleReferenceAtCursor(formula, 18);
      expect(result.formula).toBe("=Sheet1!A1+Sheet2!$B$2");
    });
  });

  // --------------------------------------------------------------------------
  // Fallback: cursor not directly on a reference
  // --------------------------------------------------------------------------
  describe("fallback to nearest reference before cursor", () => {
    it("falls back to nearest ref when cursor is after closing paren", () => {
      // =SUM(B2) -> cursor at pos 8 (after ")"), falls back to B2
      const result = toggleReferenceAtCursor("=SUM(B2)", 8);
      expect(result.formula).toBe("=SUM($B$2)");
    });

    it("falls back to last ref when cursor is at end of formula", () => {
      const result = toggleReferenceAtCursor("=A1+B2+100", 11);
      // nearest before cursor is B2
      expect(result.formula).toBe("=A1+$B$2+100");
    });

    it("picks the closest preceding ref, not earlier ones", () => {
      // =A1+B2+C3 -> cursor at end (pos 9), falls back to C3
      const formula = "=A1+B2+C3";
      const result = toggleReferenceAtCursor(formula, formula.length);
      expect(result.formula).toBe("=A1+B2+$C$3");
    });

    it("returns unchanged if cursor is before all references", () => {
      // cursor at pos 0 -> before "=" and all refs
      const result = toggleReferenceAtCursor("=A1+B2", 0);
      expect(result.formula).toBe("=A1+B2");
      expect(result.cursorPos).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases: empty / invalid input
  // --------------------------------------------------------------------------
  describe("edge cases", () => {
    it("returns unchanged for empty string", () => {
      const result = toggleReferenceAtCursor("", 0);
      expect(result.formula).toBe("");
      expect(result.cursorPos).toBe(0);
    });

    it("returns unchanged for formula with no cell references", () => {
      const result = toggleReferenceAtCursor("=1+2+3", 3);
      expect(result.formula).toBe("=1+2+3");
      expect(result.cursorPos).toBe(3);
    });

    it("returns unchanged for plain text", () => {
      const result = toggleReferenceAtCursor("Hello World", 5);
      expect(result.formula).toBe("Hello World");
      expect(result.cursorPos).toBe(5);
    });

    it("handles formula with only operators", () => {
      const result = toggleReferenceAtCursor("=+*/-", 2);
      expect(result.formula).toBe("=+*/-");
    });

    it("handles cursor position beyond formula length gracefully", () => {
      // cursor at 100, formula is short -- should fallback to last ref
      const result = toggleReferenceAtCursor("=A1", 100);
      expect(result.formula).toBe("=$A$1");
    });
  });

  // --------------------------------------------------------------------------
  // Formula string length changes
  // --------------------------------------------------------------------------
  describe("formula length changes after toggle", () => {
    it("formula grows by 2 when adding two $ signs (relative -> absolute)", () => {
      const result = toggleReferenceAtCursor("=B2", 1);
      expect(result.formula.length).toBe("=B2".length + 2);
    });

    it("formula shrinks by 1 when removing one $ (absolute -> row-abs)", () => {
      const result = toggleReferenceAtCursor("=$B$2", 1);
      expect(result.formula.length).toBe("=$B$2".length - 1);
    });

    it("preserves surrounding formula text after toggle", () => {
      const result = toggleReferenceAtCursor("=SUM(A1)+100", 5);
      expect(result.formula).toBe("=SUM($A$1)+100");
      // Verify the +100 is still there
      expect(result.formula.endsWith("+100")).toBe(true);
    });
  });
});

// ============================================================================
// getReferenceAtCursor
// ============================================================================

describe("getReferenceAtCursor", () => {
  describe("direct match", () => {
    it("returns reference info when cursor is on a reference", () => {
      const result = getReferenceAtCursor("=B2", 1);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe("B2");
      expect(result!.start).toBe(1);
      expect(result!.end).toBe(3);
    });

    it("returns reference info for absolute reference", () => {
      const result = getReferenceAtCursor("=$B$2", 1);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe("$B$2");
      expect(result!.start).toBe(1);
      expect(result!.end).toBe(5);
    });

    it("returns reference info for mixed reference B$2", () => {
      const result = getReferenceAtCursor("=B$2", 1);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe("B$2");
    });

    it("returns reference info for mixed reference $B2", () => {
      const result = getReferenceAtCursor("=$B2", 1);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe("$B2");
    });

    it("returns the correct ref when cursor is on second ref in formula", () => {
      const result = getReferenceAtCursor("=A1+B2", 4);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe("B2");
    });
  });

  describe("fallback to nearest before cursor", () => {
    it("falls back when cursor is after closing paren", () => {
      const result = getReferenceAtCursor("=SUM(B2)", 8);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe("B2");
    });

    it("picks nearest preceding ref", () => {
      const result = getReferenceAtCursor("=A1+B2+C3+100", 14);
      expect(result).not.toBeNull();
      expect(result!.ref).toBe("C3");
    });
  });

  describe("no match", () => {
    it("returns null for empty string", () => {
      expect(getReferenceAtCursor("", 0)).toBeNull();
    });

    it("returns null when no references exist", () => {
      expect(getReferenceAtCursor("=1+2", 2)).toBeNull();
    });

    it("returns null when cursor is before all references", () => {
      expect(getReferenceAtCursor("=A1", 0)).toBeNull();
    });
  });
});
