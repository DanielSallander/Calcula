//! FILENAME: app/extensions/Charts/lib/__tests__/schemaBounds.test.ts
// PURPOSE: The chart-write gate ENFORCES the schema's bounds (minimum/maximum,
//          lengths, patterns, item counts). They were advisory: a script's
//          updateSpec stored a Card with decimals 99 and a callout of 5000 px,
//          and a Gauge with targetSeriesIndex -9 (canvas-review visuals finding).

import { describe, it, expect } from "vitest";
import { validateChartSpec, validateMergedSpec } from "../chartSpecValidate";
import { schemaViolations } from "../jsonSchemaCheck";
import type { ChartSpec } from "../../types";

const axis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
function spec(mark: string, markOptions?: Record<string, unknown>): ChartSpec {
  return {
    mark,
    data: "Sheet1!A1:B5",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "S", sourceIndex: 1, color: null }],
    title: null,
    xAxis: axis,
    yAxis: axis,
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...(markOptions ? { markOptions } : {}),
  } as ChartSpec;
}

describe("bounds are enforced", () => {
  it("a Card's decimals and callout size beyond their maximum are refused", () => {
    const v = validateChartSpec(spec("card", { decimals: 99, calloutFontSize: 5000 }));
    expect(v.join(" ")).toContain("decimals");
    expect(v.join(" ")).toContain("calloutFontSize");
  });

  it("a Gauge's negative series index is refused", () => {
    expect(validateChartSpec(spec("gauge", { targetSeriesIndex: -9 })).join(" ")).toContain("targetSeriesIndex");
  });

  it("a script's MERGED update with decimals 99 is refused (the broker's gate)", () => {
    expect(validateMergedSpec(spec("card", { decimals: 99 })).length).toBeGreaterThan(0);
  });

  it("values inside the bounds pass", () => {
    expect(validateChartSpec(spec("card", { decimals: 2, calloutFontSize: 40 }))).toEqual([]);
    expect(validateChartSpec(spec("gauge", { targetSeriesIndex: 1 }))).toEqual([]);
  });

  it("a mark id that breaks its pattern is refused", () => {
    expect(validateChartSpec(spec("<script>")).join(" ")).toContain("mark");
  });
});

describe("the checker's keywords", () => {
  const defs = { definitions: {} };
  it("minimum / maximum / exclusive", () => {
    expect(schemaViolations(5, { ...defs, minimum: 6 })).toHaveLength(1);
    expect(schemaViolations(5, { ...defs, maximum: 4 })).toHaveLength(1);
    expect(schemaViolations(5, { ...defs, exclusiveMinimum: 5 })).toHaveLength(1);
    expect(schemaViolations(5, { ...defs, exclusiveMaximum: 5 })).toHaveLength(1);
    expect(schemaViolations(5, { ...defs, minimum: 5, maximum: 5 })).toEqual([]);
  });
  it("lengths and patterns apply to strings only, item counts to arrays only", () => {
    expect(schemaViolations("abc", { ...defs, maxLength: 2 })).toHaveLength(1);
    expect(schemaViolations("abc", { ...defs, minLength: 4 })).toHaveLength(1);
    expect(schemaViolations("abc", { ...defs, pattern: "^a" })).toEqual([]);
    expect(schemaViolations("xbc", { ...defs, pattern: "^a" })).toHaveLength(1);
    expect(schemaViolations([], { ...defs, minItems: 1 })).toHaveLength(1);
    expect(schemaViolations([1, 2], { ...defs, maxItems: 1 })).toHaveLength(1);
    expect(schemaViolations(5, { ...defs, maxLength: 0, minItems: 3 })).toEqual([]);
  });
});
