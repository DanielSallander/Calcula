//! FILENAME: app/extensions/Charts/lib/__tests__/chartDataReader.facet.test.ts
// PURPOSE: Unit tests for partitionByFacet — the pure row-partitioner behind
//          facet-by-field (C3 slice 2). Exercised directly against fixed grids
//          (no grid IO), so it is fully deterministic.

import { describe, it, expect } from "vitest";
import { partitionByFacet, MAX_FACETS } from "../chartDataReader";
import type { ChartSpec, ChartType, ParsedChartData, TransformSpec } from "../../types";

/** Minimal lowered spec carrying the fields partitionByFacet reads. */
function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar" as ChartType,
    data: "Sheet1!A1:C6",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 1, // Month
    series: [{ name: "Sales", sourceIndex: 2, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...over,
  };
}

// Long table: Region | Month | Sales
const GRID = [
  ["Region", "Month", "Sales"],
  ["North", "Jan", "10"],
  ["North", "Feb", "20"],
  ["South", "Jan", "30"],
  ["South", "Feb", "40"],
  ["North", "Mar", "5"],
];
const ROWS = GRID.length; // 6
const COLS = 3;
const noLookups = () => new Map<number, ParsedChartData>();

describe("partitionByFacet", () => {
  it("splits rows into one panel per distinct field value (first-seen order)", () => {
    const facets = partitionByFacet(GRID, ROWS, COLS, true, "columns", "Region", spec(), noLookups());
    expect(facets).toBeDefined();
    expect(facets!.map((f) => f.value)).toEqual(["North", "South"]);
  });

  it("builds each panel from only its matching rows", () => {
    const facets = partitionByFacet(GRID, ROWS, COLS, true, "columns", "Region", spec(), noLookups())!;
    const north = facets[0].data;
    expect(north.categories).toEqual(["Jan", "Feb", "Mar"]);
    expect(north.series[0].values).toEqual([10, 20, 5]);
    const south = facets[1].data;
    expect(south.categories).toEqual(["Jan", "Feb"]);
    expect(south.series[0].values).toEqual([30, 40]);
  });

  it("runs transforms per panel (Vega-Lite facet semantics)", () => {
    const transform: TransformSpec[] = [{ type: "filter", field: "Sales", predicate: "> 8" }];
    const facets = partitionByFacet(GRID, ROWS, COLS, true, "columns", "Region", spec({ transform }), noLookups())!;
    // North drops Mar (5 <= 8); South keeps both.
    expect(facets[0].data.categories).toEqual(["Jan", "Feb"]);
    expect(facets[0].data.series[0].values).toEqual([10, 20]);
    expect(facets[1].data.categories).toEqual(["Jan", "Feb"]);
  });

  it("panels do not nest (no recursive facets)", () => {
    const facets = partitionByFacet(GRID, ROWS, COLS, true, "columns", "Region", spec(), noLookups())!;
    for (const f of facets) expect(f.data.facets).toBeUndefined();
  });

  it("labels a blank facet value", () => {
    const grid = [["Region", "Month", "Sales"], ["", "Jan", "10"], ["", "Feb", "20"]];
    const facets = partitionByFacet(grid, 3, COLS, true, "columns", "Region", spec(), noLookups())!;
    expect(facets).toHaveLength(1);
    expect(facets[0].value).toBe("(blank)");
  });

  it("caps panels at MAX_FACETS", () => {
    const grid: string[][] = [["Region", "Month", "Sales"]];
    for (let i = 0; i < MAX_FACETS + 10; i++) grid.push([`R${i}`, "M", "1"]);
    const facets = partitionByFacet(grid, grid.length, COLS, true, "columns", "Region", spec(), noLookups())!;
    expect(facets).toHaveLength(MAX_FACETS);
  });

  it("returns undefined for an unknown field (→ caller renders single chart)", () => {
    expect(partitionByFacet(GRID, ROWS, COLS, true, "columns", "Nope", spec(), noLookups())).toBeUndefined();
  });

  it("returns undefined without a header row", () => {
    expect(partitionByFacet(GRID, ROWS, COLS, false, "columns", "Region", spec(), noLookups())).toBeUndefined();
  });

  it("returns undefined for rows orientation (v1: columns only)", () => {
    expect(partitionByFacet(GRID, ROWS, COLS, true, "rows", "Region", spec(), noLookups())).toBeUndefined();
  });

  it("does not apply index-based chart filters per panel", () => {
    // hiddenCategories are positional indices into the top-level chart, not panels.
    // North would lose index 2 ("Mar") if filters were (wrongly) applied per panel.
    const facets = partitionByFacet(
      GRID, ROWS, COLS, true, "columns", "Region",
      spec({ filters: { hiddenCategories: [2], hiddenSeries: [] } }),
      noLookups(),
    )!;
    expect(facets[0].data.categories).toEqual(["Jan", "Feb", "Mar"]);
  });

  it("matches the field by trimmed header", () => {
    const grid = [[" Region ", "Month", "Sales"], ["North", "Jan", "10"]];
    const facets = partitionByFacet(grid, 2, COLS, true, "columns", "Region", spec(), noLookups());
    expect(facets).toBeDefined();
    expect(facets!.map((f) => f.value)).toEqual(["North"]);
  });
});
