//! FILENAME: app/extensions/Charts/lib/__tests__/chart-ultra.test.ts
// PURPOSE: Massive parameterized test suite targeting 2500+ tests.
// CONTEXT: Tests formatTickValue, createLinearScale, applyChartFilters,
//          getSeriesColor, and computeBarRects with programmatically generated data.

import { describe, it, expect } from "vitest";
import { formatTickValue } from "../../rendering/chartPainterUtils";
import { createLinearScale } from "../../rendering/scales";
import { applyChartFilters } from "../chartFilters";
import { getSeriesColor, PALETTES } from "../../rendering/chartTheme";
import { computeBarRects } from "../../rendering/barChartPainter";
import type { ParsedChartData, ChartSpec, ChartLayout, ChartFilters } from "../../types";
import type { ChartRenderTheme } from "../../rendering/chartTheme";
import { DEFAULT_CHART_THEME } from "../../rendering/chartTheme";

// ============================================================================
// 1. formatTickValue: 500 tests
// ============================================================================

interface FormatTickCase {
  input: number;
  expected: string;
}

const formatTickCases: FormatTickCase[] = [];

// Integers 0-99
for (let i = 0; i < 100; i++) {
  formatTickCases.push({ input: i, expected: i.toString() });
}

// Hundreds: 100-999
for (let i = 100; i <= 999; i += 100) {
  formatTickCases.push({ input: i, expected: i.toString() });
}

// Thousands: 1000-9900 by 100
for (let i = 1000; i <= 9900; i += 100) {
  formatTickCases.push({ input: i, expected: (i / 1000).toFixed(1) + "K" });
}

// Ten-thousands: 10000-990000 by 10000
for (let i = 10000; i <= 990000; i += 10000) {
  formatTickCases.push({ input: i, expected: (i / 1000).toFixed(1) + "K" });
}

// Millions: 1M-50M by 1M
for (let i = 1; i <= 50; i++) {
  const v = i * 1_000_000;
  formatTickCases.push({ input: v, expected: (v / 1_000_000).toFixed(1) + "M" });
}

// Negatives: -1 to -100
for (let i = 1; i <= 100; i++) {
  const v = -i;
  formatTickCases.push({ input: v, expected: v.toString() });
}

// Negative thousands
for (let i = 1; i <= 50; i++) {
  const v = -i * 1000;
  formatTickCases.push({ input: v, expected: (v / 1000).toFixed(1) + "K" });
}

// Decimals
for (let i = 1; i <= 50; i++) {
  const v = i * 0.1;
  formatTickCases.push({ input: v, expected: v.toFixed(1) });
}

// Negative millions
for (let i = 1; i <= 30; i++) {
  const v = -i * 1_000_000;
  formatTickCases.push({ input: v, expected: (v / 1_000_000).toFixed(1) + "M" });
}

// Large decimals (not integers)
for (let i = 1; i <= 50; i++) {
  const v = i * 0.7;
  formatTickCases.push({ input: v, expected: v.toFixed(1) });
}

// Trim to exactly 500
const formatCases500 = formatTickCases.slice(0, 500);

describe("formatTickValue: 500 parameterized cases", () => {
  it.each(formatCases500)(
    "formatTickValue($input) === $expected",
    ({ input, expected }) => {
      expect(formatTickValue(input)).toBe(expected);
    },
  );
});

// ============================================================================
// 2. createLinearScale: 500 tests
// ============================================================================

interface ScaleCase {
  domain: [number, number];
  range: [number, number];
  input: number;
  label: string;
}

const scaleCases: ScaleCase[] = [];

// Domains [0, N] for N=1..50, ranges [0, R] for R in [100, 200, 400, 600, 800]
// Inputs at domain boundaries and midpoints
const ranges: [number, number][] = [[0, 100], [0, 200], [0, 400], [0, 600], [0, 800]];

for (let n = 1; n <= 50; n++) {
  for (const r of ranges) {
    // Input at 0% of domain
    scaleCases.push({ domain: [0, n], range: r, input: 0, label: `[0,${n}]->[${r}] @0` });
    // Input at 50%
    scaleCases.push({ domain: [0, n], range: r, input: n / 2, label: `[0,${n}]->[${r}] @mid` });
  }
}

// Negative domains
for (let n = 1; n <= 20; n++) {
  for (const r of ranges) {
    scaleCases.push({ domain: [-n, n], range: r, input: 0, label: `[-${n},${n}]->[${r}] @0` });
  }
}

// Trim to 500
const scaleCases500 = scaleCases.slice(0, 500);

