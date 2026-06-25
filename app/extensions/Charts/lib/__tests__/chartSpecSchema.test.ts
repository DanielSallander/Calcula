//! FILENAME: app/extensions/Charts/lib/__tests__/chartSpecSchema.test.ts
// PURPOSE: Tests for chartSpecSchema — JSON Schema validity and reference generation.

import { describe, it, expect } from "vitest";
import { chartSpecJsonSchema, generateSpecReference } from "../chartSpecSchema";
import { buildDefaultSpec } from "../chartSpecDefaults";
import { PALETTE_NAMES } from "../../rendering/chartTheme";
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
    expect(refs).toContain("#/definitions/LookupTransform");
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

function resolveRef(node: any): any {
  let n = node;
  while (n && n.$ref) {
    n = DEFS[String(n.$ref).replace("#/definitions/", "")];
  }
  return n;
}

/**
 * Collect `additionalProperties:false` (unknown property) and missing-`required`
 * violations of `value` against `node`. oneOf/anyOf passes if ANY branch is clean.
 */
function violations(value: any, node: any, path: string): string[] {
  const s = resolveRef(node);
  if (!s) return [];

  const branches: any[] | undefined = s.oneOf ?? s.anyOf;
  if (Array.isArray(branches)) {
    let best: string[] | null = null;
    for (const branch of branches) {
      const errs = violations(value, branch, path);
      if (errs.length === 0) return [];
      if (best === null || errs.length < best.length) best = errs;
    }
    return best ?? [];
  }

  const looksObject = s.type === "object" || s.properties !== undefined;
  if (looksObject && value && typeof value === "object" && !Array.isArray(value)) {
    const out: string[] = [];
    const props = s.properties ?? {};
    if (Array.isArray(s.required)) {
      for (const req of s.required) {
        if (value[req] === undefined) out.push(`${path}: missing required '${req}'`);
      }
    }
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      if (props[key] !== undefined) {
        out.push(...violations(value[key], props[key], `${path}.${key}`));
      } else if (s.additionalProperties === false) {
        out.push(`${path}: unknown property '${key}'`);
      }
    }
    return out;
  }

  if ((s.type === "array" || s.items !== undefined) && Array.isArray(value)) {
    const out: string[] = [];
    value.forEach((item, i) => out.push(...violations(item, s.items, `${path}[${i}]`)));
    return out;
  }

  return [];
}

function collectRefs(node: any, acc: string[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectRefs(n, acc));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") acc.push(v);
    else collectRefs(v, acc);
  }
}

// Canonical ChartSpec top-level keys (mirror of types.ts ChartSpec). Update only
// when ChartSpec itself changes — then update the schema to match.
const CHART_SPEC_KEYS: Array<keyof ChartSpec> = [
  "mark", "data", "hasHeaders", "seriesOrientation", "categoryIndex", "series",
  "title", "xAxis", "yAxis", "legend", "palette", "markOptions", "layers",
  "transform", "config", "tooltip", "trendlines", "dataLabels", "dataTable",
  "seriesRefs", "filters", "dataPointOverrides",
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

  it("wires every *MarkOptions definition into the top-level markOptions oneOf", () => {
    const markOptionDefs = Object.keys(DEFS).filter((d) => d.endsWith("MarkOptions"));
    const wired = new Set(
      (SCHEMA.properties.markOptions.oneOf as any[]).map((b) => b.$ref?.replace("#/definitions/", "")),
    );
    expect(markOptionDefs.filter((d) => !wired.has(d))).toEqual([]);
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
      expect(violations(spec, SCHEMA, mark)).toEqual([]);
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
            color: { condition: { field: "value", lt: 0 }, value: "#E15759", otherwise: "#4E79A7" },
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
      yAxis: { title: "USD", gridLines: true, showLabels: true, labelAngle: 0, min: 0, max: null },
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
    };

    expect(violations(spec, SCHEMA, "spec")).toEqual([]);
  });
});
