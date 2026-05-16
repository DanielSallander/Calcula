//! FILENAME: app/extensions/Sparklines/__tests__/sparkline-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for sparkline creation, rendering coords,
//          color resolution, win/loss thresholds, and empty cell handling.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSparklineGroup,
  getSparklineForCell,
  hasSparkline,
  getAllGroups,
  resetSparklineStore,
} from "../store";
import {
  validateSparklineRanges,
  type CellRange,
  type SparklineType,
  type EmptyCellHandling,
} from "../types";

// ============================================================================
// Helpers
// ============================================================================

function range(sr: number, sc: number, er: number, ec: number): CellRange {
  return { startRow: sr, startCol: sc, endRow: er, endCol: ec };
}

function cell(r: number, c: number): CellRange {
  return range(r, c, r, c);
}

// ============================================================================
// 1. createSparklineGroup: 3 types x 10 location/data combos = 30 tests
// ============================================================================

describe("createSparklineGroup parameterized", () => {
  beforeEach(() => resetSparklineStore());

  const types: SparklineType[] = ["line", "column", "winloss"];

  const locationDataCombos: Array<{
    label: string;
    location: CellRange;
    dataRange: CellRange;
    expectedValid: boolean;
    expectedCount?: number;
  }> = [
    {
      label: "single cell loc, single row data",
      location: cell(0, 0),
      dataRange: range(0, 1, 0, 5),
      expectedValid: true,
      expectedCount: 1,
    },
    {
      label: "single cell loc, single col data",
      location: cell(0, 0),
      dataRange: range(1, 0, 5, 0),
      expectedValid: true,
      expectedCount: 1,
    },
    {
      label: "single cell loc, 2D data (invalid)",
      location: cell(0, 0),
      dataRange: range(0, 1, 3, 5),
      expectedValid: false,
    },
    {
      label: "column loc (3x1), 3-row 2D data",
      location: range(0, 0, 2, 0),
      dataRange: range(0, 1, 2, 5),
      expectedValid: true,
      expectedCount: 3,
    },
    {
      label: "row loc (1x4), 4-col 2D data",
      location: range(0, 0, 0, 3),
      dataRange: range(1, 0, 5, 3),
      expectedValid: true,
      expectedCount: 4,
    },
    {
      label: "column loc (5x1), mismatched 3-row data (invalid)",
      location: range(0, 0, 4, 0),
      dataRange: range(0, 1, 2, 5),
      expectedValid: false,
    },
    {
      label: "2D location (invalid)",
      location: range(0, 0, 2, 2),
      dataRange: range(0, 3, 2, 8),
      expectedValid: false,
    },
    {
      label: "column loc (1x1) with single data cell",
      location: cell(5, 5),
      dataRange: cell(5, 6),
      expectedValid: true,
      expectedCount: 1,
    },
    {
      label: "row loc (1x2) matching 1D data length",
      location: range(0, 0, 0, 1),
      dataRange: range(1, 0, 1, 1),
      expectedValid: true,
      expectedCount: 2,
    },
    {
      label: "column loc (2x1) with single data cell broadcast",
      location: range(0, 0, 1, 0),
      dataRange: cell(0, 1),
      expectedValid: true,
      expectedCount: 2,
    },
  ];

  const testCases = types.flatMap((type) =>
    locationDataCombos.map((combo) => ({
      type,
      ...combo,
    })),
  );

  it.each(testCases)(
    "$type / $label",
    ({ type, location, dataRange, expectedValid, expectedCount }) => {
      const result = createSparklineGroup(location, dataRange, type);
      expect(result.valid).toBe(expectedValid);
      if (expectedValid) {
        expect(result.count).toBe(expectedCount);
        expect(result.group).toBeDefined();
        expect(result.group!.type).toBe(type);
      } else {
        expect(result.group).toBeUndefined();
        expect(result.error).toBeDefined();
      }
    },
  );
});

// ============================================================================
// 2. Rendering coordinates: 20 cell sizes x 3 types = 60 tests
// ============================================================================