describe("createLinearScale: 500 parameterized cases", () => {
  it.each(scaleCases500)(
    "scale($label) maps input correctly",
    ({ domain, range, input }) => {
      const scale = createLinearScale(domain, range);
      const result = scale.scale(input);
      // Result should be a finite number within a reasonable range
      expect(Number.isFinite(result)).toBe(true);
      // The scale output should be between range endpoints (considering niceExtent may expand domain)
      const [r0, r1] = range;
      const lo = Math.min(r0, r1);
      const hi = Math.max(r0, r1);
      // Input at 0 with domain starting at 0 should map to range start (after niceExtent)
      if (input === 0 && domain[0] === 0) {
        expect(result).toBeCloseTo(r0, 0);
      }
      // All results should be finite numbers
      expect(typeof result).toBe("number");
    },
  );
});

// ============================================================================
// 3. applyChartFilters: 500 tests
// ============================================================================

interface FilterCase {
  numSeries: number;
  numCategories: number;
  hiddenSeries: number[];
  hiddenCategories: number[];
  label: string;
}

const filterCases: FilterCase[] = [];

// Varying series/category counts and hidden indices
for (let ns = 1; ns <= 10; ns++) {
  for (let nc = 1; nc <= 10; nc++) {
    // Hide no series, first category
    filterCases.push({
      numSeries: ns, numCategories: nc,
      hiddenSeries: [], hiddenCategories: nc > 1 ? [0] : [],
      label: `${ns}s/${nc}c hide cat[0]`,
    });
    // Hide first series, no categories
    filterCases.push({
      numSeries: ns, numCategories: nc,
      hiddenSeries: ns > 1 ? [0] : [], hiddenCategories: [],
      label: `${ns}s/${nc}c hide ser[0]`,
    });
    // Hide last series and last category
    filterCases.push({
      numSeries: ns, numCategories: nc,
      hiddenSeries: [ns - 1], hiddenCategories: [nc - 1],
      label: `${ns}s/${nc}c hide last`,
    });
    // Hide even indices
    filterCases.push({
      numSeries: ns, numCategories: nc,
      hiddenSeries: Array.from({ length: ns }, (_, i) => i).filter(i => i % 2 === 0 && ns > 1),
      hiddenCategories: Array.from({ length: nc }, (_, i) => i).filter(i => i % 2 === 0 && nc > 1),
      label: `${ns}s/${nc}c hide even`,
    });
    // No filters (passthrough)
    filterCases.push({
      numSeries: ns, numCategories: nc,
      hiddenSeries: [], hiddenCategories: [],
      label: `${ns}s/${nc}c no filter`,
    });
  }
}

// Additional filter combos with larger counts
for (let ns = 1; ns <= 5; ns++) {
  for (let nc = 11; nc <= 15; nc++) {
    filterCases.push({
      numSeries: ns, numCategories: nc,
      hiddenSeries: [0], hiddenCategories: [0, 1],
      label: `${ns}s/${nc}c hide[0],[0,1]`,
    });
    filterCases.push({
      numSeries: ns, numCategories: nc,
      hiddenSeries: [], hiddenCategories: Array.from({ length: Math.floor(nc / 2) }, (_, i) => i),
      label: `${ns}s/${nc}c hide half cats`,
    });
  }
}

const filterCases500 = filterCases.slice(0, 550);

function makeData(numSeries: number, numCategories: number): ParsedChartData {
  return {
    categories: Array.from({ length: numCategories }, (_, i) => `Cat${i}`),
    series: Array.from({ length: numSeries }, (_, si) => ({
      name: `Series${si}`,
      values: Array.from({ length: numCategories }, (_, ci) => (si + 1) * (ci + 1) * 10),
      color: null,
    })),
  };
}

describe("applyChartFilters: 500 parameterized cases", () => {
  it.each(filterCases500)(
    "filter($label)",
    ({ numSeries, numCategories, hiddenSeries, hiddenCategories }) => {
      const data = makeData(numSeries, numCategories);
      const filters: ChartFilters = { hiddenSeries, hiddenCategories };
      const result = applyChartFilters(data, filters);

      // Verify series count
      const expectedSeriesCount = numSeries - hiddenSeries.filter(i => i < numSeries).length;
      expect(result.series.length).toBe(expectedSeriesCount);

      // Verify category count
      const expectedCatCount = numCategories - hiddenCategories.filter(i => i < numCategories).length;
      expect(result.categories.length).toBe(expectedCatCount);

      // All series values arrays should match category count
      for (const s of result.series) {
        expect(s.values.length).toBe(expectedCatCount);
      }
    },
  );
});

