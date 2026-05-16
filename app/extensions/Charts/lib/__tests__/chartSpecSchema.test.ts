//! FILENAME: app/extensions/Charts/lib/__tests__/chartSpecSchema.test.ts
// PURPOSE: Tests for chartSpecSchema — JSON Schema validity and reference generation.

import { describe, it, expect } from "vitest";
import { chartSpecJsonSchema, generateSpecReference } from "../chartSpecSchema";

// ============================================================================
// JSON Schema Structure
// ============================================================================

describe("chartSpecJsonSchema", () => {
  const schema = chartSpecJsonSchema as Record<string, any>;

  it("is a valid JSON Schema draft-07 object", () => {
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.title).toBe("ChartSpec");
    expect(schema.type).toBe("object");
  });

  it("declares all required top-level properties", () => {
    const required: string[] = schema.required;
    expect(required).toContain("mark");
    expect(required).toContain("data");
    expect(required).toContain("hasHeaders");
    expect(required).toContain("seriesOrientation");
    expect(required).toContain("categoryIndex");
    expect(required).toContain("series");
    expect(required).toContain("xAxis");
    expect(required).toContain("yAxis");
    expect(required).toContain("legend");
    expect(required).toContain("palette");
  });

  it("mark enum lists all 18 chart types", () => {
    const markEnum: string[] = schema.properties.mark.enum;
    expect(markEnum).toHaveLength(18);
    expect(markEnum).toContain("bar");
    expect(markEnum).toContain("sunburst");
    expect(markEnum).toContain("pareto");
  });

  it("has definitions for all referenced types", () => {
    const defs = Object.keys(schema.definitions);
    expect(defs).toContain("DataRangeRef");
    expect(defs).toContain("PivotDataSource");
    expect(defs).toContain("ChartSeries");
    expect(defs).toContain("AxisSpec");
    expect(defs).toContain("LegendSpec");
    expect(defs).toContain("ScaleSpec");
    expect(defs).toContain("BarMarkOptions");
    expect(defs).toContain("LineMarkOptions");
    expect(defs).toContain("PieMarkOptions");
    expect(defs).toContain("StockMarkOptions");
    expect(defs).toContain("BoxPlotMarkOptions");
    expect(defs).toContain("SunburstMarkOptions");
    expect(defs).toContain("ParetoMarkOptions");
  });

  it("DataRangeRef requires all coordinate fields", () => {
    const drrDef = schema.definitions.DataRangeRef;
    expect(drrDef.required).toContain("sheetIndex");
    expect(drrDef.required).toContain("startRow");
    expect(drrDef.required).toContain("endCol");
  });

  it("LayerSpec mark enum includes rule and text", () => {
    const layerDef = schema.definitions.LayerSpec;
    const markEnum: string[] = layerDef.properties.mark.enum;
    expect(markEnum).toContain("rule");
    expect(markEnum).toContain("text");
    // Should also include all chart types
    expect(markEnum).toContain("bar");
    expect(markEnum.length).toBeGreaterThanOrEqual(20);
  });

  it("TransformSpec includes all transform types", () => {
    const transformDef = schema.definitions.TransformSpec;
    const refs = transformDef.oneOf.map((o: any) => o.$ref);
    expect(refs).toContain("#/definitions/FilterTransform");
    expect(refs).toContain("#/definitions/SortTransform");
    expect(refs).toContain("#/definitions/AggregateTransform");
    expect(refs).toContain("#/definitions/CalculateTransform");
    expect(refs).toContain("#/definitions/WindowTransform");
    expect(refs).toContain("#/definitions/BinTransform");
  });

  it("survives JSON roundtrip", () => {
    const json = JSON.stringify(schema);
    const parsed = JSON.parse(json);
    expect(parsed.title).toBe("ChartSpec");
    expect(Object.keys(parsed.definitions).length).toBe(Object.keys(schema.definitions).length);
  });
});

// ============================================================================
// generateSpecReference
// ============================================================================

describe("generateSpecReference", () => {
  const ref = generateSpecReference();

  it("returns a non-empty string", () => {
    expect(ref.length).toBeGreaterThan(100);
  });

  it("starts with a heading", () => {
    expect(ref.startsWith("# ChartSpec Reference")).toBe(true);
  });

  it("documents all 18 chart types in mark options section", () => {
    expect(ref).toContain("### bar");
    expect(ref).toContain("### line");
    expect(ref).toContain("### pie");
    expect(ref).toContain("### stock");
    expect(ref).toContain("### boxPlot");
    expect(ref).toContain("### sunburst");
    expect(ref).toContain("### pareto");
    expect(ref).toContain("### funnel");
    expect(ref).toContain("### treemap");
    expect(ref).toContain("### radar");
    expect(ref).toContain("### bubble");
    expect(ref).toContain("### histogram");
    expect(ref).toContain("### waterfall");
    expect(ref).toContain("### combo");
  });

  it("documents data transforms", () => {
    expect(ref).toContain("### filter");
    expect(ref).toContain("### sort");
    expect(ref).toContain("### aggregate");
    expect(ref).toContain("### calculate");
    expect(ref).toContain("### window");
    expect(ref).toContain("### bin");
  });

  it("documents layers and annotations", () => {
    expect(ref).toContain("## Layers");
    expect(ref).toContain("### rule");
    expect(ref).toContain("### text");
  });

  it("documents theming", () => {
    expect(ref).toContain("## Deep Theming");
    expect(ref).toContain("### ThemeOverrides");
  });

  it("documents conditional encoding", () => {
    expect(ref).toContain("## Conditional Encoding");
    expect(ref).toContain("### ValueCondition");
  });

  it("documents cell references", () => {
    expect(ref).toContain("## Cell References");
    expect(ref).toContain("=A1");
  });
});
