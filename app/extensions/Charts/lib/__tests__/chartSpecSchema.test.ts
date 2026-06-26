//! FILENAME: app/extensions/Charts/lib/__tests__/chartSpecSchema.test.ts
// PURPOSE: Tests for chartSpecSchema — JSON Schema validity and reference generation.

import { describe, it, expect } from "vitest";
import { chartSpecJsonSchema, generateSpecReference } from "../chartSpecSchema";
import { buildDefaultSpec } from "../chartSpecDefaults";
import { PALETTE_NAMES } from "../../rendering/chartTheme";
import { schemaViolations, collectRefs } from "./schemaValidate";
import type { ChartSpec, ChartType, DataRangeRef } from "../../types";

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

  it("mark lists all 18 built-ins as examples and is open to custom marks", () => {
    const examples: string[] = schema.properties.mark.examples;
    expect(examples).toHaveLength(18);
    expect(examples).toContain("bar");
    expect(examples).toContain("sunburst");
    expect(examples).toContain("pareto");
    // Open (no enum) so registered custom marks are not flagged; pattern guards ids.
    expect(schema.properties.mark.enum).toBeUndefined();
    expect(typeof schema.properties.mark.pattern).toBe("string");
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
    expect(refs).toContain("#/definitions/LookupTransform");
    expect(refs).toContain("#/definitions/PivotTransform");
    expect(refs).toContain("#/definitions/CustomTransform");
  });

  it("validates a CUSTOM transform while keeping built-ins strict (oneOf via `not`)", () => {
    const axis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
    const base: Record<string, unknown> = {
      mark: "bar", data: "Sheet1!A1:B3", hasHeaders: true, seriesOrientation: "columns",
      categoryIndex: 0, series: [{ name: "S", sourceIndex: 1, color: null }], title: null,
      xAxis: axis, yAxis: axis, legend: { visible: false, position: "bottom" }, palette: "default",
    };
    // A custom (non-built-in) transform with arbitrary params -> valid.
    const customOk = { ...base, transform: [{ type: "myThing", threshold: 5, label: "x" }] };
    expect(schemaViolations(customOk, schema)).toEqual([]);

    // A well-formed built-in -> still valid (matches its own def, NOT CustomTransform).
    const builtinOk = { ...base, transform: [{ type: "filter", field: "S", predicate: "> 1" }] };
    expect(schemaViolations(builtinOk, schema)).toEqual([]);

    // A MALFORMED built-in (filter missing predicate) -> still flagged: it can't
    // match FilterTransform (missing required) NOR CustomTransform (type is a
    // built-in, excluded by `not`), so the oneOf reports a violation.
    const builtinBad = { ...base, transform: [{ type: "filter", field: "S" }] };
    expect(schemaViolations(builtinBad, schema).length).toBeGreaterThan(0);
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

// ============================================================================
// Drift Guard: schema <-> ChartSpec types / renderer
// ============================================================================
// The schema uses `additionalProperties: false` everywhere, so any ChartSpec
// field missing from the schema turns a VALID spec into a false editor error.
// These tests fail loudly if a field, definition, or markOptions branch is
// ever omitted again (the regression fixed in Phase 0 / finding §3.2).

/* eslint-disable @typescript-eslint/no-explicit-any */
const SCHEMA = chartSpecJsonSchema as any;
const DEFS = SCHEMA.definitions as Record<string, any>;

// Canonical ChartSpec top-level keys (mirror of types.ts ChartSpec). Update only
// when ChartSpec itself changes — then update the schema to match.
const CHART_SPEC_KEYS: Array<keyof ChartSpec> = [
  "mark", "data", "hasHeaders", "seriesOrientation", "categoryIndex", "series",
  "title", "xAxis", "yAxis", "legend", "palette", "markOptions", "layers",
  "transform", "config", "tooltip", "trendlines", "dataLabels", "dataTable",
  "seriesRefs", "filters", "dataPointOverrides", "encoding", "repeat", "facet", "concat", "params",
];

const ALL_CHART_TYPES: ChartType[] = [
  "bar", "horizontalBar", "line", "area", "scatter", "pie", "donut", "waterfall",
  "combo", "radar", "bubble", "histogram", "funnel", "treemap", "stock", "boxPlot",
  "sunburst", "pareto",
];

describe("chartSpecJsonSchema drift guard", () => {
  const dataRange: DataRangeRef = { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 9, endCol: 3 };
  const autoDetected = {
    categoryIndex: 0,
    series: [{ name: "Revenue", sourceIndex: 1, color: null }],
    orientation: "columns" as const,
  };

  it("declares exactly the ChartSpec top-level keys (no missing, no extra)", () => {
    const schemaKeys = Object.keys(SCHEMA.properties).sort();
    const specKeys = [...CHART_SPEC_KEYS].map(String).sort();
    expect(schemaKeys).toEqual(specKeys);
  });

  it("never references a $ref missing from definitions", () => {
    const refs: string[] = [];
    collectRefs(SCHEMA, refs);
    const missing = [...new Set(refs)].filter(
      (r) => DEFS[r.replace("#/definitions/", "")] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("narrows markOptions per mark (every chart type covered, mapped to a real def)", () => {
    const rules = SCHEMA.allOf as any[];
    expect(Array.isArray(rules)).toBe(true);

    // Every chart type is covered by some if-condition.
    const coveredMarks = new Set(rules.flatMap((r) => r.if.properties.mark.enum as string[]));
    for (const mark of ALL_CHART_TYPES) {
      expect(coveredMarks.has(mark)).toBe(true);
    }

    // Each then-branch points at a real *MarkOptions definition, and every
    // chart-type options def is referenced (Rule/Text are layer-only).
    const narrowedDefs = rules.map((r) => r.then.properties.markOptions.$ref.replace("#/definitions/", ""));
    for (const def of narrowedDefs) {
      expect(DEFS[def]).toBeDefined();
    }
    const chartTypeOptionDefs = Object.keys(DEFS).filter(
      (d) => d.endsWith("MarkOptions") && d !== "RuleMarkOptions" && d !== "TextMarkOptions",
    );
    for (const def of chartTypeOptionDefs) {
      expect(narrowedDefs).toContain(def);
    }
  });

  it("accepts markOptions matching the chart type", () => {
    const line = { ...buildDefaultSpec(dataRange, true, autoDetected, "line"), markOptions: { interpolation: "smooth", showDropLines: true } };
    expect(schemaViolations(line, SCHEMA)).toEqual([]);
    const bar = { ...buildDefaultSpec(dataRange, true, autoDetected, "bar"), markOptions: { borderRadius: 4, stackMode: "stacked" } };
    expect(schemaViolations(bar, SCHEMA)).toEqual([]);
  });

  it("rejects markOptions that belong to a different mark", () => {
    // seriesOverlap is a bar-only option; invalid under a line chart.
    const spec = { ...buildDefaultSpec(dataRange, true, autoDetected, "line"), markOptions: { seriesOverlap: 5 } as any };
    expect(schemaViolations(spec, SCHEMA).length).toBeGreaterThan(0);
  });

  it("accepts a custom (registered) mark with arbitrary markOptions", () => {
    // A custom mark matches no narrowing rule, so markOptions stays the loose
    // base object — not rejected.
    const spec = {
      ...buildDefaultSpec(dataRange, true, autoDetected, "bar"),
      mark: "customRadial" as ChartType,
      markOptions: { anything: 1, foo: "x" } as Record<string, unknown>,
    };
    expect(schemaViolations(spec, SCHEMA)).toEqual([]);
  });

  it("allows any numeric axis label angle (not just 0/45/90)", () => {
    expect(DEFS.AxisSpec.properties.labelAngle.type).toBe("number");
    expect(DEFS.AxisSpec.properties.labelAngle.enum).toBeUndefined();
  });

  it("documents exactly the palettes that actually exist", () => {
    const desc: string = SCHEMA.properties.palette.description;
    for (const name of PALETTE_NAMES) expect(desc).toContain(`'${name}'`);
    expect(desc).not.toContain("earth");
    expect(desc).not.toContain("monochrome");
  });

  it("validates the default spec for every chart type", () => {
    for (const mark of ALL_CHART_TYPES) {
      const spec = buildDefaultSpec(dataRange, true, autoDetected, mark);
      expect(schemaViolations(spec, SCHEMA)).toEqual([]);
    }
  });

  it("validates a kitchen-sink spec exercising every advanced field", () => {
    const spec: ChartSpec = {
      mark: "bar",
      data: "Sheet1!A1:D10",
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [
        {
          name: "Profit",
          sourceIndex: 1,
          color: null,
          encoding: {
            color: { condition: { field: "value", lt: 0, inSelection: "Picked" }, value: "#E15759", otherwise: "#4E79A7" },
            opacity: 0.9,
            size: 5,
            strokeDash: [6, 3],
            strokeWidth: 2,
          },
        },
      ],
      title: "=A1",
      xAxis: {
        title: null, gridLines: false, showLabels: true, labelAngle: -30, min: null, max: null,
        scale: { type: "linear", domain: [0, 100], zero: false, nice: false, reverse: false },
        tickCount: 6, tickFormat: ",.0f",
        majorUnit: 20, minorUnit: 5, displayUnit: "thousands", showDisplayUnitLabel: true,
        majorTickMark: "outside", minorTickMark: "none", labelPosition: "nextToAxis",
        crossesAt: "auto", reverse: false, lineColor: "#999999", lineWidth: 1, lineDash: [2, 2], showLine: true,
      },
      yAxis: { title: "USD", gridLines: true, showLabels: true, labelAngle: 0, min: 0, max: null, minParam: "[Floor]", maxParam: "[Threshold]" },
      legend: { visible: true, position: "bottom" },
      palette: "default",
      markOptions: {
        borderRadius: 4, barGap: 3, stackMode: "stacked",
        errorBars: { enabled: true, type: "percentage", value: 10, direction: "both", color: "#333333", lineWidth: 1.5 },
        fill: { type: "linear", direction: "topToBottom", stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] },
        seriesOverlap: -10, gapWidth: 150,
      },
      layers: [
        { mark: "rule", markOptions: { y: 50, color: "#E15759", strokeWidth: 1.5, strokeDash: [6, 3], label: "Target" } },
        { mark: "text", markOptions: { x: 2, y: 80, text: "Peak", fontSize: 12, color: "#333", anchor: "middle", baseline: "bottom" } },
        { mark: "line", markOptions: { interpolation: "smooth", lineWidth: 2, showMarkers: false }, opacity: 0.8 },
      ],
      transform: [
        { type: "filter", field: "Profit", predicate: "> 0" },
        { type: "sort", field: "Profit", order: "desc" },
        { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Profit", as: "Total" },
        { type: "calculate", expr: "Profit * 1.1", as: "Adjusted" },
        { type: "window", op: "running_sum", field: "Profit", as: "Cumulative" },
        { type: "bin", field: "Profit", binCount: 8, as: "Bins" },
        { type: "lookup", from: "Targets!A1:B13", fields: ["Target"], default: 0 },
        { type: "pivot", category: "Region", key: "Month", value: "Sales", op: "sum" },
      ],
      config: {
        theme: {
          background: "#1e1e1e", plotBackground: "#2d2d2d", gridLineColor: "#444444", gridLineWidth: 1,
          axisColor: "#666666", axisLabelColor: "#aaaaaa", titleColor: "#eeeeee", titleFontSize: 16, labelFontSize: 12,
        },
      },
      tooltip: { enabled: true, fields: ["series", "category", "value"], format: { value: "$,.2f" } },
      trendlines: [
        { type: "polynomial", seriesIndex: 0, color: null, lineWidth: 2, strokeDash: [6, 3], polynomialDegree: 3, showEquation: true, showRSquared: true, label: "Fit" },
      ],
      dataLabels: {
        enabled: true, content: ["value", "percent"], position: "above", fontSize: 10, color: "#333333",
        backgroundColor: null, format: "$,.0f", separator: " - ", seriesFilter: [0], minValue: 10,
      },
      dataTable: { enabled: true, showLegendKeys: true, showHorizontalBorder: true, showVerticalBorder: true, showOutlineBorder: true },
      seriesRefs: [{ nameRef: "Sheet1!$B$1", catRef: "Sheet1!$A$2:$A$10", valRef: "Sheet1!$B$2:$B$10" }],
      filters: { hiddenSeries: [], hiddenCategories: [2] },
      dataPointOverrides: [
        {
          seriesIndex: 0, categoryIndex: 1, color: "#FFD700", opacity: 0.8, borderColor: "#000000", borderWidth: 1, exploded: 10,
          gradientFill: { type: "radial", stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] },
        },
      ],
      params: [
        { name: "Threshold", value: 100, description: "Min revenue", bind: { input: "stepper", min: 0, max: 1000, step: 50 } },
        { name: "Region", cellRef: "=B1", bind: { input: "cycle", options: ["North", "South"] } },
        { name: "Picked", select: "point", on: "category", filter: true, sharedAs: "region", writeTo: "=C1" },
      ],
    };

    expect(schemaViolations(spec, SCHEMA)).toEqual([]);
  });
});
