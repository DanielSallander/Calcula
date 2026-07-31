//! FILENAME: app/src/api/scriptHost/__tests__/pivotLayoutVocabulary.test.ts
// PURPOSE: The pure area / aggregation / layout-directive mapping behind the
//          pivot layout aspects (B3 §4).
// CONTEXT: These words ARE the Pivot Layout DSL's. This file proves the mapping
//          itself (area <-> PivotAxis round-trip, the compact DSL aggregation
//          spellings -> the Excel-shaped AggregationFunction, and the LAYOUT
//          fold's last-wins semantics). The DRIFT check against the DSL's own
//          constant sets lives on the DSL side (extensions/_shared/dsl/
//          pivotLayout/scriptVocabularyParity.test.ts) because the API facade
//          may not import an extension.

import { describe, it, expect } from "vitest";
import {
  PIVOT_AGGREGATIONS,
  PIVOT_AREAS,
  PIVOT_LAYOUT_DIRECTIVES,
  aggregationToFunction,
  areaToAxis,
  axisToArea,
  layoutDirectivesToConfig,
  type PivotArea,
} from "../pivotLayoutVocabulary";

describe("areas", () => {
  it("maps every DSL area to its PivotAxis", () => {
    expect(areaToAxis("rows")).toBe("row");
    expect(areaToAxis("columns")).toBe("column");
    expect(areaToAxis("values")).toBe("data");
    expect(areaToAxis("filters")).toBe("filter");
  });

  it("round-trips area -> axis -> area for every area", () => {
    for (const area of PIVOT_AREAS) {
      const axis = areaToAxis(area);
      expect(axis).not.toBeNull();
      expect(axisToArea(axis!)).toBe(area);
    }
  });

  it("rejects the singular/Excel spellings a script might guess", () => {
    expect(areaToAxis("row")).toBeNull();
    expect(areaToAxis("data")).toBeNull();
    expect(areaToAxis("Rows")).toBeNull();
    expect(areaToAxis("")).toBeNull();
  });

  it("returns null for the 'unknown' axis rather than inventing an area", () => {
    expect(axisToArea("unknown")).toBeNull();
  });

  it("is not fooled by inherited Object properties", () => {
    expect(areaToAxis("toString")).toBeNull();
    expect(areaToAxis("constructor")).toBeNull();
    expect(aggregationToFunction("hasOwnProperty")).toBeNull();
  });
});

describe("aggregations", () => {
  it("passes the shared spellings through unchanged", () => {
    for (const word of ["sum", "count", "average", "min", "max", "product"]) {
      expect(aggregationToFunction(word)).toBe(word);
    }
  });

  it("translates the compact DSL spellings to the Excel-shaped enum", () => {
    expect(aggregationToFunction("countnumbers")).toBe("countNumbers");
    expect(aggregationToFunction("stddev")).toBe("standardDeviation");
    expect(aggregationToFunction("stddevp")).toBe("standardDeviationP");
    expect(aggregationToFunction("var")).toBe("variance");
    expect(aggregationToFunction("varp")).toBe("varianceP");
  });

  it("maps every word in PIVOT_AGGREGATIONS (no hole in the table)", () => {
    for (const word of PIVOT_AGGREGATIONS) {
      expect(aggregationToFunction(word)).not.toBeNull();
    }
  });

  it("rejects near-misses and the API-side spellings", () => {
    expect(aggregationToFunction("avg")).toBeNull();
    expect(aggregationToFunction("Sum")).toBeNull();
    expect(aggregationToFunction("countNumbers")).toBeNull();
    expect(aggregationToFunction("standardDeviation")).toBeNull();
    // "automatic" is an AggregationFunction the backend understands, but it is
    // NOT a DSL word — a script must say what it means.
    expect(aggregationToFunction("automatic")).toBeNull();
  });
});

describe("layout directives", () => {
  it("maps the report-layout family", () => {
    expect(layoutDirectivesToConfig(["compact"]).layout.reportLayout).toBe("compact");
    expect(layoutDirectivesToConfig(["outline"]).layout.reportLayout).toBe("outline");
    expect(layoutDirectivesToConfig(["tabular"]).layout.reportLayout).toBe("tabular");
  });

  it("maps grand totals, including the per-axis narrowing", () => {
    expect(layoutDirectivesToConfig(["no-grand-totals"]).layout).toEqual({
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
    });
    expect(layoutDirectivesToConfig(["no-row-totals"]).layout).toEqual({ showRowGrandTotals: false });
    expect(layoutDirectivesToConfig(["column-totals"]).layout).toEqual({ showColumnGrandTotals: true });
  });

  it("maps the values-position directives", () => {
    expect(layoutDirectivesToConfig(["values-on-rows"]).layout.valuesPosition).toBe("rows");
    expect(layoutDirectivesToConfig(["values-on-columns"]).layout.valuesPosition).toBe("columns");
  });

  it("maps subtotal placement (which the DSL lexer accepts but its compiler drops)", () => {
    expect(layoutDirectivesToConfig(["subtotals-top"]).layout.subtotalLocation).toBe("atTop");
    expect(layoutDirectivesToConfig(["subtotals-bottom"]).layout.subtotalLocation).toBe("atBottom");
    expect(layoutDirectivesToConfig(["subtotals-off"]).layout.subtotalLocation).toBe("off");
  });

  it("applies left to right, so a later directive wins", () => {
    const { layout } = layoutDirectivesToConfig(["compact", "tabular"]);
    expect(layout.reportLayout).toBe("tabular");
    const totals = layoutDirectivesToConfig(["no-grand-totals", "row-totals"]).layout;
    expect(totals.showRowGrandTotals).toBe(true);
    expect(totals.showColumnGrandTotals).toBe(false);
  });

  it("folds several unrelated directives into ONE config", () => {
    const { layout, unknown } = layoutDirectivesToConfig([
      "tabular",
      "values-on-rows",
      "no-grand-totals",
      "auto-fit",
      "repeat-labels",
    ]);
    expect(unknown).toEqual([]);
    expect(layout).toEqual({
      reportLayout: "tabular",
      valuesPosition: "rows",
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
      autoFitColumnWidths: true,
      repeatRowLabels: true,
    });
  });

  it("REPORTS an unknown directive instead of silently dropping it", () => {
    const { layout, unknown } = layoutDirectivesToConfig(["tabular", "make-it-pretty"]);
    expect(unknown).toEqual(["make-it-pretty"]);
    expect(layout.reportLayout).toBe("tabular");
  });

  it("maps every directive in PIVOT_LAYOUT_DIRECTIVES (no hole in the switch)", () => {
    for (const directive of PIVOT_LAYOUT_DIRECTIVES) {
      const { layout, unknown } = layoutDirectivesToConfig([directive]);
      expect(unknown).toEqual([]);
      expect(Object.keys(layout).length).toBeGreaterThan(0);
    }
  });

  it("returns an empty config for an empty directive list", () => {
    expect(layoutDirectivesToConfig([])).toEqual({ layout: {}, unknown: [] });
  });
});

describe("PIVOT_AREAS", () => {
  it("is exactly the DSL's four clauses", () => {
    expect([...PIVOT_AREAS].sort()).toEqual(["columns", "filters", "rows", "values"] as PivotArea[]);
  });
});