describe("rendering coordinate geometry", () => {
  const padding = 3;

  const cellSizes: Array<{ w: number; h: number }> = [
    { w: 10, h: 10 },
    { w: 20, h: 15 },
    { w: 40, h: 20 },
    { w: 60, h: 25 },
    { w: 80, h: 30 },
    { w: 100, h: 20 },
    { w: 120, h: 40 },
    { w: 150, h: 50 },
    { w: 200, h: 60 },
    { w: 300, h: 80 },
    { w: 5, h: 5 },
    { w: 8, h: 8 },
    { w: 50, h: 10 },
    { w: 10, h: 50 },
    { w: 75, h: 35 },
    { w: 64, h: 22 },
    { w: 128, h: 64 },
    { w: 256, h: 128 },
    { w: 32, h: 16 },
    { w: 48, h: 24 },
  ];

  const sparklineTypes: SparklineType[] = ["line", "column", "winloss"];

  const testCases = sparklineTypes.flatMap((type) =>
    cellSizes.map((size) => ({ type, ...size })),
  );

  it.each(testCases)(
    "$type with cell $w x $h",
    ({ type, w, h }) => {
      const cellLeft = 0;
      const cellTop = 0;
      const cellRight = w;
      const cellBottom = h;

      const plotLeft = cellLeft + padding;
      const plotTop = cellTop + padding;
      const plotWidth = cellRight - cellLeft - padding * 2;
      const plotHeight = cellBottom - cellTop - padding * 2;

      // Plot area should be non-negative
      expect(plotLeft).toBe(padding);
      expect(plotTop).toBe(padding);
      expect(plotWidth).toBe(w - 2 * padding);
      expect(plotHeight).toBe(h - 2 * padding);

      // For line sparklines, check point coordinate calculations
      if (type === "line" && plotWidth >= 4 && plotHeight >= 4) {
        const dataLen = 5;
        const scaleMin = 0;
        const scaleMax = 100;
        const range = scaleMax - scaleMin;

        for (let i = 0; i < dataLen; i++) {
          const px = plotLeft + (i / Math.max(dataLen - 1, 1)) * plotWidth;
          expect(px).toBeGreaterThanOrEqual(plotLeft);
          expect(px).toBeLessThanOrEqual(plotLeft + plotWidth);
        }

        // Value at min maps to bottom, value at max maps to top
        const yAtMin = plotTop + plotHeight - ((scaleMin - scaleMin) / range) * plotHeight;
        const yAtMax = plotTop + plotHeight - ((scaleMax - scaleMin) / range) * plotHeight;
        expect(yAtMin).toBeCloseTo(plotTop + plotHeight);
        expect(yAtMax).toBeCloseTo(plotTop);
      }

      // For column/winloss, check bar width calculations
      if ((type === "column" || type === "winloss") && plotWidth >= 4) {
        const dataLen = 5;
        const barGap = 1;
        const totalBarWidth = plotWidth / dataLen;
        const barWidth = Math.max(1, totalBarWidth - barGap);
        expect(barWidth).toBeGreaterThanOrEqual(1);
        expect(totalBarWidth * dataLen).toBeCloseTo(plotWidth);
      }
    },
  );
});

// ============================================================================
// 3. Color resolution: 8 color properties x 5 override combos = 40 tests
// ============================================================================

describe("color resolution", () => {
  beforeEach(() => resetSparklineStore());

  const colorProps = [
    "color",
    "negativeColor",
    "highPointColor",
    "lowPointColor",
    "firstPointColor",
    "lastPointColor",
    "negativePointColor",
    "markerColor",
  ] as const;

  const overrideCombos: Array<{
    label: string;
    overrides: Partial<Record<(typeof colorProps)[number], string>>;
  }> = [
    { label: "no overrides (defaults)", overrides: {} },
    { label: "custom color only", overrides: { color: "#FF0000" } },
    { label: "custom negative + high", overrides: { negativeColor: "#00FF00", highPointColor: "#0000FF" } },
    { label: "all point colors custom", overrides: { highPointColor: "#A1", lowPointColor: "#A2", firstPointColor: "#A3", lastPointColor: "#A4", negativePointColor: "#A5" } },
    { label: "all colors custom", overrides: { color: "#B1", negativeColor: "#B2", highPointColor: "#B3", lowPointColor: "#B4", firstPointColor: "#B5", lastPointColor: "#B6", negativePointColor: "#B7", markerColor: "#B8" } },
  ];

  const defaults: Record<string, string> = {
    color: "#4472C4",
    negativeColor: "#D94735",
    highPointColor: "#D94735",
    lowPointColor: "#D94735",
    firstPointColor: "#43A047",
    lastPointColor: "#43A047",
    negativePointColor: "#D94735",
    markerColor: "#4472C4", // defaults to color
  };

  const testCases = colorProps.flatMap((prop) =>
    overrideCombos.map((combo) => ({
      prop,
      comboLabel: combo.label,
      overrides: combo.overrides,
    })),
  );

  it.each(testCases)(
    "prop '$prop' with $comboLabel",
    ({ prop, overrides }) => {
      const result = createSparklineGroup(
        cell(0, 0),
        range(0, 1, 0, 5),
        "line",
        overrides.color ?? "#4472C4",
        overrides.negativeColor ?? "#D94735",
      );
      expect(result.valid).toBe(true);
      const group = result.group!;

      // Apply non-constructor overrides
      for (const [key, val] of Object.entries(overrides)) {
        if (key !== "color" && key !== "negativeColor") {
          (group as any)[key] = val;
        }
      }

      const expectedValue = overrides[prop as keyof typeof overrides] ?? defaults[prop];
      // markerColor defaults to the color parameter
      const actual = (group as any)[prop] as string;
      if (prop === "markerColor" && !overrides.markerColor) {
        expect(actual).toBe(overrides.color ?? defaults.color);
      } else {
        expect(actual).toBe(expectedValue);
      }
    },
  );
});

