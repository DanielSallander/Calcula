//! FILENAME: app/extensions/Pivot/types-stability.test.ts
// PURPOSE: Verify Pivot type surface stability — catch accidental breaking changes.

import { describe, it, expect } from "vitest";
import type { PivotCellType, PivotRowType, PivotColumnType, BackgroundStyle } from "../Pivot/lib/pivot-api";
import type { ZoneField, SourceField } from "./types";
import type { CompileResult } from "./dsl/compiler";

// ============================================================================
// PivotCellType values
// ============================================================================

describe("PivotCellType value stability", () => {
  it("all expected PivotCellType values are valid", () => {
    const allTypes: PivotCellType[] = [
      "Data",
      "RowHeader",
      "ColumnHeader",
      "Corner",
      "RowSubtotal",
      "ColumnSubtotal",
      "GrandTotal",
      "GrandTotalRow",
      "GrandTotalColumn",
      "Blank",
      "FilterLabel",
      "FilterDropdown",
      "RowLabelHeader",
      "ColumnLabelHeader",
    ];
    expect(allTypes).toHaveLength(14);
  });

  it("PivotRowType has expected values", () => {
    const rowTypes: PivotRowType[] = [
      "ColumnHeader", "Data", "Subtotal", "GrandTotal", "FilterRow",
    ];
    expect(rowTypes).toHaveLength(5);
  });

  it("PivotColumnType has expected values", () => {
    const colTypes: PivotColumnType[] = [
      "RowLabel", "Data", "Subtotal", "GrandTotal",
    ];
    expect(colTypes).toHaveLength(4);
  });

  it("BackgroundStyle has expected values", () => {
    const styles: BackgroundStyle[] = [
      "Normal", "Alternate", "Subtotal",
    ];
    expect(styles).toHaveLength(3);
  });
});

// ============================================================================
// ZoneField structure
// ============================================================================

describe("ZoneField structure contract", () => {
  it("has required fields", () => {
    const field: ZoneField = {
      sourceIndex: 0,
      name: "Region",
      isNumeric: false,
    };
    expect(field.sourceIndex).toBe(0);
    expect(field.name).toBe("Region");
    expect(field.isNumeric).toBe(false);
  });

  it("supports optional aggregation field", () => {
    const field: ZoneField = {
      sourceIndex: 1,
      name: "Sales",
      isNumeric: true,
      aggregation: "sum",
    };
    expect(field.aggregation).toBe("sum");
  });

  it("supports optional customName field", () => {
    const field: ZoneField = {
      sourceIndex: 1,
      name: "Sales",
      isNumeric: true,
      customName: "Total Sales",
    };
    expect(field.customName).toBe("Total Sales");
  });

  it("supports optional showValuesAs field", () => {
    const field: ZoneField = {
      sourceIndex: 1,
      name: "Sales",
      isNumeric: true,
      showValuesAs: "percentOfGrandTotal",
    };
    expect(field.showValuesAs).toBe("percentOfGrandTotal");
  });

  it("supports optional numberFormat field", () => {
    const field: ZoneField = {
      sourceIndex: 1,
      name: "Sales",
      isNumeric: true,
      numberFormat: "#,##0.00",
    };
    expect(field.numberFormat).toBe("#,##0.00");
  });

  it("supports optional baseField and baseItem", () => {
    const field: ZoneField = {
      sourceIndex: 1,
      name: "Sales",
      isNumeric: true,
      baseField: "Region",
      baseItem: "North",
    };
    expect(field.baseField).toBe("Region");
    expect(field.baseItem).toBe("North");
  });
});

// ============================================================================
// SourceField structure
// ============================================================================

describe("SourceField structure contract", () => {
  it("has required fields: index, name, isNumeric", () => {
    const field: SourceField = {
      index: 0,
      name: "Product",
      isNumeric: false,
    };
    expect(field.index).toBe(0);
    expect(field.name).toBe("Product");
    expect(field.isNumeric).toBe(false);
  });
});

// ============================================================================
// CompileResult structure
// ============================================================================

describe("CompileResult structure contract", () => {
  it("has all expected fields", () => {
    const result: CompileResult = {
      rows: [],
      columns: [],
      values: [],
      filters: [],
      layout: {
        reportLayout: "compact",
        showGrandTotalRow: true,
        showGrandTotalColumn: true,
      },
      lookupColumns: [],
      calculatedFields: [],
      valueColumnOrder: [],
      errors: [],
    };

    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.values).toEqual([]);
    expect(result.filters).toEqual([]);
    expect(result.layout).toBeDefined();
    expect(result.lookupColumns).toEqual([]);
    expect(result.calculatedFields).toEqual([]);
    expect(result.valueColumnOrder).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("supports optional saveAs field", () => {
    const result: CompileResult = {
      rows: [],
      columns: [],
      values: [],
      filters: [],
      layout: { reportLayout: "compact", showGrandTotalRow: true, showGrandTotalColumn: true },
      lookupColumns: [],
      calculatedFields: [],
      valueColumnOrder: [],
      saveAs: "MyLayout",
      errors: [],
    };

    expect(result.saveAs).toBe("MyLayout");
  });
});
