//! FILENAME: app/extensions/Charts/lib/__tests__/chartInvalidation.test.ts
// PURPOSE: chartIntersectsChanges (S7d scoped invalidation) — a chart invalidates
//          only when a changed cell hits its read-set; unbounded-dependency
//          charts always invalidate (conservative superset). The data range is
//          matched on the chart's SOURCE sheet (M4: a chart on a canvas reads
//          its data from another sheet), a param cell on the ACTIVE sheet.

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
  // Worksheet chart: placed on sheet 0, data on sheet 0, sheet 0 active.
  it("intersects when a changed cell is inside the data-range bbox", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2 }], 0, 0)).toBe(true);
  });

  it("does NOT intersect when all changes are outside the bbox", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 0, col: 0 }, { row: 11, col: 2 }, { row: 5, col: 9 }], 0, 0)).toBe(false);
  });

  it("is false for an empty change set", () => {
    expect(chartIntersectsChanges(spec(), [], 0, 0)).toBe(false);
  });

  it("intersects when a bound param's cell changes (outside the data bbox)", () => {
    const params: ParamSpec[] = [{ name: "T", cellRef: "=A1" }]; // A1 = row0,col0 (outside bbox row>=1)
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0 }], 0, 0)).toBe(true);
  });

  it("conservatively always intersects when the data range is not coordinates (A1 string / named)", () => {
    expect(chartIntersectsChanges(spec({ data: "Sheet1!A1:D10" }), [{ row: 999, col: 999 }], 0, null)).toBe(true);
  });

  it("conservatively always intersects with a lookup transform (reads an external range)", () => {
    const s = spec({ transform: [{ type: "lookup", from: "Targets!A1:B5", fields: ["Target"] }] });
    expect(chartIntersectsChanges(s, [{ row: 999, col: 999 }], 0, 0)).toBe(true);
  });

  it("conservatively always intersects with a =cell-ref title (read by spec resolution)", () => {
    expect(chartIntersectsChanges(spec({ title: "=Z1" }), [{ row: 999, col: 999 }], 0, 0)).toBe(true);
  });

  it("conservatively always intersects for a concat container (children have their own ranges)", () => {
    // Container bbox does NOT cover the change, but a child range might — always invalidate.
    const child = spec({ data: { sheetIndex: 0, startRow: 100, startCol: 100, endRow: 110, endCol: 105 } });
    const container = spec({ concat: { charts: [child], columns: 1 } });
    expect(chartIntersectsChanges(container, [{ row: 105, col: 102 }], 0, 0)).toBe(true);
  });
});

describe("chartIntersectsChanges keys the data range on the SOURCE sheet (M4)", () => {
  it("intersects an in-bbox change tagged with the source sheet", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2, sheetIndex: 0 }], 0, 0)).toBe(true);
  });

  it("does NOT intersect an in-bbox change tagged with another sheet", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2, sheetIndex: 1 }], 0, 0)).toBe(false);
  });

  it("an untagged change is the active sheet: it matches only while the source sheet is active", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2 }], 0, 0)).toBe(true);
    expect(chartIntersectsChanges(spec(), [{ row: 5, col: 2 }], 1, 0)).toBe(false);
  });

  // THE CANVAS CASE: the chart sits on sheet 2 (a canvas, active) and charts
  // sheet 0's cells, its data ref carrying sheet 0's id.
  describe("a chart on canvas sheet 2 sourced from sheet 0", () => {
    const canvasChart = spec({
      data: { sheetIndex: 0, sheetId: "sheet-0-uuid", startRow: 1, startCol: 0, endRow: 10, endCol: 3 },
    });
    const ACTIVE_CANVAS = 2;
    const SOURCE = 0;

    it("an edit on sheet 0 (tagged) invalidates it", () => {
      expect(chartIntersectsChanges(canvasChart, [{ row: 5, col: 2, sheetIndex: 0 }], ACTIVE_CANVAS, SOURCE)).toBe(true);
    });

    it("the same coordinates tagged sheet 2 (the canvas) do not", () => {
      expect(chartIntersectsChanges(canvasChart, [{ row: 5, col: 2, sheetIndex: 2 }], ACTIVE_CANVAS, SOURCE)).toBe(false);
    });

    it("an UNTAGGED change while the canvas is active does not (it is on the canvas)", () => {
      expect(chartIntersectsChanges(canvasChart, [{ row: 5, col: 2 }], ACTIVE_CANVAS, SOURCE)).toBe(false);
    });
  });

  it("follows the RESOLVED source index, not the ref's stored sheetIndex (a moved sheet)", () => {
    // Stored index says 0, but the id resolves to 3 after a sheet move.
    const moved = spec({
      data: { sheetIndex: 0, sheetId: "moved", startRow: 1, startCol: 0, endRow: 10, endCol: 3 },
    });
    expect(chartIntersectsChanges(moved, [{ row: 5, col: 2, sheetIndex: 3 }], 3, 3)).toBe(true);
    expect(chartIntersectsChanges(moved, [{ row: 5, col: 2, sheetIndex: 0 }], 3, 3)).toBe(false);
  });

  it("an UNKNOWN source sheet (null: cold cache / deleted sheet) always invalidates", () => {
    expect(chartIntersectsChanges(spec(), [{ row: 999, col: 999, sheetIndex: 7 }], 0, null)).toBe(true);
  });

  it("keeps the ACTIVE-sheet rule for a bound param cell", () => {
    const params: ParamSpec[] = [{ name: "T", cellRef: "=A1" }];
    // Param cell A1 (row0,col0) is read from the active sheet.
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0, sheetIndex: 0 }], 0, 0)).toBe(true);
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0, sheetIndex: 1 }], 0, 0)).toBe(false);
    // Data on sheet 0, canvas 2 active: a param-cell change on the active
    // sheet still counts, one on the source sheet (outside the bbox) does not.
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0, sheetIndex: 2 }], 2, 0)).toBe(true);
    expect(chartIntersectsChanges(spec({ params }), [{ row: 0, col: 0, sheetIndex: 0 }], 2, 0)).toBe(false);
  });
});
