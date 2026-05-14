//! FILENAME: app/extensions/AdvancedFilter/lib/__tests__/advancedFilterEngine.test.ts
// PURPOSE: Tests for Advanced Filter criteria parsing, matching, and range helpers.

import { describe, it, expect, vi } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("@api", () => ({
  getViewportCells: vi.fn(),
  updateCellsBatch: vi.fn(),
  setHiddenRows: vi.fn().mockImplementation((rows: number[]) => ({ type: "SET_HIDDEN_ROWS", payload: rows })),
  dispatchGridAction: vi.fn(),
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  indexToCol: (idx: number) => {
    // 0=A, 1=B, ..., 25=Z, 26=AA
    let result = "";
    let n = idx;
    do {
      result = String.fromCharCode(65 + (n % 26)) + result;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return result;
  },
  colToIndex: (col: string) => {
    let result = 0;
    for (let i = 0; i < col.length; i++) {
      result = result * 26 + (col.charCodeAt(i) - 64);
    }
    return result - 1;
  },
  setAdvancedFilterHiddenRows: vi.fn(),
  clearAdvancedFilterHiddenRows: vi.fn(),
}));

import {
  parseRangeRef,
  formatRangeRef,
  formatCellRef,
  parseCriterion,
} from "../advancedFilterEngine";

// ============================================================================
// parseRangeRef
// ============================================================================

describe("parseRangeRef", () => {
  it("parses standard A1:D10 range", () => {
    const result = parseRangeRef("A1:D10");
    expect(result).toEqual([0, 0, 9, 3]);
  });

  it("parses lowercase range", () => {
    const result = parseRangeRef("b2:c5");
    expect(result).toEqual([1, 1, 4, 2]);
  });

  it("parses range with whitespace", () => {
    const result = parseRangeRef("  A1:B3  ");
    expect(result).toEqual([0, 0, 2, 1]);
  });

  it("parses single cell reference", () => {
    const result = parseRangeRef("C7");
    expect(result).toEqual([6, 2, 6, 2]);
  });

  it("parses multi-letter columns", () => {
    const result = parseRangeRef("AA1:AB5");
    expect(result).toEqual([0, 26, 4, 27]);
  });

  it("returns null for invalid input", () => {
    expect(parseRangeRef("")).toBeNull();
    expect(parseRangeRef("hello")).toBeNull();
    expect(parseRangeRef("123")).toBeNull();
    expect(parseRangeRef("A:B")).toBeNull();
  });
});

// ============================================================================
// formatRangeRef
// ============================================================================

describe("formatRangeRef", () => {
  it("formats a range as A1-style string", () => {
    expect(formatRangeRef(0, 0, 9, 3)).toBe("A1:D10");
  });

  it("formats single cell range", () => {
    expect(formatRangeRef(4, 2, 4, 2)).toBe("C5:C5");
  });
});

// ============================================================================
// formatCellRef
// ============================================================================

describe("formatCellRef", () => {
  it("formats cell reference", () => {
    expect(formatCellRef(0, 0)).toBe("A1");
    expect(formatCellRef(9, 3)).toBe("D10");
  });
});

// ============================================================================
// parseCriterion
// ============================================================================

describe("parseCriterion", () => {
  it("parses empty string as equals-empty", () => {
    const result = parseCriterion("");
    expect(result).toEqual({ operator: "=", value: "", hasWildcard: false });
  });

  it("parses plain value as implicit equals", () => {
    const result = parseCriterion("hello");
    expect(result).toEqual({ operator: "=", value: "hello", hasWildcard: false });
  });

  it("parses = prefix", () => {
    const result = parseCriterion("=100");
    expect(result).toEqual({ operator: "=", value: "100", hasWildcard: false });
  });

  it("parses <> operator", () => {
    const result = parseCriterion("<>done");
    expect(result).toEqual({ operator: "<>", value: "done", hasWildcard: false });
  });

  it("parses > operator", () => {
    const result = parseCriterion(">50");
    expect(result).toEqual({ operator: ">", value: "50", hasWildcard: false });
  });

  it("parses < operator", () => {
    const result = parseCriterion("<10");
    expect(result).toEqual({ operator: "<", value: "10", hasWildcard: false });
  });

  it("parses >= operator", () => {
    const result = parseCriterion(">=200");
    expect(result).toEqual({ operator: ">=", value: "200", hasWildcard: false });
  });

  it("parses <= operator", () => {
    const result = parseCriterion("<=50.5");
    expect(result).toEqual({ operator: "<=", value: "50.5", hasWildcard: false });
  });

  it("detects wildcard * in equals", () => {
    const result = parseCriterion("=*smith*");
    expect(result).toEqual({ operator: "=", value: "*smith*", hasWildcard: true });
  });

  it("detects wildcard ? in equals", () => {
    const result = parseCriterion("=A?C");
    expect(result).toEqual({ operator: "=", value: "A?C", hasWildcard: true });
  });

  it("detects wildcard in implicit equals", () => {
    const result = parseCriterion("test*");
    expect(result).toEqual({ operator: "=", value: "test*", hasWildcard: true });
  });

  it("detects wildcard in <> operator", () => {
    const result = parseCriterion("<>*error*");
    expect(result).toEqual({ operator: "<>", value: "*error*", hasWildcard: true });
  });

  it("does NOT set wildcard for > with * in value", () => {
    const result = parseCriterion(">a*");
    expect(result.hasWildcard).toBe(false);
  });

  it("trims whitespace", () => {
    const result = parseCriterion("  >= 100  ");
    expect(result).toEqual({ operator: ">=", value: "100", hasWildcard: false });
  });

  it("handles operator with no value", () => {
    const result = parseCriterion(">");
    expect(result).toEqual({ operator: ">", value: "", hasWildcard: false });
  });
});

// ============================================================================
// matchesCriterion (tested indirectly via parseCriterion + known behavior)
// We access matchesCriterion indirectly since it's not exported.
// Instead, we test the criterion structures that drive matching.
// ============================================================================

describe("parseCriterion edge cases", () => {
  it("handles >= before > (operator priority)", () => {
    const ge = parseCriterion(">=5");
    expect(ge.operator).toBe(">=");

    const gt = parseCriterion(">5");
    expect(gt.operator).toBe(">");
  });

  it("handles <= before < (operator priority)", () => {
    const le = parseCriterion("<=5");
    expect(le.operator).toBe("<=");

    const lt = parseCriterion("<5");
    expect(lt.operator).toBe("<");
  });

  it("handles <> before < (operator priority)", () => {
    const ne = parseCriterion("<>5");
    expect(ne.operator).toBe("<>");

    const lt = parseCriterion("<5");
    expect(lt.operator).toBe("<");
  });

  it("numeric string values are preserved as strings", () => {
    const result = parseCriterion("42.5");
    expect(result.value).toBe("42.5");
    expect(typeof result.value).toBe("string");
  });
});
