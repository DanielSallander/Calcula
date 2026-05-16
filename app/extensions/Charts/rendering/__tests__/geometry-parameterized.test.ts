//! FILENAME: app/extensions/Charts/rendering/__tests__/geometry-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for chart geometry computation, hit testing,
//          and rendering helpers across many config combinations.

import { describe, it, expect } from "vitest";
import { computeBarRects } from "../barChartPainter";
import { computePieSliceArcs } from "../pieChartPainter";
import { computeAreaPointMarkers } from "../areaChartPainter";
import { hitTestBarChart, hitTestPoints, hitTestSlices } from "../chartHitTesting";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type {
  ChartSpec,
  ParsedChartData,
  ChartLayout,
  BarRect,
  PointMarker,
  SliceArc,
  StackMode,
  BarMarkOptions,
  AreaMarkOptions,
} from "../../types";

// ============================================================================
// Helpers
// ============================================================================

const theme = { ...DEFAULT_CHART_THEME };

function makeLayout(w = 600, h = 400): ChartLayout {
  const left = 60, top = 40, right = 20, bottom = 50;
  return {
    width: w,
    height: h,
    margin: { top, right, bottom, left },
    plotArea: {
      x: left,
      y: top,
      width: Math.max(w - left - right, 10),
      height: Math.max(h - top - bottom, 10),
    },
  };
}

function makeAxis(overrides: Partial<import("../../types").AxisSpec> = {}): import("../../types").AxisSpec {
  return {
    title: null,
    gridLines: false,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
    ...overrides,
  };
}

function makeSeries(count: number, catCount: number, valueGen: (si: number, ci: number) => number): ParsedChartData["series"] {
  const series: ParsedChartData["series"] = [];
  for (let si = 0; si < count; si++) {
    const values: number[] = [];
    for (let ci = 0; ci < catCount; ci++) {
      values.push(valueGen(si, ci));
    }
    series.push({ name: `S${si}`, values, color: null });
  }
  return series;
}

function makeCategories(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `C${i}`);
}

function makeBarSpec(
  seriesCount: number,
  catCount: number,
  stackMode: StackMode,
  valueGen: (si: number, ci: number) => number = (si, ci) => (si + 1) * (ci + 1) * 10,
): { data: ParsedChartData; spec: ChartSpec } {
  const categories = makeCategories(catCount);
  const series = makeSeries(seriesCount, catCount, valueGen);
  const data: ParsedChartData = { categories, series };
  const markOptions: BarMarkOptions = { stackMode };
  const spec: ChartSpec = {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: series.map((s, i) => ({ name: s.name, sourceIndex: i + 1, color: null })),
    title: null,
    xAxis: makeAxis(),
    yAxis: makeAxis({ min: 0 }),
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions,
  };
  return { data, spec };
}

function makeAreaSpec(
  seriesCount: number,
  catCount: number,
  stackMode: StackMode,
  valueGen: (si: number, ci: number) => number = (si, ci) => (si + 1) * (ci + 1) * 5,
): { data: ParsedChartData; spec: ChartSpec } {
  const categories = makeCategories(catCount);
  const series = makeSeries(seriesCount, catCount, valueGen);
  const data: ParsedChartData = { categories, series };
  const markOptions: AreaMarkOptions = { stackMode };
  const spec: ChartSpec = {
    mark: "area",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: series.map((s, i) => ({ name: s.name, sourceIndex: i + 1, color: null })),
    title: null,
    xAxis: makeAxis(),
    yAxis: makeAxis(),
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions,
  };
  return { data, spec };
}

function makePieSpec(
  values: number[],
  mark: "pie" | "donut" = "pie",
): { data: ParsedChartData; spec: ChartSpec } {
  const categories = values.map((_, i) => `Slice${i}`);
  const data: ParsedChartData = {
    categories,
    series: [{ name: "Values", values, color: null }],
  };
  const spec: ChartSpec = {
    mark,
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Values", sourceIndex: 1, color: null }],
    title: null,
    xAxis: makeAxis(),
    yAxis: makeAxis(),
    legend: { visible: false, position: "bottom" },
    palette: "default",
  };
  return { data, spec };
}

// ============================================================================
// 1. computeBarRects - 50 config combos
// ============================================================================

