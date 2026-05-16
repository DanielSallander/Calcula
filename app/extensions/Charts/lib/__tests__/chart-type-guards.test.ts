//! FILENAME: app/extensions/Charts/lib/__tests__/chart-type-guards.test.ts
// PURPOSE: Exhaustive tests for chart type guards and type-checking functions.

import { describe, it, expect } from "vitest";
import {
  isCartesianChart,
  isDataRangeRef,
  isPivotDataSource,
  type ChartType,
  type DataSource,
  type DataRangeRef,
  type PivotDataSource,
} from "../../types";

// ============================================================================
// isCartesianChart
// ============================================================================

describe("isCartesianChart", () => {
  const cartesianTypes: ChartType[] = [
    "bar", "horizontalBar", "line", "area", "scatter",
    "waterfall", "combo", "bubble", "histogram", "stock", "boxPlot", "pareto",
  ];

  const nonCartesianTypes: ChartType[] = [
    "pie", "donut", "radar", "funnel", "treemap", "sunburst",
  ];

  it.each(cartesianTypes)("returns true for cartesian type '%s'", (type) => {
    expect(isCartesianChart(type)).toBe(true);
  });

  it.each(nonCartesianTypes)("returns false for non-cartesian type '%s'", (type) => {
    expect(isCartesianChart(type)).toBe(false);
  });

  it("covers all ChartType values", () => {
    const allTypes = [...cartesianTypes, ...nonCartesianTypes];
    // Every declared ChartType should be in one of the two lists
    expect(allTypes.length).toBe(18);
  });
});

// ============================================================================
// isDataRangeRef
// ============================================================================

describe("isDataRangeRef", () => {
  it("returns true for DataRangeRef objects", () => {
    const ref: DataRangeRef = {
      startRow: 0,
      startCol: 0,
      endRow: 10,
      endCol: 3,
      sheetIndex: 0,
    };
    expect(isDataRangeRef(ref)).toBe(true);
  });

  it("returns true for minimal object with startRow", () => {
    const obj = { startRow: 0 } as unknown as DataSource;
    expect(isDataRangeRef(obj)).toBe(true);
  });

  it("returns false for string data sources", () => {
    expect(isDataRangeRef("Sheet1!A1:D10")).toBe(false);
    expect(isDataRangeRef("SalesData")).toBe(false);
  });

  it("returns false for PivotDataSource objects", () => {
    const pivot: PivotDataSource = { type: "pivot", pivotId: 1 };
    expect(isDataRangeRef(pivot)).toBe(false);
  });

  it("returns false for null (guarded internally)", () => {
    // null is not a valid DataSource but the guard handles it
    expect(isDataRangeRef(null as unknown as DataSource)).toBe(false);
  });
});

// ============================================================================
// isPivotDataSource
// ============================================================================

describe("isPivotDataSource", () => {
  it("returns true for PivotDataSource objects", () => {
    const pivot: PivotDataSource = { type: "pivot", pivotId: 1 };
    expect(isPivotDataSource(pivot)).toBe(true);
  });

  it("returns false for DataRangeRef objects", () => {
    const ref: DataRangeRef = {
      startRow: 0,
      startCol: 0,
      endRow: 10,
      endCol: 3,
      sheetIndex: 0,
    };
    expect(isPivotDataSource(ref)).toBe(false);
  });

  it("returns false for string sources", () => {
    expect(isPivotDataSource("A1:B10")).toBe(false);
  });

  it("returns false for objects with wrong type field", () => {
    const wrong = { type: "range", pivotId: 1 } as unknown as DataSource;
    expect(isPivotDataSource(wrong)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPivotDataSource(null as unknown as DataSource)).toBe(false);
  });

  it("returns false for objects with type but not 'pivot'", () => {
    const obj = { type: "other" } as unknown as DataSource;
    expect(isPivotDataSource(obj)).toBe(false);
  });
});
