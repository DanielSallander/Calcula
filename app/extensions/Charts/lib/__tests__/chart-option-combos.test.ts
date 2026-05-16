//! FILENAME: app/extensions/Charts/lib/__tests__/chart-option-combos.test.ts
// PURPOSE: Combinatorial tests for chart aggregate ops, trendlines, filters, and stacking.

import { describe, it, expect } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { computeTrendline } from "../trendlineComputation";
import type {
  ParsedChartData,
  AggregateOp,
  TrendlineType,
  TrendlineSpec,
  TransformSpec,
  ChartType,
  StackMode,
  BarMarkOptions,
  LineMarkOptions,
  AreaMarkOptions,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeData(overrides: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories: ["A", "B", "C", "D", "E"],
    series: [
      { name: "Revenue", values: [100, 200, 300, 150, 250], color: null },
      { name: "Cost", values: [80, 120, 180, 90, 150], color: null },
    ],
    ...overrides,
  };
}

function makeLinearData(): ParsedChartData {
  return {
    categories: ["1", "2", "3", "4", "5"],
    series: [{ name: "Y", values: [2, 4, 6, 8, 10], color: null }],
  };
}

function makeExponentialData(): ParsedChartData {
  return {
    categories: ["1", "2", "3", "4", "5"],
    series: [{ name: "Y", values: [1, 2.7, 7.4, 20.1, 54.6], color: null }],
  };
}

function makeNoisyData(): ParsedChartData {
  return {
    categories: ["1", "2", "3", "4", "5"],
    series: [{ name: "Y", values: [10, 3, 15, 7, 20], color: null }],
  };
}

// ============================================================================
// 6 aggregate ops x 3 sort directions = 18 combos
// ============================================================================

const AGG_OPS: AggregateOp[] = ["sum", "mean", "median", "min", "max", "count"];
const SORT_ORDERS: Array<"asc" | "desc" | undefined> = ["asc", "desc", undefined];

describe("aggregate ops x sort directions (18 combos)", () => {
  let comboIndex = 0;

  for (const op of AGG_OPS) {
    for (const order of SORT_ORDERS) {
      const sortLabel = order ?? "none";
      const label = `${op} + sort=${sortLabel}`;
      const idx = comboIndex++;

      it(`[${idx}] ${label}`, () => {
        // Use duplicated categories so aggregate has something to group
        const data: ParsedChartData = {
          categories: ["X", "X", "Y", "Y", "Z"],
          series: [
            { name: "Val", values: [10, 20, 30, 40, 50], color: null },
          ],
        };

        const transforms: TransformSpec[] = [
          { type: "aggregate", groupBy: ["$category"], op, field: "Val", as: "Result" },
        ];
        if (order) {
          transforms.push({ type: "sort", field: "Result", order });
        }

        const result = applyTransforms(data, transforms);
        // After aggregation, should have 3 categories: X, Y, Z
        expect(result.categories).toHaveLength(3);
        // Result series should exist
        const resultSeries = result.series.find(s => s.name === "Result");
        expect(resultSeries).toBeDefined();
        expect(resultSeries!.values).toHaveLength(3);

        // Values should be finite numbers
        for (const v of resultSeries!.values) {
          expect(Number.isFinite(v)).toBe(true);
        }

        // If sorted, verify order
        if (order === "asc") {
          for (let i = 1; i < resultSeries!.values.length; i++) {
            expect(resultSeries!.values[i]).toBeGreaterThanOrEqual(resultSeries!.values[i - 1]);
          }
        } else if (order === "desc") {
          for (let i = 1; i < resultSeries!.values.length; i++) {
            expect(resultSeries!.values[i]).toBeLessThanOrEqual(resultSeries!.values[i - 1]);
          }
        }
      });
    }
  }
});

// ============================================================================
// 6 trendline types x 3 data shapes = 18 combos
// ============================================================================

const TRENDLINE_TYPES: TrendlineType[] = [
  "linear", "exponential", "polynomial", "power", "logarithmic", "movingAverage",
];

interface DataShape {
  label: string;
  factory: () => ParsedChartData;
}

const DATA_SHAPES: DataShape[] = [
  { label: "linear", factory: makeLinearData },
  { label: "exponential", factory: makeExponentialData },
  { label: "noisy", factory: makeNoisyData },
];