describe("computeBarRects parameterized", () => {
  // Generate combos: series x categories x stackMode
  const seriesCounts = [1, 2, 3, 5, 8, 12, 20];
  const categoryCounts = [1, 3, 5, 10, 20, 30, 50];
  const stackModes: StackMode[] = ["none", "stacked", "percentStacked"];

  // Pick 50 combos from the full grid
  const combos: Array<{ s: number; c: number; m: StackMode }> = [];
  for (const s of seriesCounts) {
    for (const m of stackModes) {
      // Pick a spread of category counts per series/mode combo
      const catIdx = (s + stackModes.indexOf(m)) % categoryCounts.length;
      combos.push({ s, c: categoryCounts[catIdx], m });
    }
  }
  // Add extra combos for edge cases to reach 50
  const extras: Array<{ s: number; c: number; m: StackMode }> = [
    { s: 1, c: 1, m: "none" },
    { s: 1, c: 1, m: "stacked" },
    { s: 1, c: 1, m: "percentStacked" },
    { s: 20, c: 50, m: "none" },
    { s: 20, c: 50, m: "stacked" },
    { s: 20, c: 50, m: "percentStacked" },
    { s: 10, c: 25, m: "none" },
    { s: 10, c: 25, m: "stacked" },
    { s: 15, c: 10, m: "percentStacked" },
    { s: 3, c: 50, m: "none" },
    { s: 5, c: 1, m: "stacked" },
    { s: 7, c: 3, m: "percentStacked" },
    { s: 4, c: 7, m: "none" },
    { s: 6, c: 15, m: "stacked" },
    { s: 2, c: 40, m: "none" },
    { s: 1, c: 50, m: "percentStacked" },
    { s: 18, c: 2, m: "none" },
    { s: 9, c: 9, m: "stacked" },
    { s: 11, c: 4, m: "percentStacked" },
    { s: 14, c: 6, m: "none" },
    { s: 16, c: 8, m: "stacked" },
    { s: 19, c: 12, m: "percentStacked" },
    { s: 13, c: 20, m: "none" },
    { s: 17, c: 1, m: "stacked" },
    { s: 8, c: 30, m: "percentStacked" },
    { s: 2, c: 2, m: "none" },
    { s: 4, c: 4, m: "stacked" },
    { s: 6, c: 6, m: "percentStacked" },
    { s: 3, c: 15, m: "none" },
  ];
  for (const e of extras) {
    if (combos.length >= 50) break;
    if (!combos.some(c => c.s === e.s && c.c === e.c && c.m === e.m)) {
      combos.push(e);
    }
  }
  // Trim to exactly 50
  const barCombos = combos.slice(0, 50);

  it.each(barCombos)(
    "s=$s c=$c m=$m: correct rect count, non-negative dims, within plot area",
    ({ s, c, m }) => {
      const layout = makeLayout(800, 500);
      const { data, spec } = makeBarSpec(s, c, m);
      const rects = computeBarRects(data, spec, layout, theme);

      // Rect count: for grouped, up to s*c rects; for stacked, also up to s*c
      expect(rects.length).toBeGreaterThan(0);
      expect(rects.length).toBeLessThanOrEqual(s * c);

      for (const r of rects) {
        // Non-negative dimensions
        expect(r.width).toBeGreaterThan(0);
        expect(r.height).toBeGreaterThanOrEqual(0);

        // Y coordinate within plot area bounds (with tolerance for floating point)
        expect(r.y).toBeGreaterThanOrEqual(layout.plotArea.y - 1);
        expect(r.y + r.height).toBeLessThanOrEqual(layout.plotArea.y + layout.plotArea.height + 1);

        // X coordinate: bars start within or near plot area
        // (with many grouped series, bars can extend slightly beyond the band)
        expect(r.x).toBeGreaterThanOrEqual(layout.plotArea.x - 1);

        // Metadata
        expect(r.seriesIndex).toBeGreaterThanOrEqual(0);
        expect(r.seriesIndex).toBeLessThan(s);
        expect(r.categoryIndex).toBeGreaterThanOrEqual(0);
        expect(r.categoryIndex).toBeLessThan(c);
        expect(r.seriesName).toBeTruthy();
        expect(r.categoryName).toBeTruthy();
      }
    },
  );
});

// ============================================================================
// 2. computePieSliceArcs - 40 data combos
// ============================================================================

