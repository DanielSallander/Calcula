//! FILENAME: app/extensions/AdvancedFilter/lib/__tests__/advancedFilterEngine.test.ts
// PURPOSE: Tests for the Advanced Filter A1 range helpers (parse/format).
// NOTE: Criterion parsing + row matching moved SERVER-SIDE to Rust
//       (autofilter.rs run_advanced_filter); their tests live there now
//       (mod advanced_filter_tests). This file covers the pure TS range helpers.

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
  clearAdvancedFilterHiddenRows: vi.fn(),
  runAdvancedFilter: vi.fn(),
}));

import { parseRangeRef, formatRangeRef, formatCellRef } from "../advancedFilterEngine";

// ============================================================================
// parseRangeRef
// ============================================================================

describe("parseRangeRef", () => {
  it("parses standard A1:D10 range", () => {
    expect(parseRangeRef("A1:D10")).toEqual([0, 0, 9, 3]);
  });

  it("parses lowercase range", () => {
    expect(parseRangeRef("b2:c5")).toEqual([1, 1, 4, 2]);
  });

  it("parses range with whitespace", () => {
    expect(parseRangeRef("  A1:B3  ")).toEqual([0, 0, 2, 1]);
  });

  it("parses single cell reference", () => {
    expect(parseRangeRef("C7")).toEqual([6, 2, 6, 2]);
  });

  it("parses multi-letter columns", () => {
    expect(parseRangeRef("AA1:AB5")).toEqual([0, 26, 4, 27]);
  });

  it("returns null for invalid input", () => {
    expect(parseRangeRef("")).toBeNull();
    expect(parseRangeRef("hello")).toBeNull();
    expect(parseRangeRef("123")).toBeNull();
    expect(parseRangeRef("A:B")).toBeNull();
  });
});

// ============================================================================
// formatRangeRef / formatCellRef
// ============================================================================

describe("formatRangeRef", () => {
  it("formats a range as A1-style string", () => {
    expect(formatRangeRef(0, 0, 9, 3)).toBe("A1:D10");
  });

  it("formats single cell range", () => {
    expect(formatRangeRef(4, 2, 4, 2)).toBe("C5:C5");
  });
});

describe("formatCellRef", () => {
  it("formats cell reference", () => {
    expect(formatCellRef(0, 0)).toBe("A1");
    expect(formatCellRef(9, 3)).toBe("D10");
  });
});