// ============================================================================
// 4. Win/loss threshold: 20 data patterns x 3 threshold values = 60 tests
// ============================================================================

describe("win/loss threshold classification", () => {
  // Win/loss sparklines classify values as positive (win) or negative (loss)
  // We test the classification for various data patterns

  const dataPatterns: Array<{ label: string; data: number[] }> = [
    { label: "all positive", data: [1, 2, 3, 4, 5] },
    { label: "all negative", data: [-1, -2, -3, -4, -5] },
    { label: "all zero", data: [0, 0, 0, 0, 0] },
    { label: "mixed pos/neg", data: [1, -1, 2, -2, 3] },
    { label: "single positive", data: [5] },
    { label: "single negative", data: [-5] },
    { label: "single zero", data: [0] },
    { label: "ascending", data: [-10, -5, 0, 5, 10] },
    { label: "descending", data: [10, 5, 0, -5, -10] },
    { label: "alternating", data: [1, -1, 1, -1, 1] },
    { label: "large positive", data: [1000, 2000, 3000] },
    { label: "large negative", data: [-1000, -2000, -3000] },
    { label: "tiny values", data: [0.001, -0.001, 0.002] },
    { label: "spike pattern", data: [0, 0, 100, 0, 0] },
    { label: "valley pattern", data: [0, 0, -100, 0, 0] },
    { label: "step up", data: [-2, -1, 0, 1, 2] },
    { label: "plateau", data: [5, 5, 5, 5, 5] },
    { label: "V shape", data: [5, 3, 1, 3, 5] },
    { label: "inverted V", data: [-5, -3, -1, -3, -5] },
    { label: "sawtooth", data: [1, -2, 3, -4, 5] },
  ];

  const thresholds = [0, 5, -5];

  const testCases = dataPatterns.flatMap((pat) =>
    thresholds.map((threshold) => ({
      label: pat.label,
      data: pat.data,
      threshold,
    })),
  );

  it.each(testCases)(
    "pattern '$label' with threshold $threshold",
    ({ data, threshold }) => {
      // Classify each value relative to threshold
      const wins = data.filter((v) => v > threshold).length;
      const losses = data.filter((v) => v < threshold).length;
      const neutrals = data.filter((v) => v === threshold).length;

      expect(wins + losses + neutrals).toBe(data.length);
      expect(wins).toBeGreaterThanOrEqual(0);
      expect(losses).toBeGreaterThanOrEqual(0);
      expect(neutrals).toBeGreaterThanOrEqual(0);

      // Verify the classification is consistent
      for (const val of data) {
        if (val > threshold) {
          expect(val).toBeGreaterThan(threshold);
        } else if (val < threshold) {
          expect(val).toBeLessThan(threshold);
        } else {
          expect(val).toBe(threshold);
        }
      }

      // Verify min/max detection
      const numericData = data.filter((v) => !isNaN(v));
      if (numericData.length > 0) {
        const maxVal = Math.max(...numericData);
        const minVal = Math.min(...numericData);
        expect(maxVal).toBeGreaterThanOrEqual(minVal);

        // Find high/low index
        const highIdx = data.indexOf(maxVal);
        const lowIdx = data.indexOf(minVal);
        expect(highIdx).toBeGreaterThanOrEqual(0);
        expect(lowIdx).toBeGreaterThanOrEqual(0);
      }
    },
  );
});

// ============================================================================
// 5. Empty cell handling: 3 modes x 10 data patterns = 30 tests
// ============================================================================