describe("computePieSliceArcs parameterized", () => {
  type PieCombo = { label: string; values: number[]; mark: "pie" | "donut" };

  const pieCombos: PieCombo[] = [
    // Equal values
    { label: "1 equal", values: [100], mark: "pie" },
    { label: "2 equal", values: [50, 50], mark: "pie" },
    { label: "3 equal", values: [33, 33, 34], mark: "pie" },
    { label: "4 equal", values: [25, 25, 25, 25], mark: "donut" },
    { label: "5 equal", values: [20, 20, 20, 20, 20], mark: "pie" },
    { label: "8 equal", values: [12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5], mark: "donut" },
    { label: "10 equal", values: Array(10).fill(10), mark: "pie" },
    { label: "20 equal", values: Array(20).fill(5), mark: "donut" },

    // Unequal values
    { label: "2 unequal 90/10", values: [90, 10], mark: "pie" },
    { label: "3 unequal", values: [60, 30, 10], mark: "donut" },
    { label: "4 unequal", values: [50, 25, 15, 10], mark: "pie" },
    { label: "5 unequal", values: [40, 25, 20, 10, 5], mark: "donut" },
    { label: "5 descending", values: [100, 80, 60, 40, 20], mark: "pie" },
    { label: "8 unequal", values: [35, 20, 15, 10, 8, 5, 4, 3], mark: "pie" },
    { label: "10 unequal", values: [30, 20, 15, 10, 8, 6, 4, 3, 2, 2], mark: "donut" },
    { label: "15 varied", values: [25, 18, 12, 10, 8, 6, 5, 4, 3, 2, 2, 1, 1, 1, 2], mark: "pie" },

    // Dominant single value
    { label: "dominant 95/5", values: [95, 5], mark: "pie" },
    { label: "dominant 99/1", values: [99, 1], mark: "donut" },
    { label: "dominant among 5", values: [80, 5, 5, 5, 5], mark: "pie" },
    { label: "dominant among 10", values: [70, 5, 5, 4, 3, 3, 3, 3, 2, 2], mark: "donut" },

    // With zeros
    { label: "2 with zero", values: [100, 0], mark: "pie" },
    { label: "3 with zeros", values: [100, 0, 0], mark: "donut" },
    { label: "5 with zeros", values: [40, 30, 0, 20, 0], mark: "pie" },
    { label: "mixed zeros", values: [0, 50, 0, 50, 0], mark: "donut" },

    // Single value
    { label: "single 100", values: [100], mark: "donut" },
    { label: "single 1", values: [1], mark: "pie" },
    { label: "single 999", values: [999], mark: "donut" },

    // Large number of slices
    { label: "12 slices", values: Array.from({ length: 12 }, (_, i) => 12 - i), mark: "pie" },
    { label: "15 slices", values: Array.from({ length: 15 }, (_, i) => (i + 1) * 2), mark: "donut" },
    { label: "20 slices", values: Array.from({ length: 20 }, (_, i) => 20 - i), mark: "pie" },

    // Small values
    { label: "tiny values", values: [0.1, 0.2, 0.3, 0.4], mark: "pie" },
    { label: "mixed tiny", values: [0.01, 0.99], mark: "donut" },

    // Large values
    { label: "millions", values: [5000000, 3000000, 2000000], mark: "pie" },
    { label: "billions", values: [1e9, 5e8, 2.5e8], mark: "donut" },

    // Uniform large set
    { label: "16 uniform", values: Array(16).fill(6.25), mark: "pie" },
    { label: "18 uniform", values: Array(18).fill(100 / 18), mark: "donut" },

    // Fibonacci-ish
    { label: "fibonacci 5", values: [1, 1, 2, 3, 5], mark: "pie" },
    { label: "fibonacci 8", values: [1, 1, 2, 3, 5, 8, 13, 21], mark: "donut" },

    // Powers of 2
    { label: "powers of 2", values: [1, 2, 4, 8, 16, 32], mark: "pie" },
    { label: "powers of 10", values: [1, 10, 100, 1000], mark: "donut" },
  ];

  it.each(pieCombos)(
    "$label: angle sum near 2*PI, percent sum near 100, consistent center",
    ({ values, mark }) => {
      const layout = makeLayout(500, 500);
      const { data, spec } = makePieSpec(values, mark);
      const arcs = computePieSliceArcs(data, spec, layout, theme);

      const positiveValues = values.filter(v => v > 0);
      const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);

      if (total === 0) {
        expect(arcs.length).toBe(0);
        return;
      }

      // Should have one arc per value (including zeros)
      expect(arcs.length).toBe(values.length);

      // Angle sum: total sweep of non-zero slices should be close to 2*PI
      // (accounting for pad angles between slices)
      const totalSweep = arcs.reduce((sum, a) => sum + (a.endAngle - a.startAngle), 0);
      const padAngleRad = (1 * Math.PI) / 180; // default padAngle = 1 degree
      const expectedSweep = Math.PI * 2 - padAngleRad * values.length;
      // Only non-zero values contribute sweep; zero-value slices have 0 sweep
      expect(totalSweep).toBeCloseTo(expectedSweep, 1);

      // Percent sum should be close to 100
      const percentSum = arcs.reduce((sum, a) => sum + a.percent, 0);
      expect(percentSum).toBeCloseTo(100, 1);

      // All arcs share the same center
      const cx = arcs[0].centerX;
      const cy = arcs[0].centerY;
      for (const arc of arcs) {
        expect(arc.centerX).toBe(cx);
        expect(arc.centerY).toBe(cy);
      }

      // Outer radius is positive
      for (const arc of arcs) {
        expect(arc.outerRadius).toBeGreaterThan(0);
        expect(arc.innerRadius).toBeGreaterThanOrEqual(0);
        expect(arc.outerRadius).toBeGreaterThan(arc.innerRadius);
      }

      // For donut, inner radius > 0; for pie, inner radius = 0
      if (mark === "donut") {
        for (const arc of arcs) {
          expect(arc.innerRadius).toBeGreaterThan(0);
        }
      } else {
        for (const arc of arcs) {
          expect(arc.innerRadius).toBe(0);
        }
      }
    },
  );
});

