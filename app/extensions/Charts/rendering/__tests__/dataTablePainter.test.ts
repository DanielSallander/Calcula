//! FILENAME: app/extensions/Charts/rendering/__tests__/dataTablePainter.test.ts
// PURPOSE: Tests for data table layout computation.

import { describe, it, expect } from "vitest";
import { computeDataTableHeight } from "../dataTablePainter";
import type { ChartSpec, ParsedChartData } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeSpec(dataTableEnabled: boolean): ChartSpec {
  return {
    mark: "bar",
    data: { startRow: 0, startCol: 0, endRow: 3, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    dataTable: dataTableEnabled ? { enabled: true } : undefined,
  } as ChartSpec;
}

function makeData(seriesCount: number): ParsedChartData {
  const series = Array.from({ length: seriesCount }, (_, i) => ({
    name: `Series ${i + 1}`,
    values: [10, 20, 30],
    color: null,
  }));
  return { categories: ["A", "B", "C"], series };
}

// ============================================================================
// Tests
// ============================================================================

describe("computeDataTableHeight", () => {
  it("returns 0 when data table is not enabled", () => {
    const spec = makeSpec(false);
    const data = makeData(2);
    expect(computeDataTableHeight(spec, data)).toBe(0);
  });

  it("returns 0 when dataTable is undefined", () => {
    const spec = makeSpec(false);
    spec.dataTable = undefined;
    const data = makeData(2);
    expect(computeDataTableHeight(spec, data)).toBe(0);
  });

  it("returns height for 1 series (1 header + 1 data row + margin)", () => {
    const spec = makeSpec(true);
    const data = makeData(1);
    // 2 rows * 18 + 4 = 40
    expect(computeDataTableHeight(spec, data)).toBe(40);
  });

  it("returns height for 3 series (1 header + 3 data rows + margin)", () => {
    const spec = makeSpec(true);
    const data = makeData(3);
    // 4 rows * 18 + 4 = 76
    expect(computeDataTableHeight(spec, data)).toBe(76);
  });

  it("returns height for 0 series (header row only + margin)", () => {
    const spec = makeSpec(true);
    const data = makeData(0);
    // 1 row * 18 + 4 = 22
    expect(computeDataTableHeight(spec, data)).toBe(22);
  });

  it("scales linearly with series count", () => {
    const spec = makeSpec(true);
    const h1 = computeDataTableHeight(spec, makeData(1));
    const h5 = computeDataTableHeight(spec, makeData(5));
    // Difference should be 4 extra rows * 18 = 72
    expect(h5 - h1).toBe(72);
  });
});
