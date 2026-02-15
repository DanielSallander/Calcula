//! FILENAME: app/extensions/pivot/lib/pivot-api.test.ts
/**
 * Unit tests for pivot-api utilities
 */

import { describe, it, expect } from "vitest";
import {
  getCellNumericValue,
  getCellDisplayValue,
  isHeaderCell,
  isTotalCell,
  createFieldConfig,
  createValueFieldConfig,
  type PivotCellValue,
} from "./pivot-api";

describe("pivot-api utilities", () => {
  describe("getCellNumericValue", () => {
    it("returns number for Number type", () => {
      const value: PivotCellValue = { type: "Number", data: 42.5 };
      expect(getCellNumericValue(value)).toBe(42.5);
    });

    it("returns 0 for non-numeric types", () => {
      expect(getCellNumericValue({ type: "Empty" })).toBe(0);
      expect(getCellNumericValue({ type: "Text", data: "hello" })).toBe(0);
      expect(getCellNumericValue({ type: "Boolean", data: true })).toBe(0);
    });
  });

  describe("getCellDisplayValue", () => {
    it("handles all value types", () => {
      expect(getCellDisplayValue({ type: "Empty" })).toBe("");
      expect(getCellDisplayValue({ type: "Number", data: 123.45 })).toBe("123.45");
      expect(getCellDisplayValue({ type: "Text", data: "hello" })).toBe("hello");
      expect(getCellDisplayValue({ type: "Boolean", data: true })).toBe("TRUE");
      expect(getCellDisplayValue({ type: "Boolean", data: false })).toBe("FALSE");
      expect(getCellDisplayValue({ type: "Error", data: "VALUE" })).toBe("#VALUE");
    });
  });

  describe("isHeaderCell", () => {
    it("returns true for header cells", () => {
      expect(isHeaderCell("RowHeader")).toBe(true);
      expect(isHeaderCell("ColumnHeader")).toBe(true);
      expect(isHeaderCell("Corner")).toBe(true);
    });

    it("returns false for non-header cells", () => {
      expect(isHeaderCell("Data")).toBe(false);
      expect(isHeaderCell("GrandTotal")).toBe(false);
    });
  });

  describe("isTotalCell", () => {
    it("returns true for total cells", () => {
      expect(isTotalCell("RowSubtotal")).toBe(true);
      expect(isTotalCell("ColumnSubtotal")).toBe(true);
      expect(isTotalCell("GrandTotal")).toBe(true);
      expect(isTotalCell("GrandTotalRow")).toBe(true);
      expect(isTotalCell("GrandTotalColumn")).toBe(true);
    });

    it("returns false for non-total cells", () => {
      expect(isTotalCell("Data")).toBe(false);
      expect(isTotalCell("RowHeader")).toBe(false);
    });
  });

  describe("createFieldConfig", () => {
    it("creates config with defaults", () => {
      const config = createFieldConfig(0, "Region");
      expect(config).toEqual({
        sourceIndex: 0,
        name: "Region",
        sortOrder: "asc",
        showSubtotals: true,
        collapsed: false,
        hiddenItems: [],
      });
    });

    it("allows overriding defaults", () => {
      const config = createFieldConfig(1, "Product", {
        sortOrder: "desc",
        collapsed: true,
      });
      expect(config.sortOrder).toBe("desc");
      expect(config.collapsed).toBe(true);
    });
  });

  describe("createValueFieldConfig", () => {
    it("creates config with defaults", () => {
      const config = createValueFieldConfig(2, "Sales");
      expect(config).toEqual({
        sourceIndex: 2,
        name: "Sales",
        aggregation: "sum",
        numberFormat: undefined,
        showValuesAs: "normal",
      });
    });

    it("allows specifying aggregation", () => {
      const config = createValueFieldConfig(2, "Count", "count");
      expect(config.aggregation).toBe("count");
    });
  });
});