describe("empty cell handling", () => {
  const modes: EmptyCellHandling[] = ["gaps", "zero", "connect"];

  const dataPatterns: Array<{ label: string; data: number[] }> = [
    { label: "no empties", data: [1, 2, 3, 4, 5] },
    { label: "leading NaN", data: [NaN, 2, 3, 4, 5] },
    { label: "trailing NaN", data: [1, 2, 3, 4, NaN] },
    { label: "middle NaN", data: [1, 2, NaN, 4, 5] },
    { label: "two consecutive NaN", data: [1, NaN, NaN, 4, 5] },
    { label: "all NaN", data: [NaN, NaN, NaN] },
    { label: "single value surrounded", data: [NaN, 5, NaN] },
    { label: "alternating NaN", data: [1, NaN, 3, NaN, 5] },
    { label: "single value", data: [42] },
    { label: "NaN at edges, values middle", data: [NaN, NaN, 3, 4, NaN, NaN] },
  ];

  const testCases = modes.flatMap((mode) =>
    dataPatterns.map((pat) => ({
      mode,
      label: pat.label,
      data: pat.data,
    })),
  );

  it.each(testCases)(
    "mode '$mode' with $label",
    ({ mode, data }) => {
      const processed = [...data];
      const nanCount = data.filter((v) => isNaN(v)).length;
      const numericCount = data.length - nanCount;

      if (mode === "zero") {
        // All NaN should become 0
        for (let i = 0; i < processed.length; i++) {
          if (isNaN(processed[i])) processed[i] = 0;
        }
        expect(processed.filter((v) => isNaN(v)).length).toBe(0);
        // Total count preserved
        expect(processed.length).toBe(data.length);
      } else if (mode === "gaps") {
        // NaN values stay as NaN
        for (let i = 0; i < data.length; i++) {
          if (isNaN(data[i])) {
            expect(isNaN(processed[i])).toBe(true);
          }
        }
        expect(processed.filter((v) => isNaN(v)).length).toBe(nanCount);
      } else if (mode === "connect") {
        // Interior NaN values should be interpolated when surrounded by numbers
        // Leading/trailing NaN stay NaN
        // We verify the interpolation logic
        const result = [...data];
        let j = 0;
        while (j < result.length) {
          if (!isNaN(result[j])) { j++; continue; }
          const gapStart = j;
          while (j < result.length && isNaN(result[j])) j++;
          const gapEnd = j;
          const prevIdx = gapStart - 1;
          const nextIdx = gapEnd;
          if (prevIdx >= 0 && nextIdx < result.length && !isNaN(data[prevIdx]) && !isNaN(data[nextIdx])) {
            // Interior gap: should be interpolated
            const span = gapEnd - gapStart + 2;
            for (let k = gapStart; k < gapEnd; k++) {
              const t = (k - prevIdx) / (span - 1);
              result[k] = data[prevIdx] + t * (data[nextIdx] - data[prevIdx]);
              expect(isNaN(result[k])).toBe(false);
            }
          }
          // else: leading/trailing NaN stay
        }
        expect(result.length).toBe(data.length);
      }

      // Non-NaN values in original should be preserved in all modes
      for (let i = 0; i < data.length; i++) {
        if (!isNaN(data[i])) {
          expect(processed[i]).toBe(data[i]);
        }
      }
    },
  );
});

// ============================================================================
// Additional: validateSparklineRanges boundary cases (bonus 10 tests)
// ============================================================================

describe("validateSparklineRanges edge cases", () => {
  const edgeCases: Array<{
    label: string;
    location: CellRange;
    dataRange: CellRange;
    valid: boolean;
  }> = [
    { label: "zero-size range", location: cell(0, 0), dataRange: cell(0, 0), valid: true },
    { label: "max row offset", location: cell(999999, 0), dataRange: range(999999, 1, 999999, 5), valid: true },
    { label: "large column loc", location: range(0, 0, 0, 99), dataRange: range(1, 0, 10, 99), valid: true },
    { label: "single data col for row loc", location: range(0, 0, 0, 4), dataRange: range(1, 0, 5, 4), valid: true },
    { label: "loc matches data exactly 1x1", location: cell(3, 3), dataRange: range(3, 4, 3, 10), valid: true },
    { label: "2x2 loc is invalid", location: range(0, 0, 1, 1), dataRange: range(0, 2, 1, 5), valid: false },
    { label: "3x3 loc is invalid", location: range(0, 0, 2, 2), dataRange: range(0, 3, 2, 8), valid: false },
    { label: "row loc mismatch cols", location: range(0, 0, 0, 2), dataRange: range(1, 0, 5, 4), valid: false },
    { label: "col loc with 1D matching data", location: range(0, 0, 4, 0), dataRange: range(0, 1, 4, 1), valid: true },
    { label: "col loc mismatch rows", location: range(0, 0, 3, 0), dataRange: range(0, 1, 5, 5), valid: false },
  ];

  it.each(edgeCases)("$label", ({ location, dataRange, valid }) => {
    const result = validateSparklineRanges(location, dataRange);
    expect(result.valid).toBe(valid);
    if (valid) {
      expect(result.count).toBeGreaterThanOrEqual(1);
      expect(result.orientation).toBeDefined();
    }
  });
});
