//! FILENAME: app/extensions/Charts/lib/__tests__/dataPointOverrides.test.ts
// PURPOSE: Tests for data point override utility functions.

import { describe, it, expect } from "vitest";
import {
  getDataPointOverride,
  applyOverrideColor,
  applyOverrideOpacity,
  getExplodeOffset,
  buildOverrideMap,
  getOverrideFromMap,
} from "../dataPointOverrides";
import type { ChartSpec, DataPointOverride } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeSpec(overrides?: DataPointOverride[]): ChartSpec {
  return {
    mark: "bar",
    data: { startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "A", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true },
    yAxis: { title: null, gridLines: true, showLabels: true },
    legend: { visible: true, position: "right" },
    palette: "default",
    dataPointOverrides: overrides,
  } as ChartSpec;
}

// ============================================================================
// getDataPointOverride
// ============================================================================

describe("getDataPointOverride", () => {
  it("returns undefined when no overrides exist", () => {
    const spec = makeSpec();
    expect(getDataPointOverride(spec, 0, 0)).toBeUndefined();
  });

  it("returns undefined when overrides is empty array", () => {
    const spec = makeSpec([]);
    expect(getDataPointOverride(spec, 0, 0)).toBeUndefined();
  });

  it("finds a matching override", () => {
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 2, color: "#FF0000" },
    ]);
    const result = getDataPointOverride(spec, 0, 2);
    expect(result).toBeDefined();
    expect(result!.color).toBe("#FF0000");
  });

  it("returns undefined for non-matching indices", () => {
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 2, color: "#FF0000" },
    ]);
    expect(getDataPointOverride(spec, 0, 0)).toBeUndefined();
    expect(getDataPointOverride(spec, 1, 2)).toBeUndefined();
  });

  it("finds correct override among multiple", () => {
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 0, color: "#111111" },
      { seriesIndex: 0, categoryIndex: 1, color: "#222222" },
      { seriesIndex: 1, categoryIndex: 0, color: "#333333" },
    ]);
    expect(getDataPointOverride(spec, 0, 0)!.color).toBe("#111111");
    expect(getDataPointOverride(spec, 0, 1)!.color).toBe("#222222");
    expect(getDataPointOverride(spec, 1, 0)!.color).toBe("#333333");
  });
});

// ============================================================================
// applyOverrideColor
// ============================================================================

describe("applyOverrideColor", () => {
  it("returns original color when no override", () => {
    expect(applyOverrideColor("#4472C4", undefined)).toBe("#4472C4");
  });

  it("returns override color when present", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, color: "#FF0000" };
    expect(applyOverrideColor("#4472C4", override)).toBe("#FF0000");
  });

  it("returns original color when override has no color", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, opacity: 0.5 };
    expect(applyOverrideColor("#4472C4", override)).toBe("#4472C4");
  });
});

// ============================================================================
// applyOverrideOpacity
// ============================================================================

describe("applyOverrideOpacity", () => {
  it("returns original opacity when no override", () => {
    expect(applyOverrideOpacity(0.8, undefined)).toBe(0.8);
    expect(applyOverrideOpacity(null, undefined)).toBeNull();
  });

  it("returns override opacity when present", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, opacity: 0.3 };
    expect(applyOverrideOpacity(null, override)).toBe(0.3);
    expect(applyOverrideOpacity(0.8, override)).toBe(0.3);
  });

  it("returns original when override has no opacity", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, color: "#FF0000" };
    expect(applyOverrideOpacity(0.5, override)).toBe(0.5);
  });

  it("handles zero opacity override", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, opacity: 0 };
    expect(applyOverrideOpacity(0.8, override)).toBe(0);
  });
});

// ============================================================================
// getExplodeOffset
// ============================================================================

