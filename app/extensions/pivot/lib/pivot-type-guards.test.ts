//! FILENAME: app/extensions/Pivot/lib/pivot-type-guards.test.ts
// PURPOSE: Exhaustive tests for pivot type guard functions.

import { describe, it, expect } from "vitest";
import {
  isHeaderCell,
  isTotalCell,
  isFilterCell,
  isDataRow,
  isFilterRow,
  type PivotCellType,
  type PivotRowType,
} from "./pivot-api";

// ============================================================================
// All possible enum values for reference
// ============================================================================

const allCellTypes: PivotCellType[] = [
  "Data", "RowHeader", "ColumnHeader", "Corner",
  "RowSubtotal", "ColumnSubtotal", "GrandTotal",
  "GrandTotalRow", "GrandTotalColumn", "Blank",
  "FilterLabel", "FilterDropdown",
  "RowLabelHeader", "ColumnLabelHeader",
];

const allRowTypes: PivotRowType[] = [
  "ColumnHeader", "Data", "Subtotal", "GrandTotal", "FilterRow",
];

// ============================================================================
// isHeaderCell
// ============================================================================

describe("isHeaderCell", () => {
  const headers: PivotCellType[] = [
    "RowHeader", "ColumnHeader", "Corner", "RowLabelHeader", "ColumnLabelHeader",
  ];

  it.each(headers)("returns true for header type '%s'", (type) => {
    expect(isHeaderCell(type)).toBe(true);
  });

  const nonHeaders = allCellTypes.filter((t) => !headers.includes(t));

  it.each(nonHeaders)("returns false for non-header type '%s'", (type) => {
    expect(isHeaderCell(type)).toBe(false);
  });
});

// ============================================================================
// isTotalCell
// ============================================================================

describe("isTotalCell", () => {
  const totals: PivotCellType[] = [
    "RowSubtotal", "ColumnSubtotal", "GrandTotal", "GrandTotalRow", "GrandTotalColumn",
  ];

  it.each(totals)("returns true for total type '%s'", (type) => {
    expect(isTotalCell(type)).toBe(true);
  });

  const nonTotals = allCellTypes.filter((t) => !totals.includes(t));

  it.each(nonTotals)("returns false for non-total type '%s'", (type) => {
    expect(isTotalCell(type)).toBe(false);
  });
});

// ============================================================================
// isFilterCell
// ============================================================================

describe("isFilterCell", () => {
  const filters: PivotCellType[] = ["FilterLabel", "FilterDropdown"];

  it.each(filters)("returns true for filter type '%s'", (type) => {
    expect(isFilterCell(type)).toBe(true);
  });

  const nonFilters = allCellTypes.filter((t) => !filters.includes(t));

  it.each(nonFilters)("returns false for non-filter type '%s'", (type) => {
    expect(isFilterCell(type)).toBe(false);
  });
});

// ============================================================================
// isDataRow
// ============================================================================

describe("isDataRow", () => {
  it("returns true for 'Data' row type", () => {
    expect(isDataRow("Data")).toBe(true);
  });

  const nonData = allRowTypes.filter((t) => t !== "Data");

  it.each(nonData)("returns false for non-data row type '%s'", (type) => {
    expect(isDataRow(type)).toBe(false);
  });
});

// ============================================================================
// isFilterRow
// ============================================================================

describe("isFilterRow", () => {
  it("returns true for 'FilterRow' row type", () => {
    expect(isFilterRow("FilterRow")).toBe(true);
  });

  const nonFilter = allRowTypes.filter((t) => t !== "FilterRow");

  it.each(nonFilter)("returns false for non-filter row type '%s'", (type) => {
    expect(isFilterRow(type)).toBe(false);
  });
});