// ============================================================================
// 3. computeAreaPointMarkers - 30 combos
// ============================================================================

describe("computeAreaPointMarkers parameterized", () => {
  type AreaCombo = { label: string; s: number; c: number; m: StackMode; valueGen: (si: number, ci: number) => number };

  const areaCombos: AreaCombo[] = [
    // Non-stacked
    { label: "1s x 5c none", s: 1, c: 5, m: "none", valueGen: (si, ci) => (ci + 1) * 10 },
    { label: "2s x 5c none", s: 2, c: 5, m: "none", valueGen: (si, ci) => (si + 1) * (ci + 1) * 5 },
    { label: "3s x 10c none", s: 3, c: 10, m: "none", valueGen: (si, ci) => Math.sin(ci) * 50 + 60 },
    { label: "5s x 3c none", s: 5, c: 3, m: "none", valueGen: (si, ci) => si * 20 + ci * 10 },
    { label: "1s x 1c none", s: 1, c: 1, m: "none", valueGen: () => 42 },
    { label: "1s x 50c none", s: 1, c: 50, m: "none", valueGen: (_, ci) => ci * 2 },
    { label: "10s x 5c none", s: 10, c: 5, m: "none", valueGen: (si, ci) => si + ci },
    { label: "20s x 3c none", s: 20, c: 3, m: "none", valueGen: (si, ci) => (si * ci) + 1 },
    { label: "3s x 20c none", s: 3, c: 20, m: "none", valueGen: (_, ci) => ci * ci },
    { label: "5s x 30c none", s: 5, c: 30, m: "none", valueGen: (si, ci) => (si + 1) * Math.abs(Math.sin(ci / 3)) * 100 },

    // Stacked
    { label: "2s x 5c stacked", s: 2, c: 5, m: "stacked", valueGen: (si, ci) => (si + 1) * (ci + 1) * 10 },
    { label: "3s x 5c stacked", s: 3, c: 5, m: "stacked", valueGen: (si, ci) => 20 },
    { label: "5s x 10c stacked", s: 5, c: 10, m: "stacked", valueGen: (si, ci) => (si + 1) * 5 },
    { label: "1s x 5c stacked", s: 1, c: 5, m: "stacked", valueGen: (_, ci) => ci * 10 + 5 },
    { label: "8s x 3c stacked", s: 8, c: 3, m: "stacked", valueGen: (si, ci) => si + ci + 1 },
    { label: "10s x 10c stacked", s: 10, c: 10, m: "stacked", valueGen: (si, ci) => 10 },
    { label: "4s x 20c stacked", s: 4, c: 20, m: "stacked", valueGen: (si, ci) => (si + 1) * 3 },
    { label: "15s x 2c stacked", s: 15, c: 2, m: "stacked", valueGen: (si) => si + 1 },
    { label: "2s x 40c stacked", s: 2, c: 40, m: "stacked", valueGen: (si, ci) => ci % (si + 2) + 1 },
    { label: "6s x 8c stacked", s: 6, c: 8, m: "stacked", valueGen: (si, ci) => (si * 3) + (ci * 2) },

    // Percent stacked
    { label: "2s x 5c percent", s: 2, c: 5, m: "percentStacked", valueGen: (si, ci) => (si + 1) * (ci + 1) },
    { label: "3s x 5c percent", s: 3, c: 5, m: "percentStacked", valueGen: (si) => si * 10 + 10 },
    { label: "5s x 10c percent", s: 5, c: 10, m: "percentStacked", valueGen: () => 20 },
    { label: "4s x 3c percent", s: 4, c: 3, m: "percentStacked", valueGen: (si, ci) => (si + 1) * (ci + 1) * 5 },
    { label: "1s x 10c percent", s: 1, c: 10, m: "percentStacked", valueGen: (_, ci) => ci + 1 },
    { label: "8s x 4c percent", s: 8, c: 4, m: "percentStacked", valueGen: (si) => si + 1 },
    { label: "10s x 2c percent", s: 10, c: 2, m: "percentStacked", valueGen: () => 10 },
    { label: "3s x 30c percent", s: 3, c: 30, m: "percentStacked", valueGen: (si, ci) => ci % (si + 1) + 1 },
    { label: "12s x 5c percent", s: 12, c: 5, m: "percentStacked", valueGen: (si) => (si % 4) + 1 },
    { label: "20s x 1c percent", s: 20, c: 1, m: "percentStacked", valueGen: (si) => si + 1 },

    // Additional combos for coverage
    { label: "7s x 7c none", s: 7, c: 7, m: "none", valueGen: (si, ci) => (si + ci) * 3 + 1 },
    { label: "1s x 100c none", s: 1, c: 100, m: "none", valueGen: (_, ci) => Math.sin(ci / 10) * 50 + 51 },
    { label: "15s x 1c stacked", s: 15, c: 1, m: "stacked", valueGen: (si) => si * 2 + 1 },
    { label: "3s x 3c percent", s: 3, c: 3, m: "percentStacked", valueGen: (si, ci) => (si + 1) * (ci + 1) },
    { label: "2s x 100c stacked", s: 2, c: 100, m: "stacked", valueGen: (si, ci) => ci + si * 10 + 1 },
    { label: "5s x 5c none zeros", s: 5, c: 5, m: "none", valueGen: (si, ci) => si === ci ? 100 : 0 },
    { label: "4s x 10c none large", s: 4, c: 10, m: "none", valueGen: (si, ci) => (si + 1) * (ci + 1) * 1000 },
    { label: "6s x 2c percent", s: 6, c: 2, m: "percentStacked", valueGen: (si) => si * si + 1 },
    { label: "1s x 2c stacked", s: 1, c: 2, m: "stacked", valueGen: (_, ci) => (ci + 1) * 50 },
    { label: "9s x 4c none", s: 9, c: 4, m: "none", valueGen: (si, ci) => si + ci * 10 },
  ];

  it.each(areaCombos)(
    "$label: correct marker count, valid coordinates",
    ({ s, c, m, valueGen }) => {
      const layout = makeLayout(800, 400);
      const { data, spec } = makeAreaSpec(s, c, m, valueGen);
      const markers = computeAreaPointMarkers(data, spec, layout, theme);

      // Should have one marker per series per category
      expect(markers.length).toBe(s * c);

      for (const mk of markers) {
        // Valid indices
        expect(mk.seriesIndex).toBeGreaterThanOrEqual(0);
        expect(mk.seriesIndex).toBeLessThan(s);
        expect(mk.categoryIndex).toBeGreaterThanOrEqual(0);
        expect(mk.categoryIndex).toBeLessThan(c);

        // Coordinates are finite numbers
        expect(Number.isFinite(mk.cx)).toBe(true);
        expect(Number.isFinite(mk.cy)).toBe(true);

        // Radius is positive
        expect(mk.radius).toBeGreaterThan(0);

        // Metadata present
        expect(mk.seriesName).toBeTruthy();
        expect(mk.categoryName).toBeTruthy();
      }

      // For percent stacked, last series markers should be at or near the top of scale
      if (m === "percentStacked" && s > 1) {
        const lastSeriesMarkers = markers.filter(mk => mk.seriesIndex === s - 1);
        // All last-series markers should be near the top (low Y value)
        for (const mk of lastSeriesMarkers) {
          // cy should be near plotArea.y (top)
          expect(mk.cy).toBeCloseTo(layout.plotArea.y, -1);
        }
      }
    },
  );
});

