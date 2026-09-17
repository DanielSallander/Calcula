//! FILENAME: app/extensions/Charts/lib/__tests__/designQuerySeriesBinding.test.ts
// PURPOSE: A plotted series binds to exactly one measure, by its caption or
//          the last " - " part, and never by substring or by guess.

import { describe, it, expect } from "vitest";
import { bindSeriesToMeasures } from "../designQuerySeriesBinding";

describe("bindSeriesToMeasures", () => {
  it("binds a lone value field by its measure name", () => {
    expect(bindSeriesToMeasures(["Cost"], [{ measureName: "Cost" }])).toEqual([{ series: "Cost", measure: "Cost" }]);
  });

  it("binds by the custom caption and reports the underlying MEASURE", () => {
    expect(bindSeriesToMeasures(["Spend"], [{ measureName: "Total Cost", customName: "Spend" }])).toEqual([
      { series: "Spend", measure: "Total Cost" },
    ]);
  });

  it("binds a series under column fields by its last part", () => {
    const fields = [{ measureName: "Cost" }, { measureName: "Revenue" }];
    expect(bindSeriesToMeasures(["West - Cost", "West - Revenue", "East - Cost"], fields)).toEqual([
      { series: "West - Cost", measure: "Cost" },
      { series: "West - Revenue", measure: "Revenue" },
      { series: "East - Cost", measure: "Cost" },
    ]);
  });

  it("uses the LAST part when a member itself contains the joiner", () => {
    expect(bindSeriesToMeasures(["Q1 - 2024 - Cost"], [{ measureName: "Cost" }])).toEqual([
      { series: "Q1 - 2024 - Cost", measure: "Cost" },
    ]);
  });

  it("never binds by substring: 'Cost' does not claim 'Cost of Sales'", () => {
    expect(bindSeriesToMeasures(["Cost of Sales"], [{ measureName: "Cost" }])).toEqual([]);
  });

  it("leaves out a series that matches nothing or matches twice", () => {
    const twice = [{ measureName: "Cost" }, { measureName: "Margin", customName: "Cost" }];
    expect(bindSeriesToMeasures(["Cost", "Value 1"], twice)).toEqual([]);
  });

  it("is deterministic and order-preserving", () => {
    const names = ["B - Cost", "A - Cost"];
    const fields = [{ measureName: "Cost" }];
    const first = JSON.stringify(bindSeriesToMeasures(names, fields));
    for (let i = 0; i < 20; i++) expect(JSON.stringify(bindSeriesToMeasures(names, fields))).toBe(first);
    expect(bindSeriesToMeasures(names, fields).map((b) => b.series)).toEqual(names);
  });
});