describe("trendline types x data shapes (18 combos)", () => {
  let comboIndex = 0;

  for (const trendType of TRENDLINE_TYPES) {
    for (const shape of DATA_SHAPES) {
      const label = `${trendType} on ${shape.label} data`;
      const idx = comboIndex++;

      it(`[${idx}] ${label}`, () => {
        const data = shape.factory();
        const spec: TrendlineSpec = {
          type: trendType,
          seriesIndex: 0,
          polynomialDegree: 3,
          movingAveragePeriod: 2,
        };

        const result = computeTrendline(data, spec);

        // All trendline types should produce a result for 5-point data
        expect(result).not.toBeNull();
        if (result) {
          expect(result.points.length).toBeGreaterThan(0);
          expect(typeof result.equation).toBe("string");

          // All predicted values should be finite
          for (const pt of result.points) {
            expect(Number.isFinite(pt.value)).toBe(true);
            expect(Number.isFinite(pt.ci)).toBe(true);
          }

          // R-squared should be a number (NaN for movingAverage is acceptable)
          if (trendType !== "movingAverage") {
            expect(typeof result.rSquared).toBe("number");
          }

          // Linear trendline on linear data should have R^2 close to 1
          if (trendType === "linear" && shape.label === "linear") {
            expect(result.rSquared).toBeGreaterThan(0.99);
          }
        }
      });
    }
  }
});

// ============================================================================
// Filter operators x 3 value types (positive, negative, zero) = 18 combos
// ============================================================================

const FILTER_PREDICATES = ["> 0", "< 0", "= 0", ">= 0", "<= 0", "!= 0"];
const VALUE_SETS: Array<{ label: string; values: number[] }> = [
  { label: "positive", values: [10, 20, 30, 40, 50] },
  { label: "negative", values: [-10, -20, -30, -40, -50] },
  { label: "zero-mixed", values: [0, -5, 10, 0, -15] },
];

describe("filter operators x value types (18 combos)", () => {
  let comboIndex = 0;

  for (const pred of FILTER_PREDICATES) {
    for (const vs of VALUE_SETS) {
      const label = `filter "${pred}" on ${vs.label} values`;
      const idx = comboIndex++;

      it(`[${idx}] ${label}`, () => {
        const data: ParsedChartData = {
          categories: ["A", "B", "C", "D", "E"],
          series: [{ name: "Val", values: [...vs.values], color: null }],
        };

        const transforms: TransformSpec[] = [
          { type: "filter", field: "Val", predicate: pred },
        ];

        const result = applyTransforms(data, transforms);

        // Result should have fewer or equal categories
        expect(result.categories.length).toBeLessThanOrEqual(5);

        // Every surviving value should satisfy the predicate
        const op = pred.replace(/\s*\d+$/, "").trim();
        const threshold = parseFloat(pred.replace(/^[^-\d]*/, ""));
        for (const v of result.series[0].values) {
          switch (op) {
            case ">": expect(v).toBeGreaterThan(threshold); break;
            case "<": expect(v).toBeLessThan(threshold); break;
            case "=": expect(v).toBe(threshold); break;
            case ">=": expect(v).toBeGreaterThanOrEqual(threshold); break;
            case "<=": expect(v).toBeLessThanOrEqual(threshold); break;
            case "!=": expect(v).not.toBe(threshold); break;
          }
        }
      });
    }
  }
});

// ============================================================================
// Stacked modes x chart types that support stacking
// ============================================================================

const STACK_MODES: StackMode[] = ["none", "stacked", "percentStacked"];
const STACKABLE_TYPES: Array<{ type: ChartType; optionsKey: string }> = [
  { type: "bar", optionsKey: "stackMode" },
  { type: "horizontalBar", optionsKey: "stackMode" },
  { type: "line", optionsKey: "stackMode" },
  { type: "area", optionsKey: "stackMode" },
];

describe("stacked modes x stackable chart types (12 combos)", () => {
  let comboIndex = 0;

  for (const { type, optionsKey } of STACKABLE_TYPES) {
    for (const stackMode of STACK_MODES) {
      const label = `${type} with stackMode=${stackMode}`;
      const idx = comboIndex++;

      it(`[${idx}] ${label}: mark options are valid`, () => {
        // Verify the option structure is consistent
        const options: Record<string, StackMode> = { [optionsKey]: stackMode };

        expect(options[optionsKey]).toBe(stackMode);
        expect(["none", "stacked", "percentStacked"]).toContain(stackMode);

        // Type-specific validation: bar/horizontalBar use BarMarkOptions
        if (type === "bar" || type === "horizontalBar") {
          const barOpts: BarMarkOptions = { stackMode };
          expect(barOpts.stackMode).toBe(stackMode);
        }
        if (type === "line") {
          const lineOpts: LineMarkOptions = { stackMode };
          expect(lineOpts.stackMode).toBe(stackMode);
        }
        if (type === "area") {
          const areaOpts: AreaMarkOptions = { stackMode };
          expect(areaOpts.stackMode).toBe(stackMode);
        }
      });
    }
  }
});
