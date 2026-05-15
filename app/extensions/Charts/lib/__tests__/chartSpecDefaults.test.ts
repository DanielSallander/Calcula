//! FILENAME: app/extensions/Charts/lib/__tests__/chartSpecDefaults.test.ts
// PURPOSE: Tests for buildDefaultSpec.

import { describe, it, expect } from "vitest";
import { buildDefaultSpec } from "../chartSpecDefaults";
import type { DataRangeRef, ChartSeries } from "../../types";

// ============================================================================
// buildDefaultSpec
// ============================================================================

describe("buildDefaultSpec", () => {
  const dataRange: DataRangeRef = {
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: 9,
    endCol: 3,
  };

  const autoDetected = {
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Costs", sourceIndex: 2, color: null },
    ] as ChartSeries[],
    orientation: "columns" as const,
  };

  it("returns a spec with correct mark type", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected, "bar");
    expect(spec.mark).toBe("bar");
  });

  it("defaults to bar when no mark specified", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.mark).toBe("bar");
  });

  it("uses the provided data range", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.data).toEqual(dataRange);
  });

  it("sets hasHeaders from parameter", () => {
    expect(buildDefaultSpec(dataRange, true, autoDetected).hasHeaders).toBe(true);
    expect(buildDefaultSpec(dataRange, false, autoDetected).hasHeaders).toBe(false);
  });

  it("uses auto-detected series and orientation", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.series).toHaveLength(2);
    expect(spec.series[0].name).toBe("Revenue");
    expect(spec.seriesOrientation).toBe("columns");
    expect(spec.categoryIndex).toBe(0);
  });

  it("sets title to null", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.title).toBeNull();
  });

  it("enables y-axis grid lines by default", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.yAxis.gridLines).toBe(true);
    expect(spec.xAxis.gridLines).toBe(false);
  });

  it("sets legend visible at bottom", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.legend.visible).toBe(true);
    expect(spec.legend.position).toBe("bottom");
  });

  it("uses default palette", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.palette).toBe("default");
  });

  it("sets all axis min/max to null (auto-scale)", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected);
    expect(spec.xAxis.min).toBeNull();
    expect(spec.xAxis.max).toBeNull();
    expect(spec.yAxis.min).toBeNull();
    expect(spec.yAxis.max).toBeNull();
  });

  it("accepts line chart type", () => {
    const spec = buildDefaultSpec(dataRange, true, autoDetected, "line");
    expect(spec.mark).toBe("line");
  });
});
