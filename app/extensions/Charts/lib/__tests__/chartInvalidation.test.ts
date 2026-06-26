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
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2 }], 0)).toBe(true);
  });

  it("does NOT intersect when all changes are outside the bbox", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 0, col: 0 }, { row: 11, col: 2 }, { row: 5, col: 9 }], 0)).toBe(false);
  });

  it("is false for an empty change set", () => {
    expect(chartIntersectsChanges(spec(), [], 0)).toBe(false);
  });

  it("intersects when a bound param's cell changes (outside the data bbox)", () => {
    const params: ParamSpec[] = [{ name: "T", cellRef: "=A1" }]; // A1 = row0,col0 (outside bbox row>=1)
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0 }], 0)).toBe(true);
  });

  it("conservatively always intersects when the data range is not coordinates (A1 string / named)", () => {
    expect(chartIntersectsChanges(spec({ data: "Sheet1!A1:D10" }), [{ row: 999, col: 999 }], 0)).toBe(true);
  });

  it("conservatively always intersects with a lookup transform (reads an external range)", () => {
    const s = spec({ transform: [{ type: "lookup", from: "Targets!A1:B5", fields: ["Target"] }] });
    expect(chartIntersectsChanges(s, [{ row: 999, col: 999 }], 0)).toBe(true);
  });

  it("conservatively always intersects with a =cell-ref title (read by spec resolution)", () => {
    expect(chartIntersectsChanges(spec({ title: "=Z1" }), [{ row: 999, col: 999 }], 0)).toBe(true);
  });

  it("conservatively always intersects for a concat container (children have their own ranges)", () => {
    // Container bbox does NOT cover the change, but a child range might — always invalidate.
    const child = spec({ data: { sheetIndex: 0, startRow: 100, startCol: 100, endRow: 110, endCol: 105 } });
    const container = spec({ concat: { charts: [child], columns: 1 } });
    expect(chartIntersectsChanges(container, [{ row: 105, col: 102 }], 0)).toBe(true);
  });
});

describe("chartIntersectsChanges sheet precision (ITEM 1)", () => {
  // A coordinate chart reads cells from the ACTIVE sheet (getViewportCells is
  // active-sheet-only), so only an active-sheet change can affect it — gating is
  // by activeSheetIndex, NOT spec.data.sheetIndex.
  it("intersects an in-bbox change tagged with the active sheet", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2, sheetIndex: 0 }], 0)).toBe(true);
  });

  it("does NOT intersect an in-bbox change tagged with a NON-active sheet", () => {
    // The edit happened on sheet 1 while sheet 0 is active — the chart reads sheet 0.
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2, sheetIndex: 1 }], 0)).toBe(false);
  });

  it("treats an untagged change as the active sheet (matches in bbox)", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2 }], 0)).toBe(true);
  });

  it("an untagged change matches against whatever sheet is active (active 1)", () => {
    // Untagged = active (1); in bbox -> matches (the chart, when rendered, reads
    // the active sheet regardless of spec.data.sheetIndex).
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2 }], 1)).toBe(true);
  });

  it("ignores spec.data.sheetIndex — gates purely on the active sheet", () => {
    // Chart's data sheet is 2, but the fetch reads the active sheet; a change on
    // the active sheet (0) in bbox invalidates; a change on the data sheet (2,
    // not active) does not.
    const s = spec({ data: { sheetIndex: 2, startRow: 1, startCol: 0, endRow: 10, endCol: 3 } });
    expect(chartIntersectsChanges(s, [{ row: 5, col: 2, sheetIndex: 0 }], 0)).toBe(true);
    expect(chartIntersectsChanges(s, [{ row: 5, col: 2, sheetIndex: 2 }], 0)).toBe(false);
  });

  it("gates a bound param cell by the active sheet too", () => {
    const params: ParamSpec[] = [{ name: "T", cellRef: "=A1" }];
    // Param cell A1 (row0,col0) read from the active sheet (0).
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0, sheetIndex: 0 }], 0)).toBe(true);
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0, sheetIndex: 1 }], 0)).toBe(false);
  });
});