// ============================================================================
// 4. hitTestBarChart - 50 coordinate x geometry combos
// ============================================================================

describe("hitTestBarChart parameterized", () => {
  const layout = makeLayout(600, 400);

  function bar(si: number, ci: number, x: number, y: number, w: number, h: number): BarRect {
    return {
      seriesIndex: si, categoryIndex: ci,
      x, y, width: w, height: h,
      value: (si + 1) * 100, seriesName: `S${si}`, categoryName: `C${ci}`,
    };
  }

  // Create a grid of bars: 3 series, 4 categories
  const rects: BarRect[] = [];
  for (let ci = 0; ci < 4; ci++) {
    for (let si = 0; si < 3; si++) {
      rects.push(bar(si, ci, 80 + ci * 120 + si * 35, 100, 30, 200));
    }
  }

  type HitCase = { label: string; x: number; y: number; expected: "bar" | "plotArea" | "axis" | "none" };

  const hitCases: HitCase[] = [
    // Direct hits on bars (center of each)
    ...rects.map((r, i) => ({
      label: `center of bar ${i}`,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      expected: "bar" as const,
    })),

    // Top edge of bars
    { label: "top edge bar 0", x: rects[0].x + 15, y: rects[0].y + 1, expected: "bar" },
    { label: "top edge bar 5", x: rects[5].x + 15, y: rects[5].y + 1, expected: "bar" },

    // Bottom edge of bars
    { label: "bottom edge bar 0", x: rects[0].x + 15, y: rects[0].y + rects[0].height - 1, expected: "bar" },
    { label: "bottom edge bar 11", x: rects[11].x + 15, y: rects[11].y + rects[11].height - 1, expected: "bar" },

    // Between bars (gap regions) - inside plot area
    { label: "between bars gap 1", x: rects[0].x + rects[0].width + 2, y: 200, expected: "plotArea" },
    { label: "between bars gap 2", x: rects[3].x - 5, y: 200, expected: "plotArea" },

    // Inside plot area but no bars
    { label: "plot area above bars", x: 300, y: layout.plotArea.y + 5, expected: "plotArea" },
    { label: "plot area left edge", x: layout.plotArea.x + 2, y: 200, expected: "plotArea" },
    { label: "plot area right edge", x: layout.plotArea.x + layout.plotArea.width - 2, y: 200, expected: "plotArea" },

    // Outside plot area - axis regions
    { label: "x axis region", x: 300, y: layout.plotArea.y + layout.plotArea.height + 10, expected: "axis" },
    { label: "y axis region", x: 20, y: 200, expected: "axis" },

    // Completely outside
    { label: "above chart", x: 300, y: 5, expected: "none" },
    { label: "right of chart", x: layout.width - 5, y: 200, expected: "none" },

    // Corner hits
    { label: "bar corner top-left", x: rects[0].x, y: rects[0].y, expected: "bar" },
    { label: "bar corner bottom-right", x: rects[0].x + rects[0].width, y: rects[0].y + rects[0].height, expected: "bar" },

    // Just outside bar boundaries
    { label: "just left of bar", x: rects[0].x - 1, y: rects[0].y + 100, expected: "plotArea" },
    { label: "just above bar", x: rects[0].x + 15, y: rects[0].y - 1, expected: "plotArea" },
  ];

  // Pad to 50
  const additionalHits: HitCase[] = [
    { label: "plot empty area", x: 70, y: 350, expected: "plotArea" },
    { label: "far right bar center", x: rects[rects.length - 1].x + 15, y: 200, expected: "bar" },
    { label: "x axis far left", x: layout.plotArea.x + 5, y: layout.plotArea.y + layout.plotArea.height + 15, expected: "axis" },
    { label: "y axis top", x: 10, y: layout.plotArea.y + 5, expected: "axis" },
    { label: "bar 3 center", x: rects[3].x + 15, y: rects[3].y + 100, expected: "bar" },
    { label: "bar 7 center", x: rects[7].x + 15, y: rects[7].y + 100, expected: "bar" },
    { label: "bar 9 center", x: rects[9].x + 15, y: rects[9].y + 100, expected: "bar" },
    { label: "x axis middle", x: 250, y: layout.plotArea.y + layout.plotArea.height + 20, expected: "axis" },
    { label: "y axis middle", x: 30, y: layout.plotArea.y + layout.plotArea.height / 2, expected: "axis" },
  ];
  const allHitCases = [...hitCases, ...additionalHits].slice(0, 55);

  it.each(allHitCases)(
    "$label: expect $expected at ($x, $y)",
    ({ x, y, expected }) => {
      const result = hitTestBarChart(x, y, rects, layout);
      expect(result.type).toBe(expected);

      if (expected === "bar") {
        expect(result.seriesIndex).toBeDefined();
        expect(result.categoryIndex).toBeDefined();
        expect(result.value).toBeDefined();
        expect(result.seriesName).toBeTruthy();
        expect(result.categoryName).toBeTruthy();
      }
    },
  );
});

