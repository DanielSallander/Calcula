//! FILENAME: app/extensions/Charts/lib/__tests__/chartInvalidation.test.ts
// PURPOSE: chartIntersectsChanges (S7d scoped invalidation) — a chart invalidates
//          only when a changed cell hits its read-set; unbounded-dependency
//          charts always invalidate (conservative superset).

import { describe, it, expect } from "vitest";
import { chartIntersectsChanges } from "../chartInvalidation";
import type { ChartSpec, DataRangeRef, ParamSpec } from "../../types";

const range: DataRangeRef = { sheetIndex: 0, startRow: 1, startCol: 0, endRow: 10, endCol: 3 };
const baseAxis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar", data: range, hasHeaders: true, seriesOrientation: "columns",
    categoryIndex: 0, series: [{ name: "Rev", sourceIndex: 1, color: null }],
    title: null, xAxis: { ...baseAxis }, yAxis: { ...baseAxis },
    legend: { visible: true, position: "bottom" }, palette: "default",
    ...over,
  } as ChartSpec;
}

describe("chartIntersectsChanges (S7d)", () => {
  it("intersects when a changed cell is inside the data-range bbox", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2 }])).toBe(true);
  });

  it("does NOT intersect when all changes are outside the bbox", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 0, col: 0 }, { row: 11, col: 2 }, { row: 5, col: 9 }])).toBe(false);
  });

  it("is false for an empty change set", () => {
    expect(chartIntersectsChanges(spec(), [])).toBe(false);
  });

  it("intersects when a bound param's cell changes (outside the data bbox)", () => {
    const params: ParamSpec[] = [{ name: "T", cellRef: "=A1" }]; // A1 = row0,col0 (outside bbox row>=1)
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0 }])).toBe(true);
  });

  it("conservatively always intersects when the data range is not coordinates (A1 string / named)", () => {
    expect(chartIntersectsChanges(spec({ data: "Sheet1!A1:D10" }), [{ row: 999, col: 999 }])).toBe(true);
  });

  it("conservatively always intersects with a lookup transform (reads an external range)", () => {
    const s = spec({ transform: [{ type: "lookup", from: "Targets!A1:B5", fields: ["Target"] }] });
    expect(chartIntersectsChanges(s, [{ row: 999, col: 999 }])).toBe(true);
  });

  it("conservatively always intersects with a =cell-ref title (read by spec resolution)", () => {
    expect(chartIntersectsChanges(spec({ title: "=Z1" }), [{ row: 999, col: 999 }])).toBe(true);
  });

  it("conservatively always intersects for a concat container (children have their own ranges)", () => {
    // Container bbox does NOT cover the change, but a child range might — always invalidate.
    const child = spec({ data: { sheetIndex: 0, startRow: 100, startCol: 100, endRow: 110, endCol: 105 } });
    const container = spec({ concat: { charts: [child], columns: 1 } });
    expect(chartIntersectsChanges(container, [{ row: 105, col: 102 }])).toBe(true);
  });
});