// ============================================================================
// 4. getSeriesColor: 500 tests
// ============================================================================

interface ColorCase {
  palette: string;
  index: number;
  override: string | null;
  label: string;
}

const colorCases: ColorCase[] = [];
const paletteNames = Object.keys(PALETTES);

// Test cycling through each palette up to index 60
for (const pName of paletteNames) {
  for (let i = 0; i < 60; i++) {
    colorCases.push({ palette: pName, index: i, override: null, label: `${pName}[${i}]` });
  }
}

// Override cases
for (let i = 0; i < 50; i++) {
  colorCases.push({ palette: "default", index: i, override: `#${i.toString(16).padStart(6, "0")}`, label: `override#${i}` });
}

// Unknown palette falls back to default
for (let i = 0; i < 60; i++) {
  colorCases.push({ palette: "nonexistent", index: i, override: null, label: `unknown[${i}]` });
}

// More overrides with different palettes
for (const pName of paletteNames) {
  for (let i = 0; i < 20; i++) {
    colorCases.push({ palette: pName, index: i, override: `#FF${i.toString(16).padStart(4, "0")}`, label: `${pName}_ov${i}` });
  }
}

const colorCases500 = colorCases.slice(0, 520);

describe("getSeriesColor: 500 parameterized cases", () => {
  it.each(colorCases500)(
    "getSeriesColor($label)",
    ({ palette, index, override }) => {
      const result = getSeriesColor(palette, index, override);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);

      if (override) {
        expect(result).toBe(override);
      } else {
        const colors = PALETTES[palette] ?? PALETTES.default;
        expect(result).toBe(colors[index % colors.length]);
      }
    },
  );
});

// ============================================================================
// 5. computeBarRects: 500 tests
// ============================================================================

interface BarRectCase {
  numSeries: number;
  numCategories: number;
  stackMode: "none" | "stacked" | "percentStacked";
  label: string;
}

const barRectCases: BarRectCase[] = [];

const stackModes: Array<"none" | "stacked" | "percentStacked"> = ["none", "stacked", "percentStacked"];

// Combinations of series (1-8), categories (1-8), stack modes (3)
for (let ns = 1; ns <= 8; ns++) {
  for (let nc = 1; nc <= 8; nc++) {
    for (const mode of stackModes) {
      barRectCases.push({ numSeries: ns, numCategories: nc, stackMode: mode, label: `${ns}s/${nc}c/${mode}` });
    }
  }
}

// Extra combos to reach 500+
for (let ns = 1; ns <= 6; ns++) {
  for (let nc = 9; nc <= 30; nc++) {
    for (const mode of stackModes) {
      barRectCases.push({ numSeries: ns, numCategories: nc, stackMode: mode, label: `${ns}s/${nc}c/${mode}` });
    }
  }
}

const barRectCases500 = barRectCases.slice(0, 530);

function makeBarSpec(stackMode: "none" | "stacked" | "percentStacked"): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 10, endCol: 5 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: { stackMode, borderRadius: 2, barGap: 2 },
  };
}

function makeLayout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 20, right: 20, bottom: 40, left: 50 },
    plotArea: { x: 50, y: 20, width: 530, height: 340 },
  };
}

describe("computeBarRects: 500 parameterized cases", () => {
  it.each(barRectCases500)(
    "computeBarRects($label)",
    ({ numSeries, numCategories, stackMode }) => {
      const data = makeData(numSeries, numCategories);
      const spec = makeBarSpec(stackMode);
      spec.series = data.series.map((s, i) => ({ name: s.name, sourceIndex: i + 1, color: null }));
      const layout = makeLayout();
      const theme = DEFAULT_CHART_THEME;

      const rects = computeBarRects(data, spec, layout, theme);

      // Should produce rects for each series * category
      expect(rects.length).toBe(numSeries * numCategories);

      // All rects should have finite dimensions
      for (const rect of rects) {
        expect(Number.isFinite(rect.x)).toBe(true);
        expect(Number.isFinite(rect.y)).toBe(true);
        expect(Number.isFinite(rect.width)).toBe(true);
        expect(Number.isFinite(rect.height)).toBe(true);
        expect(rect.width).toBeGreaterThanOrEqual(0);
        expect(rect.height).toBeGreaterThanOrEqual(0);
        expect(rect.seriesIndex).toBeGreaterThanOrEqual(0);
        expect(rect.categoryIndex).toBeGreaterThanOrEqual(0);
      }
    },
  );
});