// ============================================================================
// 5. hitTestPoints - 40 coordinate x point combos
// ============================================================================

describe("hitTestPoints parameterized", () => {
  const layout = makeLayout(600, 400);

  function pt(si: number, ci: number, cx: number, cy: number, r = 4): PointMarker {
    return {
      seriesIndex: si, categoryIndex: ci,
      cx, cy, radius: r,
      value: (si + 1) * 50, seriesName: `S${si}`, categoryName: `C${ci}`,
    };
  }

  // Grid of markers: 4 series x 5 categories
  const markers: PointMarker[] = [];
  for (let si = 0; si < 4; si++) {
    for (let ci = 0; ci < 5; ci++) {
      markers.push(pt(si, ci, 100 + ci * 100, 80 + si * 60));
    }
  }

  type PointCase = { label: string; x: number; y: number; expected: "point" | "plotArea" | "none" | "axis" };

  const pointCases: PointCase[] = [
    // Direct center hits
    ...markers.slice(0, 15).map((m, i) => ({
      label: `center of marker ${i}`,
      x: m.cx,
      y: m.cy,
      expected: "point" as const,
    })),

    // Edge hits (within radius + bonus=3)
    { label: "edge hit +radius", x: markers[0].cx + 4, y: markers[0].cy, expected: "point" },
    { label: "edge hit +bonus", x: markers[0].cx + 6, y: markers[0].cy, expected: "point" },
    { label: "edge hit -Y", x: markers[0].cx, y: markers[0].cy - 6, expected: "point" },
    { label: "edge hit diagonal", x: markers[0].cx + 4, y: markers[0].cy + 4, expected: "point" },

    // Just outside hit radius (radius=4, bonus=3, total=7; need dist > 7)
    { label: "just outside radius", x: markers[0].cx + 8, y: markers[0].cy, expected: "plotArea" },
    { label: "just outside diagonal", x: markers[0].cx + 6, y: markers[0].cy + 6, expected: "plotArea" },  // dist=8.49

    // Between markers in plot area
    { label: "between markers 1", x: 150, y: 110, expected: "plotArea" },
    { label: "between markers 2", x: 250, y: 170, expected: "plotArea" },
    { label: "between markers 3", x: 350, y: 110, expected: "plotArea" },

    // Axis regions
    { label: "x axis region", x: 300, y: layout.plotArea.y + layout.plotArea.height + 10, expected: "axis" },
    { label: "y axis region", x: 20, y: 200, expected: "axis" },

    // Outside everything
    { label: "above chart", x: 300, y: 5, expected: "none" },
    { label: "far right", x: 590, y: 200, expected: "none" },

    // Exact on last marker
    { label: "last marker", x: markers[markers.length - 1].cx, y: markers[markers.length - 1].cy, expected: "point" },

    // Various radii - just within and outside
    { label: "within r+3 top", x: markers[5].cx, y: markers[5].cy - 7, expected: "point" },
    { label: "outside r+3 top", x: markers[5].cx, y: markers[5].cy - 8, expected: "plotArea" },
    { label: "within r+3 right", x: markers[10].cx + 7, y: markers[10].cy, expected: "point" },
    { label: "outside r+3 right", x: markers[10].cx + 8, y: markers[10].cy, expected: "plotArea" },

    // More plot area hits (choose coords far from any marker)
    { label: "plot far from markers", x: layout.plotArea.x + 2, y: layout.plotArea.y + layout.plotArea.height - 2, expected: "plotArea" },
    { label: "plot bottom-left", x: layout.plotArea.x + 5, y: layout.plotArea.y + layout.plotArea.height - 5, expected: "plotArea" },
    { label: "plot top-right", x: layout.plotArea.x + layout.plotArea.width - 5, y: layout.plotArea.y + 5, expected: "plotArea" },
  ];

  // Add more cases to boost count
  const morePointCases: PointCase[] = [
    // Hits on specific markers from later in the grid
    { label: "marker s3 c4", x: markers[19].cx, y: markers[19].cy, expected: "point" },
    { label: "marker s2 c2", x: markers[12].cx, y: markers[12].cy, expected: "point" },
    { label: "marker s1 c3", x: markers[8].cx, y: markers[8].cy, expected: "point" },
    { label: "marker s0 c4", x: markers[4].cx, y: markers[4].cy, expected: "point" },
    { label: "marker s3 c0", x: markers[15].cx, y: markers[15].cy, expected: "point" },
  ];
  pointCases.push(...morePointCases);
  const allPointCases = pointCases.slice(0, 45);

  it.each(allPointCases)(
    "$label: expect $expected at ($x, $y)",
    ({ x, y, expected }) => {
      const result = hitTestPoints(x, y, markers, layout);
      expect(result.type).toBe(expected);

      if (expected === "point") {
        expect(result.seriesIndex).toBeDefined();
        expect(result.categoryIndex).toBeDefined();
        expect(result.value).toBeDefined();
      }
    },
  );
});