describe("getExplodeOffset", () => {
  it("returns 0 when no override", () => {
    expect(getExplodeOffset(undefined)).toBe(0);
  });

  it("returns 0 when override has no exploded field", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, color: "#FF0000" };
    expect(getExplodeOffset(override)).toBe(0);
  });

  it("returns the explode offset", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, exploded: 15 };
    expect(getExplodeOffset(override)).toBe(15);
  });
});

// ============================================================================
// buildOverrideMap / getOverrideFromMap
// ============================================================================

describe("buildOverrideMap", () => {
  it("returns empty map for undefined overrides", () => {
    const map = buildOverrideMap(undefined);
    expect(map.size).toBe(0);
  });

  it("returns empty map for empty array", () => {
    const map = buildOverrideMap([]);
    expect(map.size).toBe(0);
  });

  it("builds map from overrides", () => {
    const overrides: DataPointOverride[] = [
      { seriesIndex: 0, categoryIndex: 0, color: "#111" },
      { seriesIndex: 0, categoryIndex: 3, color: "#222" },
      { seriesIndex: 2, categoryIndex: 1, opacity: 0.5 },
    ];
    const map = buildOverrideMap(overrides);
    expect(map.size).toBe(3);

    expect(getOverrideFromMap(map, 0, 0)!.color).toBe("#111");
    expect(getOverrideFromMap(map, 0, 3)!.color).toBe("#222");
    expect(getOverrideFromMap(map, 2, 1)!.opacity).toBe(0.5);
  });

  it("returns undefined for non-matching lookups", () => {
    const overrides: DataPointOverride[] = [
      { seriesIndex: 0, categoryIndex: 0, color: "#111" },
    ];
    const map = buildOverrideMap(overrides);
    expect(getOverrideFromMap(map, 0, 1)).toBeUndefined();
    expect(getOverrideFromMap(map, 1, 0)).toBeUndefined();
    expect(getOverrideFromMap(map, 5, 5)).toBeUndefined();
  });
});

// ============================================================================
// Integration: Override with all fields
// ============================================================================

describe("full override integration", () => {
  it("handles override with all fields set", () => {
    const override: DataPointOverride = {
      seriesIndex: 1,
      categoryIndex: 3,
      color: "#FF5500",
      opacity: 0.7,
      borderColor: "#000000",
      borderWidth: 3,
      exploded: 12,
    };

    expect(applyOverrideColor("#4472C4", override)).toBe("#FF5500");
    expect(applyOverrideOpacity(null, override)).toBe(0.7);
    expect(getExplodeOffset(override)).toBe(12);
    expect(override.borderColor).toBe("#000000");
    expect(override.borderWidth).toBe(3);
  });

  it("handles map lookup for full override", () => {
    const overrides: DataPointOverride[] = [
      { seriesIndex: 1, categoryIndex: 3, color: "#FF5500", opacity: 0.7, exploded: 12 },
    ];
    const map = buildOverrideMap(overrides);
    const found = getOverrideFromMap(map, 1, 3);
    expect(found).toBeDefined();
    expect(found!.color).toBe("#FF5500");
    expect(found!.opacity).toBe(0.7);
    expect(found!.exploded).toBe(12);
  });

  it("serializes to JSON and back correctly", () => {
    const overrides: DataPointOverride[] = [
      { seriesIndex: 0, categoryIndex: 0, color: "#FF0000" },
      { seriesIndex: 1, categoryIndex: 2, opacity: 0.5, exploded: 10 },
      { seriesIndex: 0, categoryIndex: 3, borderColor: "#000", borderWidth: 2 },
    ];

    const json = JSON.stringify(overrides);
    const parsed: DataPointOverride[] = JSON.parse(json);

    expect(parsed).toHaveLength(3);
    expect(parsed[0].color).toBe("#FF0000");
    expect(parsed[1].opacity).toBe(0.5);
    expect(parsed[1].exploded).toBe(10);
    expect(parsed[2].borderColor).toBe("#000");
    expect(parsed[2].borderWidth).toBe(2);
  });
});