// ============================================================================
// 6. hitTestSlices - 30 angle x slice combos
// ============================================================================

describe("hitTestSlices parameterized", () => {
  const layout = makeLayout(500, 500);

  const cx = 250;
  const cy = 250;
  const outerR = 150;
  const innerR = 0; // pie

  // Create 4 slices covering the full circle (with small pad)
  function makeSlices(count: number, inner = 0): SliceArc[] {
    const slices: SliceArc[] = [];
    const sweep = (Math.PI * 2) / count;
    for (let i = 0; i < count; i++) {
      slices.push({
        seriesIndex: i,
        startAngle: i * sweep - Math.PI / 2,
        endAngle: (i + 1) * sweep - Math.PI / 2,
        innerRadius: inner,
        outerRadius: outerR,
        centerX: cx,
        centerY: cy,
        value: 100 / count,
        label: `Slice${i}`,
        percent: 100 / count,
      });
    }
    return slices;
  }

  type SliceCase = { label: string; x: number; y: number; slices: SliceArc[]; expected: "slice" | "none"; sliceIdx?: number };

  const fourSlices = makeSlices(4);
  const eightSlices = makeSlices(8);
  const donutSlices = makeSlices(4, 60);

  const sliceCases: SliceCase[] = [
    // Center of each quadrant for 4-slice pie
    { label: "4sl: top (12 oclock)", x: cx, y: cy - 100, slices: fourSlices, expected: "slice" },
    { label: "4sl: right (3 oclock)", x: cx + 100, y: cy, slices: fourSlices, expected: "slice" },
    { label: "4sl: bottom (6 oclock)", x: cx, y: cy + 100, slices: fourSlices, expected: "slice" },
    { label: "4sl: left (9 oclock)", x: cx - 100, y: cy, slices: fourSlices, expected: "slice" },

    // Near the outer edge
    { label: "4sl: outer edge top", x: cx, y: cy - 149, slices: fourSlices, expected: "slice" },
    { label: "4sl: outer edge right", x: cx + 149, y: cy, slices: fourSlices, expected: "slice" },

    // Just outside outer radius
    { label: "4sl: outside top", x: cx, y: cy - 151, slices: fourSlices, expected: "none" },
    { label: "4sl: outside right", x: cx + 151, y: cy, slices: fourSlices, expected: "none" },
    { label: "4sl: outside bottom", x: cx, y: cy + 151, slices: fourSlices, expected: "none" },
    { label: "4sl: outside left", x: cx - 151, y: cy, slices: fourSlices, expected: "none" },

    // At the center (inside for pie, outside for donut)
    { label: "4sl: center pie", x: cx, y: cy, slices: fourSlices, expected: "slice" },
    { label: "donut: center hole", x: cx, y: cy, slices: donutSlices, expected: "none" },

    // Donut ring hits
    { label: "donut: in ring top", x: cx, y: cy - 100, slices: donutSlices, expected: "slice" },
    { label: "donut: in ring right", x: cx + 100, y: cy, slices: donutSlices, expected: "slice" },
    { label: "donut: in ring bottom", x: cx, y: cy + 100, slices: donutSlices, expected: "slice" },
    { label: "donut: in ring left", x: cx - 100, y: cy, slices: donutSlices, expected: "slice" },

    // Donut: inside inner radius (hole)
    { label: "donut: inner edge", x: cx, y: cy - 59, slices: donutSlices, expected: "none" },
    { label: "donut: inner close", x: cx + 30, y: cy, slices: donutSlices, expected: "none" },

    // 8-slice hits
    { label: "8sl: NE", x: cx + 80, y: cy - 80, slices: eightSlices, expected: "slice" },
    { label: "8sl: SE", x: cx + 80, y: cy + 80, slices: eightSlices, expected: "slice" },
    { label: "8sl: SW", x: cx - 80, y: cy + 80, slices: eightSlices, expected: "slice" },
    { label: "8sl: NW", x: cx - 80, y: cy - 80, slices: eightSlices, expected: "slice" },
    { label: "8sl: N", x: cx, y: cy - 80, slices: eightSlices, expected: "slice" },
    { label: "8sl: E", x: cx + 80, y: cy, slices: eightSlices, expected: "slice" },
    { label: "8sl: S", x: cx, y: cy + 80, slices: eightSlices, expected: "slice" },
    { label: "8sl: W", x: cx - 80, y: cy, slices: eightSlices, expected: "slice" },

    // Far outside
    { label: "far outside", x: cx + 300, y: cy, slices: fourSlices, expected: "none" },
    { label: "diagonal outside", x: cx + 200, y: cy + 200, slices: fourSlices, expected: "none" },

    // Empty slices
    { label: "no slices", x: cx, y: cy, slices: [], expected: "none" },
    { label: "4sl: near boundary", x: cx + 1, y: cy - 100, slices: fourSlices, expected: "slice" },

    // Additional edge cases for coverage
    { label: "4sl: at outer radius N", x: cx, y: cy - outerR, slices: fourSlices, expected: "slice" },
    { label: "4sl: at outer radius E", x: cx + outerR, y: cy, slices: fourSlices, expected: "slice" },
    { label: "4sl: at outer radius S", x: cx, y: cy + outerR, slices: fourSlices, expected: "slice" },
    { label: "4sl: at outer radius W", x: cx - outerR, y: cy, slices: fourSlices, expected: "slice" },
    { label: "donut: just outside inner", x: cx, y: cy - 61, slices: donutSlices, expected: "slice" },
    { label: "donut: at outer edge", x: cx + outerR, y: cy, slices: donutSlices, expected: "slice" },
    { label: "8sl: center hit", x: cx + 1, y: cy + 1, slices: eightSlices, expected: "slice" },
    { label: "8sl: far N", x: cx, y: cy - 140, slices: eightSlices, expected: "slice" },
    { label: "8sl: far E", x: cx + 140, y: cy, slices: eightSlices, expected: "slice" },
    { label: "8sl: outside NE", x: cx + 120, y: cy - 120, slices: eightSlices, expected: "none" },
  ];

  it.each(sliceCases)(
    "$label: expect $expected at ($x, $y)",
    ({ x, y, slices, expected, sliceIdx }) => {
      const result = hitTestSlices(x, y, slices, layout);
      expect(result.type).toBe(expected);

      if (expected === "slice") {
        expect(result.seriesIndex).toBeDefined();
        expect(result.value).toBeDefined();
        if (sliceIdx !== undefined) {
          expect(result.seriesIndex).toBe(sliceIdx);
        }
      }
    },
  );
});
